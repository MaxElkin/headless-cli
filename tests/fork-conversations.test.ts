import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.ts";
import { forkSource } from "../src/fork/conversations.ts";
import { SessionCheckpoint } from "../src/fork/session-checkpoint.ts";
import { readStoredSession, writeStoredSession } from "../src/sessions.ts";

const sourceId = "11111111-1111-4111-8111-111111111111";
const childId = "22222222-2222-4222-8222-222222222222";
const oldId = "33333333-3333-4333-8333-333333333333";

for (const agent of ["claude", "codex", "opencode"] as const) {
  for (const outcome of ["success", "failed-child", "failed-before-child", "source-id", "no-id"] as const) {
    test(`${agent} fork ${outcome} preserves the source and checkpoints only a distinct child`, async () => {
      const home = mkdtempSync(join(tmpdir(), "headless-native-fork-"));
      try {
        const bin = join(home, "bin");
        mkdirSync(bin);
        const log = join(home, "calls.jsonl");
        const script = join(bin, agent);
        writeFileSync(script, `#!/usr/bin/env node
  const fs = require('node:fs');
  const args = process.argv.slice(2);
  if (args.includes('--version')) { console.log('1.18.33'); process.exit(0); }
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
  const id = ${JSON.stringify(outcome === "source-id" ? sourceId : childId)};
  const agent = ${JSON.stringify(agent)};
  if (${JSON.stringify(outcome)} === 'failed-before-child') process.exit(1);
  if (${JSON.stringify(outcome)} === 'no-id') process.exit(0);
  if (agent === 'codex') {
    console.log(JSON.stringify({type:'thread.started', thread_id:id}));
    console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'forked'}}));
  } else if (agent === 'claude') {
    console.log(JSON.stringify({type:'system',subtype:'init',session_id:id}));
    console.log(JSON.stringify({type:'result',result:'forked',session_id:id,is_error:false}));
  } else {
    console.log(JSON.stringify({type:'step_start',sessionID:id}));
    console.log(JSON.stringify({type:'text',sessionID:id,part:{type:'text',text:'forked'}}));
  }
  process.exit(${outcome === "failed-child" ? 1 : 0});
  `);
        chmodSync(script, 0o755);
        const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`,
          HEADLESS_CLAUDE_AUTH: "api", OPENAI_API_KEY: "fake", ANTHROPIC_API_KEY: "fake",
          AWS_ACCESS_KEY_ID: "fake", AWS_SECRET_ACCESS_KEY: "fake", AWS_REGION: "us-east-1" };
        writeStoredSession(env, { agent, alias: "base", nativeId: sourceId, workDir: home });
        writeStoredSession(env, { agent, alias: "child", nativeId: oldId });
        const original = readStoredSession(env, agent, "base");
        const progress = join(home, "progress.jsonl");
        const billing = agent === "opencode" ? [] : ["--billing", "api"];
        const args = [agent, "--session", "child", "--fork-from", "base", "--prompt", "Fork it.",
          ...billing, "--work-dir", home, "--progress-file", progress];
        const errors: string[] = [];
        const deps = { env, stdinIsTTY: true, stdout: () => {}, stderr: (s: string) => errors.push(s) };
        assert.equal(await runCli([...args, "--print-command"], deps), 0, errors.join(""));
        assert.equal(readStoredSession(env, agent, "child")?.nativeId, oldId);
        assert.equal(existsSync(log), false);
        assert.equal(await runCli(args, deps), outcome === "success" ? 0 : 1, errors.join(""));
        assert.deepEqual(readStoredSession(env, agent, "base"), original);
        const hasChild = outcome === "success" || outcome === "failed-child";
        assert.equal(readStoredSession(env, agent, "child")?.nativeId, hasChild ? childId : oldId);
        const events = readFileSync(progress, "utf8").trim().split("\n").map(JSON.parse);
        assert.equal(events.filter((e) => e.kind === "fork" && e.nativeId === childId).length, hasChild ? 1 : 0);
        assert.equal(events.at(-1)?.exitCode, outcome === "success" ? 0 : 1);
        if (outcome !== "success") return;
        assert.equal(await runCli([agent, "--session", "child", "--prompt", "Continue.",
          ...billing, "--work-dir", home], deps), 0, errors.join(""));
        const calls = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse) as string[][];
        assert.equal(calls.length, 2);
        if (agent === "opencode") {
          for (const call of calls) assert.equal(call[call.indexOf("--dir") + 1], home);
        }
        assert.ok(calls[0].includes(sourceId));
        assert.ok(calls[0].includes(agent === "codex" ? "fork" : agent === "claude" ? "--fork-session" : "--fork"));
        assert.ok(!calls[0].includes(oldId));
        assert.ok(calls[1].includes(childId));
        assert.ok(!calls[1].some((arg) => ["--fork", "--fork-session", "fork"].includes(arg)));
      } finally { rmSync(home, { recursive: true, force: true }); }
    });
  }
}

test("fork sources must exist, differ from the destination, and support native forks", () => {
  const home = mkdtempSync(join(tmpdir(), "headless-fork-source-"));
  try {
    assert.throws(() => forkSource("codex", "missing", "child", { HOME: home }), /no source conversation/);
    assert.throws(() => forkSource("codex", "base", "base", { HOME: home }), /must differ/);
    assert.throws(() => forkSource("pi", "base", "child", { HOME: home }), /not supported/);
    assert.throws(() => forkSource("codex", "../base", "child", { HOME: home }), /invalid/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("fork checkpoints ignore the source ID and publish only the distinct child", () => {
  const home = mkdtempSync(join(tmpdir(), "headless-fork-checkpoint-"));
  try {
    const saved: string[] = [];
    const checkpoint = new SessionCheckpoint("codex", { alias: "child", mode: "new" },
      { HOME: home }, home, assert.fail, sourceId, (id) => saved.push(id));
    checkpoint.feed(JSON.stringify({ type: "thread.started", thread_id: sourceId }) + "\n");
    assert.equal(readStoredSession({ HOME: home }, "codex", "child"), undefined);
    checkpoint.feed(JSON.stringify({ type: "thread.started", thread_id: childId }) + "\n");
    assert.deepEqual(saved, [childId]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
