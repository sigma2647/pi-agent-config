// In-memory content store for the truncation + retrieval pattern.
// When a fetched page exceeds 30 KB, the full content is stored here
// and the tool returns a truncated version with a retrieveId. The agent
// can pass `retrieve: "<id>"` on a subsequent web_fetch call to get the
// full document without re-fetching.
//
// Entries carry timestamps so we can prune on session_start — bounds
// growth across long-running pi sessions (hours/days). 30-min max age
// mirrors the typical agent task horizon: if the agent hasn't retrieved
// it within 30 minutes, it never will.

const MAX_AGE_MS = 30 * 60 * 1000;

interface Entry {
  content: string;
  ts: number;
}

const store = new Map<string, Entry>();

export function storeContent(id: string, content: string): void {
  store.set(id, { content, ts: Date.now() });
}

export function getContent(id: string): string | null {
  const entry = store.get(id);
  if (!entry) return null;
  if (Date.now() - entry.ts > MAX_AGE_MS) {
    store.delete(id);
    return null;
  }
  return entry.content;
}

/** Drop expired entries. Called on session_start to keep the store bounded. */
export function pruneContent(): void {
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const [id, entry] of store) {
    if (entry.ts < cutoff) store.delete(id);
  }
}
