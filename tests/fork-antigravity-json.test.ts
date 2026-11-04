import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.ts";
import { extractAgentError, extractFinalMessage, extractNativeSessionId } from "../src/output.ts";
import { renderTraceEvent, traceEvents } from "../src/trace-events.ts";

const answer = { status: "done", summary: "native structured reply" };
const schema = JSON.stringify({ type: "object", properties: { status: { type: "string" }, summary: { type: "string" } }, required: ["status", "summary"] });
const init = { event: "init", conversation_id: "native-json-session", init: { cwd: "/workspace" } };
const tool = (state: string) => ({ event: "step_update", step_update: {
  step_index: 2, step_type: "tool", state, tool_name: "run_command",
  tool_info: { name: "run_command", parameters: { CommandLine: "pwd" }, output: "/workspace" },
} });
const result = (extra = {}) => ({ event: "result", result: {
  conversation_id: "native-json-session", status: "SUCCESS", response: "untrusted prose",
  structured_output: answer, ...extra,
} });
const stream = (...rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";

test("native results prefer structured_output and never expose envelopes or intermediate deltas", () => {
  const trace = stream(init, { event: "step_update", step_update: { step_type: "agent_response", text_delta: "partial" } }, result());
  assert.deepEqual(JSON.parse(extractFinalMessage("antigravity", trace)), answer);
  assert.equal(extractNativeSessionId("antigravity", trace), "native-json-session");
  assert.equal(extractFinalMessage("antigravity", stream(init)), "");
  assert.match(extractAgentError("antigravity", stream(init)), /without a result/);
  assert.equal(extractFinalMessage("antigravity", JSON.stringify(result({ structured_output: null }))), "null");
  assert.equal(extractFinalMessage("antigravity", stream({ event: "result", result: { status: "SUCCESS", response: "plain reply" } })), "plain reply");
});

test("failed and cut-off results cannot be accepted as completed structured answers", () => {
  for (const extra of [{ status: "ERROR", error: "model failed" }, { finished_reason: "print_timeout" }, { finished_reason: "interrupted" }]) {
    const trace = stream(init, result(extra));
    assert.equal(extractFinalMessage("antigravity", trace), "");
    assert.match(extractAgentError("antigravity", trace), /antigravity error:/);
  }
});

test("native tool starts, failures and the final reply normalize without repeating completed tools", () => {
  assert.deepEqual(traceEvents("antigravity", tool("ACTIVE")), [{ kind: "tool", name: "Bash", summary: "pwd" }]);
  assert.deepEqual(traceEvents("antigravity", tool("DONE")), []);
  assert.equal(traceEvents("antigravity", tool("ERROR"))[0]?.kind, "tool_result");
  assert.deepEqual(traceEvents("antigravity", result()), [{ kind: "message", text: JSON.stringify(answer) }]);
});

test("native read_file Path and view_file AbsolutePath both show the file as a read", () => {
  for (const [name, parameters] of [
    ["read_file", { Path: "/workspace/src/file.ts" }],
    ["view_file", { AbsolutePath: "/workspace/src/file.ts" }],
  ] as const) {
    const events = traceEvents("antigravity", { event: "step_update", step_update: {
      step_type: "tool", state: "ACTIVE", tool_name: name, tool_info: { parameters },
    } });
    assert.deepEqual(events, [{ kind: "tool", name: "Read", summary: "/workspace/src/file.ts" }]);
    assert.equal(renderTraceEvent(events[0]!, "/workspace"), "📖 Read(src/file.ts)\n");
  }
});

test("native and legacy file writes and edits retain the complete affected path", () => {
  const relative = `${"nested/".repeat(30)}file.ts`;
  const path = `/workspace/${relative}`;
  for (const [toolName, field, name] of [
    ["write_file", "Path", "Write"], ["edit_file", "Path", "Edit"],
    ["write_to_file", "TargetFile", "Write"],
    ["replace_file_content", "TargetFile", "Edit"],
    ["multi_replace_file_content", "TargetFile", "Edit"],
  ] as const) {
    const events = traceEvents("antigravity", { event: "step_update", step_update: {
      step_type: "tool", state: "ACTIVE", tool_name: toolName,
      tool_info: { parameters: { [field]: path } },
    } });
    assert.deepEqual(events, [{ kind: "tool", name, summary: path, paths: [path] }]);
    assert.equal(renderTraceEvent(events[0]!, "/workspace"), `📝 ${name}(${relative})\n`);
  }
});

async function invoke(rows: unknown[], flags: string[] = [], thoughts?: string) {
  const root = mkdtempSync(join(tmpdir(), "headless-agy-json-"));
  try {
    const binary = join(root, "agy");
    const progress = join(root, "progress.jsonl");
    const agyHome = join(root, "agy-home");
    if (thoughts) {
      const logs = join(agyHome, "brain", "native-json-session", ".system_generated", "logs");
      mkdirSync(logs, { recursive: true });
      writeFileSync(join(logs, "transcript.jsonl"), thoughts);
    }
    writeFileSync(binary, `#!${process.execPath}
const args = process.argv.slice(2);
if (args[args.indexOf('--output-format') + 1] !== 'stream-json' || !args.includes('--json-schema')) process.exit(42);
const output = ${JSON.stringify(stream(...rows))};
process.stdout.write(output.slice(0, 17));
setImmediate(() => process.stdout.write(output.slice(17)));
`);
    chmodSync(binary, 0o755);
    const out: string[] = [], err: string[] = [];
    const code = await runCli(["antigravity", "--prompt", "do the work", "--allow", "project", "--json-schema", schema,
      ...(!flags.includes("--json") && !flags.includes("--sdk-format") ? ["--progress"] : []),
      "--progress-file", progress, ...flags], {
      env: { ...process.env, HOME: root, ANTIGRAVITY_HOME: agyHome, ANTIGRAVITY_CLI_BIN: binary },
      stdout: (chunk) => { out.push(chunk); }, stderr: (chunk) => { err.push(chunk); },
    });
    const events = readFileSync(progress, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const sessions = flags.includes("--session") ? JSON.parse(readFileSync(join(root, ".headless", "sessions.json"), "utf8")) : undefined;
    return { code, stdout: out.join(""), stderr: err.join(""), events, sessions };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("real CLI execution unwraps JSON and streams progress without transcript discovery", async () => {
  const run = await invoke([init, tool("ACTIVE"), tool("DONE"), result()], ["--session", "probe", "--checkpoint-session"]);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), answer);
  assert.match(run.stderr, /Bash\(pwd\)/);
  assert.equal(run.events.filter((event) => event.kind === "tool").length, 1);
  assert.equal(run.events.at(-1).exitCode, 0);
  assert.match(JSON.stringify(run.sessions), /native-json-session/);
});

test("SDK output retains raw envelopes, normalized progress and native identity", async () => {
  const run = await invoke([init, tool("ACTIVE"), tool("DONE"), result()], ["--sdk-format", "ndjson"]);
  assert.equal(run.code, 0, run.stderr);
  const rows = run.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(rows.some((row) => row.type === "trace" && row.data.value?.event === "result"));
  assert.equal(rows.at(-1).data.nativeSessionId, "native-json-session");
  assert.deepEqual(JSON.parse(rows.at(-1).data.finalMessage), answer);
});

test("local progress supplements thoughts without replaying transcript tools or replacing the native answer", async () => {
  const transcript = stream({ source: "MODEL", type: "PLANNER_RESPONSE",
    thinking: "Check the schema before replying.", content: "not the authoritative reply",
    tool_calls: [{ name: "run_command", args: { CommandLine: JSON.stringify("transcript-only") } }],
  });
  const run = await invoke([init, tool("ACTIVE"), tool("DONE"), result()], [], transcript);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), answer);
  assert.match(run.stderr, /💭 Check the schema before replying\./);
  assert.match(run.stderr, /💬 \{"status":"done"/);
  assert.doesNotMatch(run.stderr, /transcript-only|not the authoritative reply/);
  assert.equal(run.events.filter((event) => event.kind === "thinking").length, 1);
  assert.equal(run.events.filter((event) => event.kind === "tool").length, 1);
  assert.equal(run.events.filter((event) => event.kind === "message").length, 1);
});

test("zero process exit with a timeout result fails in normal, raw and SDK modes", async () => {
  for (const flags of [[], ["--json"], ["--sdk-format", "json"]]) {
    const run = await invoke([init, result({ finished_reason: "print_timeout" })], flags);
    assert.equal(run.code, 1);
    assert.equal(run.events.at(-1).exitCode, 1);
    if (!flags.length) assert.equal(run.stdout, "");
  }
});
