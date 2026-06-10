// backends/types.ts

export type SearchResult = {
  title: string;
  url: string;
  snippet: string;
};

export type BackendStatus =
  | { kind: "ok"; resultCount: number }
  | { kind: "skipped"; reason: string }
  | { kind: "failed"; reason: string }
  | { kind: "empty"; reason: string };

/**
 * Per-call options carried through the chain to each backend. Today only
 * `proxy` is honored; adding more (timeout overrides, region, language, ...)
 * is a one-line addition here — no signature changes downstream.
 */
export interface SearchOptions {
  /**
   * Explicit proxy URL for this call. Overrides env-based detection.
   * Pass empty string ("") to disable proxy for this call only.
   *
   * Honored by `brave`. `opencli` inherits env (subprocess; per-call override
   * not piped through). `browser` (CDP) connects to an existing Chromium
   * instance whose proxy is fixed at launch time — per-call override is a
   * no-op there; see browser.ts.
   */
  proxy?: string;
}

export interface Backend {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  search(query: string, signal: AbortSignal, opts?: SearchOptions): Promise<SearchResult[]>;
}

export type BackendAttempt = {
  name: string;
  status: BackendStatus;
  elapsedMs: number;
};
