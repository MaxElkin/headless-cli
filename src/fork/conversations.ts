import type { AgentName, BuiltCommand, Env } from "../types.js";
import { readStoredSession, type StoredSession } from "../sessions.js";
import { tmuxSessionRunning } from "./clean.js";

/** Resolve the source before any destination cleaning; preview is read-only. */
export function forkSource(agent: AgentName, source: string | undefined, destination: string | undefined,
                           env: Env): StoredSession | undefined {
  if (source === undefined) return undefined;
  if (!env.HOME) throw new Error("HOME is required for --fork-from");
  if (source === "." || source === ".." || !/^[A-Za-z0-9_.-]+$/.test(source)) {
    throw new Error("invalid --fork-from session name");
  }
  if (source === destination) throw new Error("--fork-from source and --session destination must differ");
  if (!["claude", "codex", "opencode"].includes(agent)) {
    throw new Error(`native conversation forking is not supported for ${agent}`);
  }
  const stored = readStoredSession(env, agent, source);
  if (!stored?.nativeId) throw new Error(`no source conversation for ${agent}/${source}`);
  if (destination && tmuxSessionRunning(agent, destination, env)) {
    throw new Error(`cannot replace running destination session headless-${agent}-${destination}`);
  }
  return stored;
}

export function withForkConversation(agent: AgentName, command: BuiltCommand, sourceId?: string,
                                     workDir?: string): BuiltCommand {
  // OpenCode needs an explicit directory when resuming a named conversation;
  // changing only the subprocess cwd can leave its event stream waiting forever.
  const explicitDirectory = agent === "opencode" && workDir;
  if (!sourceId && !explicitDirectory) return command;
  const args = [...command.args];
  if (explicitDirectory) args.splice(1, 0, "--dir", workDir);
  if (!sourceId) return { ...command, args };
  if (agent === "claude") args.unshift("--resume", sourceId, "--fork-session");
  else if (agent === "opencode") args.push("--session", sourceId, "--fork");
  else if (agent === "codex") {
    args.splice(args.indexOf("exec") + 1, 0, "fork");
    args.splice(args.length - 1, 0, sourceId);
  } else throw new Error(`native conversation forking is not supported for ${agent}`);
  return { ...command, args };
}
