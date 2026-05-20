// backends/types.ts

export type SearchResult = {
  title: string;
  url: string;
  snippet: string;
};

export type BackendStatus =
  | { kind: "ok"; results: SearchResult[] }
  | { kind: "skipped"; reason: string }
  | { kind: "failed"; reason: string }
  | { kind: "empty"; reason: string };

export interface Backend {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  search(query: string, signal: AbortSignal): Promise<SearchResult[]>;
}

export type BackendAttempt = {
  name: string;
  status: BackendStatus;
  elapsedMs: number;
};
