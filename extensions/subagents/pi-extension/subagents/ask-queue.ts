/**
 * The durable child-to-parent question queue.
 *
 * A child that parks on `ask_question` appends to `<sessionFile>.asks.json`.
 * The parent watcher reads that file, delivers each new question to the parent
 * session, and clears it only once the answer has been sent back.
 *
 * The file is deliberately NOT deleted on read. It is the only record of an
 * unanswered question, and a parent restart is exactly the moment that record
 * matters: the child is still parked in its pane, waiting.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

/** Suffix of the queue file that sits next to a child's session file. */
export const ASK_QUEUE_SUFFIX = ".asks.json";

export interface AskRequest {
  id: string;
  name: string;
  question: string;
  at: string;
}

/** Path of the queue belonging to a child session. */
export function askQueuePath(sessionFile: string): string {
  return `${sessionFile}${ASK_QUEUE_SUFFIX}`;
}

/**
 * Parse a queue payload, dropping anything without a usable question. An entry
 * without an id is still accepted (it falls back to its timestamp) so a queue
 * written by an older child is not silently dropped.
 */
export function parseAskQueue(data: unknown): AskRequest[] {
  if (!Array.isArray(data)) return [];
  const requests: AskRequest[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const question = typeof record.question === "string" ? record.question.trim() : "";
    if (!question) continue;
    const at = typeof record.at === "string" ? record.at : "";
    const id = typeof record.id === "string" && record.id !== "" ? record.id : at;
    requests.push({
      id: id || `ask-${requests.length}`,
      name: typeof record.name === "string" && record.name !== "" ? record.name : "subagent",
      question,
      at,
    });
  }
  return requests;
}

/** Read a child's queue. A missing or unreadable file reads as empty. */
export function readAskQueue(path: string): AskRequest[] {
  try {
    if (!existsSync(path)) return [];
    return parseAskQueue(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return [];
  }
}

/**
 * Append one question, keeping whatever is already queued. Two questions asked
 * in the same turn must both reach the parent, so the queue is additive.
 */
export function appendAskRequest(path: string, request: AskRequest): void {
  const queued = readAskQueue(path);
  queued.push(request);
  writeFileSync(path, `${JSON.stringify(queued, null, 2)}\n`, "utf8");
}

/**
 * Drop the whole queue: its child has been answered. A parked child waits for
 * one answer, so the outstanding questions are settled by that single reply.
 */
export function clearAskQueue(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Best effort: a queue that cannot be removed is re-cleared on the next answer.
  }
}
