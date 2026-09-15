/**
 * Key-event decoding for `pi-dictation keytest`.
 *
 * Hold-to-talk needs the terminal to report key *release* events, which only
 * happens when the Kitty keyboard protocol is negotiated with the "report event
 * types" flag (bit 2). Whether that works depends on the terminal AND on
 * anything in between (tmux swallows release events even with
 * `extended-keys on`). This module turns raw terminal bytes into a readable
 * list so a user can see what their setup actually sends.
 */

export type KeyEventType = "press" | "repeat" | "release";

export type DecodedKey = {
  raw: string;
  label: string;
  type: KeyEventType;
  /** Codepoint for CSI-u sequences, undefined for legacy bytes. */
  codepoint?: number;
  ctrl?: boolean;
};

const EVENT_TYPES: Record<string, KeyEventType> = { "2": "repeat", "3": "release" };

const SPECIAL: Record<number, string> = { 13: "enter", 27: "escape", 32: "space", 9: "tab", 127: "backspace" };

/** Decode one chunk of terminal input into key events. Unknown bytes are reported raw. */
export const decodeKeyEvents = (data: string): DecodedKey[] => {
  const events: DecodedKey[] = [];
  const csiU = /\x1b\[(\d+)(?:;(\d+))?(?::(\d+))?u/g;
  let cursor = 0;

  for (const match of data.matchAll(csiU)) {
    const index = match.index ?? 0;
    if (index > cursor) events.push(...legacyEvents(data.slice(cursor, index)));
    cursor = index + match[0].length;

    const codepoint = Number.parseInt(match[1] ?? "0", 10);
    const modifiers = Number.parseInt(match[2] ?? "1", 10);
    const ctrl = Math.floor((modifiers - 1) / 4) % 2 === 1;
    const name = SPECIAL[codepoint] ?? String.fromCodePoint(codepoint);
    events.push({
      raw: match[0],
      label: `${ctrl ? "ctrl+" : ""}${name}`,
      type: EVENT_TYPES[match[3] ?? "1"] ?? "press",
      codepoint,
      ctrl,
    });
  }

  if (cursor < data.length) events.push(...legacyEvents(data.slice(cursor)));
  return events;
};

/** Legacy (non-CSI-u) bytes: control codes and printable text. */
const legacyEvents = (chunk: string): DecodedKey[] =>
  [...chunk].map((char) => {
    const code = char.codePointAt(0) ?? 0;
    if (code === 13) return { raw: char, label: "enter", type: "press" as const, ctrl: false };
    if (code === 27) return { raw: char, label: "escape", type: "press" as const, ctrl: false };
    if (code > 0 && code < 27) return { raw: char, label: `ctrl+${String.fromCharCode(code + 96)}`, type: "press" as const, ctrl: true };
    if (code < 32) return { raw: char, label: `0x${code.toString(16)}`, type: "press" as const, ctrl: false };
    return { raw: char, label: JSON.stringify(char), type: "press" as const, ctrl: false };
  });

/** Parse the terminal's reply to `CSI > 7 u` (kitty keyboard protocol flags). */
export const parseKittyFlags = (data: string): number | undefined => {
  const match = /\x1b\[\?(\d+)u/.exec(data);
  if (!match) return undefined;
  const flags = Number.parseInt(match[1] ?? "0", 10);
  return Number.isFinite(flags) ? flags : undefined;
};

export const supportsKeyRelease = (flags: number | undefined): boolean => flags !== undefined && (flags & 2) !== 0;

export type KeytestVerdict = {
  sawRelease: boolean;
  sawPress: boolean;
  repeatedSameKey: boolean;
  text: string;
};

export const keytestVerdict = (events: DecodedKey[], flags: number | undefined, key = "ctrl+r"): KeytestVerdict => {
  const forKey = events.filter((event) => event.label === key);
  const sawRelease = forKey.some((event) => event.type === "release");
  const sawPress = forKey.some((event) => event.type === "press");
  const repeatedSameKey = forKey.some((event) => event.type === "repeat");

  if (!sawPress) {
    return { sawRelease, sawPress, repeatedSameKey, text: `没有检测到 ${key}：请在小工具运行期间按几次 ${key}` };
  }
  if (sawRelease && supportsKeyRelease(flags)) {
    return { sawRelease, sawPress, repeatedSameKey, text: `可以长按：终端上报真实的松开事件，默认的 hold（keybindMode）直接用它` };
  }
  if (sawRelease) {
    return { sawRelease, sawPress, repeatedSameKey, text: `收到松开事件，但终端没有声明支持（flags 缺 bit2）：hold 可用，以收到的松开事件为准` };
  }
  return {
    sawRelease,
    sawPress,
    repeatedSameKey,
    text: `这个终端不上报按键松开（${flags === undefined ? "未答复键盘协议查询" : `flags=${flags}`}）：默认的 hold 仍可用——靠按键重复的间隔判断松手（第一次 800 毫秒，之后 300 毫秒）；tmux 会吞掉松开事件，想看真实事件就在 ghostty 里直接跑 pi`,
  };
};
