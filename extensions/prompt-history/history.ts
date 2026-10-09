/**
 * History sources: the live session branch plus earlier sessions in the same
 * directory. Read-only — it parses the session JSONL pi already wrote, so this
 * extension never keeps a second copy of your prompts.
 */

import { SessionManager, type ReadonlySessionManager } from "@earendil-works/pi-coding-agent";
import { promptsOf } from "./prompts.ts";

/** Size of the cross-session search pool. */
export const MAX_PROMPTS = 200;

/** This session's prompts, newest first. */
export const branchPrompts = (manager: ReadonlySessionManager): string[] => {
  try {
    return promptsOf(manager.getBranch()).reverse();
  } catch {
    return [];
  }
};

/** Prompts from previous sessions in `cwd`, newest session first, de-duplicated. */
export type RecentHistory = {
  /** Newest first, de-duplicated, at most `max` entries. */
  prompts: string[];
  /** Why the sessions on disk could not be read, when that happened at all. */
  error?: string;
};

export const loadRecentPrompts = async (cwd: string, max = MAX_PROMPTS): Promise<RecentHistory> => {
  const out: string[] = [];
  const seen = new Set<string>();
  let sessions: Awaited<ReturnType<typeof SessionManager.list>>;
  try {
    sessions = await SessionManager.list(cwd);
  } catch (error) {
    // No session directory yet is normal on a fresh machine; anything else means
    // the history is missing rather than empty, and the caller says so.
    return (error as NodeJS.ErrnoException)?.code === "ENOENT"
      ? { prompts: out }
      : { prompts: out, error: errorText(error) };
  }

  sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
  let unreadable = 0;
  for (const session of sessions) {
    if (out.length >= max) break;
    let prompts: string[];
    try {
      prompts = promptsOf(SessionManager.open(session.path).getEntries()).reverse();
    } catch {
      unreadable += 1;
      continue; // unreadable or vanished session: skip it, keep the rest
    }
    for (const prompt of prompts) {
      if (seen.has(prompt)) continue;
      seen.add(prompt);
      out.push(prompt);
      if (out.length >= max) break;
    }
  }

  // One bad file is noise; every file failing means the format moved.
  return unreadable > 0 && unreadable === sessions.length
    ? { prompts: out, error: `${unreadable} 个会话文件都读不了` }
    : { prompts: out };
};

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
