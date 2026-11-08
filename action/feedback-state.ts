// The identity and state contract of the closed-loop review feedback: the receipt comment that a
// hosted acceptance job writes, the marker that a published review carries, and the strict parsers
// for both. Only this module formats or reads those markers. Callers must serialize writers per
// source run with the workflow concurrency group `rev-engine-feedback-<repository_id>-<run id>`,
// and each writer derives state from GitHub before it writes. Arrival order of events is not trusted.

export type Mode = "agent" | "human";
export type State = "accepted" | "started" | "published" | "failed" | "cancelled";

/** The receipt of one source run, as its comment records it. */
export interface Receipt {
  run: number;
  attempt: number;
  pr: number;
  mode: Mode;
  state: State;
  feedbackAuthorId: number;
  reviewAuthorId: number;
  commentId: number | null;
}

const RECEIPT_PREFIX = "<!-- rev-engine-feedback:v1 ";
const RECEIPT_LINE = /^<!-- rev-engine-feedback:v1 run=(\d+) attempt=(\d+) pr=(\d+) mode=(agent|human) state=(accepted|started|published|failed|cancelled) feedback-author=(\d+) review-author=(\d+) comment=(\d+|none) -->$/;
const REVIEW_LINE = /^<!-- rev-engine-feedback-review:v1 run=(\d+) attempt=(\d+) -->$/;

/** A positive whole number JavaScript holds exactly. Every numeric identity this protocol reads must pass it. */
export function isPositiveSafe(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** The value when it is an absolute HTTPS URL with a host and no credentials, otherwise null. */
export function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string" || !URL.canParse(value)) return null;
  const url = new URL(value);
  return url.protocol === "https:" && url.hostname !== "" && url.username === "" && url.password === "" ? value : null;
}

export function receiptLine(receipt: Receipt): string {
  const comment = receipt.commentId === null ? "none" : String(receipt.commentId);
  return `<!-- rev-engine-feedback:v1 run=${receipt.run} attempt=${receipt.attempt} pr=${receipt.pr} mode=${receipt.mode} state=${receipt.state} feedback-author=${receipt.feedbackAuthorId} review-author=${receipt.reviewAuthorId} comment=${comment} -->`;
}

/** Whether a comment mentions the receipt of this run. It proves nothing about who wrote it. */
export function mentionsReceipt(body: string, run: number): boolean {
  return body.includes(`${RECEIPT_PREFIX}run=${run} `);
}

/**
 * The receipt a comment carries, or null when it carries none. A comment that starts a receipt
 * marker but does not match the strict format is an error, never a receipt.
 */
export function parseReceipt(body: string): Receipt | null {
  const lines = body.split("\n").filter((line) => line.startsWith(RECEIPT_PREFIX));
  if (lines.length === 0) return null;
  if (lines.length > 1) throw new Error("the comment carries more than one receipt marker");
  const match = RECEIPT_LINE.exec(lines[0]!.replace(/\r$/, ""));
  if (!match) throw new Error("the receipt marker does not match the expected format");
  const [, run, attempt, pr, mode, state, feedbackAuthorId, reviewAuthorId, comment] = match;
  const receipt: Receipt = {
    run: Number(run),
    attempt: Number(attempt),
    pr: Number(pr),
    mode: mode as Mode,
    state: state as State,
    feedbackAuthorId: Number(feedbackAuthorId),
    reviewAuthorId: Number(reviewAuthorId),
    commentId: comment === "none" ? null : Number(comment),
  };
  const ids = [receipt.run, receipt.attempt, receipt.pr, receipt.feedbackAuthorId, receipt.reviewAuthorId, receipt.commentId];
  if (!ids.every((id) => id === null || isPositiveSafe(id))) throw new Error("the receipt marker has a number that is not a positive whole number");
  return receipt;
}

/** The marker a review carries, so that the watcher can prove which attempt published it. */
export function reviewMarker(run: number, attempt: number): string {
  return `<!-- rev-engine-feedback-review:v1 run=${run} attempt=${attempt} -->`;
}

/** The run and attempt a review body proves, from the marker lines that match the strict format. */
export function reviewMarkersIn(body: string): Array<{ run: number; attempt: number }> {
  const found: Array<{ run: number; attempt: number }> = [];
  for (const raw of body.split("\n")) {
    const match = REVIEW_LINE.exec(raw.replace(/\r$/, ""));
    if (!match) continue;
    const run = Number(match[1]);
    const attempt = Number(match[2]);
    if (isPositiveSafe(run) && isPositiveSafe(attempt)) found.push({ run, attempt });
  }
  return found;
}

const RANK: Record<State, number> = { accepted: 0, started: 1, published: 2, failed: 2, cancelled: 2 };

export function isTerminal(state: State): boolean {
  return state === "published" || state === "failed" || state === "cancelled";
}

/**
 * The state a run shows, in priority order. A published review of the current attempt wins; a
 * completed run without one is cancelled or failed, and a success without a review is failed.
 * Only an in-progress review job shows as started, since that promises no result. A job that has
 * already completed establishes nothing by itself, so it never shows the request as running.
 */
export function projectState(input: { runStatus: string; runConclusion: string | null; reviewJobStatus: string | null; published: boolean }): State {
  if (input.published) return "published";
  if (input.runStatus === "completed") return input.runConclusion === "cancelled" ? "cancelled" : "failed";
  if (input.reviewJobStatus === "in_progress") return "started";
  return "accepted";
}

/**
 * The receipt after one observation, or null when nothing changes. Attempts only increase, so a
 * delayed event for an older attempt is ignored. Within one attempt a terminal state does not
 * regress: only a published review may replace a failed or cancelled one.
 */
export function advance(current: Receipt, observed: { attempt: number; state: State }): Receipt | null {
  if (observed.attempt < current.attempt) return null;
  if (observed.attempt > current.attempt) return { ...current, attempt: observed.attempt, state: observed.state };
  if (current.state === "published") return null;
  if (isTerminal(current.state)) return observed.state === "published" ? { ...current, state: observed.state } : null;
  if (isTerminal(observed.state)) return { ...current, state: observed.state };
  if (RANK[observed.state] > RANK[current.state]) return { ...current, state: observed.state };
  return null;
}

const HEADLINES: Record<State, string> = {
  accepted: "Accepted — waiting for a review runner",
  started: "Review job started",
  published: "Review published",
  failed: "Failed / no review published",
  cancelled: "Cancelled",
};

/** The receipt's visible text. The marker line is first, so it stays the only parsed part. */
export function renderReceipt(receipt: Receipt, attemptUrl: string, reviewUrl?: string): string {
  const mode = receipt.mode === "agent" ? "Agent" : "Human";
  const detail: Record<State, string> = {
    accepted: "The review has been accepted and waits for a runner. Starting it is not a result.",
    started: "The review job has started. This shows only that the job started, not that a review will be produced.",
    published: reviewUrl ? `The review is [here](${reviewUrl}).` : "The review is published.",
    failed: "The run ended without a published review. It may have been stopped, or finished without posting.",
    cancelled: "The run was cancelled, or replaced by a newer request.",
  };
  return [
    receiptLine(receipt),
    "",
    `**${HEADLINES[receipt.state]}**`,
    "",
    `- Mode: ${mode} review`,
    `- Actions attempt: [run ${receipt.run}, attempt ${receipt.attempt}](${attemptUrl})`,
    "",
    detail[receipt.state],
  ].join("\n");
}
