import type { TraceEvent } from "../trace-events.js";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";

/** agy 1.4.12 stream-json uses event envelopes, unlike its historical transcript. */
export function isAntigravityEvent(value: unknown): boolean {
  return ["init", "step_update", "result", "error"].includes(text(record(value).event));
}

function records(stdout: string): RecordValue[] {
  try {
    const value = JSON.parse(stdout);
    if (isAntigravityEvent(value)) return [record(value)];
  } catch { /* Streaming output has one envelope per line. */ }
  return stdout.split(/\r?\n/).flatMap((line) => {
    try {
      const value = JSON.parse(line);
      return isAntigravityEvent(value) ? [record(value)] : [];
    } catch { return []; }
  });
}

function resultFailure(result: RecordValue): string {
  if (result.finished_reason) return `turn ended early (${text(result.finished_reason)})`;
  if (result.status !== "SUCCESS") {
    return text(result.error) || text(record(result.error).message) || text(result.message) ||
      `result status ${text(result.status) || "missing"}`;
  }
  return "";
}

/** undefined means a legacy transcript/plain reply; an empty string is an incomplete native run. */
export function antigravityFinalMessage(stdout: string): string | undefined {
  const rows = records(stdout);
  if (!rows.length) return undefined;
  const last = rows.reverse().find((row) => row.event === "result");
  if (!last || antigravityError(stdout)) return "";
  const result = record(last.result);
  if (Object.hasOwn(result, "structured_output")) return JSON.stringify(result.structured_output);
  return text(result.response).trim();
}

export function antigravityError(stdout: string): string {
  const rows = records(stdout);
  for (const row of rows) {
    if (row.event === "error") {
      return `antigravity error: ${text(row.error) || text(record(row.error).message) || text(row.message) || "native error"}`;
    }
  }
  const last = rows.reverse().find((row) => row.event === "result");
  const failure = last ? resultFailure(record(last.result)) : rows.length ? "native stream ended without a result" : "";
  return failure ? `antigravity error: ${failure}` : "";
}

export function antigravitySessionId(stdout: string): string {
  for (const row of records(stdout)) {
    const id = text(row.conversation_id) || text(record(row.result).conversation_id);
    if (id) return id;
  }
  return "";
}

const names: Record<string, string> = {
  read_file: "Read", view_file: "Read", run_command: "Bash",
  write_file: "Write", write_to_file: "Write", edit_file: "Edit",
  replace_file_content: "Edit", multi_replace_file_content: "Edit",
  grep_search: "Grep", find_by_name: "Glob", list_dir: "LS",
  read_url_content: "WebFetch", search_web: "WebSearch",
};

/** Tool starts are immediate; the terminal result alone supplies the authoritative reply.
 * text_delta belongs to an intermediate agent step and must never become a completed answer.
 */
export function antigravityJsonEvents(value: unknown): TraceEvent[] | undefined {
  if (!isAntigravityEvent(value)) return undefined;
  const row = record(value);
  if (row.event === "result" || row.event === "error") {
    const line = JSON.stringify(row);
    const error = antigravityError(line);
    if (error) return [{ kind: "error", text: error }];
    const reply = antigravityFinalMessage(line);
    return reply ? [{ kind: "message", text: reply }] : [];
  }
  const step = record(row.step_update);
  if (step.step_type !== "tool") return [];
  const info = record(step.tool_info);
  const args = record(info.parameters);
  if (step.state === "ERROR") {
    return [{ kind: "tool_result", ok: false, detail: text(info.output) || text(step.error) }];
  }
  if (step.state !== "ACTIVE") return [];
  const name = text(step.tool_name) || text(info.name) || "tool";
  const subject = ["CommandLine", "Path", "AbsolutePath", "TargetFile", "DirectoryPath", "SearchPath", "Query", "Pattern", "Url", "toolSummary"]
    .map((key) => text(args[key])).find((part) => part.trim()) || "";
  return [{ kind: "tool", name: names[name] || name, summary: subject }];
}
