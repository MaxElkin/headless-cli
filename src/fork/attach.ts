// Fork: `--attach` launches a tmux session like `--tmux`, then attaches the current terminal to it.
//
// The session is still created detached and every post-launch step (prompt paste, run
// registration) finishes first; only then is the terminal handed over. Inside tmux the current
// client is switched to the new session instead of nesting a second tmux client.
import { spawn } from "node:child_process";

import type { BuiltCommand, Env } from "../types.js";

export interface ForkAttachOptions {
  wait?: boolean;
  printCommand?: boolean;
}

export function validateForkAttach(options: ForkAttachOptions, stdinIsTTY: boolean): void {
  if (options.wait) {
    throw new Error("--attach cannot be used with --wait");
  }
  if (!options.printCommand && !stdinIsTTY) {
    throw new Error("--attach requires an interactive terminal");
  }
}

export function buildForkAttachCommand(sessionName: string, env: Env): BuiltCommand {
  return env.TMUX
    ? { command: "tmux", args: ["switch-client", "-t", sessionName] }
    : { command: "tmux", args: ["attach-session", "-t", sessionName] };
}

export async function forkAttachTmuxSession(
  sessionName: string,
  env: Env,
  stderr: (text: string) => void,
): Promise<number> {
  const command = buildForkAttachCommand(sessionName, env);
  return await new Promise<number>((resolve) => {
    const child = spawn(command.command, command.args, { env: env as NodeJS.ProcessEnv, stdio: "inherit" });
    child.on("error", (error) => {
      stderr(`${error.message}\n`);
      resolve(127);
    });
    child.on("close", (code, signal) => {
      resolve(signal ? 1 : (code ?? 1));
    });
  });
}
