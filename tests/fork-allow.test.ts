import assert from "node:assert/strict";
import test from "node:test";

import { buildAgentCommand, buildInteractiveAgentCommand, buildInteractiveOpencodeRun } from "../src/agents.ts";
import { runCli } from "../src/cli.ts";
import { parseHeadlessConfig, resolveInvocationDefaults } from "../src/config.ts";
import { buildWithForkAllow } from "../src/fork/allow.ts";

const permissionFlags =
  /^(--dangerously-skip-permissions|--dangerously-bypass-approvals-and-sandbox|--force|--approval-mode|--permission-mode|--allowedTools|--sandbox|-c)$/;

test("project mode passes no permission flags so agents use their own config", () => {
  for (const agent of ["antigravity", "claude", "codex", "cursor", "gemini", "opencode"] as const) {
    for (const build of [buildAgentCommand, buildInteractiveAgentCommand]) {
      const command = build(agent, { prompt: "hello", allow: "project", workDir: "/work" }, {});
      assert.deepEqual(command.args.filter((arg) => permissionFlags.test(arg)), [], `${agent} ${build.name}`);
      assert.equal(command.env?.OPENCODE_CONFIG_CONTENT, undefined);
    }
  }
});

test("ask mode routes sandbox escapes to the user", () => {
  assert.deepEqual(buildAgentCommand("claude", { prompt: "hello", allow: "ask" }, {}).args, [
    "--permission-mode",
    "acceptEdits",
    "--model",
    "claude-opus-4-6",
    "-p",
    "hello",
    "--output-format",
    "stream-json",
    "--verbose",
  ]);
  assert.deepEqual(buildInteractiveAgentCommand("claude", { prompt: "hello", allow: "ask" }, {}).args, [
    "--permission-mode",
    "acceptEdits",
    "--model",
    "claude-opus-4-6",
    "hello",
  ]);
  assert.deepEqual(buildAgentCommand("codex", { prompt: "hello", allow: "ask" }, {}).args, [
    "-c",
    'approvals_reviewer="user"',
    "exec",
    "--model",
    "gpt-5.5",
    "--json",
    "--skip-git-repo-check",
    "-",
  ]);
  assert.deepEqual(buildInteractiveAgentCommand("codex", { prompt: "hello", allow: "ask" }, {}).args, [
    "-c",
    'approvals_reviewer="user"',
    "--model",
    "gpt-5.5",
    "hello",
  ]);
  assert.deepEqual(buildAgentCommand("gemini", { prompt: "hello", allow: "ask" }, {}).args, [
    "--approval-mode",
    "auto_edit",
    "--model",
    "gemini-3.1-pro-preview",
    "--skip-trust",
    "-p",
    "hello",
    "--output-format",
    "stream-json",
  ]);
  assert.deepEqual(buildInteractiveAgentCommand("cursor", { prompt: "hello", allow: "ask" }, {}).args, [
    "--model",
    "gpt-5.5-medium",
    "hello",
  ]);
  assert.deepEqual(buildInteractiveAgentCommand("opencode", { prompt: "hello", allow: "ask" }, {}), {
    command: "opencode",
    args: ["--model", "openai/gpt-5.4"],
  });
});

test("auto mode routes sandbox escapes to the agent's AI reviewer", () => {
  assert.deepEqual(buildInteractiveAgentCommand("claude", { prompt: "hello", allow: "auto" }, {}).args, [
    "--permission-mode",
    "auto",
    "--model",
    "claude-opus-4-6",
    "hello",
  ]);
  assert.deepEqual(buildAgentCommand("codex", { prompt: "hello", allow: "auto" }, {}).args.slice(0, 3), [
    "-c",
    'approvals_reviewer="auto_review"',
    "exec",
  ]);
  assert.deepEqual(buildInteractiveAgentCommand("codex", { prompt: "hello", allow: "auto" }, {}).args.slice(0, 2), [
    "-c",
    'approvals_reviewer="auto_review"',
  ]);
});

test("rejects fork modes for agents that cannot honor them", () => {
  for (const agent of ["antigravity", "cursor", "gemini", "opencode", "pi", "acp"] as const) {
    assert.throws(
      () => buildAgentCommand(agent, { prompt: "hello", allow: "auto" }, {}),
      /--allow auto is supported only by claude, codex/,
    );
  }
  assert.throws(
    () => buildWithForkAllow("opencode", { prompt: "hello", allow: "auto" }, buildInteractiveOpencodeRun),
    /--allow auto is supported only by claude, codex/,
  );
  for (const agent of ["pi", "acp"] as const) {
    for (const allow of ["project", "ask"] as const) {
      assert.throws(
        () => buildInteractiveAgentCommand(agent, { prompt: "hello", allow }, {}),
        new RegExp(`--allow ${allow} is supported only by`),
      );
    }
  }
});

test("CLI accepts fork modes and rejects auto for agents without an AI reviewer", async () => {
  const stdout: string[] = [];
  assert.equal(
    await runCli(["codex", "--tmux", "--allow", "auto", "--prompt", "hello", "--print-command"], {
      stdout: (text) => stdout.push(text),
    }),
    0,
  );
  assert.match(stdout.join(""), /codex -c '\\''approvals_reviewer="auto_review"'\\''/);

  const stderr: string[] = [];
  assert.equal(
    await runCli(["opencode", "--tmux", "--allow", "auto", "--prompt", "hello", "--print-command"], {
      stderr: (text) => stderr.push(text),
    }),
    2,
  );
  assert.match(stderr.join(""), /--allow auto is supported only by claude, codex/);
});

test("config [general] allow sets the default below roles and explicit flags", () => {
  const config = parseHeadlessConfig('[general]\nallow = "project"\n');

  assert.equal(config.general.allow, "project");
  assert.equal(resolveInvocationDefaults("claude", undefined, {}, {}, config).allow, "project");
  assert.equal(resolveInvocationDefaults("claude", undefined, { allow: "auto" }, {}, config).allow, "auto");
  assert.equal(resolveInvocationDefaults("claude", "reviewer", {}, {}, config).allow, "read-only");
  assert.equal(
    resolveInvocationDefaults(
      "claude",
      "worker",
      {},
      {},
      parseHeadlessConfig('[general]\nallow = "project"\n[roles.worker]\nallow = "ask"\n'),
    ).allow,
    "ask",
  );
  assert.throws(() => parseHeadlessConfig('[general]\nallow = "maybe"\n'), /unsupported headless config allow at line 2: maybe/);
});
