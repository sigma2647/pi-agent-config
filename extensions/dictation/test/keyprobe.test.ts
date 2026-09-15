import { strict as assert } from "node:assert";
import { test } from "node:test";
import { decodeKeyEvents, keytestVerdict, parseKittyFlags, supportsKeyRelease } from "../keyprobe.ts";

const PRESS = "\x1b[114;5u";
const REPEAT = "\x1b[114;5:2u";
const RELEASE = "\x1b[114;5:3u";

test("decodes kitty press, repeat and release events for ctrl+r", () => {
  assert.deepEqual(
    decodeKeyEvents(`${PRESS}${REPEAT}${RELEASE}`).map((event) => [event.label, event.type]),
    [
      ["ctrl+r", "press"],
      ["ctrl+r", "repeat"],
      ["ctrl+r", "release"],
    ],
  );
});

test("decodes a legacy ctrl+r byte as a press", () => {
  const [event] = decodeKeyEvents("\u0012");
  assert.equal(event?.label, "ctrl+r");
  assert.equal(event?.type, "press");
});

test("decodes plain text and special keys", () => {
  assert.deepEqual(
    decodeKeyEvents("hi\r").map((event) => event.label),
    ['"h"', '"i"', "enter"],
  );
  assert.equal(decodeKeyEvents("\x1b[13;2u")[0]?.label, "enter");
});

test("decodes shift+ctrl combinations", () => {
  // modifiers 6 = shift+ctrl
  const [event] = decodeKeyEvents("\x1b[114;6u");
  assert.equal(event?.label, "ctrl+r");
  assert.equal(event?.ctrl, true);
});

test("parses the kitty protocol flag reply", () => {
  assert.equal(parseKittyFlags("\x1b[?7u"), 7);
  assert.equal(parseKittyFlags("\x1b[?0u"), 0);
  assert.equal(parseKittyFlags("no reply here"), undefined);
});

test("only flag bit 2 means key releases are reported", () => {
  assert.equal(supportsKeyRelease(7), true);
  assert.equal(supportsKeyRelease(3), true);
  assert.equal(supportsKeyRelease(1), false);
  assert.equal(supportsKeyRelease(0), false);
  assert.equal(supportsKeyRelease(undefined), false);
});

test("verdict recommends hold only when releases actually arrive", () => {
  const withRelease = decodeKeyEvents(`${PRESS}${RELEASE}`);
  assert.match(keytestVerdict(withRelease, 7).text, /可以长按/);
  // Releases arrive but the terminal never declared bit 2: the events still
  // win, so hold works — the verdict must not send the user to toggle.
  assert.match(keytestVerdict(withRelease, 1).text, /hold 可用/);
  assert.doesNotMatch(keytestVerdict(withRelease, 1).text, /toggle/);

  const pressOnly = decodeKeyEvents(PRESS);
  const verdict = keytestVerdict(pressOnly, undefined);
  assert.equal(verdict.sawRelease, false);
  // No releases: hold survives on gap detection, so the verdict explains that
  // instead of telling the user to switch modes.
  assert.match(verdict.text, /不上报按键松开/);
  assert.match(verdict.text, /间隔判断松手/);
  assert.doesNotMatch(verdict.text, /保持 keybindMode/);
});

test("verdict reports when the key was never pressed", () => {
  assert.match(keytestVerdict([], 7).text, /没有检测到/);
});
