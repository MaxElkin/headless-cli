/**
 * The last line of a `--progress` run on a terminal: `⏳ Working… 12s`, the
 * time since progress last wrote, redrawn each second.
 *
 * An agent thinking and an agent hung look the same, a run of silence; the
 * line keeps counting either way, and how long it has counted says which is
 * likelier. Everything else written goes through `write`, which clears the
 * line first and draws it again under what was written, so it never stays in
 * the output.
 */
export class WorkingLine {
  private since = Date.now();
  private timer: NodeJS.Timeout | undefined;
  private shown = false;
  /** Whether what was written last ended a line: the working line goes on a line of its own. */
  private atLineStart = true;

  constructor(
    private readonly out: (text: string) => void,
    private readonly now: () => number = Date.now,
  ) {
    this.since = this.now();
  }

  start(): void {
    if (this.timer) return;
    this.since = this.now();
    this.draw();
    this.timer = setInterval(() => this.draw(), 1000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.clear();
  }

  readonly write = (text: string): void => {
    if (!text) return;
    this.clear();
    this.out(text);
    this.atLineStart = text.endsWith("\n");
    this.since = this.now();
    if (this.timer) this.draw();
  };

  draw(): void {
    if (!this.atLineStart) return;
    this.out(`\r\u001b[2K⏳ Working… ${elapsed(this.now() - this.since)}`);
    this.shown = true;
  }

  private clear(): void {
    if (!this.shown) return;
    this.out("\r\u001b[2K");
    this.shown = false;
  }
}

/** `12s`, or `3m 05s` past a minute. */
export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}
