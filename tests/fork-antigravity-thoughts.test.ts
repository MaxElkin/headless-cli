import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AntigravityThoughts } from "../src/fork/antigravity-thoughts.ts";

const envelope = (event: string, value = {}) => JSON.stringify({ event, ...value }) + "\n";
const thought = (thinking: string) => JSON.stringify({ source: "MODEL", type: "PLANNER_RESPONSE", thinking }) + "\n";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "headless-agy-thoughts-"));
  const transcript = (id: string) => {
    const logs = join(root, "brain", id, ".system_generated", "logs");
    mkdirSync(logs, { recursive: true });
    return join(logs, "transcript.jsonl");
  };
  return { root, transcript, env: { ANTIGRAVITY_HOME: root }, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("continued conversations skip history, pin identity and tolerate fragmented UTF-8 and native records", () => {
  const f = fixture();
  const chunks: string[] = [];
  const path = f.transcript("continued");
  writeFileSync(path, thought("old history"));
  writeFileSync(f.transcript("unrelated"), thought("another conversation"));
  const follow = new AntigravityThoughts(f.env, f.root, (text) => chunks.push(text), "continued");
  try {
    const next = Buffer.from(thought("fresh 🧠 thought"));
    const split = next.indexOf(Buffer.from("🧠")) + 2;
    appendFileSync(path, next.subarray(0, split));
    const init = envelope("init", { conversation_id: "continued" });
    follow.feed(init.slice(0, 11));
    follow.feed(init.slice(11));
    assert.deepEqual(chunks, []);
    appendFileSync(path, next.subarray(split));
    follow.feed(envelope("step_update"));
    follow.feed(envelope("result"));
    follow.stop();
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0], "fresh 🧠 thought");
  } finally { follow.stop(); f.cleanup(); }
});

test("a new conversation is followed when its transcript appears after init, without scanning neighbours", () => {
  const f = fixture();
  const chunks: string[] = [];
  writeFileSync(f.transcript("neighbour"), thought("unrelated"));
  const follow = new AntigravityThoughts(f.env, f.root, (text) => chunks.push(text));
  try {
    follow.feed(envelope("init", { conversation_id: "new-session" }));
    assert.deepEqual(chunks, []);
    writeFileSync(f.transcript("new-session"), thought("this conversation"));
    follow.feed(envelope("result"));
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0], "this conversation");
  } finally { follow.stop(); f.cleanup(); }
});
