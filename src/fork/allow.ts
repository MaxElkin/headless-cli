// Fork: permission modes that keep the agent's own permission config.
//
// Upstream's read-only and yolo override the agent's permissions. The fork modes keep the agent's
// project/user config (sandbox, allow/ask/deny lists) and differ only in who reviews a request to
// leave the sandbox:
//   project — whatever the config says; no permission flags are passed
//   ask     — the user
//   auto    — the agent's AI reviewer
import type { AgentName, BuildOptions, BuiltCommand } from "../types.js";

export type ForkAllowMode = "project" | "ask" | "auto";

export const FORK_ALLOW_MODES: readonly ForkAllowMode[] = ["project", "ask", "auto"];

export function isForkAllowMode(value: string | undefined): value is ForkAllowMode {
  return (FORK_ALLOW_MODES as readonly (string | undefined)[]).includes(value);
}

// Pi has no permission system and the ACP client approves every request itself, so no fork mode
// fits them. Only Claude and Codex have an AI reviewer for auto.
const projectAllowAgents: readonly AgentName[] = ["antigravity", "claude", "codex", "cursor", "gemini", "opencode"];
const autoAllowAgents: readonly AgentName[] = ["claude", "codex"];

export function validateForkAllowAgent(name: AgentName, allow: ForkAllowMode): void {
  const supported = allow === "auto" ? autoAllowAgents : projectAllowAgents;
  if (!supported.includes(name)) {
    throw new Error(`--allow ${allow} is supported only by ${supported.join(", ")}`);
  }
}

function forkAllowArgs(name: AgentName, allow: ForkAllowMode): string[] {
  if (allow === "project") return [];
  if (name === "claude") return ["--permission-mode", allow === "ask" ? "acceptEdits" : "auto"];
  if (name === "codex") return ["-c", `approvals_reviewer="${allow === "ask" ? "user" : "auto_review"}"`];
  if (name === "gemini") return ["--approval-mode", "auto_edit"];
  return [];
}

// Upstream builders pass no permission flags for an allow value they do not recognize, except the
// ones below, which they add for anything that is not read-only.
function withoutUpstreamBypass(args: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dangerously-bypass-approvals-and-sandbox") continue;
    if (arg === "--approval-mode" && args[index + 1] === "yolo") {
      index += 1;
      continue;
    }
    result.push(arg as string);
  }
  return result;
}

// Wraps an upstream command builder. For a fork mode it builds the command without upstream's
// permission flags and puts the fork's flags first, ahead of any subcommand or prompt.
export function buildWithForkAllow(
  name: AgentName,
  options: BuildOptions,
  build: (options: BuildOptions) => BuiltCommand,
): BuiltCommand {
  const allow = options.allow;
  if (!isForkAllowMode(allow)) return build(options);
  validateForkAllowAgent(name, allow);
  const command = build(options);
  return { ...command, args: [...forkAllowArgs(name, allow), ...withoutUpstreamBypass(command.args)] };
}
