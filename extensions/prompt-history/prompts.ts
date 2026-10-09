/**
 * Sessions into prompts. Pure — entries are passed in, so this module runs
 * under plain `node --test`.
 */

export type TextPart = { type?: string; text?: string };

export type SessionEntryLike = {
  type?: string;
  message?: { role?: string; content?: string | readonly TextPart[] };
};

/** Text of a user message; attachments and images are ignored. */
export const extractText = (content: string | readonly TextPart[] | undefined): string | undefined => {
  if (typeof content === "string") return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;
  for (const part of content) {
    if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) return part.text.trim();
  }
  return undefined;
};

/** The user's prompts in `entries`, in the order they were sent. */
export const promptsOf = (entries: readonly SessionEntryLike[]): string[] => {
  const out: string[] = [];
  for (const entry of entries) {
    if (entry?.type !== "message" || entry.message?.role !== "user") continue;
    const text = extractText(entry.message.content);
    if (text) out.push(text);
  }
  return out;
};

/** Concatenate newest-first lists, dropping repeats (first occurrence wins). */
export const mergeNewestFirst = (...lists: readonly (readonly string[])[]): string[] => {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const list of lists) {
    for (const prompt of list) {
      if (seen.has(prompt)) continue;
      seen.add(prompt);
      merged.push(prompt);
    }
  }
  return merged;
};
