/**
 * Endpoint policy, shared by every HTTP provider: HTTPS everywhere except
 * loopback, where a plain-HTTP local server (whisper.cpp, faster-whisper,
 * sherpa-onnx server) is legitimate. Loopback endpoints also need no API key.
 */

export const isLoopbackHost = (hostname: string): boolean => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname);

export const assertEndpoint = (endpoint: string): URL => {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`invalid endpoint: ${endpoint}`);
  }
  if (url.username || url.password) {
    throw new Error("endpoint must not embed credentials — use apiKey or apiKeyEnv");
  }
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return url;
  throw new Error(`endpoint must use HTTPS unless it points at localhost: ${endpoint}`);
};

export const endpointNeedsAuth = (endpoint: string): boolean => {
  const url = assertEndpoint(endpoint);
  return !(url.protocol === "http:" && isLoopbackHost(url.hostname));
};

export const describeHttpFailure = (prefix: string, response: Response, body: string): string => {
  const detail = body.replace(/\s+/g, " ").slice(0, 300);
  if (response.status === 401 || response.status === 403) {
    return `${prefix}: authentication failed (${response.status}) — check the API key. ${detail}`;
  }
  if (response.status === 413) {
    return `${prefix}: audio too large (413) — shorten the recording. ${detail}`;
  }
  if (response.status === 429) {
    return `${prefix}: rate limited (429) — retry later or switch provider. ${detail}`;
  }
  return `${prefix}: HTTP ${response.status} ${detail}`;
};
