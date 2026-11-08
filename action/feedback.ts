// The hosted side of the closed-loop review feedback. `accept` writes the receipt for an accepted
// /review request before anything is paid for, and `sync` brings the receipt in line with the
// review run. Both read and write GitHub only through GitHubApi, and never run PR code or read an
// artifact. The CLI at the bottom is thin: it reads the environment and writes GITHUB_OUTPUT.
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { advance, httpsUrl, isPositiveSafe, mentionsReceipt, parseReceipt, projectState, receiptLine, renderReceipt, reviewMarkersIn, type Mode, type Receipt, type State } from "./feedback-state.ts";

export class FeedbackError extends Error {}

/** A GitHub REST client that holds one token. Errors name the route and status, never a response body. */
export class GitHubApi {
  readonly base: string;
  readonly token: string;

  constructor(base: string, token: string) {
    this.base = base.replace(/\/+$/, "");
    this.token = token;
  }

  send(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "rev-engine-feedback",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async json<T>(path: string): Promise<T> {
    const response = await this.send("GET", path);
    if (!response.ok) throw new FeedbackError(`GET ${path} failed with status ${response.status}`);
    return await response.json() as T;
  }

  /** Every item of a paginated list. A short page ends it; a failed page fails the whole read. */
  async pages<T>(path: string, key?: string): Promise<T[]> {
    const items: T[] = [];
    const joiner = path.includes("?") ? "&" : "?";
    for (let page = 1; page <= 500; page += 1) {
      const pathPage = `${path}${joiner}per_page=100&page=${page}`;
      const response = await this.send("GET", pathPage);
      if (!response.ok) throw new FeedbackError(`GET ${path} failed with status ${response.status}`);
      const body = await response.json() as unknown;
      const batch = (key ? (body as Record<string, unknown>)[key] : body) as T[] | undefined;
      if (!Array.isArray(batch)) throw new FeedbackError(`GET ${path} returned no list`);
      items.push(...batch);
      if (batch.length < 100) return items;
    }
    throw new FeedbackError(`GET ${path} has more pages than the reader follows`);
  }
}

export interface Identity {
  id: number;
  login: string;
}

/** The numeric ID of a configured login, from the trusted users API. Failure blocks the request. */
export async function resolveUserId(api: GitHubApi, login: string): Promise<number> {
  const user = await api.json<Identity>(`/users/${encodeURIComponent(login)}`);
  if (!isPositiveSafe(user.id)) throw new FeedbackError(`the ID of ${login} is not a positive whole number`);
  return user.id;
}

/**
 * The one author of receipts: GitHub.com's Actions identity. Its numeric ID is pinned here. No receipt,
 * event, requested login or token supplies it, so an account that only claims the login owns nothing.
 */
const RECEIPT_AUTHOR = { login: "github-actions[bot]", id: 41898282 } as const;

/** The receipt author's ID, checked against the pin. Any other login is refused before the lookup. */
async function resolveReceiptAuthor(api: GitHubApi, login: string): Promise<number> {
  if (login !== RECEIPT_AUTHOR.login) throw new FeedbackError(`the receipt author must be ${RECEIPT_AUTHOR.login}; other receipt authors are not supported`);
  const id = await resolveUserId(api, login);
  if (id !== RECEIPT_AUTHOR.id) throw new FeedbackError(`the ID of ${login} is not the trusted ID, so the receipt author cannot be verified`);
  return id;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A GitHub user: null for a deleted account, otherwise a positive ID and a login. Undefined when malformed. */
function userOf(value: unknown): Identity | null | undefined {
  if (value === null) return null;
  if (!isObject(value) || !isPositiveSafe(value.id) || typeof value.login !== "string") return undefined;
  return { id: value.id, login: value.login };
}

interface IssueComment {
  id: number;
  body: string;
  html_url: string;
  issue_url: string;
  user: Identity | null;
}

/** A listed or created comment, or null when a field this protocol reads is missing or malformed. */
function parseComment(value: unknown): IssueComment | null {
  if (!isObject(value) || !isPositiveSafe(value.id) || typeof value.body !== "string") return null;
  const html = httpsUrl(value.html_url);
  const issue = value.issue_url;
  const user = userOf(value.user);
  if (html === null || typeof issue !== "string" || !URL.canParse(issue) || user === undefined) return null;
  return { id: value.id, body: value.body, html_url: html, issue_url: issue, user };
}

function commentOf(row: unknown): IssueComment {
  const comment = parseComment(row);
  if (comment === null) throw new FeedbackError("GitHub returned a malformed comment, so no receipt can be decided");
  return comment;
}

interface Review {
  id: number;
  body: string;
  html_url: string;
  state: string;
  user: Identity | null;
}

/** Every review state GitHub uses. A row with another state is malformed, and a valid row is never mistaken for publication. */
const REVIEW_STATES = ["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"];

function reviewOf(row: unknown): Review {
  const html = isObject(row) ? httpsUrl(row.html_url) : null;
  const user = isObject(row) ? userOf(row.user) : undefined;
  if (!isObject(row) || !isPositiveSafe(row.id) || typeof row.body !== "string" || typeof row.state !== "string" || !REVIEW_STATES.includes(row.state) || html === null || user === undefined) {
    throw new FeedbackError("GitHub returned a malformed review, so publication cannot be decided");
  }
  return { id: row.id, body: row.body, html_url: html, state: row.state, user };
}

/** The issue address of a pull request, where its comments and receipts live. */
function issueOf(api: GitHubApi, repo: string, pr: number): string {
  return `${api.base}/repos/${repo}/issues/${pr}`;
}

/** Whether a receipt body is exactly the receipt this request asked for. */
function isRequested(body: string, wanted: Receipt): boolean {
  try {
    const parsed = parseReceipt(body);
    return parsed !== null && receiptLine(parsed) === receiptLine(wanted);
  } catch {
    return false;
  }
}

export interface AcceptConfig {
  repo: string;
  runId: number;
  attempt: number;
  pr: number;
  mode: Mode;
  commentId: number | null;
  feedbackAuthor: string;
  reviewAuthor: string;
  serverUrl: string;
}

export interface Owned {
  id: number;
  issueUrl: string;
  receipt: Receipt;
}

/**
 * The receipt this run owns on a list of comments. Only a comment written by the trusted receipt author
 * counts. A same-marker comment by anyone else, or by a deleted account, is ignored. When the configured
 * login belongs to a different ID than the author, the identity changed, which is an error and never a silent switch.
 */
export function ownedReceipt(comments: IssueComment[], run: number, feedbackAuthor: string, feedbackId: number, reviewId: number): Owned | null {
  const owned: Owned[] = [];
  for (const comment of comments) {
    if (!mentionsReceipt(comment.body, run)) continue;
    if (comment.user?.id === feedbackId) {
      const receipt = parseReceipt(comment.body);
      if (!receipt || receipt.run !== run) throw new FeedbackError("an owned comment has a malformed receipt");
      if (receipt.feedbackAuthorId !== feedbackId) throw new FeedbackError("the receipt records a different feedback author ID than the configured one");
      if (receipt.reviewAuthorId !== reviewId) throw new FeedbackError(`the receipt records review author ID ${receipt.reviewAuthorId}, but the configured review author is ${reviewId}`);
      owned.push({ id: comment.id, issueUrl: comment.issue_url, receipt });
    } else if (comment.user?.login === feedbackAuthor) {
      throw new FeedbackError("the configured feedback author login belongs to a different ID than the receipt's author");
    }
  }
  if (owned.length > 1) throw new FeedbackError("more than one receipt is owned by this run");
  return owned[0] ?? null;
}

function attemptUrl(config: { serverUrl: string; repo: string }, run: number, attempt: number): string {
  return `${config.serverUrl}/${config.repo}/actions/runs/${run}/attempts/${attempt}`;
}

/** Writes the receipt for an accepted request. Returns once the receipt exists on GitHub. */
export async function accept(config: AcceptConfig, api: GitHubApi): Promise<{ commentId: number }> {
  const feedbackId = await resolveReceiptAuthor(api, config.feedbackAuthor);
  const reviewId = await resolveUserId(api, config.reviewAuthor);
  const commentsPath = `/repos/${config.repo}/issues/${config.pr}/comments`;
  const wanted: Receipt = {
    run: config.runId,
    attempt: config.attempt,
    pr: config.pr,
    mode: config.mode,
    state: "accepted",
    feedbackAuthorId: feedbackId,
    reviewAuthorId: reviewId,
    commentId: config.commentId,
  };
  const read = async (): Promise<Owned | null> => ownedReceipt((await api.pages<unknown>(commentsPath)).map(commentOf), config.runId, config.feedbackAuthor, feedbackId, reviewId);

  const owned = await read();
  if (owned) {
    if (owned.receipt.pr !== config.pr || owned.issueUrl !== issueOf(api, config.repo, config.pr)) throw new FeedbackError("the receipt of this run belongs to another pull request");
    if (owned.receipt.attempt >= config.attempt) return { commentId: owned.id };
    // A rerun moves the same receipt to the new attempt, so the request keeps one comment.
    const next: Receipt = { ...owned.receipt, attempt: config.attempt, mode: config.mode, state: "accepted" };
    const updated = await api.send("PATCH", `/repos/${config.repo}/issues/comments/${owned.id}`, { body: renderReceipt(next, attemptUrl(config, config.runId, config.attempt)) });
    if (!updated.ok) throw new FeedbackError(`updating the receipt failed with status ${updated.status}`);
    return { commentId: owned.id };
  }

  const body = renderReceipt(wanted, attemptUrl(config, config.runId, config.attempt));
  let response: Response | null = null;
  try {
    response = await api.send("POST", commentsPath, { body });
  } catch {
    response = null;
  }
  if (response === null || response.status >= 500) {
    // The write may have happened. Look before anything else, and never post a second receipt blindly.
    const again = await read();
    if (again) return { commentId: again.id };
    throw new FeedbackError("the receipt could not be confirmed on GitHub, so the request is not accepted");
  }
  if (!response.ok) throw new FeedbackError(`writing the receipt failed with status ${response.status}`);
  // Only a well-formed answer is evidence. A malformed one is never patched or repeated, because its ID is not trusted.
  const created = parseComment(await response.json().catch(() => null));
  if (created === null) throw new FeedbackError("GitHub's answer to the receipt write is malformed, so the request is not accepted; the write was not repeated");
  if (created.user?.id !== feedbackId || created.issue_url !== issueOf(api, config.repo, config.pr) || !isRequested(created.body, wanted)) {
    // The well-formed comment is kept, marked as not accepted, so no reader takes it for a receipt.
    await api.send("PATCH", `/repos/${config.repo}/issues/comments/${created.id}`, {
      body: "### Review feedback\n\n**Not accepted** — the receipt was not written as requested, so the request was not accepted.",
    }).catch(() => undefined);
    const reason = created.user?.id !== feedbackId ? "written by an unexpected author" : "not the receipt that was requested";
    throw new FeedbackError(`the receipt was ${reason}; the request was not accepted: ${created.html_url}`);
  }
  return { commentId: created.id };
}

export interface SyncConfig {
  repo: string;
  runId: number;
  reviewWorkflow: string;
  reviewJob: string;
  feedbackAuthor: string;
  reviewAuthor: string;
  serverUrl: string;
}

interface Run {
  id: number;
  run_attempt: number;
  path: string;
  event: string;
  status: string;
  conclusion: string | null;
  created_at?: string;
}

interface Job {
  name: string;
  status: string;
  conclusion: string | null;
}

const SYNC_EVENTS = ["issue_comment", "workflow_dispatch"];
const RECONCILE_ROUNDS = 3;

/** The attempt of a run. A run without a positive safe attempt cannot be reconciled. */
function attemptOf(run: Run): number {
  if (!isPositiveSafe(run.run_attempt)) throw new FeedbackError("the source run has no valid attempt");
  return run.run_attempt;
}

/**
 * Brings the receipt of one review run into line with GitHub's current state. It is safe to call
 * for any run, in any order, and as often as notifications arrive: it reads the run's current attempt,
 * its jobs and the pull request's reviews, and writes only when the receipt would change. A run
 * with no receipt is a no-op. Callers must hold the source-run concurrency group.
 */
export async function sync(config: SyncConfig, api: GitHubApi): Promise<{ changed: boolean; state: State | null }> {
  // The workflow and job come from the feedback action's manifest. An empty value is a broken configuration, not a default.
  if (config.reviewWorkflow.trim() === "" || config.reviewJob.trim() === "") throw new FeedbackError("the review workflow and job must be configured, and the feedback action's defaults supply them");
  const feedbackId = await resolveReceiptAuthor(api, config.feedbackAuthor);
  const reviewId = await resolveUserId(api, config.reviewAuthor);
  const runPath = `/repos/${config.repo}/actions/runs/${config.runId}`;
  const first = await api.json<Run>(runPath);
  if (first.id !== config.runId) throw new FeedbackError("the source run is not the one requested");
  if (first.path !== config.reviewWorkflow) throw new FeedbackError("the source run is not from the expected review workflow");
  if (!SYNC_EVENTS.includes(first.event)) throw new FeedbackError("the source run has an event that is not a review request");
  attemptOf(first);

  const since = first.created_at ? `&since=${encodeURIComponent(first.created_at)}` : "";
  const comments = (await api.pages<unknown>(`/repos/${config.repo}/issues/comments?sort=created&direction=asc${since}`)).map(commentOf);
  const owned = ownedReceipt(comments, config.runId, config.feedbackAuthor, feedbackId, reviewId);
  if (!owned) return { changed: false, state: null };
  if (owned.issueUrl !== issueOf(api, config.repo, owned.receipt.pr)) {
    throw new FeedbackError("the receipt does not belong to a pull request of this repository");
  }
  await api.json(`/repos/${config.repo}/pulls/${owned.receipt.pr}`);
  const pr = owned.receipt.pr;
  const current = owned.receipt;

  for (let round = 0; round < RECONCILE_ROUNDS; round += 1) {
    const run = round === 0 ? first : await api.json<Run>(runPath);
    const attempt = attemptOf(run);
    const jobs = await api.pages<Job>(`/repos/${config.repo}/actions/runs/${config.runId}/attempts/${attempt}/jobs`, "jobs");
    const job = jobs.find((candidate) => candidate.name === config.reviewJob) ?? null;
    // Every listed row is decoded before any is trusted, so one malformed row makes the whole read unknown.
    const reviews = (await api.pages<unknown>(`/repos/${config.repo}/pulls/${pr}/reviews`)).map(reviewOf);
    const published = reviews.find((review) =>
      review.user?.id === reviewId &&
      review.state === "COMMENTED" &&
      reviewMarkersIn(review.body).some((marker) => marker.run === config.runId && marker.attempt === attempt));
    const state = projectState({
      runStatus: run.status,
      runConclusion: run.conclusion,
      reviewJobStatus: job?.status ?? null,
      published: Boolean(published),
    });
    const next = advance(current, { attempt, state });
    if (!next) return { changed: false, state };
    // A rerun that began while these reads ran makes them stale, so they are taken again.
    const recheck = await api.json<Run>(runPath);
    if (recheck.run_attempt !== attempt) continue;
    const reviewUrl = published?.html_url;
    const updated = await api.send("PATCH", `/repos/${config.repo}/issues/comments/${owned.id}`, {
      body: renderReceipt(next, attemptUrl(config, config.runId, next.attempt), reviewUrl),
    });
    if (!updated.ok) throw new FeedbackError(`updating the receipt failed with status ${updated.status}`);
    return { changed: true, state: next.state };
  }
  throw new FeedbackError("the source run changed attempts during sync, so the receipt was not updated");
}

export interface CliEnv {
  token: string;
  apiUrl: string;
  serverUrl: string;
  repo: string;
  runId: string;
  runAttempt: string;
  pr: string;
  mode: string;
  commentId: string;
  feedbackAuthor: string;
  reviewAuthor: string;
  reviewWorkflow: string;
  reviewJob: string;
  output: string;
}

function positive(name: string, value: string): number {
  const number = Number(value);
  if (!/^[1-9][0-9]*$/.test(value) || !isPositiveSafe(number)) throw new FeedbackError(`${name} must be a positive whole number`);
  return number;
}

function acceptConfigFrom(env: CliEnv): AcceptConfig {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.repo)) throw new FeedbackError("the repository is not owner/name");
  if (env.mode !== "agent" && env.mode !== "human") throw new FeedbackError("mode must be agent or human");
  return {
    repo: env.repo,
    runId: positive("the run ID", env.runId),
    attempt: positive("the run attempt", env.runAttempt),
    pr: positive("the pull request number", env.pr),
    mode: env.mode,
    commentId: env.commentId === "" ? null : positive("the comment ID", env.commentId),
    feedbackAuthor: env.feedbackAuthor,
    reviewAuthor: env.reviewAuthor,
    serverUrl: env.serverUrl,
  };
}

async function main(phase: string, env: CliEnv): Promise<void> {
  const api = new GitHubApi(env.apiUrl, env.token);
  if (phase === "sync") {
    const result = await sync({
      repo: env.repo,
      runId: positive("the run ID", env.runId),
      reviewWorkflow: env.reviewWorkflow,
      reviewJob: env.reviewJob,
      feedbackAuthor: env.feedbackAuthor,
      reviewAuthor: env.reviewAuthor,
      serverUrl: env.serverUrl,
    }, api);
    console.log(result.changed ? `Receipt updated to ${result.state}.` : "No change to the receipt.");
    return;
  }
  if (phase !== "accept") throw new FeedbackError("phase must be accept or sync");
  const config = acceptConfigFrom(env);
  const { commentId } = await accept(config, api);
  // The outputs are written only now, after the receipt exists on GitHub.
  appendFileSync(env.output, `accepted=true\ncomment-id=${commentId}\nrun-id=${config.runId}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env: CliEnv = {
    token: process.env.GITHUB_TOKEN ?? "",
    apiUrl: (process.env.GITHUB_API_URL ?? "https://api.github.com").trim(),
    serverUrl: (process.env.GITHUB_SERVER_URL ?? "https://github.com").trim(),
    repo: process.env.REPO ?? "",
    runId: process.env.SOURCE_RUN_ID ?? "",
    runAttempt: process.env.RUN_ATTEMPT ?? "",
    pr: process.env.PR_NUMBER ?? "",
    mode: process.env.MODE ?? "",
    commentId: process.env.COMMENT_ID ?? "",
    feedbackAuthor: process.env.FEEDBACK_AUTHOR ?? "",
    reviewAuthor: process.env.REVIEW_AUTHOR ?? "",
    reviewWorkflow: process.env.REVIEW_WORKFLOW ?? "",
    reviewJob: process.env.REVIEW_JOB ?? "",
    output: process.env.GITHUB_OUTPUT ?? "",
  };
  main(process.argv[2] ?? "", env).catch((error: unknown) => {
    // Only the error's own message is printed. Responses and tokens never reach the log.
    console.log(`::error::${error instanceof Error ? error.message : "feedback failed"}`);
    process.exitCode = 1;
  });
}
