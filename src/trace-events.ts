import { closeSync, openSync, readSync, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

import type { AgentName } from "./types.js";

/**
 * What an agent is doing, in one shape whichever harness it runs under.
 *
 * Each harness streams its own native events — Claude's stream-json, Codex's
 * `exec --json` items, OpenCode's `run --format json` parts — and the raw
 * trace is the only view of a run in progress. These are the parts of it worth showing a person: what the agent
 * says, which tools it calls and on what, the tool calls that failed, and its
 * errors. Anything a normaliser does not recognise yields nothing, so a new
 * native event type is quietly skipped rather than misread.
 */
export type TraceEvent =
  | { kind: "message"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; name: string; summary: string }
  | { kind: "tool_result"; ok: false; detail: string }
  | { kind: "error"; text: string };

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/, 1)[0] ?? "";
}

/** The input fields that say what a tool call is about, most telling first. */
const toolSubjectFields = [
  "command",
  "file_path",
  "notebook_path",
  "path",
  "pattern",
  "url",
  "query",
  "description",
  "prompt",
  "skill",
] as const;

function toolSubject(input: unknown): string {
  const record = asRecord(input);
  for (const field of toolSubjectFields) {
    const value = asString(record[field]);
    if (value.trim()) return value;
  }
  return "";
}

function claudeEvents(value: JsonRecord): TraceEvent[] {
  const type = asString(value.type);
  if (type !== "assistant" && type !== "user") return [];
  const content = asRecord(value.message).content;
  if (!Array.isArray(content)) return [];
  const events: TraceEvent[] = [];
  for (const block of content) {
    const record = asRecord(block);
    const blockType = asString(record.type);
    if (type === "assistant" && blockType === "text") {
      const text = asString(record.text);
      if (text.trim()) events.push({ kind: "message", text });
    } else if (type === "assistant" && blockType === "thinking") {
      const text = asString(record.thinking);
      if (text.trim()) events.push({ kind: "thinking", text });
    } else if (type === "assistant" && blockType === "tool_use") {
      events.push({ kind: "tool", name: asString(record.name) || "tool", summary: toolSubject(record.input) });
    } else if (type === "user" && blockType === "tool_result" && record.is_error === true) {
      const result = record.content;
      const detail = Array.isArray(result)
        ? result.map((part) => asString(asRecord(part).text)).join("\n")
        : asString(result);
      events.push({ kind: "tool_result", ok: false, detail: firstLine(detail) });
    }
  }
  return events;
}

/**
 * The command a Codex `command_execution` ran, without the login shell Codex
 * wraps every command in: `/bin/zsh -lc "sed -n '1,9p' f"` is `sed -n '1,9p' f`.
 */
export function unwrapShellCommand(command: string): string {
  const wrapped = /^\S*\/(?:ba|z)?sh\s+-l?c\s+([\s\S]*)$/.exec(command.trim());
  if (!wrapped) return command;
  const inner = wrapped[1]!.trim();
  const quote = inner[0];
  if ((quote === '"' || quote === "'") && inner.length >= 2 && inner.endsWith(quote)) {
    const body = inner.slice(1, -1);
    return quote === '"' ? body.replace(/\\(["\\$`])/g, "$1") : body;
  }
  return inner;
}

function codexItemEvents(phase: "started" | "completed", item: JsonRecord): TraceEvent[] {
  const type = asString(item.type);
  // A tool call is told when it starts, so a long one is seen while it runs,
  // and again only if it failed.
  if (type === "command_execution") {
    if (phase === "started") {
      return [{ kind: "tool", name: "Bash", summary: unwrapShellCommand(asString(item.command)) }];
    }
    const exitCode = item.exit_code;
    if (typeof exitCode === "number" && exitCode !== 0) {
      const output = firstLine(asString(item.aggregated_output));
      return [{ kind: "tool_result", ok: false, detail: `exit ${exitCode}${output ? `: ${output}` : ""}` }];
    }
    return [];
  }
  if (type === "file_change") {
    if (phase !== "completed") return [];
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const paths = changes.map((change) => asString(asRecord(change).path)).filter(Boolean);
    return [{ kind: "tool", name: "Edit", summary: paths.join(", ") }];
  }
  if (type === "mcp_tool_call") {
    if (phase !== "started") return [];
    const server = asString(item.server);
    const tool = asString(item.tool);
    return [{ kind: "tool", name: server ? `${server}.${tool}` : tool || "mcp", summary: "" }];
  }
  if (type === "web_search") {
    if (phase !== "started") return [];
    return [{ kind: "tool", name: "WebSearch", summary: asString(item.query) }];
  }
  if (phase !== "completed") return [];
  if (type === "agent_message") {
    const text = asString(item.text);
    return text.trim() ? [{ kind: "message", text }] : [];
  }
  if (type === "reasoning") {
    const text = asString(item.text);
    return text.trim() ? [{ kind: "thinking", text }] : [];
  }
  if (type === "error") {
    const text = asString(item.message);
    return text.trim() ? [{ kind: "error", text }] : [];
  }
  return [];
}

function codexEvents(value: JsonRecord): TraceEvent[] {
  const type = asString(value.type);
  if (type === "item.started" || type === "item.completed") {
    return codexItemEvents(type === "item.started" ? "started" : "completed", asRecord(value.item));
  }
  if (type === "error") {
    const text = asString(value.message);
    return text.trim() ? [{ kind: "error", text }] : [];
  }
  if (type === "turn.failed") {
    const text = asString(asRecord(value.error).message);
    return [{ kind: "error", text: text || "turn failed" }];
  }
  return [];
}

/** Antigravity's tool names, where they have a counterpart in the others'. */
const antigravityToolNames: Record<string, string> = {
  view_file: "Read",
  run_command: "Bash",
  write_to_file: "Write",
  replace_file_content: "Edit",
  multi_replace_file_content: "Edit",
  grep_search: "Grep",
  find_by_name: "Glob",
  list_dir: "LS",
  read_url_content: "WebFetch",
  search_web: "WebSearch",
};

/** Antigravity's argument names that say what a call is about, most telling first. */
const antigravitySubjectFields = [
  "CommandLine",
  "AbsolutePath",
  "TargetFile",
  "DirectoryPath",
  "SearchPath",
  "Query",
  "Pattern",
  "Url",
  "toolSummary",
] as const;

/**
 * An Antigravity tool argument. The transcript keeps every argument as JSON
 * text — a path arrives as `"\"/a/b.md\""` — so each is decoded once more.
 */
function antigravityArgument(value: unknown): string {
  const text = asString(value);
  try {
    const decoded = JSON.parse(text) as unknown;
    return typeof decoded === "string" ? decoded : text;
  } catch {
    return text;
  }
}

/**
 * The events of one record of Antigravity's transcript, which it writes as it
 * works while `agy -p` itself prints only the reply: a `PLANNER_RESPONSE` is a
 * model turn, holding its thinking, its tool calls and what it says; a
 * `GENERIC` record is what a tool gave back, marked `ERROR` when it failed.
 */
function antigravityEvents(value: JsonRecord): TraceEvent[] {
  if (asString(value.source) !== "MODEL") return [];
  const type = asString(value.type);
  if (type === "GENERIC") {
    if (asString(value.status) !== "ERROR") return [];
    return [{ kind: "tool_result", ok: false, detail: firstLine(asString(value.error) || asString(value.content)) }];
  }
  if (type !== "PLANNER_RESPONSE") return [];
  const events: TraceEvent[] = [];
  const thinking = asString(value.thinking);
  if (thinking.trim()) events.push({ kind: "thinking", text: thinking });
  const calls = Array.isArray(value.tool_calls) ? value.tool_calls : [];
  for (const call of calls) {
    const record = asRecord(call);
    const name = asString(record.name) || "tool";
    const args = asRecord(record.args);
    let summary = "";
    for (const field of antigravitySubjectFields) {
      summary = antigravityArgument(args[field]);
      if (summary.trim()) break;
    }
    events.push({ kind: "tool", name: antigravityToolNames[name] ?? name, summary });
  }
  const content = asString(value.content);
  if (content.trim()) events.push({ kind: "message", text: content });
  return events;
}

/** OpenCode's tool ids, as the names the other harnesses show. */
const opencodeToolNames: Record<string, string> = {
  bash: "Bash",
  read: "Read",
  write: "Write",
  edit: "Edit",
  multiedit: "Edit",
  apply_patch: "Edit",
  grep: "Grep",
  glob: "Glob",
  list: "LS",
  webfetch: "WebFetch",
  websearch: "WebSearch",
  task: "Task",
  todowrite: "TodoWrite",
  skill: "Skill",
};

/** The files a patch touches, which say more than its `*** Begin Patch` first line. */
function patchedFiles(patch: string): string {
  const files = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((match) => match[1]!.trim());
  return files.join(", ");
}

/**
 * The events of one record of `opencode run --format json`: a `text` part is
 * what the agent says, a `reasoning` part its thinking, and a `tool_use` part a
 * tool call once it has finished, its state saying whether it failed. An
 * `error` record is the run's own error.
 */
function opencodeEvents(value: JsonRecord): TraceEvent[] {
  const type = asString(value.type);
  const part = asRecord(value.part);
  if (type === "text") {
    const text = asString(part.text);
    return text.trim() ? [{ kind: "message", text }] : [];
  }
  if (type === "reasoning") {
    const text = asString(part.text);
    return text.trim() ? [{ kind: "thinking", text }] : [];
  }
  if (type === "tool_use") {
    const tool = asString(part.tool) || "tool";
    const state = asRecord(part.state);
    const input = asRecord(state.input);
    const summary = patchedFiles(asString(input.patchText)) || asString(input.filePath) || toolSubject(input);
    const events: TraceEvent[] = [{ kind: "tool", name: opencodeToolNames[tool] ?? tool, summary }];
    if (asString(state.status) === "error") {
      events.push({ kind: "tool_result", ok: false, detail: firstLine(asString(state.error)) });
    }
    return events;
  }
  if (type === "error") {
    const error = asRecord(value.error);
    const text = asString(asRecord(error.data).message) || asString(error.message) || asString(error.name);
    return text.trim() ? [{ kind: "error", text }] : [];
  }
  return [];
}

/** The events one native trace record holds, for the harnesses whose trace is known. */
export function traceEvents(agent: AgentName, value: unknown): TraceEvent[] {
  const record = asRecord(value);
  if (Object.keys(record).length === 0) return [];
  if (agent === "claude") return claudeEvents(record);
  if (agent === "codex") return codexEvents(record);
  if (agent === "antigravity") return antigravityEvents(record);
  if (agent === "opencode") return opencodeEvents(record);
  return [];
}

const maxSummaryChars = 160;

function clipped(text: string): string {
  const line = firstLine(text);
  const more = line.length > maxSummaryChars || text.trim().includes("\n");
  return line.length > maxSummaryChars ? `${line.slice(0, maxSummaryChars - 1)}…` : more ? `${line} …` : line;
}

function relative(text: string, workDir: string | undefined): string {
  if (!workDir) return text;
  const prefix = workDir.endsWith("/") ? workDir : `${workDir}/`;
  return text.split(prefix).join("");
}

/**
 * What a tool call is marked with: reading and editing apart from the rest,
 * so a run that changes files reads differently from one that looks around.
 * The names are the ones every harness's trace is put into here; a command
 * is a command whatever it does, since what it does is its own text.
 */
const toolMarks: Record<string, string> = {
  Read: "📖", Grep: "📖", Glob: "📖", LS: "📖", WebFetch: "📖", WebSearch: "📖",
  Edit: "📝", MultiEdit: "📝", Write: "📝", NotebookEdit: "📝",
};

function toolMark(name: string): string {
  return toolMarks[name] ?? "🔧";
}

/**
 * One event as the lines a person reads, or nothing for one not worth a line.
 *
 * Thinking is set apart with a thought bubble and blank lines, so it remains
 * readable without being confused with the agent's outward messages. A tool
 * call is one line, its subject clipped, but for a command, which is shown
 * whole; what the agent says is shown whole too, since that is the part
 * written for a reader.
 */
export function renderTraceEvent(event: TraceEvent, workDir?: string): string | undefined {
  switch (event.kind) {
    case "message": {
      // The reply, set apart as a thought is, with its own mark: it is what
      // the run came to, not one more thing done on the way.
      const [head, ...rest] = event.text.trim().split(/\r?\n/);
      return ["", `💬 ${head}`, ...rest.map((line) => (line ? `   ${line}` : "")), "", ""].join("\n");
    }
    case "tool": {
      // A command is shown whole: cut short, the part that says what it does
      // is often the part lost, after a long `cd` or a list of files.
      const subject = event.name === "Bash"
        ? relative(event.summary, workDir).trim().split(/\r?\n/).join("\n  ")
        : clipped(relative(event.summary, workDir));
      return `${toolMark(event.name)} ${event.name}${subject ? `(${subject})` : ""}\n`;
    }
    case "tool_result":
      return `  ⎿ failed${event.detail ? `: ${clipped(relative(event.detail, workDir))}` : ""}\n`;
    case "error":
      return `✗ ${clipped(event.text)}\n`;
    case "thinking": {
      const [head, ...rest] = thoughtLines(event.text);
      if (head === undefined) return undefined;
      return ["", `💭 ${head}`, ...rest.map((line) => (line ? `   ${line}` : "")), "", ""].join("\n");
    }
  }
}

/**
 * A thought's lines as shown. Codex's summaries head each part of a thought in
 * bold, which in a terminal is two pairs of asterisks around what the bubble
 * already sets apart, so a line that is bold throughout is shown plain.
 */
function thoughtLines(text: string): string[] {
  return text.trim().split(/\r?\n/).map((line) => line.replace(/^\s*\*\*(.+)\*\*\s*$/, "$1"));
}

/**
 * Renders an agent's native trace as it streams, for `--progress`.
 *
 * Fed the harness's stdout chunk by chunk, whatever else is done with it; a
 * record split across chunks waits for the rest of its line. A line that is
 * not JSON is left alone: for a harness with no event stream it is the reply
 * itself, which is printed where replies go.
 */
export class ProgressRenderer {
  private pending = "";
  /**
   * The last message, held until what follows it says what it was. A message
   * with more work after it is the agent saying what it is about to do —
   * Codex writes several such in a turn, as the same kind of item as its
   * answer — and is shown as a thought; only the last is the reply, shown
   * with 💬. The events carry no mark of their own to tell the two apart.
   */
  private held: TraceEvent | undefined;
  /** The previous thought's lines: Codex repeats a part it already sent. */
  private thought: string[] = [];
  /** Whether what was written last ended in a blank line. */
  private blank = false;

  constructor(
    private readonly agent: AgentName,
    private readonly write: (text: string) => void,
    private readonly workDir?: string,
  ) {}

  feed(chunk: string): void {
    this.pending += chunk;
    let newline = this.pending.indexOf("\n");
    while (newline >= 0) {
      this.line(this.pending.slice(0, newline));
      this.pending = this.pending.slice(newline + 1);
      newline = this.pending.indexOf("\n");
    }
  }

  flush(): void {
    if (this.pending) this.line(this.pending);
    this.pending = "";
    if (this.held) this.emit(this.held);
    this.held = undefined;
  }

  private event(event: TraceEvent): void {
    if (this.held) {
      const said = this.held;
      this.held = undefined;
      this.event({ kind: "thinking", text: (said as { text: string }).text });
    }
    if (event.kind === "message") {
      this.held = event;
      return;
    }
    if (event.kind === "thinking") {
      const lines = thoughtLines(event.text).filter((line) => !line.trim() || !this.thought.includes(line));
      this.thought = thoughtLines(event.text);
      if (!lines.some((line) => line.trim())) return;
      event = { kind: "thinking", text: lines.join("\n") };
    }
    this.emit(event);
  }

  private emit(event: TraceEvent): void {
    let rendered = renderTraceEvent(event, this.workDir);
    if (!rendered) return;
    // A thought is set apart by blank lines, one each side: two thoughts in a
    // row share the one between them.
    if (this.blank && rendered.startsWith("\n")) rendered = rendered.slice(1);
    this.write(rendered);
    this.blank = rendered.endsWith("\n\n");
  }

  private line(line: string): void {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return;
    let value: unknown;
    try {
      value = JSON.parse(trimmed) as unknown;
    } catch {
      return;
    }
    for (const event of traceEvents(this.agent, value)) this.event(event);
  }
}

/**
 * Feeds a renderer from a transcript file as the harness appends to it, for a
 * harness whose stdout carries no events: `agy -p` prints only its reply, and
 * what it does meanwhile is written to its transcript instead.
 *
 * The file is not known when the run starts — the harness creates it — so
 * `find` is asked on every poll until it names one. Each poll reads what was
 * appended since the last; `stop` reads the rest and flushes the renderer.
 */
export class TranscriptFollower {
  private path: string | undefined;
  private offset = 0;
  // A read can end inside a character; the decoder holds its first bytes.
  private readonly decoder = new StringDecoder("utf8");
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly find: () => string | undefined,
    private readonly renderer: ProgressRenderer,
    private readonly intervalMs = 500,
  ) {}

  start(): void {
    this.timer = setInterval(() => this.poll(), this.intervalMs);
    // Progress is never a reason to keep the process alive.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.poll();
    this.renderer.flush();
  }

  poll(): void {
    try {
      this.path ??= this.find();
      if (!this.path) return;
      const size = statSync(this.path).size;
      if (size <= this.offset) return;
      const handle = openSync(this.path, "r");
      try {
        const buffer = Buffer.alloc(size - this.offset);
        const read = readSync(handle, buffer, 0, buffer.length, this.offset);
        this.offset += read;
        this.renderer.feed(this.decoder.write(buffer.subarray(0, read)));
      } finally {
        closeSync(handle);
      }
    } catch {
      // A transcript that cannot be read costs the progress, never the run.
    }
  }
}
