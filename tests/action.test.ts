import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// The shell scripts under action/ run under bash, as the workflow runs them. Their outside
// programs (gh, sudo, the Node binary) are shims placed first on PATH, and every path lives under
// one temporary directory.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const GIT_ENV = {
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.test",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.test",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

function sandbox(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "action-")));
  mkdirSync(join(root, "bin"));
  return root;
}

function shim(root: string, name: string, body: string): void {
  writeFileSync(join(root, "bin", name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
}

function shimEnv(root: string, extra: Record<string, string>): Record<string, string> {
  return { PATH: `${join(root, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`, ...extra };
}

function bash(script: string, args: string[], env: Record<string, string>) {
  return spawnSync("bash", [join(ROOT, "action", script), ...args], { encoding: "utf8", env });
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: { ...process.env, ...GIT_ENV }, encoding: "utf8" });
}

function commit(dir: string, text: string): string {
  writeFileSync(join(dir, "a.txt"), text);
  git(dir, ["add", "a.txt"]);
  git(dir, ["commit", "-q", "-m", `set ${text.trim()}`]);
  return git(dir, ["rev-parse", "HEAD"]).trim();
}

const COMPARE_DIFF = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-one
+two
diff --git a/b.txt b/b.txt
--- /dev/null
+++ b/b.txt
@@ -0,0 +1 @@
+new
`;

// A checkout at the head commit whose origin does not exist, so any fetch fails the test.
function twoCommitCheckout(root: string): { checkout: string; base: string; head: string } {
  const checkout = join(root, "checkout");
  mkdirSync(checkout);
  git(checkout, ["init", "-q", "-b", "main"]);
  const base = commit(checkout, "one\n");
  const head = commit(checkout, "two\n");
  git(checkout, ["remote", "add", "origin", join(root, "no-such-origin")]);
  return { checkout, base, head };
}

// An origin with three commits and a shallow clone of it at the last one. The base is the first.
function shallowHistory(root: string): { clone: string; base: string; head: string; expected: string } {
  const origin = join(root, "origin");
  mkdirSync(origin);
  git(origin, ["init", "-q", "-b", "main"]);
  const base = commit(origin, "one\n");
  commit(origin, "middle\n");
  const head = commit(origin, "three\n");
  git(origin, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
  const expected = git(origin, ["diff", `${base}...${head}`]);
  const clone = join(root, "clone");
  git(root, ["clone", "-q", "--depth", "1", `file://${origin}`, clone]);
  return { clone, base, head, expected };
}

function runDiff(root: string, checkout: string, base: string, head: string, changedFiles: number, out: string) {
  const pull = join(root, "pull.json");
  writeFileSync(pull, JSON.stringify({ changed_files: changedFiles }));
  return bash("diff.sh", [], shimEnv(root, {
    GH_TOKEN: "token-under-test",
    REPO: "owner/repo",
    BASE: base,
    HEAD: head,
    PULL_JSON: pull,
    CHECKOUT: checkout,
    OUT: out,
  }));
}

test("diff.sh takes the compare API diff, without fetching, when its file count matches", () => {
  const root = sandbox();
  const { checkout, base, head } = twoCommitCheckout(root);
  writeFileSync(join(root, "compare.diff"), COMPARE_DIFF);
  shim(root, "gh", `cat '${join(root, "compare.diff")}'`);
  const out = join(root, "diff.patch");

  const result = runDiff(root, checkout, base, head, 2, out);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(out, "utf8"), COMPARE_DIFF);
  assert.doesNotMatch(result.stdout, /Diff from git/);
});

test("diff.sh takes the diff from git when the compare API fails, and fetches only what it needs", () => {
  const root = sandbox();
  const { clone, base, head, expected } = shallowHistory(root);
  shim(root, "gh", "exit 1");
  const out = join(root, "diff.patch");

  const result = runDiff(root, clone, base, head, 2, out);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /::notice::Diff from git: /);
  assert.equal(readFileSync(out, "utf8"), expected);
  assert.equal(spawnSync("git", ["-C", clone, "cat-file", "-e", `${base}^{commit}`], { env: { ...process.env, ...GIT_ENV } }).status, 0);
});

test("diff.sh takes the diff from git when the compare file count differs from the pull request", () => {
  const root = sandbox();
  const { clone, base, head, expected } = shallowHistory(root);
  writeFileSync(join(root, "compare.diff"), COMPARE_DIFF);
  shim(root, "gh", `cat '${join(root, "compare.diff")}'`);
  const out = join(root, "diff.patch");

  const result = runDiff(root, clone, base, head, 3, out);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /::notice::Diff from git: the compare diff has 2 files and the pull request 3/);
  assert.equal(readFileSync(out, "utf8"), expected);
});

const actionYml = readFileSync(join(ROOT, "action.yml"), "utf8");

// action.yml has no YAML parser in this repository, so steps are cut where each "- name:" starts.
function stepNamed(name: string): string {
  const step = actionYml.split("\n    - name: ").slice(1).find((chunk) => chunk.split("\n")[0] === name);
  assert.ok(step, `no step named ${name}`);
  return step;
}

test("action.yml checks out only the head commit", () => {
  const checkout = stepNamed("Check out the pull request");
  assert.match(checkout, /fetch-depth: 1\n/);
  assert.doesNotMatch(checkout, /fetch-depth: 0/);
});

test("action.yml writes the diff with diff.sh and the variables it reads", () => {
  const diff = stepNamed("Write the diff");
  assert.match(diff, /bash "\$GITHUB_ACTION_PATH\/action\/diff\.sh"/);
  for (const name of ["GH_TOKEN", "REPO", "BASE", "HEAD", "PULL_JSON", "CHECKOUT", "OUT"]) {
    assert.match(diff, new RegExp(`^ +${name}: `, "m"), `missing ${name}`);
  }
});
