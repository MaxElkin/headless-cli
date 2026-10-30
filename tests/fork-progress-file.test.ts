import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.ts";
import { ProgressFile } from "../src/fork/progress-file.ts";

type Json = Record<string, any>;

const patch = "*** Begin Patch\n*** Update File: /work/a, b.kt\n*** Add File: /work/docs/guide.md\n*** End Patch";

const records: Json[] = [
  { type: "tool_use", part: { tool: "apply_patch", state: { status: "completed", input: { patchText: patch } } } },
  { type: "tool_use", part: { tool: "bash", state: { status: "error", input: { command: `echo ${"x".repeat(300)}` },
    error: "exit 1" } } },
  { type: "text", part: { text: "Done." } },
];

function lines(path: string): Json[] {
  return readFileSync(path, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line) as Json);
}

function fixture(exitCode = 0) {
  const home = mkdtempSync(join(tmpdir(), "fork-progress-file-"));
  writeFileSync(join(home, "opencode"), `#!${process.execPath}\n` +
    `for (const record of ${JSON.stringify(records)}) console.log(JSON.stringify(record));\n` +
    `process.exitCode = ${exitCode};\n`, { mode: 0o755 });
  const env = { HOME: home, PATH: `${home}:${process.env.PATH}`, HEADLESS_MODELS_DEV_CACHE: "" };
  return {
    file: join(home, "agent", "step.jsonl"),
    async run(flags: string[]) {
      const errors: string[] = [];
      const code = await runCli(["opencode", "--prompt", "hi", "--work-dir", home, ...flags], {
        env, stdout: () => undefined, stderr: (text) => errors.push(text),
      });
      return { code, stderr: errors.join("") };
    },
    cleanup() { rmSync(home, { recursive: true, force: true }); },
  };
}

test("every event goes to the file, timed and uncut, between a start and an end", async () => {
  const run = fixture();
  try {
    const { code } = await run.run(["--progress-file", run.file]);
    assert.equal(code, 0);
    const written = lines(run.file);
    for (const line of written) assert.match(line.time, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    const events = written.map(({ time: _time, ...event }) => event);
    assert.equal(events[0]!.kind, "start");
    assert.equal(events[0]!.agent, "opencode");
    assert.equal(typeof events[0]!.workDir, "string");
    assert.deepEqual(events.slice(1), [
      { kind: "tool", name: "Edit", summary: "/work/a, b.kt, /work/docs/guide.md",
        paths: ["/work/a, b.kt", "/work/docs/guide.md"] },
      { kind: "tool", name: "Bash", summary: `echo ${"x".repeat(300)}` },
      { kind: "tool_result", ok: false, detail: "exit 1" },
      { kind: "message", text: "Done." },
      { kind: "end", exitCode: 0 },
    ]);
  } finally {
    run.cleanup();
  }
});

test("a second run appends, and the end says how the harness exited", async () => {
  const run = fixture(3);
  try {
    await run.run(["--progress-file", run.file, "--session", "aqa"]);
    await run.run(["--progress-file", run.file]);
    const kinds = lines(run.file).filter((line) => line.kind === "start" || line.kind === "end");
    assert.deepEqual(kinds.map((line) => [line.kind, line.session ?? line.exitCode ?? null]),
      [["start", "aqa"], ["end", 3], ["start", null], ["end", 3]]);
  } finally {
    run.cleanup();
  }
});

test("--progress-file is refused with --tmux", async () => {
  const run = fixture();
  try {
    const { code, stderr } = await run.run(["--progress-file", run.file, "--tmux"]);
    assert.notEqual(code, 0);
    assert.match(stderr, /--progress-file cannot be used with --tmux/);
  } finally {
    run.cleanup();
  }
});

test("a file that cannot be written is reported once and costs nothing else", () => {
  const home = mkdtempSync(join(tmpdir(), "fork-progress-file-"));
  try {
    writeFileSync(join(home, "taken"), "");
    const reported: string[] = [];
    const file = new ProgressFile(join(home, "taken", "step.jsonl"), "opencode", (text) => reported.push(text));
    file.start({ workDir: home });
    file.feed(`${JSON.stringify(records[2])}\n`);
    file.end(0);
    assert.equal(reported.length, 1);
    assert.match(reported[0]!, /could not write --progress-file/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a record split across chunks is written once it is whole", () => {
  const home = mkdtempSync(join(tmpdir(), "fork-progress-file-"));
  try {
    const path = join(home, "step.jsonl");
    const file = new ProgressFile(path, "opencode", () => undefined, () => new Date(0));
    const record = JSON.stringify(records[2]);
    file.feed(record.slice(0, 10));
    assert.throws(() => readFileSync(path));
    file.feed(`${record.slice(10)}\n`);
    assert.deepEqual(lines(path), [{ time: "1970-01-01T00:00:00.000Z", kind: "message", text: "Done." }]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
