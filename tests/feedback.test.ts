import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { accept, GitHubApi, sync, type AcceptConfig, type SyncConfig } from "../action/feedback.ts";

// The hosted feedback code talks to GitHub only through its REST API. These tests give it a local
// HTTP fixture that keeps issue comments, reviews, runs and jobs in memory. The token names its
// author (`token-<login>`), so a test chooses who wrote a comment or review by choosing the token.
// The CLI runs as a child process, which is async so the fixture keeps serving while it waits.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FEEDBACK_SCRIPT = join(ROOT, "action", "feedback.ts");
const REPO = "owner/repo";
const RUN = 123;
const PR = 7;
const BOT = "github-actions[bot]";
const REVIEW_APP = "review-app[bot]";
const PAT_USER = "reviewer";
const USERS: Record<string, number> = { [BOT]: 41898282, [REVIEW_APP]: 555, [PAT_USER]: 777 };

type Row = Record<string, unknown>;
interface Recorded { method: string; path: string; body: string; login: string | null }
interface Fake {
  url: string;
  requests: Recorded[];
  users: Record<string, number>;
  comments: Row[];
  /** Raw rows as the reviews list returns them. A row with no pull belongs to the pull request under test. */
  reviews: unknown[];
  run: Row;
  jobs: Row[];
  pulls: number[];
  /** Keys are "METHOD /path". A number is an HTTP status; "drop" closes the socket; "drop-after" closes it after the write. */
  failures: Record<string, number | "drop" | "drop-after">;
  afterRunRead?: () => void;
  /** When set, the answer to a comment POST, in place of the created comment. The comment is still stored. */
  createReply?: unknown;
  close(): Promise<void>;
}

function startFake(): Promise<Fake> {
  const fake: Fake = {
    url: "",
    requests: [],
    users: { ...USERS },
    comments: [],
    reviews: [],
    run: runRow(),
    jobs: [],
    pulls: [PR],
    failures: {},
    afterRunRead: undefined,
    close: () => Promise.resolve(),
  };
  let nextId = 1000;
  const server = createServer((request, response) => {
    void handle(request, response);
  });
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    const url = new URL(request.url ?? "/", "http://fixture");
    const path = decodeURIComponent(url.pathname);
    const method = request.method ?? "GET";
    const auth = request.headers.authorization ?? "";
    const login = auth.startsWith("Bearer token-") ? auth.slice("Bearer token-".length) : null;
    fake.requests.push({ method, path, body, login });
    const key = `${method} ${path}`;
    const failure = fake.failures[key];
    if (failure === "drop") {
      request.socket.destroy();
      return;
    }
    if (login === null || fake.users[login] === undefined) return send(response, 401, { message: "bad credentials" });
    if (typeof failure === "number") return send(response, failure, { message: "failed" });
    const page = Number(url.searchParams.get("page") ?? "1");
    const perPage = Number(url.searchParams.get("per_page") ?? "30");
    const slice = <T,>(rows: T[]): T[] => rows.slice((page - 1) * perPage, page * perPage);
    const issueMatch = /^\/repos\/owner\/repo\/issues\/(\d+)\/comments$/.exec(path);
    const commentMatch = /^\/repos\/owner\/repo\/issues\/comments\/(\d+)$/.exec(path);
    const pullMatch = /^\/repos\/owner\/repo\/pulls\/(\d+)$/.exec(path);
    const reviewsMatch = /^\/repos\/owner\/repo\/pulls\/(\d+)\/reviews$/.exec(path);
    const runMatch = /^\/repos\/owner\/repo\/actions\/runs\/(\d+)$/.exec(path);
    const attemptJobsMatch = /^\/repos\/owner\/repo\/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs$/.exec(path);
    const userMatch = /^\/users\/(.+)$/.exec(path);
    if (method === "GET" && userMatch) {
      const who = userMatch[1]!;
      if (fake.users[who] === undefined) return send(response, 404, { message: "Not Found" });
      return send(response, 200, { id: fake.users[who], login: who });
    }
    if (method === "GET" && path === "/repos/owner/repo/issues/comments") {
      return send(response, 200, slice(fake.comments));
    }
    if (issueMatch) {
      const number = Number(issueMatch[1]);
      if (method === "GET") return send(response, 200, slice(fake.comments.filter((comment) => comment.issue_url === `${fake.url}/repos/owner/repo/issues/${number}`)));
      if (method === "POST") {
        const author = login;
        const created: Row = {
          id: nextId++,
          body: JSON.parse(body).body,
          html_url: `https://github.example/owner/repo/pull/${number}#issuecomment-${nextId}`,
          issue_url: `${fake.url}/repos/owner/repo/issues/${number}`,
          user: { id: fake.users[author!], login: author },
        };
        fake.comments.push(created);
        if (failure === "drop-after") {
          request.socket.destroy();
          return;
        }
        return send(response, 201, fake.createReply ?? created);
      }
    }
    if (commentMatch && method === "PATCH") {
      const found = fake.comments.find((comment) => comment.id === Number(commentMatch[1]));
      if (!found) return send(response, 404, { message: "Not Found" });
      found.body = JSON.parse(body).body;
      return send(response, 200, found);
    }
    if (runMatch && method === "GET" && Number(runMatch[1]) === fake.run.id) {
      const current = { ...fake.run };
      send(response, 200, current);
      fake.afterRunRead?.();
      return;
    }
    if (attemptJobsMatch && method === "GET" && Number(attemptJobsMatch[1]) === fake.run.id) {
      const attempt = Number(attemptJobsMatch[2]);
      return send(response, 200, { total_count: 0, jobs: slice(fake.jobs.filter((job) => job.attempt === attempt)) });
    }
    if (pullMatch && method === "GET") {
      return fake.pulls.includes(Number(pullMatch[1])) ? send(response, 200, { number: Number(pullMatch[1]) }) : send(response, 404, { message: "Not Found" });
    }
    if (reviewsMatch && method === "GET") {
      const number = Number(reviewsMatch[1]);
      return send(response, 200, slice(fake.reviews.filter((review) => !isRow(review) || (review.pull ?? PR) === number)));
    }
    return send(response, 404, { message: `no route for ${key}` });
  }
  function send(response: ServerResponse, status: number, payload: unknown): void {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  }
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      fake.url = `http://127.0.0.1:${port}`;
      fake.close = () => new Promise<void>((done) => server.close(() => done()));
      resolve(fake);
    });
  });
}

function isRow(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runRow(attempt = 1, extra: Row = {}): Row {
  return {
    id: RUN,
    run_attempt: attempt,
    path: ".github/workflows/review.yml",
    event: "issue_comment",
    name: "Review",
    status: "in_progress",
    conclusion: null,
    created_at: "2026-11-08T10:00:00Z",
    ...extra,
  };
}

function acceptConfig(fake: Fake, overrides: Partial<AcceptConfig> = {}): { api: GitHubApi; config: AcceptConfig } {
  return {
    api: new GitHubApi(fake.url, `token-${BOT}`),
    config: {
      repo: REPO,
      runId: RUN,
      attempt: 1,
      pr: PR,
      mode: "agent",
      commentId: 55,
      feedbackAuthor: BOT,
      reviewAuthor: BOT,
      serverUrl: "https://github.example",
      ...overrides,
    },
  };
}

// A receipt as an earlier accept wrote it. The format is the contract the receipt parser reads.
function seedReceipt(fake: Fake, options: { id?: number; run?: number; attempt?: number; pr?: number; login?: string; reviewAuthorId?: number; mode?: string; state?: string; body?: string } = {}): number {
  const id = options.id ?? 900 + fake.comments.length;
  const author = options.login ?? BOT;
  const marker = `<!-- rev-engine-feedback:v1 run=${options.run ?? RUN} attempt=${options.attempt ?? 1} pr=${options.pr ?? PR} mode=${options.mode ?? "agent"} state=${options.state ?? "accepted"} feedback-author=${fake.users[author]} review-author=${options.reviewAuthorId ?? USERS[BOT]} comment=55 -->`;
  fake.comments.push({
    id,
    body: options.body ?? `${marker}\nseeded receipt`,
    html_url: `https://github.example/owner/repo/pull/${PR}#issuecomment-${id}`,
    issue_url: `${fake.url}/repos/owner/repo/issues/${PR}`,
    user: { id: fake.users[author], login: author },
  });
  return id;
}

async function runCli(phase: string, env: Record<string, string>): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [FEEDBACK_SCRIPT, phase], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const status = await new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
  return { status, stdout, stderr };
}

function cliEnv(fake: Fake, login: string, output: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    GITHUB_TOKEN: `token-${login}`,
    GITHUB_API_URL: fake.url,
    GITHUB_SERVER_URL: "https://github.example",
    REPO,
    SOURCE_RUN_ID: String(RUN),
    RUN_ATTEMPT: "1",
    PR_NUMBER: String(PR),
    MODE: "agent",
    COMMENT_ID: "55",
    FEEDBACK_AUTHOR: BOT,
    REVIEW_AUTHOR: BOT,
    GITHUB_OUTPUT: output,
    ...extra,
  };
}

function freshOutput(): string {
  return join(realpathSync(mkdtempSync(join(tmpdir(), "feedback-"))), "github-output");
}

function receiptsOf(fake: Fake): Row[] {
  return fake.comments.filter((comment) => String(comment.body).includes(`run=${RUN} `));
}

function postsTo(fake: Fake, path: string): Recorded[] {
  return fake.requests.filter((request) => request.method === "POST" && request.path === path);
}

// --- Acceptance: the receipt is written before accepted=true. ---

test("accept writes one receipt on the pull request with the mode, the run link and the trusted author IDs", async () => {
  const fake = await startFake();
  try {
    const { api, config } = acceptConfig(fake);
    const result = await accept(config, api);

    assert.equal(postsTo(fake, `/repos/owner/repo/issues/${PR}/comments`).length, 1);
    const receipt = fake.comments[0]!;
    assert.equal(result.commentId, receipt.id);
    const body = String(receipt.body);
    assert.match(body, /^<!-- rev-engine-feedback:v1 run=123 attempt=1 pr=7 mode=agent state=accepted feedback-author=41898282 review-author=41898282 comment=55 -->$/m);
    assert.match(body, /Agent/);
    assert.match(body, /Accepted — waiting for a review runner/);
    assert.match(body, /https:\/\/github\.example\/owner\/repo\/actions\/runs\/123\/attempts\/1/);
  } finally {
    await fake.close();
  }
});

test("accept leaves the request unaccepted when the receipt cannot be written, and does not retry the write", async () => {
  const fake = await startFake();
  try {
    fake.failures[`POST /repos/owner/repo/issues/${PR}/comments`] = 500;
    const { api, config } = acceptConfig(fake);

    await assert.rejects(accept(config, api));
    assert.equal(postsTo(fake, `/repos/owner/repo/issues/${PR}/comments`).length, 1);
    assert.equal(receiptsOf(fake).length, 0);
  } finally {
    await fake.close();
  }
});

test("accept reuses the receipt the same run already owns, and writes nothing", async () => {
  const fake = await startFake();
  try {
    const existing = seedReceipt(fake, { login: BOT });
    const { api, config } = acceptConfig(fake);

    const result = await accept(config, api);

    assert.equal(result.commentId, existing);
    assert.equal(fake.requests.filter((request) => request.method !== "GET").length, 0);
  } finally {
    await fake.close();
  }
});

test("accept ignores a same-marker receipt written by another author, and writes its own", async () => {
  const fake = await startFake();
  try {
    const forged = seedReceipt(fake, { login: PAT_USER });
    const { api, config } = acceptConfig(fake);

    const result = await accept(config, api);

    assert.notEqual(result.commentId, forged);
    assert.equal(postsTo(fake, `/repos/owner/repo/issues/${PR}/comments`).length, 1);
    assert.match(String(fake.comments.find((comment) => comment.id === forged)!.body), /seeded receipt/);
    assert.equal(fake.comments.find((comment) => comment.id === forged)!.user && (fake.comments.find((comment) => comment.id === forged)!.user as { login: string }).login, PAT_USER);
  } finally {
    await fake.close();
  }
});

test("accept recovers a receipt whose write succeeded but whose response was lost", async () => {
  const fake = await startFake();
  try {
    fake.failures[`POST /repos/owner/repo/issues/${PR}/comments`] = "drop-after";
    const { api, config } = acceptConfig(fake);

    const result = await accept(config, api);

    assert.equal(postsTo(fake, `/repos/owner/repo/issues/${PR}/comments`).length, 1);
    assert.equal(result.commentId, fake.comments[0]!.id);
  } finally {
    await fake.close();
  }
});

test("accept does not write again when the write fails before reaching GitHub", async () => {
  const fake = await startFake();
  try {
    fake.failures[`POST /repos/owner/repo/issues/${PR}/comments`] = "drop";
    const { api, config } = acceptConfig(fake);

    await assert.rejects(accept(config, api));
    assert.equal(postsTo(fake, `/repos/owner/repo/issues/${PR}/comments`).length, 1);
    assert.equal(receiptsOf(fake).length, 0);
  } finally {
    await fake.close();
  }
});

test("accept refuses a receipt written by an unexpected author, marks that comment failed, and names it", async () => {
  const fake = await startFake();
  try {
    const { api, config } = acceptConfig(fake);
    const impostor = new GitHubApi(fake.url, `token-${PAT_USER}`);

    await assert.rejects(accept(config, impostor), (error: Error) => {
      assert.match(error.message, /unexpected author/);
      assert.match(error.message, /https:\/\/github\.example\/owner\/repo\/pull\/7#issuecomment-/);
      return true;
    });
    const created = fake.comments[0]!;
    assert.match(String(created.body), /not accepted/);
    assert.ok(!String(created.body).includes("state=accepted"));
  } finally {
    await fake.close();
  }
});

test("accept stops without writing when a configured author cannot be resolved", async () => {
  const fake = await startFake();
  try {
    const { api, config } = acceptConfig(fake, { reviewAuthor: "nobody[bot]" });

    await assert.rejects(accept(config, api));
    assert.equal(fake.requests.filter((request) => request.method !== "GET").length, 0);
  } finally {
    await fake.close();
  }
});

test("accept on a rerun moves the same receipt to the new attempt, with no new comment", async () => {
  const fake = await startFake();
  try {
    const existing = seedReceipt(fake, { login: BOT, attempt: 1 });
    const { api, config } = acceptConfig(fake, { attempt: 2 });

    const result = await accept(config, api);

    assert.equal(result.commentId, existing);
    assert.equal(postsTo(fake, `/repos/owner/repo/issues/${PR}/comments`).length, 0);
    const body = String(fake.comments[0]!.body);
    assert.match(body, /attempt=2 /);
    assert.match(body, /attempts\/2/);
  } finally {
    await fake.close();
  }
});

test("accept for a different run on the same pull request writes a separate receipt and leaves the first alone", async () => {
  const fake = await startFake();
  try {
    const first = seedReceipt(fake, { login: BOT, run: RUN });
    const { api, config } = acceptConfig(fake, { runId: 456, commentId: null });

    const result = await accept(config, api);

    assert.notEqual(result.commentId, first);
    assert.match(String(fake.comments.find((comment) => comment.id === result.commentId)!.body), /run=456 attempt=1 pr=7 mode=agent state=accepted feedback-author=41898282 review-author=41898282 comment=none/);
    assert.equal(fake.comments.find((comment) => comment.id === first)!.body, `<!-- rev-engine-feedback:v1 run=123 attempt=1 pr=7 mode=agent state=accepted feedback-author=41898282 review-author=41898282 comment=55 -->\nseeded receipt`);
  } finally {
    await fake.close();
  }
});

test("accept refuses an owned receipt whose recorded review author differs from the configured one", async () => {
  const fake = await startFake();
  try {
    seedReceipt(fake, { login: BOT, reviewAuthorId: 777 });
    const { api, config } = acceptConfig(fake, { reviewAuthor: REVIEW_APP });

    await assert.rejects(accept(config, api), /review author/);
    assert.equal(fake.requests.filter((request) => request.method !== "GET").length, 0);
  } finally {
    await fake.close();
  }
});

test("accept finds its owned receipt on a later page of the pull request's comments", async () => {
  const fake = await startFake();
  try {
    for (let index = 0; index < 120; index += 1) seedReceipt(fake, { login: PAT_USER, run: 5000 + index });
    const existing = seedReceipt(fake, { login: BOT });
    const { api, config } = acceptConfig(fake);

    const result = await accept(config, api);

    assert.equal(result.commentId, existing);
    assert.equal(postsTo(fake, `/repos/owner/repo/issues/${PR}/comments`).length, 0);
  } finally {
    await fake.close();
  }
});

test("the CLI reports accepted=true only after the receipt exists, with the comment ID", async () => {
  const fake = await startFake();
  try {
    const output = freshOutput();
    const result = await runCli("accept", cliEnv(fake, BOT, output, { PR_NUMBER: String(PR), MODE: "human", COMMENT_ID: "" }));

    assert.equal(result.status, 0, result.stderr);
    const written = readFileSync(output, "utf8");
    assert.match(written, /^accepted=true$/m);
    assert.match(written, new RegExp(`^comment-id=${fake.comments[0]!.id}$`, "m"));
    assert.match(written, /^run-id=123$/m);
    assert.equal(receiptsOf(fake).length, 1);
  } finally {
    await fake.close();
  }
});

test("the CLI writes no accepted output when the receipt cannot be written", async () => {
  const fake = await startFake();
  try {
    fake.failures[`POST /repos/owner/repo/issues/${PR}/comments`] = 500;
    const output = freshOutput();
    writeFileSync(output, "");

    const result = await runCli("accept", cliEnv(fake, BOT, output));

    assert.notEqual(result.status, 0);
    assert.ok(!readFileSync(output, "utf8").includes("accepted=true"));
    assert.ok(!result.stdout.includes("accepted=true"));
  } finally {
    await fake.close();
  }
});

// --- Lifecycle: the receipt follows the review run through GitHub's current state. ---

const JOB = "Review pull request";

function syncConfig(overrides: Partial<SyncConfig> = {}): SyncConfig {
  return {
    repo: REPO,
    runId: RUN,
    reviewWorkflow: ".github/workflows/review.yml",
    reviewJob: JOB,
    feedbackAuthor: BOT,
    reviewAuthor: BOT,
    serverUrl: "https://github.example",
    ...overrides,
  };
}

function setJob(fake: Fake, attempt: number, status: string, conclusion: string | null = null, name = JOB): void {
  fake.jobs = fake.jobs.filter((job) => !(job.attempt === attempt && job.name === name));
  fake.jobs.push({ attempt, name, status, conclusion, html_url: `https://github.example/owner/repo/actions/runs/${RUN}/job/${attempt}` });
}

function publish(fake: Fake, options: { login?: string; attempt?: number; run?: number; state?: string; body?: string } = {}): number {
  const id = 5000 + fake.reviews.length;
  const author = options.login ?? BOT;
  fake.reviews.push({
    id,
    pull: PR,
    state: options.state ?? "COMMENTED",
    html_url: `https://github.example/owner/repo/pull/${PR}#pullrequestreview-${id}`,
    body: options.body ?? `### Automated review\n\nFindings.\n\n<!-- rev-engine-prime -->\n<!-- rev-engine-feedback-review:v1 run=${options.run ?? RUN} attempt=${options.attempt ?? 1} -->`,
    user: { id: fake.users[author], login: author },
  });
  return id;
}

function receiptBody(fake: Fake, run = RUN): string {
  return String(receiptsOf(fake).find((comment) => String(comment.body).includes(`run=${run} `))!.body);
}

function patchesOf(fake: Fake): Recorded[] {
  return fake.requests.filter((request) => request.method === "PATCH");
}

function runIs(fake: Fake, status: string, conclusion: string | null, attempt = 1, path = ".github/workflows/review.yml", event = "issue_comment"): void {
  fake.run = runRow(attempt, { status, conclusion, path, event });
}

test("sync moves the receipt from accepted to started to published, as the run and its review progress", async () => {
  const fake = await startFake();
  try {
    seedReceipt(fake, { login: BOT });
    const api = new GitHubApi(fake.url, `token-${BOT}`);

    setJob(fake, 1, "queued");
    assert.equal((await sync(syncConfig(), api)).changed, false);
    assert.equal(patchesOf(fake).length, 0);

    setJob(fake, 1, "in_progress");
    assert.equal((await sync(syncConfig(), api)).changed, true);
    assert.match(receiptBody(fake), /\*\*Review job started\*\*/);
    assert.match(receiptBody(fake), /state=started/);

    publish(fake);
    runIs(fake, "completed", "success");
    setJob(fake, 1, "completed", "success");
    await sync(syncConfig(), api);
    assert.match(receiptBody(fake), /\*\*Review published\*\*/);
    assert.match(receiptBody(fake), /https:\/\/github\.example\/owner\/repo\/pull\/7#pullrequestreview-5000/);
    assert.equal(patchesOf(fake).length, 2);
  } finally {
    await fake.close();
  }
});

test("a successful run with no published review is reported as failed, not as success", async () => {
  const fake = await startFake();
  try {
    seedReceipt(fake, { login: BOT, state: "started" });
    runIs(fake, "completed", "success");
    setJob(fake, 1, "completed", "skipped");

    await sync(syncConfig(), new GitHubApi(fake.url, `token-${BOT}`));

    assert.match(receiptBody(fake), /\*\*Failed \/ no review published\*\*/);
    assert.doesNotMatch(receiptBody(fake), /Review published/);
  } finally {
    await fake.close();
  }
});

test("a cancelled or replaced run is reported as cancelled", async () => {
  const fake = await startFake();
  try {
    seedReceipt(fake, { login: BOT, state: "started" });
    runIs(fake, "completed", "cancelled");
    setJob(fake, 1, "completed", "cancelled");

    await sync(syncConfig(), new GitHubApi(fake.url, `token-${BOT}`));

    assert.match(receiptBody(fake), /\*\*Cancelled\*\*/);
  } finally {
    await fake.close();
  }
});

test("a delayed event for attempt 1 reconciles the current attempt 2 and never shows attempt 1's review", async () => {
  const fake = await startFake();
  try {
    seedReceipt(fake, { login: BOT, attempt: 2, state: "started" });
    publish(fake, { attempt: 1 });
    runIs(fake, "in_progress", null, 2);
    setJob(fake, 2, "in_progress");
    setJob(fake, 1, "completed", "success");

    const result = await sync(syncConfig(), new GitHubApi(fake.url, `token-${BOT}`));

    assert.equal(result.changed, false);
    assert.equal(patchesOf(fake).length, 0);
    assert.match(receiptBody(fake), /attempt=2 /);
  } finally {
    await fake.close();
  }
});

test("a completed review job does not show the request as started while the run is still going", async () => {
  const fake = await startFake();
  try {
    seedReceipt(fake, { login: BOT, state: "accepted" });
    runIs(fake, "in_progress", null, 1);
    const api = new GitHubApi(fake.url, `token-${BOT}`);

    for (const conclusion of ["skipped", "success", "failure", "cancelled"]) {
      setJob(fake, 1, "completed", conclusion);
      const result = await sync(syncConfig(), api);
      assert.equal(result.changed, false, conclusion);
      assert.equal(result.state, "accepted", conclusion);
    }
    assert.equal(patchesOf(fake).length, 0);
    assert.match(receiptBody(fake), /state=accepted /);
  } finally {
    await fake.close();
  }
});

test("a receipt that has started says the job has started, and never that it is still running", async () => {
  const fake = await startFake();
  try {
    seedReceipt(fake, { login: BOT, attempt: 1, state: "accepted" });
    runIs(fake, "in_progress", null, 2);
    setJob(fake, 2, "in_progress");

    await sync(syncConfig(), new GitHubApi(fake.url, `token-${BOT}`));

    assert.match(receiptBody(fake), /attempt=2 pr=7 mode=agent state=started/);
    assert.match(receiptBody(fake), /The review job has started\./);
    assert.doesNotMatch(receiptBody(fake), /is running/);
  } finally {
    await fake.close();
  }
});

test("a rerun is detected when the attempt changes between the reads, and the receipt moves to the new attempt", async () => {
  const fake = await startFake();
  try {
    seedReceipt(fake, { login: BOT, attempt: 1, state: "accepted" });
    runIs(fake, "in_progress", null, 1);
    setJob(fake, 1, "in_progress");
    fake.afterRunRead = () => {
      fake.afterRunRead = undefined;
      runIs(fake, "in_progress", null, 2);
      setJob(fake, 2, "in_progress");
    };

    await sync(syncConfig(), new GitHubApi(fake.url, `token-${BOT}`));

    assert.match(receiptBody(fake), /attempt=2 pr=7 mode=agent state=started/);
    assert.match(receiptBody(fake), /attempts\/2/);
    assert.equal(postsTo(fake, `/repos/owner/repo/issues/${PR}/comments`).length, 0);
  } finally {
    await fake.close();
  }
});

test("a delayed or repeated notification does not restore an earlier state or rewrite the receipt", async () => {
  const fake = await startFake();
  try {
    seedReceipt(fake, { login: BOT, state: "published", body: `${"<!-- rev-engine-feedback:v1 run=123 attempt=1 pr=7 mode=agent state=published feedback-author=41898282 review-author=41898282 comment=55 -->"}\n**Review published**\n\nThe review is [here](https://github.example/owner/repo/pull/7#pullrequestreview-5000).` });
    publish(fake);
    runIs(fake, "in_progress", null, 1);
    setJob(fake, 1, "in_progress");

    const api = new GitHubApi(fake.url, `token-${BOT}`);
    assert.equal((await sync(syncConfig(), api)).changed, false);
    assert.equal((await sync(syncConfig(), api)).changed, false);
    assert.equal(patchesOf(fake).length, 0);
  } finally {
    await fake.close();
  }
});

test("an owned receipt keeps a terminal failure against a later, non-published start", async () => {
  const fake = await startFake();
  try {
    seedReceipt(fake, { login: BOT, state: "failed" });
    runIs(fake, "in_progress", null, 1);
    setJob(fake, 1, "in_progress");

    assert.equal((await sync(syncConfig(), new GitHubApi(fake.url, `token-${BOT}`))).changed, false);
    assert.equal(patchesOf(fake).length, 0);
  } finally {
    await fake.close();
  }
});

test("sync updates only the receipt of its own run when two runs share a pull request", async () => {
  const fake = await startFake();
  try {
    seedReceipt(fake, { login: BOT, run: 123 });
    const other = seedReceipt(fake, { login: BOT, run: 456 });
    runIs(fake, "completed", "cancelled");
    setJob(fake, 1, "completed", "cancelled");

    await sync(syncConfig(), new GitHubApi(fake.url, `token-${BOT}`));

    assert.equal(patchesOf(fake).length, 1);
    assert.equal(patchesOf(fake)[0]!.path, `/repos/owner/repo/issues/comments/${fake.comments[0]!.id}`);
    assert.notEqual(fake.comments.find((comment) => comment.id === other)!.body, undefined);
  } finally {
    await fake.close();
  }
});

test("forged publication markers and reviews from other authors never publish a receipt", async () => {
  const fake = await startFake();
  try {
    seedReceipt(fake, { login: BOT, state: "started" });
    publish(fake, { login: PAT_USER });
    seedReceipt(fake, { login: PAT_USER, id: 777 });
    runIs(fake, "in_progress", null, 1);
    setJob(fake, 1, "in_progress");

    await sync(syncConfig(), new GitHubApi(fake.url, `token-${BOT}`));

    assert.doesNotMatch(receiptBody(fake), /Review published/);
  } finally {
    await fake.close();
  }
});

test("a review by the configured review author proves publication, and one by another author does not", async () => {
  const fake = await startFake();
  try {
    seedReceipt(fake, { login: BOT, state: "started", reviewAuthorId: USERS[PAT_USER] });
    publish(fake, { login: PAT_USER });
    runIs(fake, "completed", "success");
    setJob(fake, 1, "completed", "success");
    const api = new GitHubApi(fake.url, `token-${BOT}`);

    await sync(syncConfig({ reviewAuthor: PAT_USER }), api);
    assert.match(receiptBody(fake), /Review published/);
  } finally {
    await fake.close();
  }
});

test("a failed read of the reviews stops sync without marking the request failed", async () => {
  const fake = await startFake();
  try {
    seedReceipt(fake, { login: BOT, state: "started" });
    runIs(fake, "completed", "success");
    setJob(fake, 1, "completed", "success");
    fake.failures[`GET /repos/owner/repo/pulls/${PR}/reviews`] = 500;

    await assert.rejects(sync(syncConfig(), new GitHubApi(fake.url, `token-${BOT}`)));
    assert.equal(patchesOf(fake).length, 0);
  } finally {
    await fake.close();
  }
});

test("a failed write leaves the receipt for a manual retry, and the error is raised", async () => {
  const fake = await startFake();
  try {
    const id = seedReceipt(fake, { login: BOT, state: "accepted" });
    setJob(fake, 1, "in_progress");
    runIs(fake, "in_progress", null, 1);
    fake.failures[`PATCH /repos/owner/repo/issues/comments/${id}`] = 503;

    await assert.rejects(sync(syncConfig(), new GitHubApi(fake.url, `token-${BOT}`)));
  } finally {
    await fake.close();
  }
});

test("sync finds a receipt and a publication on later pages of the lists", async () => {
  const fake = await startFake();
  try {
    for (let index = 0; index < 150; index += 1) seedReceipt(fake, { login: PAT_USER, run: 7000 + index });
    seedReceipt(fake, { login: BOT, state: "started" });
    for (let index = 0; index < 120; index += 1) publish(fake, { run: 8000 + index });
    publish(fake, { attempt: 1 });
    runIs(fake, "completed", "success");
    setJob(fake, 1, "completed", "success");

    await sync(syncConfig(), new GitHubApi(fake.url, `token-${BOT}`));

    assert.match(receiptBody(fake), /Review published/);
  } finally {
    await fake.close();
  }
});

test("sync refuses a receipt whose recorded review author differs from the configured one, without writing", async () => {
  const fake = await startFake();
  try {
    seedReceipt(fake, { login: BOT, reviewAuthorId: 777, state: "started" });
    runIs(fake, "in_progress", null, 1);
    setJob(fake, 1, "in_progress");

    await assert.rejects(sync(syncConfig({ reviewAuthor: REVIEW_APP }), new GitHubApi(fake.url, `token-${BOT}`)), /review author/);
    assert.equal(patchesOf(fake).length, 0);
  } finally {
    await fake.close();
  }
});

test("sync rejects a source run that is not the expected review workflow or a review request event", async () => {
  const fake = await startFake();
  try {
    seedReceipt(fake, { login: BOT, state: "started" });
    const api = new GitHubApi(fake.url, `token-${BOT}`);
    runIs(fake, "in_progress", null, 1, ".github/workflows/other.yml");
    await assert.rejects(sync(syncConfig(), api));
    for (const event of ["push", "pull_request_target", "schedule"]) {
      runIs(fake, "in_progress", null, 1, ".github/workflows/review.yml", event);
      await assert.rejects(sync(syncConfig(), api), event);
    }
    assert.equal(patchesOf(fake).length, 0);
  } finally {
    await fake.close();
  }
});

test("sync accepts a review run started by a pull request event, as a workflow that reviews on open does", async () => {
  const fake = await startFake();
  try {
    seedReceipt(fake, { login: BOT, state: "accepted" });
    const api = new GitHubApi(fake.url, `token-${BOT}`);
    runIs(fake, "completed", "success", 1, ".github/workflows/review.yml", "pull_request");
    const result = await sync(syncConfig(), api);
    assert.equal(result.state, "failed");
    assert.equal(patchesOf(fake).length, 1);
  } finally {
    await fake.close();
  }
});

test("sync never creates a receipt, so a run without one is a quiet no-op", async () => {
  const fake = await startFake();
  try {
    runIs(fake, "completed", "failure");
    setJob(fake, 1, "completed", "failure");

    const result = await sync(syncConfig(), new GitHubApi(fake.url, `token-${BOT}`));

    assert.equal(result.changed, false);
    assert.equal(fake.requests.filter((request) => request.method !== "GET").length, 0);
  } finally {
    await fake.close();
  }
});

test("the CLI sync writes the receipt from the run's current state", async () => {
  const fake = await startFake();
  try {
    seedReceipt(fake, { login: BOT, state: "accepted" });
    setJob(fake, 1, "in_progress");
    runIs(fake, "in_progress", null, 1);
    const output = freshOutput();
    writeFileSync(output, "");

    const result = await runCli("sync", cliEnv(fake, BOT, output, { REVIEW_WORKFLOW: ".github/workflows/review.yml", REVIEW_JOB: JOB }));

    assert.equal(result.status, 0, result.stderr);
    assert.match(receiptBody(fake), /Review job started/);
    assert.equal(readFileSync(output, "utf8"), "");
  } finally {
    await fake.close();
  }
});

// --- Receipt author: only the trusted GitHub Actions identity writes a receipt. ---

const TRUSTED = USERS[BOT]!;
const CREATED_RECEIPT = `<!-- rev-engine-feedback:v1 run=${RUN} attempt=1 pr=${PR} mode=agent state=accepted feedback-author=${TRUSTED} review-author=${TRUSTED} comment=55 -->\nAccepted`;
const CURRENT_MARKER = `<!-- rev-engine-feedback-review:v1 run=${RUN} attempt=1 -->`;

function createdRow(fake: Fake, overrides: Row = {}): Row {
  return {
    // The first comment a fresh fixture creates, so a compensating PATCH finds the stored comment.
    id: 1000,
    body: CREATED_RECEIPT,
    html_url: `https://github.example/owner/repo/pull/${PR}#issuecomment-2001`,
    issue_url: `${fake.url}/repos/owner/repo/issues/${PR}`,
    user: { id: TRUSTED, login: BOT },
    ...overrides,
  };
}

function commentRow(fake: Fake, overrides: Row): Row {
  return {
    id: 880,
    body: "A comment",
    html_url: `https://github.example/owner/repo/pull/${PR}#issuecomment-880`,
    issue_url: `${fake.url}/repos/owner/repo/issues/${PR}`,
    user: { id: fake.users[PAT_USER], login: PAT_USER },
    ...overrides,
  };
}

function reviewRow(overrides: Row): Row {
  return {
    id: 5300,
    pull: PR,
    state: "COMMENTED",
    body: `A review\n\n${CURRENT_MARKER}`,
    html_url: `https://github.example/owner/repo/pull/${PR}#pullrequestreview-5300`,
    user: { id: TRUSTED, login: BOT },
    ...overrides,
  };
}

function writesOf(fake: Fake): number {
  return fake.requests.filter((request) => request.method !== "GET").length;
}

test("a receipt author other than github-actions[bot] is refused before any lookup or write, and an owned receipt is kept", async () => {
  const fake = await startFake();
  try {
    const existing = seedReceipt(fake, { login: BOT });
    const before = String(fake.comments.find((comment) => comment.id === existing)!.body);
    const api = new GitHubApi(fake.url, `token-${BOT}`);
    const { config } = acceptConfig(fake, { feedbackAuthor: REVIEW_APP });

    await assert.rejects(accept(config, api), /receipt author must be github-actions\[bot\]/);
    await assert.rejects(sync(syncConfig({ feedbackAuthor: REVIEW_APP }), api), /receipt author must be github-actions\[bot\]/);

    assert.equal(fake.requests.length, 0);
    assert.equal(String(fake.comments.find((comment) => comment.id === existing)!.body), before);
  } finally {
    await fake.close();
  }
});

test("an unsupported receipt author on a fresh request creates nothing", async () => {
  const fake = await startFake();
  try {
    const { config } = acceptConfig(fake, { feedbackAuthor: PAT_USER });

    await assert.rejects(accept(config, new GitHubApi(fake.url, `token-${PAT_USER}`)), /receipt author must be github-actions\[bot\]/);

    assert.equal(fake.requests.length, 0);
    assert.equal(fake.comments.length, 0);
  } finally {
    await fake.close();
  }
});

test("the trusted receipt author's ID is pinned: another ID for the same login fails before any write, with no receipt", async () => {
  const fake = await startFake();
  try {
    fake.users[BOT] = 999;
    const api = new GitHubApi(fake.url, `token-${BOT}`);

    await assert.rejects(accept(acceptConfig(fake).config, api), /trusted ID/);
    await assert.rejects(sync(syncConfig(), api), /trusted ID/);

    assert.equal(writesOf(fake), 0);
    assert.equal(fake.comments.length, 0);
  } finally {
    await fake.close();
  }
});

test("a same-marker receipt by a foreign author listed first does not hide the owned receipt from sync", async () => {
  const fake = await startFake();
  try {
    const forged = seedReceipt(fake, { login: PAT_USER, state: "started" });
    const forgedBefore = String(fake.comments.find((comment) => comment.id === forged)!.body);
    const owned = seedReceipt(fake, { login: BOT, state: "started" });
    runIs(fake, "completed", "success");
    setJob(fake, 1, "completed", "success");

    await sync(syncConfig(), new GitHubApi(fake.url, `token-${BOT}`));

    assert.deepEqual(patchesOf(fake).map((request) => request.path), [`/repos/owner/repo/issues/comments/${owned}`]);
    assert.match(String(fake.comments.find((comment) => comment.id === owned)!.body), /Failed \/ no review published/);
    assert.equal(String(fake.comments.find((comment) => comment.id === forged)!.body), forgedBefore);
  } finally {
    await fake.close();
  }
});

test("a comment by a deleted account that carries a receipt marker is unowned: accept writes its own, and sync leaves it alone", async () => {
  const fake = await startFake();
  try {
    fake.comments.push(commentRow(fake, { id: 880, body: `${CREATED_RECEIPT}\nseeded`, user: null }));
    const api = new GitHubApi(fake.url, `token-${BOT}`);

    const result = await accept(acceptConfig(fake).config, api);

    assert.notEqual(result.commentId, 880);
    assert.equal(postsTo(fake, `/repos/owner/repo/issues/${PR}/comments`).length, 1);
    runIs(fake, "in_progress", null, 1);
    setJob(fake, 1, "in_progress");

    await sync(syncConfig(), api);

    assert.deepEqual(patchesOf(fake).map((request) => request.path), [`/repos/owner/repo/issues/comments/${result.commentId}`]);
    assert.equal(String(fake.comments.find((comment) => comment.id === 880)!.body), `${CREATED_RECEIPT}\nseeded`);
  } finally {
    await fake.close();
  }
});

test("a foreign comment carrying a malformed copy of a receipt marker is never parsed as owned, so accept writes its own", async () => {
  const fake = await startFake();
  try {
    fake.comments.push(commentRow(fake, { id: 880, body: `<!-- rev-engine-feedback:v1 run=${RUN} attempt=x pr=${PR} -->\nseeded` }));

    const result = await accept(acceptConfig(fake).config, new GitHubApi(fake.url, `token-${BOT}`));

    assert.notEqual(result.commentId, 880);
    assert.equal(postsTo(fake, `/repos/owner/repo/issues/${PR}/comments`).length, 1);
    assert.equal(patchesOf(fake).length, 0);
  } finally {
    await fake.close();
  }
});

test("a trailing slash on the API base changes nothing in accept or sync", async () => {
  const fake = await startFake();
  try {
    const api = new GitHubApi(`${fake.url}/`, `token-${BOT}`);

    await accept(acceptConfig(fake).config, api);
    runIs(fake, "completed", "success");
    setJob(fake, 1, "completed", "success");
    const result = await sync(syncConfig(), api);

    assert.equal(result.changed, true);
    assert.match(receiptBody(fake), /Failed \/ no review published/);
  } finally {
    await fake.close();
  }
});

// --- Receipt evidence: a write is accepted only when GitHub's answer is a receipt for this request. ---

const UNREADABLE_CREATES: Array<[string, (fake: Fake) => unknown]> = [
  ["only the expected author", () => ({ user: { id: TRUSTED } })],
  ["an ID of zero", (fake) => createdRow(fake, { id: 0 })],
  ["a negative ID", (fake) => createdRow(fake, { id: -4 })],
  ["a fractional ID", (fake) => createdRow(fake, { id: 1.5 })],
  ["an ID beyond the safe integers", (fake) => createdRow(fake, { id: 2 ** 60 })],
  ["no URL", (fake) => createdRow(fake, { html_url: undefined })],
  ["a bare https prefix as the URL", (fake) => createdRow(fake, { html_url: "https://" })],
  ["a URL with credentials", (fake) => createdRow(fake, { html_url: "https://user:secret@github.example/owner/repo/pull/7" })],
  ["an issue URL that is not a URL", (fake) => createdRow(fake, { issue_url: "not a url" })],
  ["no body", (fake) => createdRow(fake, { body: undefined })],
  ["an ID that is not a number", (fake) => createdRow(fake, { id: "2001" })],
];

for (const [name, reply] of UNREADABLE_CREATES) {
  test(`a receipt write answered with ${name} is not accepted, is not repeated, and its comment is not patched`, async () => {
    const fake = await startFake();
    try {
      fake.createReply = reply(fake);

      await assert.rejects(accept(acceptConfig(fake).config, new GitHubApi(fake.url, `token-${BOT}`)));

      assert.equal(postsTo(fake, `/repos/owner/repo/issues/${PR}/comments`).length, 1);
      assert.equal(patchesOf(fake).length, 0);
    } finally {
      await fake.close();
    }
  });
}

const WRONG_CREATES: Array<[string, (fake: Fake) => unknown]> = [
  ["a body that is not the requested receipt", (fake) => createdRow(fake, { body: "Accepted" })],
  ["another pull request", (fake) => createdRow(fake, { issue_url: `${fake.url}/repos/owner/repo/issues/8` })],
];

for (const [name, reply] of WRONG_CREATES) {
  test(`a receipt write answered with ${name} is refused, and only that comment is marked not accepted`, async () => {
    const fake = await startFake();
    try {
      fake.createReply = reply(fake);

      await assert.rejects(accept(acceptConfig(fake).config, new GitHubApi(fake.url, `token-${BOT}`)), /not accepted/);

      assert.equal(postsTo(fake, `/repos/owner/repo/issues/${PR}/comments`).length, 1);
      assert.deepEqual(patchesOf(fake).map((request) => request.path), [`/repos/owner/repo/issues/comments/${fake.comments[0]!.id}`]);
      assert.match(String(fake.comments[0]!.body), /Not accepted/);
    } finally {
      await fake.close();
    }
  });
}

test("the CLI writes no accepted output when the receipt answer carries only the expected author", async () => {
  const fake = await startFake();
  try {
    fake.createReply = { user: { id: TRUSTED } };
    const output = freshOutput();
    writeFileSync(output, "");

    const result = await runCli("accept", cliEnv(fake, BOT, output, { COMMENT_ID: "" }));

    assert.notEqual(result.status, 0);
    assert.ok(!readFileSync(output, "utf8").includes("accepted=true"));
    assert.ok(!result.stdout.includes("accepted=true"));
    assert.equal(postsTo(fake, `/repos/owner/repo/issues/${PR}/comments`).length, 1);
  } finally {
    await fake.close();
  }
});

const MALFORMED_COMMENTS: Array<[string, Row]> = [
  ["no user field", { user: undefined }],
  ["a user with a zero ID", { user: { id: 0, login: PAT_USER } }],
  ["an ID of zero", { id: 0 }],
  ["a body that is not text", { body: 7 }],
  ["a URL that is only the https prefix", { html_url: "https://" }],
];

for (const [name, overrides] of MALFORMED_COMMENTS) {
  test(`a listed comment with ${name} fails accept, so no second receipt is written in its place`, async () => {
    const fake = await startFake();
    try {
      fake.comments.push(commentRow(fake, overrides));

      await assert.rejects(accept(acceptConfig(fake).config, new GitHubApi(fake.url, `token-${BOT}`)));

      assert.equal(postsTo(fake, `/repos/owner/repo/issues/${PR}/comments`).length, 0);
    } finally {
      await fake.close();
    }
  });
}

test("a listed comment whose issue URL is not a URL fails sync, which lists every comment of the repository", async () => {
  const fake = await startFake();
  try {
    const id = seedReceipt(fake, { login: BOT, state: "started" });
    fake.comments.push(commentRow(fake, { issue_url: "not a url" }));
    runIs(fake, "in_progress", null, 1);
    setJob(fake, 1, "in_progress");

    await assert.rejects(sync(syncConfig(), new GitHubApi(fake.url, `token-${BOT}`)));

    assert.equal(patchesOf(fake).length, 0);
    assert.match(String(fake.comments.find((comment) => comment.id === id)!.body), /state=started/);
  } finally {
    await fake.close();
  }
});

const UNSAFE_RECEIPTS: Array<[string, string]> = [
  ["a zero attempt", `<!-- rev-engine-feedback:v1 run=${RUN} attempt=0 pr=${PR} mode=agent state=accepted feedback-author=${TRUSTED} review-author=${TRUSTED} comment=55 -->\nseeded`],
  ["a zero comment ID", `<!-- rev-engine-feedback:v1 run=${RUN} attempt=1 pr=${PR} mode=agent state=accepted feedback-author=${TRUSTED} review-author=${TRUSTED} comment=0 -->\nseeded`],
  ["an unsafe review author ID", `<!-- rev-engine-feedback:v1 run=${RUN} attempt=1 pr=${PR} mode=agent state=accepted feedback-author=${TRUSTED} review-author=99999999999999999999 comment=55 -->\nseeded`],
];

for (const [name, body] of UNSAFE_RECEIPTS) {
  test(`an owned receipt with ${name} is malformed, so accept and sync refuse it without writing`, async () => {
    const fake = await startFake();
    try {
      const existing = seedReceipt(fake, { login: BOT, body });
      const api = new GitHubApi(fake.url, `token-${BOT}`);
      runIs(fake, "in_progress", null, 1);

      await assert.rejects(accept(acceptConfig(fake).config, api));
      await assert.rejects(sync(syncConfig(), api));

      assert.equal(writesOf(fake), 0);
      assert.equal(String(fake.comments.find((comment) => comment.id === existing)!.body), body);
    } finally {
      await fake.close();
    }
  });
}

// --- Review rows: a malformed row is an unknown answer, never proof of absence. ---

const MALFORMED_REVIEWS: Array<[string, unknown]> = [
  ["an empty object", {}],
  ["null", null],
  ["a number", 42],
  ["an ID of zero", reviewRow({ id: 0 })],
  ["a fractional ID", reviewRow({ id: 2.5 })],
  ["a body that is not text", reviewRow({ body: 7 })],
  ["a URL that is only the https prefix", reviewRow({ html_url: "https://" })],
  ["a state GitHub does not use", reviewRow({ state: "MAYBE" })],
  ["no user field", reviewRow({ user: undefined })],
  ["a user with no login", reviewRow({ user: { id: TRUSTED } })],
  ["a user with a zero ID", reviewRow({ user: { id: 0, login: BOT } })],
];

for (const [name, row] of MALFORMED_REVIEWS) {
  test(`a review list with ${name} fails sync and leaves the receipt unchanged`, async () => {
    const fake = await startFake();
    try {
      seedReceipt(fake, { login: BOT, state: "started" });
      runIs(fake, "completed", "success");
      setJob(fake, 1, "completed", "success");
      fake.reviews.push(row);
      const before = receiptBody(fake);

      await assert.rejects(sync(syncConfig(), new GitHubApi(fake.url, `token-${BOT}`)));

      assert.equal(patchesOf(fake).length, 0);
      assert.equal(receiptBody(fake), before);
    } finally {
      await fake.close();
    }
  });
}

test("a malformed review row fails sync even on the page where another row proves publication", async () => {
  const fake = await startFake();
  try {
    seedReceipt(fake, { login: BOT, state: "started" });
    publish(fake);
    fake.reviews.push({});
    runIs(fake, "completed", "success");
    setJob(fake, 1, "completed", "success");

    await assert.rejects(sync(syncConfig(), new GitHubApi(fake.url, `token-${BOT}`)));

    assert.equal(patchesOf(fake).length, 0);
  } finally {
    await fake.close();
  }
});

test("a pending review and a review by a deleted account are not publication, and do not fail sync", async () => {
  const fake = await startFake();
  try {
    seedReceipt(fake, { login: BOT, state: "started" });
    fake.reviews.push(reviewRow({ id: 5400, state: "PENDING", user: null }));
    fake.reviews.push(reviewRow({ id: 5401, user: null }));
    runIs(fake, "completed", "success");
    setJob(fake, 1, "completed", "success");

    await sync(syncConfig(), new GitHubApi(fake.url, `token-${BOT}`));

    assert.match(receiptBody(fake), /\*\*Failed \/ no review published\*\*/);
  } finally {
    await fake.close();
  }
});

// --- Configuration: the CLI refuses an unsupported or incomplete setting before any request. ---

test("the CLI refuses an unsupported receipt author before any request", async () => {
  const fake = await startFake();
  try {
    const output = freshOutput();
    writeFileSync(output, "");

    const result = await runCli("accept", cliEnv(fake, BOT, output, { FEEDBACK_AUTHOR: REVIEW_APP }));

    assert.notEqual(result.status, 0);
    assert.equal(fake.requests.length, 0);
    assert.equal(readFileSync(output, "utf8"), "");
  } finally {
    await fake.close();
  }
});

test("the CLI sync fails before any request when the review workflow or job is not configured", async () => {
  const fake = await startFake();
  try {
    const output = freshOutput();
    writeFileSync(output, "");
    const env = cliEnv(fake, BOT, output);

    const unset = await runCli("sync", env);
    const blankJob = await runCli("sync", { ...env, REVIEW_WORKFLOW: ".github/workflows/review.yml", REVIEW_JOB: "  " });
    const blankWorkflow = await runCli("sync", { ...env, REVIEW_WORKFLOW: "   ", REVIEW_JOB: JOB });

    for (const result of [unset, blankJob, blankWorkflow]) assert.notEqual(result.status, 0, result.stderr);
    assert.equal(fake.requests.length, 0);
  } finally {
    await fake.close();
  }
});

test("the CLI refuses ids that are not safe positive integers before any request", async () => {
  const fake = await startFake();
  try {
    const output = freshOutput();
    writeFileSync(output, "");
    const unsafe = "99999999999999999999";

    const results = [
      await runCli("accept", cliEnv(fake, BOT, output, { RUN_ATTEMPT: unsafe })),
      await runCli("accept", cliEnv(fake, BOT, output, { PR_NUMBER: unsafe })),
      await runCli("sync", cliEnv(fake, BOT, output, { SOURCE_RUN_ID: unsafe, REVIEW_WORKFLOW: ".github/workflows/review.yml", REVIEW_JOB: JOB })),
    ];

    for (const result of results) assert.notEqual(result.status, 0, result.stderr);
    assert.equal(fake.requests.length, 0);
  } finally {
    await fake.close();
  }
});

// --- Workflow wiring: the trusted, hosted parts of the lifecycle, read from the canonical files. ---

const workflowReview = readFileSync(join(ROOT, ".github", "workflows", "review.yml"), "utf8");
const workflowStatus = readFileSync(join(ROOT, ".github", "workflows", "review-status.yml"), "utf8");
const feedbackAction = readFileSync(join(ROOT, "feedback", "action.yml"), "utf8");
const rootAction = readFileSync(join(ROOT, "action.yml"), "utf8");
const install = readFileSync(join(ROOT, "docs", "INSTALL.md"), "utf8");

const REVIEW_AUTHOR_EXPR = "vars.REV_ENGINE_REVIEW_AUTHOR || 'github-actions[bot]'";

// The job block of a workflow: from its key line to the next job key at the same depth.
function job(workflow: string, key: string): string {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => line === `  ${key}:`);
  assert.ok(start >= 0, `no job ${key}`);
  const end = lines.findIndex((line, index) => index > start && /^  [a-z-]+:$/.test(line));
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

function withBlock(text: string, uses: string): string {
  const at = text.indexOf(`uses: ${uses}`);
  assert.ok(at >= 0, `no step uses ${uses}`);
  const rest = text.slice(at);
  const next = rest.search(/\n {6}- /);
  return next < 0 ? rest : rest.slice(0, next);
}

test("review.yml keeps both triggers, and takes the manual mode input", () => {
  assert.match(workflowReview, /^on:\n {2}issue_comment:\n {4}types: \[created\]\n/m);
  assert.match(workflowReview, /^ {2}workflow_dispatch:/m);
  assert.match(workflowReview, /^ {6}mode:$/m);
});

test("review.yml accepts a request in a hosted accept job before any paid review job exists", () => {
  const accept = job(workflowReview, "accept");
  assert.match(accept, /runs-on: ubuntu-latest/);
  assert.match(accept, /timeout-minutes: [1-9][0-9]*$/m);
  assert.match(accept, /uses: heliowap\/rev-engine\/feedback@main/);
  assert.match(accept, /phase: accept/);
  assert.doesNotMatch(accept, /OPENROUTER|openrouter-api-key/);
  for (const output of ["accepted", "number", "mode", "comment-id", "run-id"]) {
    assert.match(job(workflowReview, "accept"), new RegExp(`^ {6}${output}: \\$\\{\\{ steps\\.feedback\\.outputs\\.${output} \\}\\}$`, "m"), output);
  }
});

test("the accept job's permissions are the explicit feedback grants, and it never gets actions write", () => {
  const accept = job(workflowReview, "accept");
  for (const grant of ["contents: read", "pull-requests: write", "issues: write", "actions: read"]) {
    assert.match(accept, new RegExp(`^ {6}${grant.replace(".", "\\.")}$`, "m"), grant);
  }
  assert.doesNotMatch(accept, /actions: write/);
});

test("the accept job's coarse filter admits manual dispatch and pull request comments, and leaves the command to the gate", () => {
  const condition = /^ {4}if: (.+)$/m.exec(job(workflowReview, "accept"));
  assert.ok(condition, "no if on the accept job");
  assert.equal(condition[1], "github.event_name == 'workflow_dispatch' || github.event.issue.pull_request");
});

test("the shared gate reads the first line without its carriage return or trailing spaces, so the coarse filter need not", () => {
  // The coarse filter admits every pull request comment. A tab after /review, a CR before LF, and a
  // command followed by more lines are valid input that the gate accepts, so they must reach it.
  const gate = readFileSync(join(ROOT, "action", "ask.sh"), "utf8");
  assert.ok(gate.includes("head -n 1 | tr -d '\\r' | sed"), "the gate no longer normalizes the first line");
  assert.ok(gate.includes(`"$COMMAND\t"*`), "the gate no longer accepts a tab after the command");
});

test("the review job waits for accepted=true exactly, and keeps its display name and timeout", () => {
  const review = job(workflowReview, "review");
  assert.match(review, /^ {4}needs: accept$/m);
  assert.match(review, /^ {4}if: needs\.accept\.outputs\.accepted == 'true'$/m);
  assert.match(review, /^ {4}name: Review pull request$/m);
  assert.match(review, /^ {4}timeout-minutes: 30$/m);
});

test("the review job replaces an older request for the same pull request, and only after acceptance", () => {
  const review = job(workflowReview, "review");
  assert.match(review, /^ {4}concurrency:\n {6}group: rev-engine-review-\$\{\{ github\.repository_id \}\}-\$\{\{ needs\.accept\.outputs\.number \}\}\n {6}cancel-in-progress: true$/m);
  assert.doesNotMatch(workflowReview, /^concurrency:/m);
});

test("the review job holds actions write only for the status dispatch, and calls the root with feedback on", () => {
  const review = job(workflowReview, "review");
  assert.match(review, /^ {6}actions: write$/m);
  const call = withBlock(review, "heliowap/rev-engine@main");
  assert.match(call, /^ {10}feedback: 'true'$/m);
  assert.match(call, /^ {10}openrouter-api-key: \$\{\{ secrets\.OPENROUTER_API_KEY \}\}$/m);
  assert.doesNotMatch(call, /feedback-token:|github-token:/);
});

test("every writer of a source run shares one concurrency group, with cancel-in-progress false, and it matches the watcher's", () => {
  const acceptGroup = /group: (rev-engine-feedback-\$\{\{ github\.repository_id \}\}-)\$\{\{ github\.run_id \}\}/.exec(job(workflowReview, "accept"));
  const watchGroup = /group: (rev-engine-feedback-\$\{\{ github\.repository_id \}\}-)\$\{\{ github\.event\.workflow_run\.id \|\| inputs\.run-id \}\}/.exec(job(workflowStatus, "sync"));
  assert.ok(acceptGroup, "accept group");
  assert.ok(watchGroup, "status group");
  assert.equal(acceptGroup[1], watchGroup[1], "the prefix differs");
  assert.match(job(workflowReview, "accept"), /cancel-in-progress: false/);
  assert.match(job(workflowStatus, "sync"), /cancel-in-progress: false/);
});

test("the trusted review-author configuration reaches accept, the root review, and the sync, and no receipt-author variable exists", () => {
  const acceptWith = withBlock(job(workflowReview, "accept"), "heliowap/rev-engine/feedback@main");
  assert.ok(acceptWith.includes(`review-author: \${{ ${REVIEW_AUTHOR_EXPR} }}`), "accept review author");
  const rootWith = withBlock(job(workflowReview, "review"), "heliowap/rev-engine@main");
  assert.ok(rootWith.includes(`review-author: \${{ ${REVIEW_AUTHOR_EXPR} }}`), "root review author");
  const syncWith = withBlock(workflowStatus, "heliowap/rev-engine/feedback@main");
  assert.ok(syncWith.includes(`review-author: \${{ ${REVIEW_AUTHOR_EXPR} }}`), "sync review author");
  for (const text of [workflowReview, workflowStatus, install]) {
    assert.doesNotMatch(text, /REV_ENGINE_FEEDBACK_AUTHOR/);
  }
  for (const text of [workflowReview, workflowStatus]) {
    assert.doesNotMatch(text, /^\s+feedback-author:/m);
    assert.doesNotMatch(text, /inputs\.(feedback|review)-author|github\.event\.comment\.body.*author/);
  }
});

test("the manifest pins the receipt author, names the default Actions token, and carries the watcher's sync defaults", () => {
  assert.match(feedbackAction, /^ {2}feedback-author:\n {4}description: [^\n]*github-actions\[bot\][^\n]*\n {4}default: github-actions\[bot\]$/m);
  assert.match(feedbackAction, /^ {2}github-token:\n {4}description: [^\n]*default Actions token[^\n]*\n/m);
  assert.match(feedbackAction, /^ {2}review-workflow:\n {4}description: [^\n]*\n {4}default: \.github\/workflows\/review\.yml$/m);
  assert.match(feedbackAction, /^ {2}review-job:\n {4}description: [^\n]*\n {4}default: Review pull request$/m);
});

test("the status watcher triggers on the Review workflow's start and completion, and on a manual run ID", () => {
  assert.match(workflowStatus, /^name: Review feedback$/m);
  assert.match(workflowStatus, /^on:\n {2}workflow_run:\n {4}workflows: \[Review\]\n {4}types: \[in_progress, completed\]\n/m);
  assert.match(workflowStatus, /^ {2}workflow_dispatch:\n {4}inputs:\n {6}run-id:\n {8}description: [^\n]+\n {8}required: true\n {8}type: string$/m);
});

test("the status watcher is one short hosted job with no checkout, no secret, and the sync permissions", () => {
  const sync = job(workflowStatus, "sync");
  assert.match(sync, /runs-on: ubuntu-latest/);
  assert.match(sync, /timeout-minutes: [1-9][0-9]*$/m);
  assert.doesNotMatch(workflowStatus, /actions\/checkout|secrets\.|head_sha|ref: \$\{\{ github\.event\.workflow_run/);
  for (const grant of ["contents: read", "actions: read", "pull-requests: read", "issues: write"]) {
    assert.match(workflowStatus, new RegExp(`^ {2}${grant.replace(".", "\\.")}$`, "m"), grant);
  }
  const call = withBlock(sync, "heliowap/rev-engine/feedback@main");
  assert.match(call, /phase: sync/);
  assert.match(call, /run-id: \$\{\{ github\.event\.workflow_run\.id \|\| inputs\.run-id \}\}/);
  assert.match(call, /review-workflow: \.github\/workflows\/review\.yml/);
  assert.match(call, /review-job: Review pull request/);
});

test("the trusted references are the self-use repository, and no PR checkout or artifact is executed", () => {
  for (const text of [workflowReview, workflowStatus]) {
    assert.doesNotMatch(text, /laude-institute/);
    assert.doesNotMatch(text, /upload-artifact|download-artifact/);
  }
  assert.match(workflowReview, /uses: heliowap\/rev-engine@main/);
});

test("no hosted accept or watcher step gets a model key or a posting token", () => {
  for (const text of [job(workflowReview, "accept"), workflowStatus, feedbackAction]) {
    assert.doesNotMatch(text, /OPENROUTER|openrouter-api-key/);
  }
});

test("the sibling action is a hosted composite that calls the shared gate and the TypeScript entry point from the repository", () => {
  assert.match(feedbackAction, /^  using: composite$/m);
  assert.match(feedbackAction, /uses: actions\/setup-node@v4/);
  assert.match(feedbackAction, /node-version: '?24'?/);
  assert.match(feedbackAction, /bash "\$GITHUB_ACTION_PATH\/\.\.\/action\/ask\.sh"/);
  assert.match(feedbackAction, /node "\$GITHUB_ACTION_PATH\/\.\.\/action\/feedback\.ts" accept/);
  assert.match(feedbackAction, /node "\$GITHUB_ACTION_PATH\/\.\.\/action\/feedback\.ts" sync/);
  assert.match(feedbackAction, /^ {4}default: \$\{\{ github\.token \}\}$/m);
  assert.match(feedbackAction, /REVIEW_AUTHOR: \$\{\{ inputs\.review-author \|\| inputs\.feedback-author \}\}/);
  for (const output of ["accepted", "number", "mode", "comment-id", "run-id"]) {
    assert.match(feedbackAction, new RegExp(`^  ${output}:$`, "m"), output);
  }
});

test("the root action keeps its own trust rules: it never writes a receipt, and its dispatch uses the feedback token", () => {
  assert.doesNotMatch(rootAction, /PATCH|issues\/comments\//);
  assert.doesNotMatch(rootAction, /rev-engine-feedback:v1/);
  assert.match(rootAction, /GH_TOKEN: \$\{\{ inputs\.feedback-token \}\}/);
});

test("the INSTALL token fragment separates the posting token from the feedback token and matches the review author", () => {
  const fences = [...install.matchAll(/```yaml\n([\s\S]*?)```/g)].map((match) => match[1]!);
  const text = fences.find((fence) => fence.includes("review-author:"));
  assert.ok(text, "no App-token fragment");
  assert.match(text, /github-token: \$\{\{ steps\.[a-z-]+\.outputs\.token \}\}/);
  assert.match(text, /feedback-token: \$\{\{ github\.token \}\}/);
  assert.match(text, /review-author: \$\{\{ vars\.REV_ENGINE_REVIEW_AUTHOR \}\}/);
  assert.doesNotMatch(text, /feedback-token: \$\{\{ steps\./);
});
