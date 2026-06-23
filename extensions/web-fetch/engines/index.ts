// Engines barrel — re-exports all extraction engines for pi-wf.
// Each engine is one step in the fallback chain; they share the signature
// `(ctx: FetchContext) => Promise<FetchResult | null>`.
export { extractWithDefuddle } from "./defuddle.ts";
export { extractViaHttp, extractHeadingTitle, htmlToMarkdown } from "./readability.ts";
export { extractWithJinaReader } from "./jina.ts";
export { extractWithPlaywright, PLAYWRIGHT_AUTO_HOSTS } from "./playwright.ts";
export { isPDF, extractPDF } from "./pdf.ts";
export { loadCloakBrowser, cloakbrowserInstallHint } from "./cloakbrowser.ts";
