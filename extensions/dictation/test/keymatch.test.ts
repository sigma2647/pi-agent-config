import { strict as assert } from "node:assert";
import { test } from "node:test";
import { matchesKeybind, type EditorHelpers } from "../ui.ts";

/**
 * pi-tui's real behaviour: a function key matches only in its legacy form, a
 * ctrl+letter in its Kitty `CSI u` form.
 */
const helpers = {
  matchesKey: (data: string, key: string) =>
    (key === "f7" && data === "\x1b[18~") || (key === "ctrl+r" && data === "\x1b[114;5u"),
} as unknown as EditorHelpers;

test("matchesKeybind accepts a Kitty-protocol function key", () => {
  assert.equal(matchesKeybind(helpers, "\x1b[18~", "f7"), true, "legacy press");
  assert.equal(matchesKeybind(helpers, "\x1b[18;1~", "f7"), true, "Kitty press, modifier field only");
  assert.equal(matchesKeybind(helpers, "\x1b[18;1:1~", "f7"), true, "Kitty press");
  assert.equal(matchesKeybind(helpers, "\x1b[18;1:2~", "f7"), true, "Kitty auto-repeat");
  assert.equal(matchesKeybind(helpers, "\x1b[18;1:3~", "f7"), true, "Kitty release");
});

test("matchesKeybind leaves other keys alone", () => {
  assert.equal(matchesKeybind(helpers, "\x1b[18;5~", "f7"), false, "ctrl+F7 is a different key");
  assert.equal(matchesKeybind(helpers, "\x1b[114;5u", "ctrl+r"), true, "Kitty ctrl+r still matches");
  assert.equal(matchesKeybind(helpers, "a", "f7"), false);
  assert.equal(matchesKeybind(helpers, "\x1b[18~", "escape"), false);
});
