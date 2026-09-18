import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.ts";
import { withForkInteractiveResume } from "../src/fork/sessions.ts";
import { readStoredSession, writeStoredSession } from "../src/sessions.ts";

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

// A fake tmux that logs its calls. `has-session` succeeds only when TMUX_LIVE is set. With
// TMUX_ROLLOUT set, `new-session` writes a Codex rollout for the workspace, as a launched Codex would.
function fakeTmux(dir: string): { env: NodeJS.ProcessEnv; home: string; log: () => string[] } {
  const binDir = join(dir, "bin");
  const home = join(dir, "home");
  const logFile = join(dir, "tmux.log");
  mkdirSync(binDir);
  mkdirSync(home);
  writeFileSync(
    join(binDir, "tmux"),
    [
      "#!/usr/bin/env node",
      "const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs');",
      "const { dirname } = require('node:path');",
      "const args = process.argv.slice(2);",
      "appendFileSync(process.env.TMUX_LOG, args.join(' ') + '\\n');",
      "if (args[0] === 'has-session') process.exit(process.env.TMUX_LIVE ? 0 : 1);",
      "if (args[0] === 'new-session' && process.env.TMUX_ROLLOUT) {",
      "  mkdirSync(dirname(process.env.TMUX_ROLLOUT), { recursive: true });",
      "  writeFileSync(process.env.TMUX_ROLLOUT, JSON.stringify({ type: 'session_meta', payload: { cwd: process.env.TMUX_CWD } }) + '\\n');",
      "}",
      "process.exit(0);",
      "",
    ].join("\n"),
  );
  chmodSync(join(binDir, "tmux"), 0o755);
  return {
    env: {
      ...process.env,
      TMUX: undefined,
      TMUX_LIVE: undefined,
      TMUX_ROLLOUT: undefined,
      CODEX_HOME: undefined,
      TMUX_LOG: logFile,
      HOME: home,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      HEADLESS_TMUX_WAIT_INTERVAL_MS: "20",
      HEADLESS_FORK_CLAIM_TIMEOUT_MS: "2000",
    },
    home,
    log: () => readFileSync(logFile, "utf8").trim().split("\n").filter((line) => !line.startsWith("has-session")),
  };
}

async function withDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "headless-fork-sessions-")));
  try {
    await body(dir);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

test("interactive Claude resume puts --resume first", () => {
  const command = withForkInteractiveResume(
    "claude",
    { sessionMode: "resume", sessionId: "abc" },
    { command: "claude", args: ["--model", "opus", "hi"] },
  );
  assert.deepEqual(command.args, ["--resume", "abc", "--model", "opus", "hi"]);
  const unchanged = withForkInteractiveResume("claude", { sessionMode: "new", sessionId: "abc" }, command);
  assert.equal(unchanged, command);
});

test("a dead tmux session with a stored id is relaunched resuming it", async () => {
  await withDir(async (dir) => {
    const tmux = fakeTmux(dir);
    writeStoredSession(tmux.env, { agent: "claude", alias: "demo", nativeId: "11111111-2222-3333-4444-555555555555" });
    writeStoredSession(tmux.env, { agent: "codex", alias: "demo", nativeId: "66666666-7777-8888-9999-000000000000" });

    const claude = await run(["claude", "--tmux", "--session", "demo", "--prompt", "hi", "--print-command"], { env: tmux.env });
    assert.equal(claude.code, 0, claude.stderr);
    assert.match(claude.stdout, /claude --resume 11111111-2222-3333-4444-555555555555 /);
    assert.doesNotMatch(claude.stdout, /--session-id/);

    const codex = await run(["codex", "--tmux", "--session", "demo", "--prompt", "hi", "--print-command"], { env: tmux.env });
    assert.equal(codex.code, 0, codex.stderr);
    assert.match(codex.stdout, /codex .*resume 66666666-7777-8888-9999-000000000000/);
  });
});

test("a new Claude tmux session records the id it was launched with", async () => {
  await withDir(async (dir) => {
    const tmux = fakeTmux(dir);
    const result = await run(["claude", "--tmux", "--session", "demo", "--prompt", "hi", "--work-dir", dir], { env: tmux.env });
    assert.equal(result.code, 0, result.stderr);
    const launch = tmux.log().find((line) => line.startsWith("new-session")) ?? "";
    const launchedId = /--session-id ([0-9a-f-]{36})/.exec(launch)?.[1];
    assert.ok(launchedId, launch);
    assert.equal(readStoredSession(tmux.env, "claude", "demo")?.nativeId, launchedId);
  });
});

test("a new Codex tmux session records the id of the transcript it creates", async () => {
  await withDir(async (dir) => {
    const tmux = fakeTmux(dir);
    const id = "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
    const env = {
      ...tmux.env,
      TMUX_CWD: dir,
      TMUX_ROLLOUT: join(tmux.home, ".codex", "sessions", "2026", "09", "18", `rollout-2026-09-18T10-00-00-${id}.jsonl`),
    };
    const result = await run(["codex", "--tmux", "--session", "demo", "--prompt", "hi", "--work-dir", dir], { env });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(readStoredSession(env, "codex", "demo")?.nativeId, id);
  });
});

test("--attach on a live tmux session sends the prompt, then attaches", async () => {
  await withDir(async (dir) => {
    const tmux = fakeTmux(dir);
    const result = await run(["codex", "--attach", "--session", "demo", "--prompt", "hi"], {
      env: { ...tmux.env, TMUX_LIVE: "1" },
    });
    assert.equal(result.code, 0, result.stderr);
    const calls = tmux.log();
    assert.ok(!calls.some((line) => line.startsWith("new-session")), calls.join("\n"));
    assert.equal(calls.at(-1), "attach-session -t headless-codex-demo");
  });
});
