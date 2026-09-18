import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.ts";

async function run(argv: string[], deps: Parameters<typeof runCli>[1] = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(argv, {
    stdinIsTTY: true,
    ...deps,
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  });
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

test("--attach prints the tmux launch followed by the attach command", async () => {
  const outside = await run(["codex", "--attach", "--name", "demo", "--prompt", "hello", "--print-command"], {
    env: { ...process.env, TMUX: undefined },
  });
  assert.equal(outside.code, 0);
  const lines = outside.stdout.trim().split("\n");
  assert.match(lines[0] ?? "", /^tmux new-session -d -s headless-codex-demo /);
  assert.equal(lines.at(-1), "tmux attach-session -t headless-codex-demo");

  const inside = await run(["codex", "--attach", "--name", "demo", "--prompt", "hello", "--print-command"], {
    env: { ...process.env, TMUX: "/tmp/tmux-1/default,1,0" },
  });
  assert.equal(inside.code, 0);
  assert.equal(inside.stdout.trim().split("\n").at(-1), "tmux switch-client -t headless-codex-demo");
});

test("--attach rejects --wait and non-interactive terminals", async () => {
  const withWait = await run(["codex", "--attach", "--wait", "--prompt", "hello"]);
  assert.equal(withWait.code, 2);
  assert.match(withWait.stderr, /--attach cannot be used with --wait/);

  const noTty = await run(["codex", "--attach", "--prompt", "hello"], { stdinIsTTY: false });
  assert.equal(noTty.code, 2);
  assert.match(noTty.stderr, /--attach requires an interactive terminal/);
});

test("--attach launches detached, then attaches to the new session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-fork-attach-"));
  try {
    const binDir = join(dir, "bin");
    const logFile = join(dir, "tmux.log");
    mkdirSync(binDir);
    mkdirSync(join(dir, "home"));
    writeFileSync(
      join(binDir, "tmux"),
      [
        "#!/usr/bin/env node",
        "const { appendFileSync } = require('node:fs');",
        "appendFileSync(process.env.TMUX_LOG, process.argv.slice(2).join(' ') + '\\n');",
        "process.exit(process.argv[2] === 'has-session' ? 1 : 0);",
        "",
      ].join("\n"),
    );
    chmodSync(join(binDir, "tmux"), 0o755);

    const result = await run(["codex", "--attach", "--name", "demo", "--prompt", "hello"], {
      env: { ...process.env, TMUX: undefined, TMUX_LOG: logFile, HOME: join(dir, "home"), PATH: `${binDir}:${process.env.PATH ?? ""}` },
    });

    assert.equal(result.code, 0, result.stderr);
    const calls = readFileSync(logFile, "utf8").trim().split("\n").filter((line) => !line.startsWith("has-session"));
    assert.match(calls[0] ?? "", /^new-session -d -s headless-codex-demo /);
    assert.equal(calls.at(-1), "attach-session -t headless-codex-demo");
    assert.doesNotMatch(result.stdout, /tmux session:/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
