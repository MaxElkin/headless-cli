import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { lockSync as LockSync } from "proper-lockfile";

import { extractNativeSessionId } from "../output.js";
import { writeStoredSession } from "../sessions.js";
import type { AgentName, Env } from "../types.js";

/** Read/modify/write must cover the whole store when named runs execute concurrently. */
export function withForkSessionStoreLock<T>(env: Env, write: () => T): T {
  if (!env.HOME || env.HEADLESS_INTERNAL_SECURE_SESSION_STORE === "1") return write();
  const path = join(env.HOME, ".headless", "sessions.json");
  mkdirSync(join(env.HOME, ".headless"), { recursive: true });
  const { lockSync } = createRequire(import.meta.url)("proper-lockfile") as { lockSync: typeof LockSync };
  const deadline = Date.now() + 10_000;
  let release: () => void;
  while (true) {
    try {
      release = lockSync(path, { realpath: false, stale: 5000 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || Date.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try { return write(); } finally { release(); }
}

/** Save a new local session as soon as its native trace identifies it, before cancellation. */
export class SessionCheckpoint {
  private pending = "";
  private saved = false;
  nativeId?: string;

  constructor(
    private readonly agent: AgentName,
    private readonly plan: { alias: string; mode: "new" | "resume"; profile?: string } | undefined,
    private readonly env: Env,
    private readonly workDir: string,
    private readonly report: (text: string) => void,
    private readonly forkSourceId?: string,
    private readonly checkpointed?: (nativeId: string) => void,
  ) {}

  feed(chunk: string): void {
    if (this.saved || !this.plan || this.plan.mode !== "new") return;
    this.pending += chunk;
    let newline = this.pending.indexOf("\n");
    while (newline >= 0) {
      const line = this.pending.slice(0, newline);
      this.pending = this.pending.slice(newline + 1);
      const nativeId = extractNativeSessionId(this.agent, line);
      if (nativeId && nativeId !== this.forkSourceId) {
        try {
          writeStoredSession(this.env, {
            agent: this.agent, alias: this.plan.alias, nativeId,
            profile: this.plan.profile, workDir: this.workDir,
          });
          this.saved = true;
          this.nativeId = nativeId;
          this.pending = "";
          this.checkpointed?.(nativeId);
          return;
        } catch (error) {
          this.report(`headless: could not checkpoint session ${this.plan.alias}: ${error}\n`);
        }
      }
      newline = this.pending.indexOf("\n");
    }
  }
}
