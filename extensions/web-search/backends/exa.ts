// backends/exa.ts — Exa Search API backend.
// POST https://api.exa.ai/search with x-api-key header.
// Returns title/url/snippet from results (snippet = first highlight or text prefix).

import type { Backend, SearchResult } from "./types.ts";

interface ExaResult {
  title?: string;
  url?: string;
  text?: string;
  highlights?: string[];
  publishedDate?: string;
  author?: string;
}

interface ExaResponse {
  results?: ExaResult[];
  costDollars?: { total?: number };
}

export const exaBackend: Backend = {
  name: "exa",

  async isAvailable() {
    return !!process.env.EXA_SEARCH_API_KEY;
  },

  async search(query, signal, opts) {
    const key = process.env.EXA_SEARCH_API_KEY;
    if (!key) throw new Error("EXA_SEARCH_API_KEY not set");

    const body: Record<string, unknown> = {
      query,
      numResults: 10,
      type: "auto",
      contents: { highlights: true },
    };

    // Exa supports ISO-8601 date filtering. If we add a `freshness` param
    // later, map it to startPublishedDate here.

    const res = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`exa HTTP ${res.status}${errText ? `: ${errText.slice(0, 200)}` : ""}`);
    }

    const data = (await res.json()) as ExaResponse;
    const raw = data.results ?? [];

    const results: SearchResult[] = raw
      .filter((x) => x.title && x.url)
      .map((x) => ({
        title: x.title ?? "",
        url: x.url ?? "",
        // Pick the best snippet: first highlight if available, otherwise
        // first ~200 chars of text, otherwise empty.
        snippet: x.highlights?.[0] ?? x.text?.slice(0, 200) ?? "",
      }));

    return results;
  },
};
