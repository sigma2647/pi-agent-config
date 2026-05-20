// validate.ts

import type { SearchResult } from "./backends/types";

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "in", "to", "for", "is", "on",
  "at", "by", "with", "as", "be", "this", "that", "it", "are", "was",
  "were", "from", "but", "not", "you", "i", "we", "they",
]);

// Chinese function words — appearing alone they carry almost no topical
// signal. Drop these so we don't accept results that only matched "的"/"了".
const CJK_STOPCHARS = new Set([
  "的", "了", "是", "在", "和", "与", "或", "也", "就", "都", "对", "为",
  "把", "被", "向", "从", "到", "之", "其", "这", "那", "什", "么", "什么",
  "吗", "呢", "啊", "呀", "哦", "嗯", "哪", "怎", "样", "怎么", "怎样",
  "一", "二", "三", "上", "下", "中", "里", "外", "前", "后", "有", "无",
]);

const CJK_CHAR = /[一-鿿぀-ヿ㐀-䶿]/u;
const CJK_RUN = /[一-鿿぀-ヿ㐀-䶿]+/gu;
// Latin-script words / numbers only — \p{L} would swallow CJK letters too.
const ASCII_WORD = /[\p{Script=Latin}\p{N}]+/gu;

function bigrams(run: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + 2 <= run.length; i++) out.push(run.slice(i, i + 2));
  return out;
}

export function extractTokens(query: string): string[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return [];

  const tokens: string[] = [];

  if (CJK_CHAR.test(trimmed)) {
    // Mixed or pure CJK: take each CJK run; for runs ≥ 2 also expand to bigrams.
    // This lets "什么是pi agent" match a result containing "pi agent" OR
    // "什么是" (or a bigram of it), without requiring the whole phrase.
    for (const m of trimmed.matchAll(CJK_RUN)) {
      const run = m[0];
      if (run.length >= 2 && !CJK_STOPCHARS.has(run)) tokens.push(run);
      if (run.length >= 4) {
        for (const bg of bigrams(run)) {
          if (!CJK_STOPCHARS.has(bg)) tokens.push(bg);
        }
      }
    }
    // ASCII portions of a mixed query (e.g. "pi", "agent")
    for (const m of trimmed.matchAll(ASCII_WORD)) {
      const w = m[0];
      if (w.length >= 2 && !STOPWORDS.has(w)) tokens.push(w);
    }
  } else {
    // Pure ASCII path
    for (const m of trimmed.matchAll(ASCII_WORD)) {
      const w = m[0];
      if (w.length >= 2 && !STOPWORDS.has(w)) tokens.push(w);
    }
  }

  return [...new Set(tokens)];
}

export function isRelevant(query: string, r: SearchResult): boolean {
  const tokens = extractTokens(query);
  if (tokens.length === 0) return true; // pure-symbol query → don't filter
  const hay = `${r.title} ${r.snippet}`.toLowerCase();
  return tokens.some((t) => hay.includes(t));
}

export function filterRelevant(
  query: string,
  results: SearchResult[],
): SearchResult[] {
  return results.filter((r) => isRelevant(query, r));
}
