import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  FIXED_ROWS,
  filterMatches,
  fuzzyMatch,
  isSubsequence,
  matchPositions,
  oneLine,
  renderOverlay,
} from "../search.ts";

const strip = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

const plain = {
  accent: (text: string) => text,
  border: (text: string) => text,
  dim: (text: string) => text,
  text: (text: string) => text,
  selected: (text: string) => text,
};

const view = (over: Partial<Parameters<typeof renderOverlay>[0]> = {}) => ({
  query: "",
  cursor: 0,
  matches: [] as string[],
  pointer: 0,
  listLines: 3,
  width: 64,
  widthOf: (text: string) => [...strip(text)].length,
  fit: (text: string, width: number) => {
    const bare = strip(text);
    return [...bare].length <= width ? text : [...bare].slice(0, width).join("");
  },
  paint: plain,
  ...over,
});

test("isSubsequence and fuzzyMatch", () => {
  assert.equal(isSubsequence("input", "in"), true);
  assert.equal(isSubsequence("input", "np"), true);
  assert.equal(isSubsequence("input", "pn"), false);
  assert.equal(fuzzyMatch("Add retry backoff", "retry back"), true);
  assert.equal(fuzzyMatch("Add retry backoff", ""), true);
  assert.equal(fuzzyMatch("Add retry backoff", "nope"), false);
  assert.deepEqual(filterMatches(["one", "two", "one two"], "two"), ["two", "one two"]);
});

test("matchPositions highlights the tightest span", () => {
  // `in` in "input" is one run, not the `i` of "pi" plus a later `n`.
  assert.deepEqual([...matchPositions("input", "in")].sort((a, b) => a - b), [0, 1]);
  assert.deepEqual([...matchPositions("prefix", "fix")].sort((a, b) => a - b), [3, 4, 5]);
  assert.equal(matchPositions("input", "zz").size, 0);
});

test("oneLine keeps the row single-line without moving the match positions", () => {
  const text = "first\nsecond\tthird";
  assert.equal(oneLine(text).length, text.length);
  assert.equal(oneLine(text).includes("\n"), false);
  assert.deepEqual([...matchPositions(oneLine(text), "third")], [13, 14, 15, 16, 17]);
});

test("renderOverlay draws a closed box of the requested width", () => {
  const rows = renderOverlay(view({ listLines: 3, matches: ["one", "two", "three"], query: "" }));
  assert.equal(rows.length, 3 + FIXED_ROWS, "list rows plus the fixed panel rows");
  assert.match(strip(rows[0] ?? ""), /^╭─ History Search /);
  assert.match(strip(rows.at(-1) ?? ""), /^╰─+╯$/);
  for (const row of rows) {
    assert.equal(strip(row).length, 64, row);
    assert.equal(row.includes("\n"), false, row);
  }
  assert.equal(strip(rows[0] ?? "").endsWith("╮"), true);
});

test("renderOverlay marks the selection and shows the counter", () => {
  const rows = renderOverlay(view({ matches: ["alpha", "beta"], pointer: 1, query: "" }));
  const body = rows.map(strip);
  assert.match(body[1] ?? "", /\[2\/2\]/);
  assert.equal(body.filter((row) => row.includes("▸")).length, 1);
  assert.match(body.find((row) => row.includes("▸")) ?? "", /beta/);
});

test("renderOverlay highlights matched characters", () => {
  const rows = renderOverlay(view({ query: "ret", matches: ["Add retry backoff"] }));
  const row = rows.find((line) => strip(line).includes("retry")) ?? "";
  assert.match(row, /\x1b\[4m/, "the matched run is underlined");
  assert.match(strip(row), /▸ Add retry backoff/);
});

test("renderOverlay keeps a long match inside the box", () => {
  const rows = renderOverlay(view({ width: 24, matches: ["x".repeat(200)], query: "" }));
  for (const row of rows) assert.equal(strip(row).length, 24, row);
});

test("renderOverlay draws the cursor where it is, not at the end", () => {
  const rows = renderOverlay(view({ query: "abc", cursor: 1, matches: ["zzz"] }));
  assert.match(strip(rows[1] ?? ""), /> a▌bc/);
});

test("renderOverlay scrolls a long query to keep the cursor visible", () => {
  const long = `${"x".repeat(200)}tail`;
  const rows = renderOverlay(view({ width: 30, query: long, cursor: long.length, matches: [] }));
  const query = strip(rows[1] ?? "");
  assert.ok(query.includes("▌"), query);
  assert.equal(query.length, 30, query);
});

test("the hint rows name the emacs keys", () => {
  const hints = renderOverlay(view({ matches: ["one"] }))
    .map(strip)
    .join("\n");
  for (const key of ["C-j", "C-g", "C-n/C-p", "C-a/C-e", "C-k", "C-r"]) assert.ok(hints.includes(key), key);
});

test("renderOverlay reports an empty pool and an empty search", () => {
  assert.match(strip(renderOverlay(view({ matches: [], query: "zz" }))[3] ?? ""), /no match/);
  assert.match(strip(renderOverlay(view({ matches: [], query: "" }))[3] ?? ""), /no history yet/);
  assert.doesNotMatch(strip(renderOverlay(view({ matches: [] }))[1] ?? ""), /\[\d+\/\d+\]/, "a zero counter is noise");
});
