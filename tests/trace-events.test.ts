import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { appendFile, chmod, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.ts";
import { ProgressRenderer, renderTraceEvent, TranscriptFollower, traceEvents, unwrapShellCommand } from "../src/trace-events.ts";

// The records below keep the shapes of real `claude -p --output-format
// stream-json --verbose` and `codex exec --json` traces, trimmed to the fields
// that matter.

const claudeThinking = {
  type: "assistant",
  message: { role: "assistant", content: [{ type: "thinking", thinking: "The user wants me to read a file." }] },
};
const claudeRead = {
  type: "assistant",
  message: {
    role: "assistant",
    content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/work/package.json" } }],
  },
};
const claudeBash = {
  type: "assistant",
  message: {
    role: "assistant",
    content: [{ type: "tool_use", id: "toolu_2", name: "Bash", input: { command: "npm test", description: "Run tests" } }],
  },
};
const claudeToolOk = {
  type: "user",
  message: { role: "user", content: [{ tool_use_id: "toolu_1", type: "tool_result", content: "1\t{\n2\t  \"name\": \"x\"" }] },
};
const claudeToolFailed = {
  type: "user",
  message: {
    role: "user",
    content: [{ tool_use_id: "toolu_2", type: "tool_result", is_error: true, content: "Exit code 1\nnpm ERR! missing script" }],
  },
};
const claudeText = {
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text: "The `name` field is `x`." }] },
};
const claudeNoise = [
  { type: "system", subtype: "init", cwd: "/work", tools: ["Bash", "Read"] },
  { type: "rate_limit_event", rate_limit_info: { status: "allowed" } },
  { type: "system", subtype: "post_turn_summary", status_detail: "read package.json" },
  { type: "result", subtype: "success", result: "The `name` field is `x`." },
];

const codexStarted = {
  type: "item.started",
  item: { id: "item_0", type: "command_execution", command: "/bin/zsh -lc \"sed -n '1,9p' /work/a.md\"", status: "in_progress" },
};
const codexCompletedOk = {
  type: "item.completed",
  item: { id: "item_0", type: "command_execution", command: "/bin/zsh -lc \"sed -n '1,9p' /work/a.md\"", aggregated_output: "# A\n", exit_code: 0 },
};
const codexCompletedFailed = {
  type: "item.completed",
  item: { id: "item_1", type: "command_execution", command: "/bin/zsh -lc 'false'", aggregated_output: "boom\nmore", exit_code: 1 },
};
const codexMessage = { type: "item.completed", item: { id: "item_2", type: "agent_message", text: "Reading the onboarding first." } };
const codexFileChange = {
  type: "item.completed",
  item: { id: "item_3", type: "file_change", changes: [{ path: "/work/a.md", kind: "update" }, { path: "/work/b.md", kind: "add" }] },
};
const codexNoise = [
  { type: "thread.started", thread_id: "t" },
  { type: "turn.started" },
  { type: "turn.completed", usage: { input_tokens: 1 } },
];

test("Claude records become a message, tool calls, failed results, and visible thinking", () => {
  assert.deepEqual(traceEvents("claude", claudeRead), [{ kind: "tool", name: "Read", summary: "/work/package.json" }]);
  // The command is what a Bash call is about, not its description.
  assert.deepEqual(traceEvents("claude", claudeBash), [{ kind: "tool", name: "Bash", summary: "npm test" }]);
  assert.deepEqual(traceEvents("claude", claudeText), [{ kind: "message", text: "The `name` field is `x`." }]);
  assert.deepEqual(traceEvents("claude", claudeToolFailed), [{ kind: "tool_result", ok: false, detail: "Exit code 1" }]);
  assert.deepEqual(traceEvents("claude", claudeThinking), [{ kind: "thinking", text: "The user wants me to read a file." }]);
  assert.equal(renderTraceEvent(traceEvents("claude", claudeThinking)[0]!), "\n💭 The user wants me to read a file.\n\n");
  // A result that did not fail is not worth a line: the call already had one.
  assert.deepEqual(traceEvents("claude", claudeToolOk), []);
  for (const record of claudeNoise) assert.deepEqual(traceEvents("claude", record), [], JSON.stringify(record));
});

test("Codex items are told when a command starts, and again only if it failed", () => {
  assert.deepEqual(traceEvents("codex", codexStarted), [{ kind: "tool", name: "Bash", summary: "sed -n '1,9p' /work/a.md" }]);
  assert.deepEqual(traceEvents("codex", codexCompletedOk), []);
  assert.deepEqual(traceEvents("codex", codexCompletedFailed), [{ kind: "tool_result", ok: false, detail: "exit 1: boom" }]);
  assert.deepEqual(traceEvents("codex", codexMessage), [{ kind: "message", text: "Reading the onboarding first." }]);
  assert.deepEqual(traceEvents("codex", codexFileChange), [{ kind: "tool", name: "Edit", summary: "/work/a.md, /work/b.md" }]);
  assert.deepEqual(traceEvents("codex", { type: "turn.failed", error: { message: "quota" } }), [{ kind: "error", text: "quota" }]);
  for (const record of codexNoise) assert.deepEqual(traceEvents("codex", record), [], JSON.stringify(record));
});

// Antigravity's transcript, where every tool argument is itself JSON text.
const agyInput = { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", content: "<USER_REQUEST>\nRead a.md" };
const agyCalls = {
  step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", thinking: "Reading it.",
  tool_calls: [
    { name: "view_file", args: { AbsolutePath: "\"/work/a.md\"", toolSummary: "\"Read a\"" } },
    { name: "run_command", args: { CommandLine: "\"ls \\\"x y\\\"\"", Cwd: "\"/work\"" } },
    { name: "something_new", args: { toolSummary: "\"Did a thing\"" } },
  ],
};
const agyResult = { step_index: 2, source: "MODEL", type: "GENERIC", status: "DONE", content: "# A" };
const agyFailed = { step_index: 3, source: "MODEL", type: "GENERIC", status: "ERROR", content: "", error: "permission denied\nmore" };
const agyReply = { step_index: 4, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: "It says A." };

test("Antigravity transcript records become tool calls, failures and the reply", () => {
  assert.deepEqual(traceEvents("antigravity", agyInput), []);
  assert.deepEqual(traceEvents("antigravity", agyCalls), [
    { kind: "thinking", text: "Reading it." },
    { kind: "tool", name: "Read", summary: "/work/a.md" },
    { kind: "tool", name: "Bash", summary: "ls \"x y\"" },
    { kind: "tool", name: "something_new", summary: "Did a thing" },
  ]);
  assert.deepEqual(traceEvents("antigravity", agyResult), []);
  assert.deepEqual(traceEvents("antigravity", agyFailed), [{ kind: "tool_result", ok: false, detail: "permission denied" }]);
  assert.deepEqual(traceEvents("antigravity", agyReply), [{ kind: "message", text: "It says A." }]);
});

// `opencode run --format json` parts, trimmed the same way.
const ocStep = { type: "step_start", part: { type: "step-start" } };
const ocBash = {
  type: "tool_use",
  part: { type: "tool", tool: "bash", state: { status: "completed", input: { command: "ls", workdir: "/work" }, output: "a.md\n" } },
};
const ocRead = {
  type: "tool_use",
  part: { type: "tool", tool: "read", state: { status: "error", input: { filePath: "/work/b.md" }, error: "File not found: /work/b.md" } },
};
const ocPatch = {
  type: "tool_use",
  part: {
    type: "tool",
    tool: "apply_patch",
    state: { status: "completed", input: { patchText: "*** Begin Patch\n*** Update File: /work/a.md\n@@\n-A\n+B\n*** Add File: /work/c.md\n+C\n*** End Patch" } },
  },
};
const ocNew = { type: "tool_use", part: { type: "tool", tool: "something_new", state: { status: "completed", input: { description: "Did a thing" } } } };
const ocThinking = { type: "reasoning", part: { type: "reasoning", text: "Reading it." } };
const ocText = { type: "text", part: { type: "text", text: "It says A." } };
const ocError = { type: "error", error: { name: "APIError", data: { message: "rate limited" } } };

test("OpenCode parts become tool calls, failures, thinking, the reply and errors", () => {
  assert.deepEqual(traceEvents("opencode", ocStep), []);
  assert.deepEqual(traceEvents("opencode", ocBash), [{ kind: "tool", name: "Bash", summary: "ls" }]);
  assert.deepEqual(traceEvents("opencode", ocRead), [
    { kind: "tool", name: "Read", summary: "/work/b.md" },
    { kind: "tool_result", ok: false, detail: "File not found: /work/b.md" },
  ]);
  assert.deepEqual(traceEvents("opencode", ocPatch), [{ kind: "tool", name: "Edit", summary: "/work/a.md, /work/c.md" }]);
  assert.deepEqual(traceEvents("opencode", ocNew), [{ kind: "tool", name: "something_new", summary: "Did a thing" }]);
  assert.deepEqual(traceEvents("opencode", ocThinking), [{ kind: "thinking", text: "Reading it." }]);
  assert.deepEqual(traceEvents("opencode", ocText), [{ kind: "message", text: "It says A." }]);
  assert.deepEqual(traceEvents("opencode", ocError), [{ kind: "error", text: "rate limited" }]);
});

test("A transcript is followed from when it appears, as it grows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-follow-test-"));
  try {
    const path = join(dir, "transcript.jsonl");
    const out: string[] = [];
    let found: string | undefined;
    const follower = new TranscriptFollower(() => found, new ProgressRenderer("antigravity", (text) => out.push(text), "/work"));
    follower.poll();
    await writeFile(path, `${JSON.stringify(agyInput)}\n`);
    found = path;
    const line = `${JSON.stringify(agyCalls)}\n`;
    await appendFile(path, line.slice(0, 30));
    follower.poll();
    assert.deepEqual(out, []);
    await appendFile(path, line.slice(30));
    follower.poll();
    assert.deepEqual(out, ["\n💭 Reading it.\n\n", "📖 Read(a.md)\n", "🔧 Bash(ls \"x y\")\n", "🔧 something_new(Did a thing)\n"]);
    await appendFile(path, `${JSON.stringify(agyReply)}\n`);
    follower.stop();
    assert.equal(out.at(-1), "\n💬 It says A.\n\n");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("A harness with no known trace, or a record of another harness, yields nothing", () => {
  assert.deepEqual(traceEvents("gemini", claudeText), []);
  assert.deepEqual(traceEvents("antigravity", claudeText), []);
  assert.deepEqual(traceEvents("claude", codexMessage), []);
  assert.deepEqual(traceEvents("codex", "plain text"), []);
  assert.deepEqual(traceEvents("opencode", claudeText), []);
});

test("Codex's login-shell wrapper is taken off the command", () => {
  assert.equal(unwrapShellCommand("/bin/zsh -lc \"sed -n '1,220p' a.md\""), "sed -n '1,220p' a.md");
  assert.equal(unwrapShellCommand("/bin/bash -lc 'ls -la'"), "ls -la");
  assert.equal(unwrapShellCommand(`/bin/zsh -lc "node -p \\"require('./p.json').name\\""`), `node -p "require('./p.json').name"`);
  assert.equal(unwrapShellCommand("git status"), "git status");
});

test("A message followed by more work is a thought, and thoughts share their blank lines", () => {
  const out: string[] = [];
  const renderer = new ProgressRenderer("codex", (text) => out.push(text));
  const item = (id: string, type: string, text: string) =>
    `${JSON.stringify({ type: "item.completed", item: { id, type, text } })}\n`;
  renderer.feed(item("1", "reasoning", "**Inspecting UI and tests**\n**Checking transition API usage**"));
  renderer.feed(item("2", "reasoning", "**Inspecting UI and tests**\n**Inspecting UI and model**"));
  renderer.feed(item("3", "agent_message", "SA found one remaining gap."));
  renderer.feed(item("4", "agent_message", "Done."));
  renderer.flush();
  assert.equal(out.join(""), [
    "",
    "💭 Inspecting UI and tests",
    "   Checking transition API usage",
    "",
    // The part already shown is not shown again.
    "💭 Inspecting UI and model",
    "",
    "💭 SA found one remaining gap.",
    "",
    "💬 Done.",
    "",
    "",
  ].join("\n"));
});

test("Events render as one line per call and the message whole, paths made relative", () => {
  const work = "/work";
  assert.equal(renderTraceEvent({ kind: "tool", name: "Read", summary: "/work/package.json" }, work), "📖 Read(package.json)\n");
  assert.equal(renderTraceEvent({ kind: "tool", name: "mcp.x", summary: "" }), "🔧 mcp.x\n");
  assert.equal(renderTraceEvent({ kind: "tool", name: "Write", summary: "a.md" }), "📝 Write(a.md)\n");
  assert.equal(renderTraceEvent({ kind: "tool_result", ok: false, detail: "exit 1: boom" }), "  ⎿ failed: exit 1: boom\n");
  assert.equal(renderTraceEvent({ kind: "message", text: "One.\n\nTwo." }), "\n💬 One.\n\n   Two.\n\n");
  assert.equal(renderTraceEvent({ kind: "thinking", text: "One.\n\nTwo." }), "\n💭 One.\n\n   Two.\n\n");
  assert.equal(renderTraceEvent({ kind: "thinking", text: "**Checking the tests**" }), "\n💭 Checking the tests\n\n");
  assert.equal(renderTraceEvent({ kind: "error", text: "quota" }), "✗ quota\n");
  const long = renderTraceEvent({ kind: "tool", name: "Grep", summary: "x".repeat(400) })!;
  assert.ok(long.length < 200 && long.includes("…"), long);
  assert.equal(renderTraceEvent({ kind: "tool", name: "Grep", summary: "a\nb" }), "📖 Grep(a …)\n");
  // A command is never cut, however long, and keeps its lines.
  const command = `cat /work/${"x".repeat(400)}.md`;
  assert.equal(renderTraceEvent({ kind: "tool", name: "Bash", summary: command }, work), `🔧 Bash(cat ${"x".repeat(400)}.md)\n`);
  assert.equal(renderTraceEvent({ kind: "tool", name: "Bash", summary: "a &&\nb" }), "🔧 Bash(a &&\n  b)\n");
});

test("The renderer waits for a record split across chunks, and leaves lines that are not JSON alone", () => {
  const out: string[] = [];
  const renderer = new ProgressRenderer("claude", (text) => out.push(text), "/work");
  const line = `${JSON.stringify(claudeRead)}\n`;
  renderer.feed(line.slice(0, 20));
  assert.deepEqual(out, []);
  renderer.feed(line.slice(20));
  renderer.feed("not json at all\n");
  renderer.feed(JSON.stringify(claudeText));
  assert.deepEqual(out, ["📖 Read(package.json)\n"]);
  renderer.flush();
  assert.deepEqual(out, ["📖 Read(package.json)\n", "\n💬 The `name` field is `x`.\n\n"]);
});

async function fakeAgent(dir: string, name: string, records: unknown[]): Promise<string> {
  const binDir = join(dir, "bin");
  await mkdir(binDir, { recursive: true });
  const binary = join(binDir, name);
  const trace = records.map((record) => `${JSON.stringify(record)}\n`).join("");
  await writeFile(binary, ["#!/usr/bin/env node", `process.stdout.write(${JSON.stringify(trace)});`, ""].join("\n"));
  await chmod(binary, 0o755);
  return binDir;
}

test("CLI --progress shows the run on stderr and leaves stdout the final message alone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-progress-test-"));
  try {
    const binDir = await fakeAgent(dir, "codex", [codexNoise[0],
      { type: "item.completed", item: { id: "item_thinking", type: "reasoning", text: "Checking the repository." } },
      codexStarted, codexCompletedOk, codexMessage,
      { type: "item.completed", item: { id: "item_9", type: "agent_message", text: "Done." } }, codexNoise[2]]);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runCli(["codex", "--prompt", "hello", "--progress"], {
      env: { ...process.env, HOME: join(dir, "home"), PATH: `${binDir}:${process.env.PATH ?? ""}` },
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
      stderrIsTTY: true,
    });

    assert.equal(code, 0, stderr.join(""));
    assert.equal(stdout.join(""), "Done.\n");
    const shown = stderr.join("");
    assert.match(shown, /🔧 Bash\(sed -n '1,9p' \/work\/a\.md\)\n/);
    assert.match(shown, /\n💭 Checking the repository\.\n\n/);
    // A message with more work after it is what the agent is about to do, a
    // thought; the last one is the reply.
    assert.match(shown, /\n💭 Reading the onboarding first\.\n\n💬 Done\.\n\n$/);
    // No spinner: it would redraw over the lines progress writes.
    assert.doesNotMatch(shown, /\u001b\[|⠋/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI ndjson trace envelopes carry the normalized events beside the native value", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-progress-test-"));
  try {
    const binDir = await fakeAgent(dir, "codex", [codexNoise[0], codexStarted, codexMessage]);
    const stdout: string[] = [];
    const code = await runCli(["codex", "--prompt", "hello", "--sdk-format", "ndjson"], {
      env: { ...process.env, HOME: join(dir, "home"), PATH: `${binDir}:${process.env.PATH ?? ""}` },
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 0);
    const traces = stdout.join("").trim().split("\n").map((line) => JSON.parse(line) as { type: string; data: Record<string, unknown> })
      .filter((envelope) => envelope.type === "trace");
    assert.equal(traces.length, 3);
    assert.equal(traces[0]!.data.events, undefined);
    assert.deepEqual(traces[1]!.data.events, [{ kind: "tool", name: "Bash", summary: "sed -n '1,9p' /work/a.md" }]);
    assert.deepEqual(traces[1]!.data.value, codexStarted);
    assert.deepEqual(traces[2]!.data.events, [{ kind: "message", text: "Reading the onboarding first." }]);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI rejects --progress with output modes that already show the run", async () => {
  for (const [flag, said] of [
    [["--json"], "--json"],
    [["--debug"], "--debug"],
    [["--sdk-format", "ndjson"], "--sdk-format"],
    [["--tmux"], "--tmux or --attach"],
  ] as const) {
    const stderr: string[] = [];
    const stdout: string[] = [];
    const code = await runCli(["codex", "--prompt", "hello", "--progress", ...flag], {
      stderr: (text) => stderr.push(text),
      stdout: (text) => stdout.push(text),
    });
    assert.equal(code, 2, flag.join(" "));
    assert.match(stderr.join("") + stdout.join(""), new RegExp(`--progress cannot be used with ${said.replace(/[-]/g, "\\-")}`));
  }
});
