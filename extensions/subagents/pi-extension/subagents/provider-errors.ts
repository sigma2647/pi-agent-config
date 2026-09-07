/**
 * Classify LLM provider error text on a single axis that actually matters to
 * the subagent orchestrator: is this a *terminal* account/quota/credits
 * condition (retrying will never work — the account must be topped up, the
 * spend cap raised, or the limit recharged), or a transient overload /
 * rate-limit that retry plus model-pool fallback can ride out?
 *
 * Why this exists: pi's own client retries on HTTP 429 and only treats a small
 * keyword set as terminal — and that set is OpenAI/DeepSeek-flavored
 * (`insufficient_quota`, `quota exceeded`, `out of budget`, `available
 * balance`, `billing`, ...). Anthropic (Claude Code) reports credit / spend-cap
 * exhaustion as a *429* whose message reads like an ordinary rate limit
 * ("This request would exceed your account's rate limit. Please try again
 * later.", "Credit balance is too low", "spend limit reached"), so pi never
 * classifies it as terminal and an exhausted account keeps getting re-requested
 * and falls through the whole model pool forever — the subagent never settles.
 *
 * This helper closes that gap so the orchestrator can fail a run immediately
 * with an actionable error instead of looping through retries / fallbacks.
 */
const TERMINAL_PROVIDER_LIMIT_PATTERNS: string[] = [
  // OpenAI (chat.completions / Responses) style
  "GoUsageLimitError",
  "FreeUsageLimitError",
  "Monthly usage limit reached",
  "exceeded your current quota",
  "your current quota has been exceeded",
  "Insufficient Quota",
  "insufficient_quota",
  "insufficient quota",
  "quota exceeded",
  "no more quota",
  "not enough quota",
  // Generic spend / credits
  "out of budget",
  "over budget",
  "available balance",
  "usage limit reached",
  "credit limit reached",
  "billing",
  "account balance",
  // Anthropic / Claude Code style (often surfaced as a 429 "rate limit")
  "credit balance is too low",
  "insufficient credits",
  "insufficient api credits",
  "insufficient api_credits",
  "spend limit reached",
  "spend limit unavailable",
  "usage credits required",
  "exhausted usage credits",
  "This request would exceed your account's rate limit",
];

const TERMINAL_PROVIDER_LIMIT_RE = new RegExp(
  TERMINAL_PROVIDER_LIMIT_PATTERNS.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
  "i",
);

/**
 * True when `text` indicates an account/plan quota, credit, or spend-cap has
 * been exhausted — a condition that retrying or falling through the model pool
 * will not fix. Accepts the raw `errorMessage` from a subagent (or an API
 * error body/string). Returns false for empty / unknown text and for genuine
 * transient rate-limit or server-overload messages.
 */
export function isTerminalProviderLimitError(text: string | undefined | null): boolean {
  if (!text) return false;
  return TERMINAL_PROVIDER_LIMIT_RE.test(text);
}
