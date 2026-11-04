import { resolveNativeTranscript } from "../native-transcripts.js";
import { TranscriptFollower } from "../trace-events.js";
import type { Env } from "../types.js";
import { antigravitySessionId } from "./antigravity-json.js";

/** stream-json omits thinking text; supplement only that field from this conversation's log. */
export class AntigravityThoughts {
  private pending = "";
  private transcriptPending = "";
  private follower?: TranscriptFollower;
  private stopped = false;
  private readonly resumed: ReturnType<typeof resolveNativeTranscript>;

  constructor(
    private readonly env: Env,
    private readonly workDir: string,
    private readonly thinking: (text: string) => void,
    private readonly resumedId?: string,
  ) {
    // Snapshot before launch, so continuing a session never replays earlier turns.
    this.resumed = resolveNativeTranscript("antigravity", resumedId, workDir, env);
  }

  feed(chunk: string): void {
    if (this.stopped) return;
    this.pending += chunk;
    let newline = this.pending.indexOf("\n");
    while (newline >= 0) {
      const line = this.pending.slice(0, newline);
      this.pending = this.pending.slice(newline + 1);
      if (!this.follower) {
        const id = antigravitySessionId(line);
        if (id) this.follow(id);
      }
      try {
        if (["result", "error"].includes(JSON.parse(line).event)) {
          // Drain thoughts before the renderer receives (and holds) the final reply.
          this.stop();
          return;
        }
      } catch { /* Wait for a complete native envelope. */ }
      newline = this.pending.indexOf("\n");
    }
    this.follower?.poll();
  }

  private follow(id: string): void {
    this.follower = new TranscriptFollower(
      () => {
        const found = resolveNativeTranscript("antigravity", id, this.workDir, this.env);
        return found?.kind === "jsonl" ? found.path : undefined;
      },
      { feed: (text) => this.transcript(text), flush: () => {} },
      undefined,
      id === this.resumedId ? this.resumed?.endOffset : 0,
    );
    this.follower.start();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.follower?.stop();
    this.pending = "";
  }

  private transcript(chunk: string): void {
    this.transcriptPending += chunk;
    let newline = this.transcriptPending.indexOf("\n");
    while (newline >= 0) {
      const line = this.transcriptPending.slice(0, newline);
      this.transcriptPending = this.transcriptPending.slice(newline + 1);
      try {
        const row = JSON.parse(line);
        if (row.source === "MODEL" && row.type === "PLANNER_RESPONSE" &&
            typeof row.thinking === "string" && row.thinking.trim()) {
          this.thinking(row.thinking);
        }
      } catch { /* Ignore malformed records; never expose raw transcript material. */ }
      newline = this.transcriptPending.indexOf("\n");
    }
  }
}
