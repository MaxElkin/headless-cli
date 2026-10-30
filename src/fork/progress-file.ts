import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { traceEvents } from "../trace-events.js";
import type { AgentName } from "../types.js";

/**
 * `--progress-file`: the run's events, as `data.events` has them, appended
 * to a file one JSON object a line, for whatever watches or audits the run
 * from outside. Each line is timed and nothing is cut, as `--progress` cuts
 * for a person. A `start` line opens the run and an `end` line closes it, so
 * a file without one was cut short.
 *
 * Fed the harness's stdout as the renderer is, a record split across chunks
 * waiting for the rest of its line. Each line goes out in one append, so a
 * reader following the file never sees half of one. A file that cannot be
 * written costs the file, never the run.
 */
export class ProgressFile {
  private pending = "";
  private failed = false;

  constructor(
    private readonly path: string,
    private readonly agent: AgentName,
    private readonly report: (text: string) => void,
    private readonly now: () => Date = () => new Date(),
  ) {}

  start(run: { model?: string; session?: string; workDir: string }): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
    } catch {
      // The append below reports it.
    }
    this.append({ kind: "start", agent: this.agent, ...run });
  }

  feed(chunk: string): void {
    this.pending += chunk;
    let newline = this.pending.indexOf("\n");
    while (newline >= 0) {
      this.line(this.pending.slice(0, newline));
      this.pending = this.pending.slice(newline + 1);
      newline = this.pending.indexOf("\n");
    }
  }

  flush(): void {
    if (this.pending) this.line(this.pending);
    this.pending = "";
  }

  end(exitCode: number): void {
    this.flush();
    this.append({ kind: "end", exitCode });
  }

  private line(line: string): void {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return;
    let value: unknown;
    try {
      value = JSON.parse(trimmed) as unknown;
    } catch {
      return;
    }
    for (const event of traceEvents(this.agent, value)) this.append(event);
  }

  private append(event: object): void {
    if (this.failed) return;
    try {
      appendFileSync(this.path, `${JSON.stringify({ time: this.now().toISOString(), ...event })}\n`);
    } catch (error) {
      this.failed = true;
      const message = error instanceof Error ? error.message : String(error);
      this.report(`headless: could not write --progress-file: ${message}\n`);
    }
  }
}
