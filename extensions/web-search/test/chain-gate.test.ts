// Weak-result escalation gate — chain.ts.
//
// Run: node --experimental-strip-types --no-warnings --test extensions/web-search/test/chain-gate.test.ts
//
// The gate exists because a non-empty set used to stop the chain: measured
// 2026-10-09 (/tmp/web-token-bench/REPORT.md, test 1) a Chinese query ended on a
// thin Brave set and the browser-probe fallback never ran. These cases pin the
// two halves — a weak first entry escalates, a strong one still stops.

import { test } from "node:test";
import assert from "node:assert/strict";
import { registerBackend, runChain } from "../chain.ts";
import { isStrongResultSet } from "../validate.ts";
import type { Backend, SearchResult } from "../backends/types.ts";

// Five tokens: pi, coding, agent, subagents, extension.
const QUERY = "pi coding agent subagents extension";

function row(title: string, snippet = ""): SearchResult {
  return { title, url: `https://example.com/${encodeURIComponent(title)}`, snippet };
}

function fake(name: string, results: SearchResult[]): Backend {
  registerBackend({
    name,
    async isAvailable() {
      return true;
    },
    async search() {
      return results;
    },
  });
  return { name } as unknown as Backend;
}

// Two rows, both passing filterRelevant (the MIN_TOKEN_HITS bar) — a thin page
// of near-misses, which is what "weak" means.
const WEAK = [row("pi coding agent", "pi extension"), row("coding agent notes", "subagents")];

// Three rows, one of them carrying the whole query — comfortably relevant.
const STRONG = [
  row("pi coding agent subagents", "extension for pi"),
  row("subagents", "pi agent"),
  row("notes", "pi agent"),
];

function search(chain: string[]) {
  return runChain(QUERY, new AbortController().signal, { chain });
}

test("weak first set escalates to the next entry", async () => {
  fake("fake-weak", WEAK);
  fake("fake-strong", STRONG);

  const result = await search(["fake-weak", "fake-strong"]);

  assert.equal(result.kind, "ok");
  assert.equal(result.kind === "ok" && result.backend, "fake-strong");
  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[0].status.kind, "weak");
  assert.equal(result.attempts[1].status.kind, "ok");
  assert.equal(result.kind === "ok" && result.results.length, STRONG.length);
});

test("strong first set still stops the chain", async () => {
  fake("fake-strong", STRONG);
  fake("fake-weak", WEAK);

  const result = await search(["fake-strong", "fake-weak"]);

  assert.equal(result.kind, "ok");
  assert.equal(result.kind === "ok" && result.backend, "fake-strong");
  assert.equal(result.attempts.length, 1, "the weak second entry must not be called");
});

test("a weak set on the last entry is returned, not dropped", async () => {
  fake("fake-weak", WEAK);

  const result = await search(["fake-weak"]);

  assert.equal(result.kind, "ok", "nothing to escalate to — keep the only answer");
  assert.equal(result.kind === "ok" && result.results.length, WEAK.length);
  assert.equal(result.attempts[0].status.kind, "weak", "still labelled weak");
});

test("weak set is kept when the fallback is unavailable", async () => {
  fake("fake-weak", WEAK);
  registerBackend({
    name: "fake-down",
    async isAvailable() {
      return false;
    },
    async search() {
      throw new Error("must not be called");
    },
  });

  const result = await search(["fake-weak", "fake-down"]);

  assert.equal(result.kind, "ok", "a weak set must not become a total failure");
  assert.equal(result.kind === "ok" && result.backend, "fake-weak");
  assert.equal(result.attempts[0].status.kind, "weak");
  assert.equal(result.attempts[1].status.kind, "skipped");
});

test("empty set still escalates (unchanged)", async () => {
  fake("fake-empty", []);
  fake("fake-strong", STRONG);

  const result = await search(["fake-empty", "fake-strong"]);

  assert.equal(result.attempts[0].status.kind, "empty");
  assert.equal(result.kind === "ok" && result.backend, "fake-strong");
});

test("isStrongResultSet: count and token bar", () => {
  assert.equal(isStrongResultSet(QUERY, STRONG), true);
  assert.equal(isStrongResultSet(QUERY, WEAK), false, "too few results");
  // Enough results, but none carries more than the MIN_TOKEN_HITS bar.
  assert.equal(
    isStrongResultSet(QUERY, [row("pi agent"), row("pi agent"), row("pi agent")]),
    false,
  );
  // Unfilterable query: any non-empty set stands on its own.
  assert.equal(isStrongResultSet("+++", WEAK), true);
});
