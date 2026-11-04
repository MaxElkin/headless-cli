import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.ts";
import { OpenCodeToolProgress } from "../src/fork/opencode-progress.ts";
import { ProgressFile } from "../src/fork/progress-file.ts";
import { ProgressRenderer } from "../src/trace-events.ts";

const sqliteAvailable = spawnSync("sqlite3", ["--version"]).status === 0;
const schema = "create table message(id text primary key, data text); " +
  "create table part(id text primary key, session_id text, message_id text, time_created integer, data text);";
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

function sql(db: string, statement: string): void {
  const result = spawnSync("sqlite3", [db], { input: statement, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function tool(id: string, status: string, command = "sleep 120", sessionID = "ses_current") {
  return { type: "tool_use", sessionID, part: { id, tool: "bash",
    state: { status, input: { command }, ...(status === "error" ? { error: "command failed" } : {}) } } };
}

test("running tool progress uses the exact session and excludes resumed history and other roles", { skip: !sqliteAvailable }, () => {
  const home = mkdtempSync(join(tmpdir(), "fork-opencode-running-"));
  try {
    const db = join(home, "opencode.db");
    sql(db, schema + "insert into message values('assistant', '{\"role\":\"assistant\"}');" +
      "insert into message values('user', '{\"role\":\"user\"}');");
    const now = Date.now();
    const rows = [
      ["old", "ses_current", "assistant", now - 10_000, "running"],
      ["other", "ses_other", "assistant", now + 1, "running"],
      ["user-tool", "ses_current", "user", now + 1, "running"],
      ["done", "ses_current", "assistant", now + 1, "completed"],
      ["active", "ses_current", "assistant", now + 1, "running"],
    ] as const;
    for (const [id, session, role, created, status] of rows) {
      const part = { type: "tool", tool: "bash", state: { status, input: { command: "sleep 120" },
        metadata: { output: "x".repeat(id === "active" ? 2 * 1024 * 1024 : 0) } } };
      sql(db, `insert into part values(${literal(id)},${literal(session)},${literal(role)},${created},${literal(JSON.stringify(part))});`);
    }
    const delivered: string[] = [];
    const follower = new OpenCodeToolProgress({ OPENCODE_DATA_HOME: home }, (chunk) => delivered.push(chunk),
      (text) => assert.fail(text), now);
    follower.feed('{"type":"step_start","sessionID":');
    follower.poll();
    assert.equal(delivered.length, 0);
    follower.feed('"ses_current"}\n');
    follower.poll();
    follower.poll();
    assert.equal(delivered.length, 1);
    assert.deepEqual(JSON.parse(delivered[0]!), { type: "tool_use", sessionID: "ses_current",
      part: { id: "active", type: "tool", tool: "bash", state: { status: "running", input: { command: "sleep 120" } } } });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("running calls appear once in terminal and file while later failures remain visible", () => {
  const home = mkdtempSync(join(tmpdir(), "fork-opencode-dedup-"));
  try {
    const path = join(home, "progress.jsonl");
    const text: string[] = [];
    const renderer = new ProgressRenderer("opencode", (chunk) => text.push(chunk));
    const file = new ProgressFile(path, "opencode", (error) => assert.fail(error));
    for (const event of [tool("a", "pending"), tool("a", "running"), tool("a", "running"),
      tool("a", "completed"), tool("b", "running"), tool("b", "error"), tool("c", "completed")]) {
      const chunk = JSON.stringify(event) + "\n";
      renderer.feed(chunk);
      file.feed(chunk);
    }
    renderer.flush();
    file.flush();
    assert.equal(text.join("").match(/Bash\(sleep 120\)/g)?.length, 3);
    assert.match(text.join(""), /failed: command failed/);
    const events = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events.filter((event) => event.kind === "tool").length, 3);
    assert.deepEqual(events.filter((event) => event.kind === "tool_result").map(({ time: _, ...event }) => event),
      [{ kind: "tool_result", ok: false, detail: "command failed" }]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("a database error warns once without preventing native completion progress", { skip: !sqliteAvailable }, () => {
  const home = mkdtempSync(join(tmpdir(), "fork-opencode-bad-database-"));
  try {
    writeFileSync(join(home, "opencode.db"), "not a database");
    const warnings: string[] = [];
    const follower = new OpenCodeToolProgress({ OPENCODE_DATA_HOME: home }, () => assert.fail("unexpected tool"),
      (text) => warnings.push(text));
    follower.feed('{"sessionID":"ses_current"}\n');
    follower.poll();
    follower.poll();
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /could not observe running OpenCode tools/);
    const text: string[] = [];
    const renderer = new ProgressRenderer("opencode", (chunk) => text.push(chunk));
    renderer.feed(JSON.stringify(tool("finished", "completed")) + "\n");
    renderer.flush();
    assert.match(text.join(""), /Bash\(sleep 120\)/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

for (const raw of [false, true]) test(`CLI reports running tools before completion with raw stdout ${raw}`, { skip: !sqliteAvailable }, async () => {
  const home = mkdtempSync(join(tmpdir(), "fork-opencode-cli-running-"));
  const bin = join(home, "bin");
  mkdirSync(bin);
  const db = join(home, "opencode.db");
  const progress = join(home, "progress.jsonl");
  const release = join(home, "release");
  sql(db, schema);
  writeFileSync(join(bin, "opencode"), `#!${process.execPath}
const { existsSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const part = ${JSON.stringify({ ...tool("active", "running").part, type: "tool" })};
const insert = "insert into message values('assistant', '{\\\"role\\\":\\\"assistant\\\"}'); " +
  "insert into part values('active','ses_current','assistant'," + Date.now() + ", '" + JSON.stringify(part).replaceAll("'", "''") + "');";
const result = spawnSync('sqlite3', [${JSON.stringify(db)}], { input: insert, encoding: 'utf8' });
if (result.status !== 0) throw new Error(result.stderr);
console.log(JSON.stringify({type:'step_start', sessionID:'ses_current'}));
const timer = setInterval(() => {
  if (!existsSync(${JSON.stringify(release)})) return;
  clearInterval(timer);
  console.log(JSON.stringify(${JSON.stringify(tool("active", "completed"))}));
  console.log(JSON.stringify({type:'text', sessionID:'ses_current', part:{text:'done'}}));
}, 20);
`, { mode: 0o755 });
  const stdout: string[] = [];
  const stderr: string[] = [];
  const running = runCli(["opencode", "--prompt", "test", ...(raw ? ["--json"] : ["--progress"]), "--progress-file", progress,
    "--timeout", "20", "--work-dir", home], {
    env: { ...process.env, HOME: home, OPENCODE_DATA_HOME: home, PATH: `${bin}:${process.env.PATH}` },
    stdout: (chunk) => { stdout.push(chunk); }, stderr: (chunk) => { stderr.push(chunk); },
  });
  try {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && (!existsSync(progress) || !readFileSync(progress, "utf8").includes('"kind":"tool"'))) {
      await new Promise((done) => setTimeout(done, 20));
    }
    const activeEvents = readFileSync(progress, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(activeEvents.some((event) => event.kind === "tool" && event.summary === "sleep 120"));
    assert.ok(!activeEvents.some((event) => event.kind === "end"));
    if (!raw) assert.match(stderr.join(""), /Bash\(sleep 120\)/);
    assert.doesNotMatch(stdout.join(""), /tool_use/);
  } finally {
    writeFileSync(release, "");
    const code = await running;
    try {
      assert.equal(code, 0, stderr.join(""));
      const events = readFileSync(progress, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(events.filter((event) => event.kind === "tool").length, 1);
      assert.equal(events.at(-1).kind, "end");
      if (raw) assert.equal(stdout.join("").match(/tool_use/g)?.length, 1);
      else assert.equal(stdout.join("").trim(), "done");
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
});
