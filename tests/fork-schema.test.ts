import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.ts";
import {
  forkSchemaRoute, loadForkSchema, validateForkSchema, withForkSchemaArgs, withForkSchemaPrompt,
} from "../src/fork/schema.ts";

const SCHEMA = '{"type":"object","properties":{"platform":{"enum":["All","Desktop"]}}}';

async function printed(argv: string[]) {
  const out: string[] = [];
  const stderr: string[] = [];
  const code = await runCli([...argv, "--print-command"], {
    stdout: (text) => out.push(text),
    stderr: (text) => stderr.push(text),
  });
  return { code, out: out.join(""), stderr: stderr.join("") };
}

test("a harness with a schema flag is given the schema through it", async () => {
  const claude = await printed(["claude", "--prompt", "hi", "--json-schema", SCHEMA]);
  assert.equal(claude.code, 0);
  assert.match(claude.out, /--json-schema/);
  assert.match(claude.out, /"platform"/);
  // ...and the prompt is left as the caller wrote it.
  assert.doesNotMatch(claude.out, /matching this JSON Schema/);
});

test("codex takes a file, which holds the schema", async () => {
  const codex = await printed(["codex", "--prompt", "hi", "--json-schema", SCHEMA]);
  const found = /--output-schema (\S+)/.exec(codex.out);
  assert.ok(found, codex.out);
  assert.deepEqual(JSON.parse(readFileSync(found[1], "utf8")), JSON.parse(SCHEMA));
  // The flag goes where codex reads flags: before the `-` that says the
  // prompt comes on stdin, which is a positional and not a flag's value.
  assert.ok(codex.out.indexOf("--output-schema") < codex.out.lastIndexOf(" -"));
});

test("a harness without one is asked in the prompt, and says so", async () => {
  const opencode = await printed(["opencode", "--prompt", "hi", "--json-schema", SCHEMA]);
  assert.equal(opencode.code, 0);
  assert.doesNotMatch(opencode.out, /--json-schema/);
  assert.match(opencode.out, /matching this JSON Schema/);
  assert.equal(forkSchemaRoute("opencode"), "prompt");
});

test("the schema may be a file as well as JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-schema-in-"));
  try {
    const path = join(dir, "reply.json");
    writeFileSync(path, `${SCHEMA}\n`);
    assert.deepEqual(loadForkSchema(path)?.value, JSON.parse(SCHEMA));
    assert.equal(loadForkSchema(undefined), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a schema that is not one is refused before anything is launched", () => {
  assert.throws(() => loadForkSchema("{oops"), /not valid JSON/);
  assert.throws(() => loadForkSchema("[]"), /must be a JSON object/);
  assert.throws(() => loadForkSchema("/no/such/schema.json"), /file not found/);
  assert.throws(() => loadForkSchema("  "), /needs a JSON schema/);
});

test("it is refused where there is no reply to hold to a shape", () => {
  const base = { agent: "claude" as const, forkJsonSchema: SCHEMA };
  assert.throws(() => validateForkSchema({ ...base, tmux: true }), /interactive session/);
  assert.throws(() => validateForkSchema({ ...base, forkAttach: true }), /interactive session/);
  assert.throws(() => validateForkSchema({ ...base, docker: true }), /--docker or --modal/);
  assert.throws(() => validateForkSchema({ ...base, modal: true }), /--docker or --modal/);
  assert.throws(
    () => validateForkSchema({ agent: "opencode", forkJsonSchema: SCHEMA, promptFile: "/p.md" }),
    /--prompt-file/,
  );
  // A harness with a flag needs nothing of the prompt, so a prompt file is fine.
  validateForkSchema({ ...base, promptFile: "/p.md" });
  validateForkSchema({ agent: "claude" });
});

test("nothing happens without a schema", () => {
  const built = { command: "codex", args: ["exec", "-"] };
  assert.deepEqual(withForkSchemaArgs("codex", built, undefined), built);
  assert.equal(withForkSchemaPrompt("opencode", "hi", undefined), "hi");
});
