import { spawnSync } from "node:child_process";

import { resolveNativeTranscript } from "../native-transcripts.js";
import type { TraceEvent } from "../trace-events.js";
import type { AgentName, Env } from "../types.js";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

/** A running tool from the database and its later stdout result describe one call. */
export class OpenCodeToolCalls {
  private readonly seen = new Set<string>();

  events(agent: AgentName, value: unknown, events: TraceEvent[]): TraceEvent[] {
    if (agent !== "opencode") return events;
    const native = record(value);
    if (native.type !== "tool_use") return events;
    const part = record(native.part);
    if (record(part.state).status === "pending") return events.filter((event) => event.kind !== "tool");
    const id = part.id ?? part.callID;
    if (typeof id !== "string" || !id) return events;
    const key = JSON.stringify([native.sessionID ?? part.sessionID, id]);
    const seen = this.seen.has(key);
    if (events.some((event) => event.kind === "tool")) this.seen.add(key);
    return seen ? events.filter((event) => event.kind !== "tool") : events;
  }
}

/**
 * OpenCode's JSON stdout omits running tools. Read only this invocation's
 * assistant tool parts from its local database, using the native session id
 * from stdout rather than guessing the latest session in the workspace.
 * Synthetic records feed the existing progress sinks, never the raw stdout.
 */
export class OpenCodeToolProgress {
  private pending = "";
  private sessionId?: string;
  private timer?: ReturnType<typeof setInterval>;
  private readonly seen = new Set<string>();
  private reported = false;

  constructor(
    private readonly env: Env,
    private readonly deliver: (chunk: string) => void,
    private readonly report: (text: string) => void,
    private readonly startedAt = Date.now(),
  ) {}

  start(): void {
    this.timer = setInterval(() => this.poll(), 500);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  feed(chunk: string): void {
    this.pending += chunk;
    let newline = this.pending.indexOf("\n");
    while (newline >= 0) {
      const line = this.pending.slice(0, newline);
      this.pending = this.pending.slice(newline + 1);
      try {
        const id = record(JSON.parse(line)).sessionID;
        if (!this.sessionId && typeof id === "string" && id) this.sessionId = id;
      } catch { /* Not every stdout line is a native JSON event. */ }
      newline = this.pending.indexOf("\n");
    }
  }

  poll(): void {
    if (!this.sessionId) return;
    const transcript = resolveNativeTranscript("opencode", this.sessionId, undefined, this.env);
    if (!transcript) return;
    try {
      const result = spawnSync("sqlite3", ["-readonly", "-json", transcript.path, [
        "select part.id, json_extract(part.data, '$.tool') as tool,",
        "json_extract(part.data, '$.state.input') as input",
        "from part join message on message.id = part.message_id",
        `where part.session_id = '${this.sessionId.replaceAll("'", "''")}'`,
        `and part.time_created >= ${Math.floor(this.startedAt)}`,
        "and json_extract(message.data, '$.role') = 'assistant'",
        "and json_extract(part.data, '$.type') = 'tool'",
        "and json_extract(part.data, '$.state.status') = 'running'",
        "order by part.time_created, part.id;",
      ].join(" ")], { encoding: "utf8", timeout: 1000, maxBuffer: 1024 * 1024 });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(result.stderr.trim() || "database query failed");
      const rows: unknown = JSON.parse(result.stdout.trim() || "[]");
      if (!Array.isArray(rows)) throw new Error("invalid database query result");
      for (const row of rows) {
        const entry = record(row);
        if (typeof entry.id !== "string" || this.seen.has(entry.id)) continue;
        const input = typeof entry.input === "string" ? record(JSON.parse(entry.input)) : record(entry.input);
        this.seen.add(entry.id);
        this.deliver(`${JSON.stringify({ type: "tool_use", sessionID: this.sessionId,
          part: { id: entry.id, type: "tool", tool: entry.tool, state: { status: "running", input } } })}\n`);
      }
    } catch (error) {
      if (!this.reported) {
        this.reported = true;
        this.report(`headless: could not observe running OpenCode tools: ${error}\n`);
      }
    }
  }
}
