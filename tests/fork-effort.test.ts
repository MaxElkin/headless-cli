import assert from "node:assert/strict";
import test from "node:test";

import { runCli } from "../src/cli.ts";
import { parseHeadlessConfig, resolveInvocationDefaults } from "../src/config.ts";

test("max effort reaches OpenCode as its native variant through the CLI", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli([
    "opencode", "--model", "opencode/deepseek-v4.1-flash", "--effort", "max",
    "--session", "worker", "--checkpoint-session", "--allow", "project",
    "--prompt", "Preview only", "--print-command",
  ], { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) });
  assert.equal(code, 0, stderr.join(""));
  assert.match(stdout.join(""), /--variant max/);
  assert.match(stdout.join(""), /--model opencode\/deepseek-v4\.1-flash/);
});

test("max effort also survives config defaults", () => {
  const config = parseHeadlessConfig('[agents.opencode]\nreasoning_effort = "max"\n');
  assert.equal(resolveInvocationDefaults("opencode", undefined, {}, {}, config).reasoningEffort, "max");
});
