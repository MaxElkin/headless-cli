import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { SessionCheckpoint } from "../src/fork/session-checkpoint.ts";
import { readStoredSession } from "../src/sessions.ts";

test("a split trace checkpoints the native session before the invocation finishes", () => {
  const home = mkdtempSync(join(tmpdir(), "headless-checkpoint-"));
  try {
    const checkpoint = new SessionCheckpoint("opencode", { alias: "aqa-subagent", mode: "new" },
      { HOME: home }, home, (text) => { throw new Error(text); });
    checkpoint.feed('{"type":"step_start","session');
    assert.equal(readStoredSession({ HOME: home }, "opencode", "aqa-subagent"), undefined);
    checkpoint.feed('ID":"ses_worker"}\n');
    assert.equal(readStoredSession({ HOME: home }, "opencode", "aqa-subagent")?.nativeId, "ses_worker");
    checkpoint.feed('{"sessionID":"ses_other"}\n');
    assert.equal(readStoredSession({ HOME: home }, "opencode", "aqa-subagent")?.nativeId, "ses_worker");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("cancelling a new one-shot run still lets a followup resume its native conversation", async () => {
  const home = mkdtempSync(join(tmpdir(), "headless-checkpoint-cli-"));
  const bin = join(home, "bin");
  mkdirSync(bin);
  const log = join(home, "calls.jsonl");
  const executable = join(bin, "opencode");
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('1.18.33'); process.exit(0); }
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
console.log(JSON.stringify({type:'step_start', sessionID:'ses_worker'}));
if (args.includes('FIRST')) setInterval(() => {}, 1000);
else console.log(JSON.stringify({type:'text',sessionID:'ses_worker',part:{type:'text',text:'corrected'}}));
`);
  chmodSync(executable, 0o755);
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` };
  const argv = [resolve("dist/cli.js"), "opencode", "--session", "aqa-subagent", "--checkpoint-session", "--allow", "project", "--prompt"];
  const first = spawn(process.execPath, [...argv, "FIRST"], { env, detached: true, stdio: "ignore" });
  const exited = once(first, "exit");
  try {
    const deadline = Date.now() + 10_000;
    while (!readStoredSession(env, "opencode", "aqa-subagent")?.nativeId && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 20));
    }
    assert.equal(readStoredSession(env, "opencode", "aqa-subagent")?.nativeId, "ses_worker");
    process.kill(-first.pid!, "SIGTERM");
    await exited;
    const followup = spawn(process.execPath, [...argv, "FOLLOWUP"], { env, stdio: "ignore" });
    const [code] = await once(followup, "exit");
    assert.equal(code, 0);
    const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    assert.equal(calls.length, 2);
    assert.equal(calls[1][calls[1].indexOf("--session") + 1], "ses_worker");
  } finally {
    if (first.exitCode === null && first.signalCode === null) {
      try { process.kill(-first.pid!, "SIGKILL"); } catch { /* already gone */ }
      await exited;
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test("concurrent named runs keep every alias in their shared session store", async () => {
  const home = mkdtempSync(join(tmpdir(), "headless-session-writers-"));
  try {
    const module = new URL("../src/sessions.ts", import.meta.url).href;
    const children = Array.from({ length: 6 }, (_, number) => spawn(process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", `
        import { writeStoredSession } from ${JSON.stringify(module)};
        for (let i = 0; i < 12; i++) writeStoredSession({HOME:${JSON.stringify(home)}},
          {agent:'opencode', alias:'worker-${number}', nativeId:'ses-${number}'});
      `], { stdio: "ignore" }));
    const exits = await Promise.all(children.map((child) => once(child, "exit")));
    for (const [code] of exits) assert.equal(code, 0);
    for (let number = 0; number < children.length; number++) {
      assert.equal(readStoredSession({ HOME: home }, "opencode", `worker-${number}`)?.nativeId, `ses-${number}`);
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});
