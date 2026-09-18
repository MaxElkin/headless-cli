// Fork: `--clean-before` and `--clean-after` let one session name start a new conversation.
//
// Forgetting a session removes its native conversation id (and the tmux wait strategy that belongs
// to that conversation) from the session store, so the next launch under the name starts a new
// conversation. The conversation itself is not deleted. An id is only ever forgotten while the
// name's tmux session is not running:
//
// - `--clean-before` forgets the id before the launch, and refuses while the tmux session runs.
// - `--clean-after` marks the name; the first launch that finds the tmux session stopped forgets
//   the id. This covers every way a session ends (exit, detach then exit, crash, reboot) without
//   watching it, and for a one-shot run the next launch is always after it.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { sessionStorePath } from "../sessions.js";
import type { AgentName, Env } from "../types.js";

export interface ForkCleanOptions {
  forkCleanBefore?: boolean;
  forkCleanAfter?: boolean;
  sessionAlias?: string;
  docker?: boolean;
  printCommand?: boolean;
}

interface CleanMarksFile {
  version: 1;
  cleanAfter: Record<string, true>;
}

export function validateForkClean(options: ForkCleanOptions): void {
  for (const [flag, set] of [["--clean-before", options.forkCleanBefore], ["--clean-after", options.forkCleanAfter]] as const) {
    if (!set) continue;
    if (options.sessionAlias === undefined) throw new Error(`${flag} requires --session`);
    if (options.docker) throw new Error(`${flag} cannot be used with --docker`);
  }
}

// Called on every launch with --session, before the session store is read. --print-command
// changes nothing.
export function applyForkClean(agent: AgentName, options: ForkCleanOptions, env: Env): void {
  const alias = options.sessionAlias;
  if (alias === undefined || options.docker || options.printCommand) return;
  const key = markKey(agent, alias);
  const marks = readMarks(env);
  const pending = marks.cleanAfter[key] === true;
  if (!pending && !options.forkCleanBefore && !options.forkCleanAfter) return;

  const running = pending || options.forkCleanBefore ? tmuxSessionRunning(agent, alias, env) : false;
  if (options.forkCleanBefore && running) {
    throw new Error(`--clean-before: tmux session headless-${agent}-${alias} is running; exit it first`);
  }
  if ((pending && !running) || options.forkCleanBefore) {
    forgetStoredSession(env, agent, alias);
    delete marks.cleanAfter[key];
  }
  if (options.forkCleanAfter) marks.cleanAfter[key] = true;
  if (pending !== (marks.cleanAfter[key] === true)) writeMarks(env, marks);
}

function markKey(agent: AgentName, alias: string): string {
  return `${agent}/${alias}`;
}

// The session name upstream's buildHeadlessTmuxSessionName gives a --session alias.
function tmuxSessionRunning(agent: AgentName, alias: string, env: Env): boolean {
  const result = spawnSync("tmux", ["has-session", "-t", `headless-${agent}-${alias}`], {
    env: env as NodeJS.ProcessEnv,
    stdio: "ignore",
    timeout: 5000,
  });
  return result.status === 0;
}

// Removes the conversation id from upstream's session store and keeps the rest of the entry (the
// Codex profile, the work dir). Writes the file the way upstream's writeSessionStore does.
function forgetStoredSession(env: Env, agent: AgentName, alias: string): void {
  const path = sessionStorePath(env);
  if (!path || !existsSync(path)) return;
  let store: { agents?: Record<string, Record<string, Record<string, unknown>>> };
  try {
    store = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return;
  }
  const entry = store.agents?.[agent]?.[alias];
  if (!entry) return;
  delete entry.nativeId;
  delete entry.tmuxWaitStrategy;
  entry.updatedAt = new Date().toISOString();
  writeJsonAtomic(path, store);
}

function marksPath(env: Env): string | undefined {
  return env.HOME ? join(env.HOME, ".headless", "fork-sessions.json") : undefined;
}

function readMarks(env: Env): CleanMarksFile {
  const path = marksPath(env);
  const empty: CleanMarksFile = { version: 1, cleanAfter: {} };
  if (!path || !existsSync(path)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CleanMarksFile>;
    return parsed.version === 1 && parsed.cleanAfter && typeof parsed.cleanAfter === "object"
      ? { version: 1, cleanAfter: parsed.cleanAfter }
      : empty;
  } catch {
    return empty;
  }
}

function writeMarks(env: Env, marks: CleanMarksFile): void {
  const path = marksPath(env);
  if (!path) throw new Error("HOME is required for --session");
  writeJsonAtomic(path, marks);
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}`;
  writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmpPath, path);
}
