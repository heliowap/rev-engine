import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// post.ts runs its work at import and exits the process, so it is run as a subprocess. The
// subprocess is async, so the fixture below keeps answering while it runs. The fixture is a small
// GitHub stand-in: users, the review POST and PUT, and the review's comments.

const POST_SCRIPT = fileURLToPath(new URL("../action/post.ts", import.meta.url));
const REPO = "owner/repo";
const PR = 7;
const BOT = "github-actions[bot]";
const REVIEW_APP = "review-app[bot]";
const PAT_USER = "reviewer";
const USERS: Record<string, number> = { [BOT]: 41898282, [REVIEW_APP]: 555, [PAT_USER]: 777 };
const DIFF = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,2 +1,3 @@
 one
+two
 three
`;
const FINDING = { file: "src/app.ts", start_line: 2, end_line: 2, severity: "high", title: "Two is wrong", detail: "The added line breaks the check." };

interface Recorded { method: string; path: string; body: string; token: string | null }
interface Reply { status: number; body: unknown }
interface Fixture {
  url: string;
  requests: Recorded[];
  /** Replies to the review POST, in order. The last one repeats. */
  postReplies: Reply[];
  putStatus: number;
  close(): Promise<void>;
}

function startFixture(): Promise<Fixture> {
  const fixture: Fixture = {
    url: "",
    requests: [],
    postReplies: [],
    putStatus: 200,
    close: () => Promise.resolve(),
  };
  const comments = new Map<number, Array<{ path: string; body: string; html_url: string }>>();
  let nextId = 901;
  const server = createServer((request, response) => {
    void handle(request, response);
  });
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    const url = new URL(request.url ?? "/", "http://fixture");
    const path = url.pathname;
    const method = request.method ?? "GET";
    const auth = request.headers.authorization ?? "";
    fixture.requests.push({ method, path, body, token: auth.replace(/^Bearer /, "") || null });
    const user = /^\/users\/(.+)$/.exec(decodeURIComponent(path));
    if (method === "GET" && user) {
      const login = user[1]!;
      if (USERS[login] === undefined) return reply(response, { status: 404, body: { message: "Not Found" } });
      return reply(response, { status: 200, body: { id: USERS[login], login } });
    }
    if (method === "GET" && path === `/repos/${REPO}/pulls/${PR}/comments`) return reply(response, { status: 200, body: [] });
    if (method === "POST" && path === `/repos/${REPO}/pulls/${PR}/reviews`) {
      const sent = JSON.parse(body) as { comments: Array<{ path: string; body: string }> };
      const index = fixture.requests.filter((request) => request.method === "POST" && request.path === `/repos/${REPO}/pulls/${PR}/reviews`).length - 1;
      const planned = fixture.postReplies[Math.min(index, fixture.postReplies.length - 1)];
      // A planned reply is returned as it is. Otherwise the review is created as GitHub would create it.
      if (planned) return reply(response, planned);
      const id = nextId++;
      const html = `https://github.example/${REPO}/pull/${PR}#pullrequestreview-${id}`;
      comments.set(id, sent.comments.map((comment, position) => ({ path: comment.path, body: comment.body, html_url: `${html}#r${position}` })));
      return reply(response, { status: 200, body: { id, html_url: html, user: { id: USERS[BOT] } } });
    }
    const listing = /^\/repos\/owner\/repo\/pulls\/7\/reviews\/(\d+)\/comments$/.exec(path);
    if (method === "GET" && listing) return reply(response, { status: 200, body: comments.get(Number(listing[1])) ?? [] });
    const single = /^\/repos\/owner\/repo\/pulls\/7\/reviews\/(\d+)$/.exec(path);
    if (method === "PUT" && single) return reply(response, { status: fixture.putStatus, body: { id: Number(single[1]) } });
    return reply(response, { status: 404, body: { message: "no route" } });
  }
  function reply(response: ServerResponse, planned: Reply): void {
    response.writeHead(planned.status, { "content-type": "application/json" });
    response.end(JSON.stringify(planned.body));
  }
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      fixture.url = `http://127.0.0.1:${port}`;
      fixture.close = () => new Promise<void>((done) => server.close(() => done()));
      resolve(fixture);
    });
  });
}

interface Job {
  mode: "agent" | "human";
  findings: unknown[];
  feedback?: { run: string; attempt: string; reviewAuthor: string };
  token?: string;
  extra?: Record<string, string>;
}

function workDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "post-")));
}

async function runPost(fixture: Fixture, job: Job): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const dir = workDir();
  const findings = join(dir, "details.json");
  const diff = join(dir, "diff.patch");
  writeFileSync(findings, JSON.stringify({ findings: job.findings }));
  writeFileSync(diff, DIFF);
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    GITHUB_TOKEN: job.token ?? `token-${BOT}`,
    GITHUB_API_URL: fixture.url,
    GITHUB_GRAPHQL_URL: `${fixture.url}/graphql`,
    RB_NWO: REPO,
    RB_PR_NUMBER: String(PR),
    RB_HEAD: "c".repeat(40),
    REVIEW_MODEL: "a model",
    REVIEW_MODE: job.mode,
    MIN_SEVERITY: "medium",
    MAX_COMMENTS: "10",
    FINDINGS_PATH: findings,
    DIFF_PATH: diff,
    ...job.extra,
  };
  if (job.feedback) {
    env.FEEDBACK_RUN_ID = job.feedback.run;
    env.FEEDBACK_RUN_ATTEMPT = job.feedback.attempt;
    env.REVIEW_AUTHOR = job.feedback.reviewAuthor;
  }
  const child = spawn(process.execPath, [POST_SCRIPT], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const status = await new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
  return { status, stdout, stderr };
}

const FEEDBACK = { run: "123", attempt: "2", reviewAuthor: BOT };
const MARKER = "<!-- rev-engine-feedback-review:v1 run=123 attempt=2 -->";

function reviewPosts(fixture: Fixture): Array<{ body: { body: string; comments: unknown[] } }> {
  return fixture.requests.filter((request) => request.method === "POST" && request.path === `/repos/${REPO}/pulls/${PR}/reviews`).map((request) => ({ body: JSON.parse(request.body) }));
}

function publicationOf(stdout: string): { id: number; url: string } {
  return JSON.parse(stdout) as { id: number; url: string };
}

test("an agent review with no findings publishes with the run and attempt marker and prints its identity", async () => {
  const fixture = await startFixture();
  try {
    const result = await runPost(fixture, { mode: "agent", findings: [], feedback: FEEDBACK });

    assert.equal(result.status, 0, result.stderr);
    const [posted] = reviewPosts(fixture);
    assert.ok(posted!.body.body.includes(MARKER));
    assert.deepEqual(publicationOf(result.stdout), { id: 901, url: `https://github.example/${REPO}/pull/${PR}#pullrequestreview-901` });
  } finally {
    await fixture.close();
  }
});

test("an agent review with findings keeps the marker and prints the publication", async () => {
  const fixture = await startFixture();
  try {
    const result = await runPost(fixture, { mode: "agent", findings: [FINDING], feedback: FEEDBACK });

    assert.equal(result.status, 0, result.stderr);
    assert.ok(reviewPosts(fixture)[0]!.body.body.includes(MARKER));
    assert.equal(publicationOf(result.stdout).id, 901);
  } finally {
    await fixture.close();
  }
});

test("a human review with a line comment keeps the marker on the post and on its summary link repair", async () => {
  const fixture = await startFixture();
  try {
    const result = await runPost(fixture, { mode: "human", findings: [FINDING], feedback: FEEDBACK });

    assert.equal(result.status, 0, result.stderr);
    const [posted] = reviewPosts(fixture);
    assert.ok(posted!.body.body.includes(MARKER));
    assert.equal(posted!.body.comments.length, 1);
    const repair = fixture.requests.find((request) => request.method === "PUT")!;
    assert.ok(repair.body.includes(MARKER), "the summary link repair dropped the marker");
    assert.ok(repair.body.includes(`https://github.example/${REPO}/pull/${PR}#pullrequestreview-901#r0`), "the repair did not link the comment");
    assert.equal(publicationOf(result.stdout).id, 901);
  } finally {
    await fixture.close();
  }
});

test("a failed summary link repair is only a warning, and the publication is still printed", async () => {
  const fixture = await startFixture();
  try {
    fixture.putStatus = 500;
    const result = await runPost(fixture, { mode: "human", findings: [FINDING], feedback: FEEDBACK });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /the summary has no links to its comments/);
    assert.equal(publicationOf(result.stdout).id, 901);
  } finally {
    await fixture.close();
  }
});

test("a human review with no findings publishes with the marker and prints the publication", async () => {
  const fixture = await startFixture();
  try {
    const result = await runPost(fixture, { mode: "human", findings: [], feedback: FEEDBACK });

    assert.equal(result.status, 0, result.stderr);
    assert.ok(reviewPosts(fixture)[0]!.body.body.includes(MARKER));
    assert.equal(publicationOf(result.stdout).id, 901);
  } finally {
    await fixture.close();
  }
});

test("when GitHub rejects a line, the summary-only fallback carries the marker and is what gets published", async () => {
  const fixture = await startFixture();
  try {
    fixture.postReplies = [
      { status: 422, body: { message: "Unprocessable" } },
      { status: 200, body: { id: 901, html_url: `https://github.example/${REPO}/pull/${PR}#pullrequestreview-901`, user: { id: USERS[BOT] } } },
    ];
    const result = await runPost(fixture, { mode: "human", findings: [FINDING], feedback: FEEDBACK });

    assert.equal(result.status, 0, result.stderr);
    const posts = reviewPosts(fixture);
    assert.equal(posts.length, 2);
    assert.equal(posts[1]!.body.comments.length, 0);
    assert.ok(posts[1]!.body.body.includes(MARKER));
    assert.equal(publicationOf(result.stdout).id, 901);
  } finally {
    await fixture.close();
  }
});

test("a failed POST prints no publication and does not claim success", async () => {
  const fixture = await startFixture();
  try {
    fixture.postReplies = [{ status: 500, body: { message: "server" } }];
    const result = await runPost(fixture, { mode: "agent", findings: [], feedback: FEEDBACK });

    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
  } finally {
    await fixture.close();
  }
});

test("a response with no review identity is not a success, and prints nothing", async () => {
  const fixture = await startFixture();
  try {
    fixture.postReplies = [{ status: 200, body: { user: { id: USERS[BOT] } } }];
    const result = await runPost(fixture, { mode: "agent", findings: [], feedback: FEEDBACK });

    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
  } finally {
    await fixture.close();
  }
});

test("a review posted by an author other than the configured one fails visibly, names the review, and is not reposted", async () => {
  const fixture = await startFixture();
  try {
    fixture.postReplies = [{ status: 200, body: { id: 905, html_url: `https://github.example/${REPO}/pull/${PR}#pullrequestreview-905`, user: { id: USERS[PAT_USER] } } }];
    const result = await runPost(fixture, { mode: "agent", findings: [], feedback: FEEDBACK });

    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /905/);
    assert.match(result.stderr, /pullrequestreview-905/);
    assert.equal(reviewPosts(fixture).length, 1);
  } finally {
    await fixture.close();
  }
});

test("a configured GitHub App review author and a configured personal-access user each publish", async () => {
  for (const reviewAuthor of [REVIEW_APP, PAT_USER]) {
    const fixture = await startFixture();
    try {
      fixture.postReplies = [{ status: 200, body: { id: 910, html_url: `https://github.example/${REPO}/pull/${PR}#pullrequestreview-910`, user: { id: USERS[reviewAuthor]! } } }];
      const token = `token-${reviewAuthor}`;
      const result = await runPost(fixture, { mode: "agent", findings: [], feedback: { ...FEEDBACK, reviewAuthor }, token });

      assert.equal(result.status, 0, `${reviewAuthor}: ${result.stderr}`);
      assert.equal(publicationOf(result.stdout).id, 910);
    } finally {
      await fixture.close();
    }
  }
});

test("a review author that cannot be resolved stops before anything is posted", async () => {
  const fixture = await startFixture();
  try {
    const result = await runPost(fixture, { mode: "agent", findings: [], feedback: { ...FEEDBACK, reviewAuthor: "nobody[bot]" } });

    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(reviewPosts(fixture).length, 0);
  } finally {
    await fixture.close();
  }
});

test("without feedback, posting keeps its custom-token behavior and adds no marker and no identity lookup", async () => {
  const fixture = await startFixture();
  try {
    const result = await runPost(fixture, { mode: "agent", findings: [], token: "legacy-token-value" });

    assert.equal(result.status, 0, result.stderr);
    const [posted] = reviewPosts(fixture);
    assert.ok(!posted!.body.body.includes("rev-engine-feedback"));
    assert.ok(fixture.requests.every((request) => !request.path.startsWith("/users/")));
    assert.ok(fixture.requests.some((request) => request.token === "legacy-token-value"));
    assert.equal(publicationOf(result.stdout).id, 901);
  } finally {
    await fixture.close();
  }
});

// A publication is printed only when GitHub's answer proves it: a positive safe review ID and a
// credential-free HTTPS URL. Anything else is not confirmed, and the review is not posted again.
const CONFIRMED = { id: 901, html_url: `https://github.example/${REPO}/pull/${PR}#pullrequestreview-901`, user: { id: USERS[BOT] } };
const UNCONFIRMED: Array<[string, Record<string, unknown>]> = [
  ["a zero ID", { id: 0 }],
  ["a negative ID", { id: -901 }],
  ["an ID beyond the safe integers", { id: 2 ** 60 }],
  ["a URL that is only the https prefix", { html_url: "https://" }],
  ["a URL that is not a URL", { html_url: "not a url" }],
  ["a URL with credentials", { html_url: `https://user:secret@github.example/${REPO}/pull/${PR}#pullrequestreview-901` }],
  ["an http URL", { html_url: `http://github.example/${REPO}/pull/${PR}#pullrequestreview-901` }],
];

for (const [name, change] of UNCONFIRMED) {
  test(`a posted review answered with ${name} is not confirmed as published, and is not posted again`, async () => {
    const fixture = await startFixture();
    try {
      fixture.postReplies = [{ status: 200, body: { ...CONFIRMED, ...change } }];
      const result = await runPost(fixture, { mode: "agent", findings: [], feedback: FEEDBACK });

      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, "");
      assert.equal(reviewPosts(fixture).length, 1);
    } finally {
      await fixture.close();
    }
  });
}
