import { strict as assert } from "node:assert";
import { test } from "node:test";
import { extractText, mergeNewestFirst, promptsOf } from "../prompts.ts";

test("extractText reads plain and multi-part user messages", () => {
  assert.equal(extractText("hello"), "hello");
  assert.equal(extractText("  spaced  "), "spaced");
  assert.equal(extractText([{ type: "image" }, { type: "text", text: "with image" }]), "with image");
  assert.equal(extractText("   "), undefined);
  assert.equal(extractText([]), undefined);
  assert.equal(extractText(undefined), undefined);
});

test("promptsOf keeps user prompts in order and drops everything else", () => {
  const entries = [
    { type: "message", message: { role: "user", content: "first" } },
    { type: "message", message: { role: "assistant", content: "reply" } },
    { type: "message", message: { role: "tool", content: "output" } },
    { type: "label" },
    { type: "message", message: { role: "user", content: [{ type: "text", text: "second" }] } },
    { type: "message", message: { role: "user", content: "   " } },
  ];
  assert.deepEqual(promptsOf(entries), ["first", "second"]);
});

test("mergeNewestFirst drops repeats, first list wins", () => {
  assert.deepEqual(mergeNewestFirst(["b", "a"], ["a", "c"]), ["b", "a", "c"]);
  assert.deepEqual(mergeNewestFirst([], []), []);
});
