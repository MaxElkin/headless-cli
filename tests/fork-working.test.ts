import assert from "node:assert/strict";
import test from "node:test";

import { elapsed, WorkingLine } from "../src/fork/working.ts";

const CLEAR = "\r\u001b[2K";

test("the time is in seconds, then minutes and seconds", () => {
  assert.equal(elapsed(0), "0s");
  assert.equal(elapsed(12_900), "12s");
  assert.equal(elapsed(59_999), "59s");
  assert.equal(elapsed(185_000), "3m 05s");
});

test("the line counts from what was last written, and is cleared before the next", () => {
  const out: string[] = [];
  let now = 1_000;
  const line = new WorkingLine((text) => out.push(text), () => now);
  line.start();
  now += 12_000;
  line.draw();
  line.write("🔧 Bash(ls)\n");
  now += 3_000;
  line.draw();
  line.stop();
  assert.deepEqual(out, [
    `${CLEAR}⏳ Working… 0s`,
    `${CLEAR}⏳ Working… 12s`,
    CLEAR,
    "🔧 Bash(ls)\n",
    `${CLEAR}⏳ Working… 0s`,
    `${CLEAR}⏳ Working… 3s`,
    CLEAR,
  ]);
});

test("a line left unfinished is not drawn over", () => {
  const out: string[] = [];
  const line = new WorkingLine((text) => out.push(text), () => 0);
  line.start();
  line.write("partial");
  line.draw();
  line.stop();
  assert.deepEqual(out, [`${CLEAR}⏳ Working… 0s`, CLEAR, "partial"]);
});
