import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.ts";
import { applyForkClean } from "../src/fork/clean.ts";
import { readStoredSession, writeStoredSession } from "../src/sessions.ts";

const oldId = "11111111-2222-3333-4444-555555555555";

async function run(argv: string[], env: NodeJS.ProcessEnv) {
  const stderr: string[] = [];
  const code = await runCli(argv, { env, stdinIsTTY: true, stdout: () => undefined, stderr: (text) => stderr.push(text) });
  return { code, stderr: stderr.join("") };
}

// A fake tmux that logs its calls; `has-session` succeeds only when TMUX_LIVE is set.
async function withTmux(body: (env: NodeJS.ProcessEnv, launches: () => string[], dir: string) => Promise<void>): Promise<void> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "headless-fork-clean-")));
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
        "const args = process.argv.slice(2);",
        "appendFileSync(process.env.TMUX_LOG, args.join(' ') + '\\n');",
        "process.exit(args[0] === 'has-session' && !process.env.TMUX_LIVE ? 1 : 0);",
        "",
      ].join("\n"),
    );
    chmodSync(join(binDir, "tmux"), 0o755);
    const env = {
      ...process.env,
      TMUX: undefined,
      TMUX_LIVE: undefined,
      TMUX_LOG: logFile,
      HOME: join(dir, "home"),
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    };
    const launches = () =>
      existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").filter((line) => line.startsWith("new-session")) : [];
    await body(env, launches, dir);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

test("--clean-before and --clean-after require --session and reject --docker", async () => {
  await withTmux(async (env) => {
    for (const flag of ["--clean-before", "--clean-after"]) {
      const bare = await run(["claude", "--tmux", flag, "--prompt", "hi"], env);
      assert.equal(bare.code, 2);
      assert.match(bare.stderr, new RegExp(`${flag} requires --session`));
      const docker = await run(["claude", "--docker", "--session", "demo", flag, "--prompt", "hi"], env);
      assert.equal(docker.code, 2);
      assert.match(docker.stderr, new RegExp(`${flag} cannot be used with --docker`));
    }
  });
});

test("--clean-before starts a new conversation, and refuses while the tmux session runs", async () => {
  await withTmux(async (env, launches, dir) => {
    writeStoredSession(env, { agent: "claude", alias: "demo", nativeId: oldId });

    const live = await run(["claude", "--tmux", "--session", "demo", "--clean-before", "--prompt", "hi"], { ...env, TMUX_LIVE: "1" });
    assert.equal(live.code, 2);
    assert.match(live.stderr, /headless-claude-demo is running; exit it first/);
    assert.equal(readStoredSession(env, "claude", "demo")?.nativeId, oldId);

    const result = await run(["claude", "--tmux", "--session", "demo", "--clean-before", "--prompt", "hi", "--work-dir", dir], env);
    assert.equal(result.code, 0, result.stderr);
    const launch = launches().at(-1) ?? "";
    assert.doesNotMatch(launch, /--resume/);
    const newId = /--session-id ([0-9a-f-]{36})/.exec(launch)?.[1];
    assert.ok(newId && newId !== oldId, launch);
    assert.equal(readStoredSession(env, "claude", "demo")?.nativeId, newId);
  });
});

test("--clean-after forgets the conversation on the first launch that finds the session stopped", async () => {
  await withTmux(async (env, launches, dir) => {
    writeStoredSession(env, { agent: "claude", alias: "demo", nativeId: oldId });
    const launch = (extra: string[], extraEnv: NodeJS.ProcessEnv = {}) =>
      run(["claude", "--tmux", "--session", "demo", "--prompt", "hi", "--work-dir", dir, ...extra], { ...env, ...extraEnv });

    // This task still continues the stored conversation.
    assert.equal((await launch(["--clean-after"])).code, 0);
    assert.match(launches().at(-1) ?? "", new RegExp(`--resume ${oldId}`));

    // While the session runs, prompts go to it and nothing is forgotten.
    assert.equal((await launch([], { TMUX_LIVE: "1" })).code, 0);
    assert.equal(launches().length, 1);
    assert.equal(readStoredSession(env, "claude", "demo")?.nativeId, oldId);

    // Once it has stopped, the next launch starts a new conversation.
    assert.equal((await launch([])).code, 0);
    const fresh = launches().at(-1) ?? "";
    assert.doesNotMatch(fresh, /--resume/);
    const newId = /--session-id ([0-9a-f-]{36})/.exec(fresh)?.[1];
    assert.equal(readStoredSession(env, "claude", "demo")?.nativeId, newId);

    // The mark was used up: the launch after that resumes the new conversation.
    assert.equal((await launch([])).code, 0);
    assert.match(launches().at(-1) ?? "", new RegExp(`--resume ${newId}`));
  });
});

test("forgetting keeps the rest of the stored session", async () => {
  await withTmux(async (env) => {
    writeStoredSession(env, { agent: "codex", alias: "demo", nativeId: oldId, profile: "work", workDir: "/work" });
    applyForkClean("codex", { sessionAlias: "demo", forkCleanBefore: true }, env);
    const stored = readStoredSession(env, "codex", "demo");
    assert.equal(stored?.nativeId, undefined);
    assert.equal(stored?.profile, "work");
    assert.equal(stored?.workDir, "/work");
  });
});
