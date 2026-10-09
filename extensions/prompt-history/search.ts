/**
 * Search internals: matching and rendering. Pure — no pi imports, so it runs
 * under plain `node --test`.
 *
 * `renderOverlay` draws the whole floating panel (border, title, query, list,
 * hints). The caller supplies the theme colors and pi-tui's width helpers, so
 * nothing here depends on pi.
 */

const CURSOR = "▌";
const UNDERLINE_ON = "\x1b[4m";
const UNDERLINE_OFF = "\x1b[24m";
const TITLE = "History Search";

/** Upper bound on list rows; the caller clamps further by terminal height. */
export const MAX_LIST_LINES = 10;

/** Rows the panel spends besides the list: two rules, the query, two separators and two hint rows. */
export const FIXED_ROWS = 7;

export type SearchPaint = {
  accent(text: string): string;
  border(text: string): string;
  dim(text: string): string;
  text(text: string): string;
  /** Background for the selected row. */
  selected(text: string): string;
};

export type OverlayView = {
  query: string;
  /** Cursor position inside `query`, 0..query.length. */
  cursor: number;
  /** Matches, newest first. */
  matches: readonly string[];
  /** Index into `matches`: the selected row. */
  pointer: number;
  /** Rows available for the list. */
  listLines: number;
  /** Total columns for the panel. */
  width: number;
  widthOf(text: string): number;
  fit(text: string, width: number): string;
  paint: SearchPaint;
};

/** Every character of `needle` appears in `haystack`, in order. */
export const isSubsequence = (haystack: string, needle: string): boolean => {
  let at = 0;
  for (const char of needle) {
    at = haystack.indexOf(char, at);
    if (at === -1) return false;
    at += 1;
  }
  return true;
};

/** Every whitespace-separated token of `query` is a subsequence of `item`. */
export const fuzzyMatch = (item: string, query: string): boolean => {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const haystack = item.toLowerCase();
  return tokens.every((token) => isSubsequence(haystack, token));
};

export const filterMatches = (items: readonly string[], query: string): string[] =>
  items.filter((item) => fuzzyMatch(item, query));

/**
 * Char indices of one token in `text`, using the tightest span — so `in` in
 * "input" highlights `in`, not the `i` of "pi" plus some later `n`.
 */
const bestSpan = (text: string, token: string): number[] => {
  const positions: number[][] = [];
  for (const char of token) {
    const indices: number[] = [];
    for (let i = 0; i < text.length; i += 1) if (text[i] === char) indices.push(i);
    if (indices.length === 0) return [];
    positions.push(indices);
  }

  let best: number[] = [];
  let bestWidth = Number.POSITIVE_INFINITY;
  for (const first of positions[0] ?? []) {
    const span = [first];
    let previous = first;
    let complete = true;
    for (let tokenIndex = 1; tokenIndex < positions.length; tokenIndex += 1) {
      const next = positions[tokenIndex]?.find((index) => index > previous);
      if (next === undefined) {
        complete = false;
        break;
      }
      span.push(next);
      previous = next;
    }
    if (!complete) continue;
    const width = (span.at(-1) ?? first) - first;
    if (width < bestWidth) {
      bestWidth = width;
      best = span;
    }
  }
  return best;
};

/** Char indices in `text` matched by `query`, one tightest span per token. */
export const matchPositions = (text: string, query: string): Set<number> => {
  const found = new Set<number>();
  const haystack = text.toLowerCase();
  for (const token of query.toLowerCase().split(/\s+/).filter(Boolean)) {
    for (const index of bestSpan(haystack, token)) found.add(index);
  }
  return found;
};

/** Accent + underline for matched characters, plain text elsewhere. */
export const highlight = (text: string, positions: ReadonlySet<number>, paint: SearchPaint): string => {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const matched = positions.has(i);
    let end = i + 1;
    while (end < text.length && positions.has(end) === matched) end += 1;
    const run = text.slice(i, end);
    out += matched ? `${UNDERLINE_ON}${paint.accent(run)}${UNDERLINE_OFF}` : paint.text(run);
    i = end;
  }
  return out;
};

/**
 * One row per entry: newlines and tabs become spaces **one character for one
 * character**, so the match positions stay valid and a row can never break the
 * panel's height.
 */
export const oneLine = (text: string): string => text.replace(/[\u0000-\u001f\u007f]/g, " ");

/** The floating panel: border, title, query, list, hints. */
export const renderOverlay = (view: OverlayView): string[] => {
  const { paint, width } = view;
  const inner = Math.max(4, width - 4); // "│ " … " │"
  const total = view.matches.length;
  const pointer = total === 0 ? 0 : Math.min(Math.max(view.pointer, 0), total - 1);

  const rows: string[] = [];
  const border = (text: string): string => paint.border(text);
  const rule = (left: string, right: string): string => border(`${left}${"─".repeat(Math.max(0, width - 2))}${right}`);

  // Title sits in the top rule, the way the floating panels in pi do it.
  const label = ` ${TITLE} `;
  const topFill = Math.max(0, width - 3 - view.widthOf(label));
  rows.push(`${border("╭─")}${paint.accent(label)}${border(`${"─".repeat(topFill)}╮`)}`);

  const content = (text: string, selected = false): string => {
    const clipped = view.fit(text, inner);
    const padded = clipped + " ".repeat(Math.max(0, inner - view.widthOf(clipped)));
    return `${border("│ ")}${selected ? paint.selected(padded) : padded}${border(" │")}`;
  };

  // Query line: the typed text on the left, the counter flush right.
  const at = Math.min(Math.max(view.cursor, 0), view.query.length);
  const counter = total === 0 ? "" : paint.dim(`[${pointer + 1}/${total}]`);
  const room = Math.max(4, inner - view.widthOf(counter) - 1);
  // Keep the cursor on screen: a long query scrolls instead of losing its tail
  // (and with it the cursor).
  const textRoom = Math.max(1, room - 2); // "> "
  const windowStart = Math.max(0, at - Math.floor(textRoom / 2));
  const visible = view.query.slice(windowStart, windowStart + textRoom);
  const cursorAt = Math.max(0, Math.min(at - windowStart, visible.length));
  const typed = `${paint.accent("> ")}${visible.slice(0, cursorAt)}${paint.accent(
    CURSOR,
  )}${visible.slice(cursorAt)}`;
  const gap = Math.max(1, inner - view.widthOf(typed) - view.widthOf(counter));
  rows.push(
    `${border("│ ")}${view.fit(typed, room)}${" ".repeat(Math.max(1, gap))}${counter}${border(" │")}`,
  );
  rows.push(rule("├", "┤"));

  // List window: keep the selected row near the middle.
  const listLines = Math.max(1, view.listLines);
  const start = Math.max(0, Math.min(pointer - Math.floor(listLines / 2), Math.max(0, total - listLines)));
  for (let index = 0; index < listLines; index += 1) {
    const position = start + index;
    const match = view.matches[position];
    if (match === undefined) {
      rows.push(content(total === 0 && index === 0 ? emptyHint(total, view.query, paint) : ""));
      continue;
    }
    const text = oneLine(match);
    const marker = position === pointer ? paint.accent("▸ ") : paint.dim("  ");
    rows.push(content(`${marker}${highlight(text, matchPositions(text, view.query), paint)}`, position === pointer));
  }

  rows.push(rule("├", "┤"));
  rows.push(content(paint.dim("C-n/C-p move · Enter/C-j select · C-r repeat")));
  rows.push(content(paint.dim("C-a/C-e line ends · C-k kill · Esc/C-g cancel")));
  rows.push(rule("╰", "╯"));
  return rows.map((row) => view.fit(row, width));
};

const emptyHint = (total: number, query: string, paint: SearchPaint): string =>
  paint.dim(total === 0 && query !== "" ? "no match" : "no history yet");
