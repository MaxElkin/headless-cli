import type { AgentName, BuiltCommand } from "../types.js";
import { inserted } from "./schema.js";

/**
 * `--progress` shows the agent's thinking, set apart with 💭, but only what a
 * harness puts in its event stream. Codex puts none there unless asked: its
 * reasoning stays in the token count, and a `--progress` run showed the
 * commands it ran with nothing of why. `model_reasoning_summary` has it write
 * a `reasoning` item beside each step, which is what the trace renders.
 *
 * Only for `--progress`: a run nobody watches has no use for the summaries,
 * and they are output the model is billed for.
 */
const flagged: Partial<Record<AgentName, string[]>> = {
  codex: ["-c", 'model_reasoning_summary="detailed"'],
};

export function withForkProgressArgs(agent: AgentName, built: BuiltCommand, progress: boolean): BuiltCommand {
  const flags = progress ? flagged[agent] : undefined;
  if (!flags) return built;
  return { ...built, args: inserted(built.args, flags) };
}
