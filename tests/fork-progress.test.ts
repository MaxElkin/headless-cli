import assert from "node:assert/strict";
import test from "node:test";

import { runCli } from "../src/cli.ts";
import { withForkProgressArgs } from "../src/fork/progress.ts";

async function printed(argv: string[]) {
  const out: string[] = [];
  const code = await runCli([...argv, "--print-command"], {
    stdout: (text) => out.push(text),
    stderr: () => undefined,
  });
  return { code, out: out.join("") };
}

test("codex is asked for its reasoning when the run is watched", async () => {
  const watched = await printed(["codex", "--prompt", "hi", "--progress"]);
  assert.equal(watched.code, 0);
  assert.match(watched.out, /model_reasoning_summary="detailed"/);
  // Before the `-` that says the prompt comes on stdin.
  assert.ok(watched.out.indexOf("model_reasoning_summary") < watched.out.lastIndexOf(" -"));

  const unwatched = await printed(["codex", "--prompt", "hi"]);
  assert.doesNotMatch(unwatched.out, /model_reasoning_summary/);
});

test("other agents are left as they are", () => {
  const built = { command: "claude", args: ["-p", "hi"] };
  assert.deepEqual(withForkProgressArgs("claude", built, true), built);
  assert.deepEqual(withForkProgressArgs("codex", { command: "codex", args: ["exec", "-"] }, false),
    { command: "codex", args: ["exec", "-"] });
});
