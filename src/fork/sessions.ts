// Fork: named tmux sessions resume the agent's native conversation.
//
// Upstream's `--tmux --session <name>` only names the tmux session: a live one gets the prompt
// typed into it, a dead one starts a new conversation. The fork records the native conversation id
// of every tmux launch in the session store (the same `nativeId` one-shot `--session` uses) and,
// when the tmux session is gone, relaunches it resuming that conversation.
//
// The id is known up front for a resume and for Claude (`--session-id <uuid>`). Codex,
// Antigravity and OpenCode cannot be given one, so the fork claims the transcript that appears
// after launch — for OpenCode, the new session row in its database for the work dir — under the
// same launch lock upstream's `--tmux --wait` claim tier uses. OpenCode writes the row with the
// first message, so a session launched without a prompt is claimed only if one is typed in time.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";

import { acquireLaunchLock } from "../launch-lock.js";
import { resolveLatestNativeTranscripts } from "../native-transcripts.js";
import { readStoredSession, writeStoredSession, type StoredTmuxWaitStrategy } from "../sessions.js";
import type { AgentName, BuildOptions, BuiltCommand, Env } from "../types.js";

const resumableAgents: readonly AgentName[] = ["antigravity", "claude", "codex", "opencode"];

export interface ForkTmuxSession {
  identity: Pick<BuildOptions, "sessionMode" | "sessionId">;
  nativeId?: string;
  claim?: { workDir: string; startedAt?: string; known?: Set<string> };
  release: () => void;
}

type Transcript = ReturnType<typeof resolveLatestNativeTranscripts>[number];

function transcriptIdentity(transcript: Transcript): string {
  return [transcript.kind, transcript.path, transcript.sessionId ?? ""].join("\t");
}

function claimOptions(agent: AgentName): Parameters<typeof resolveLatestNativeTranscripts>[5] {
  return agent === "antigravity" ? { antigravityScope: "all" } : {};
}

// Kept in step with upstream's claimLockScope in cli.ts, so fork and `--wait` claims contend.
function claimLockScope(agent: AgentName, workDir: string): string {
  if (agent === "antigravity") return "__global_antigravity_brain__";
  try {
    return realpathSync(workDir);
  } catch {
    return workDir;
  }
}

// Kept in step with upstream's claimedNativeIdFromPath in cli.ts.
export function nativeIdFromTranscriptPath(agent: AgentName, path: string): string | undefined {
  if (agent === "antigravity") {
    const parts = path.split("/");
    const brainIndex = parts.lastIndexOf("brain");
    const nativeId = brainIndex >= 0 ? parts[brainIndex + 1] : undefined;
    return nativeId && /^[A-Za-z0-9_.:-]+$/.test(nativeId) ? nativeId : undefined;
  }
  if (agent === "codex") {
    const name = path.split("/").at(-1)?.replace(/\.jsonl$/, "");
    if (!name) return undefined;
    const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(name);
    return match?.[1] ?? name;
  }
  return undefined;
}

// Called for a tmux launch that creates a new tmux session. Returns undefined when the fork has
// nothing to add: no --session, an agent it cannot resume, or --wait (whose own identity wins).
export function planForkTmuxSession(
  agent: AgentName,
  alias: string | undefined,
  workDir: string,
  env: Env,
  wait: boolean,
): ForkTmuxSession | undefined {
  if (!alias || wait || !resumableAgents.includes(agent)) return undefined;
  const stored = readStoredSession(env, agent, alias);
  if (stored?.nativeId) {
    return {
      identity: { sessionMode: "resume", sessionId: stored.nativeId },
      nativeId: stored.nativeId,
      release: () => undefined,
    };
  }
  if (agent === "claude") {
    const sessionId = randomUUID();
    return { identity: { sessionMode: "new", sessionId }, nativeId: sessionId, release: () => undefined };
  }
  return { identity: {}, claim: { workDir }, release: () => undefined };
}

// Called immediately before the launch, inside the try whose finally calls plan.release(): takes
// the launch lock and the set of transcripts that already exist.
export function beginForkTmuxClaim(agent: AgentName, plan: ForkTmuxSession | undefined, env: Env): void {
  if (!plan?.claim) return;
  const lock = acquireLaunchLock(env, agent, claimLockScope(agent, plan.claim.workDir));
  let released = false;
  plan.release = () => {
    if (released) return;
    released = true;
    lock.release();
  };
  plan.claim.startedAt = new Date().toISOString();
  plan.claim.known = new Set(
    resolveLatestNativeTranscripts(agent, plan.claim.workDir, env, {}, 20, claimOptions(agent)).map(transcriptIdentity),
  );
}

function tmuxSessionExists(sessionName: string, env: Env): boolean {
  const result = spawnSync("tmux", ["has-session", "-t", sessionName], {
    env: env as NodeJS.ProcessEnv,
    stdio: "ignore",
    timeout: 2000,
  });
  return result.status === 0;
}

// Called right after a successful launch: waits for the new transcript of a Codex, Antigravity or OpenCode
// session and takes its id. Gives up when the tmux session exits or after the timeout, leaving the
// session without a recorded id rather than guessing.
export async function claimForkTmuxSession(
  agent: AgentName,
  plan: ForkTmuxSession | undefined,
  sessionName: string,
  env: Env,
  stderr: (text: string) => void,
): Promise<void> {
  if (!plan?.claim?.known) return;
  const { workDir, startedAt, known } = plan.claim;
  const intervalMs = Number.parseInt(env.HEADLESS_TMUX_WAIT_INTERVAL_MS ?? "", 10) || 500;
  const deadline = Date.now() + (Number.parseInt(env.HEADLESS_FORK_CLAIM_TIMEOUT_MS ?? "", 10) || 30_000);
  try {
    while (Date.now() < deadline) {
      const fresh = resolveLatestNativeTranscripts(agent, workDir, env, { startedAt }, 20, claimOptions(agent)).find(
        (candidate) => !known.has(transcriptIdentity(candidate)),
      );
      if (fresh) {
        plan.nativeId = fresh.sessionId ?? nativeIdFromTranscriptPath(agent, fresh.path);
        return;
      }
      if (!tmuxSessionExists(sessionName, env)) break;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    stderr(`headless: could not identify the ${agent} conversation of ${sessionName}; it will not be resumable\n`);
  } finally {
    plan.release();
  }
}

// Called after a successful launch with --session: stores the conversation id so the next launch
// of the same name resumes it. Under --wait the id comes from upstream's wait strategy instead.
export function recordForkTmuxSession(
  env: Env,
  agent: AgentName,
  alias: string | undefined,
  plan: ForkTmuxSession | undefined,
  waitStrategy: StoredTmuxWaitStrategy | undefined,
  workDir: string | undefined,
  profile: string | undefined,
): void {
  if (!alias || !resumableAgents.includes(agent)) return;
  const nativeId =
    plan?.nativeId ??
    (waitStrategy?.kind === "pin"
      ? waitStrategy.sessionId
      : waitStrategy?.kind === "claim"
        ? nativeIdFromTranscriptPath(agent, waitStrategy.claimed)
        : undefined);
  if (!nativeId) return;
  writeStoredSession(env, { agent, alias, nativeId, profile, workDir });
}

// Upstream's interactive Claude and OpenCode commands have no resume case.
export function withForkInteractiveResume(name: AgentName, options: BuildOptions, command: BuiltCommand): BuiltCommand {
  if (options.sessionMode !== "resume" || !options.sessionId) return command;
  if (name === "claude") return { ...command, args: ["--resume", options.sessionId, ...command.args] };
  if (name === "opencode") return { ...command, args: [...command.args, "--session", options.sessionId] };
  return command;
}
