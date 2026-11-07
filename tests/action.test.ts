import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
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

// review-env.sh reads the settings from its environment. A clean environment shows that nothing
// else leaks into its output.
function reviewEnv(vars: Record<string, string>) {
  return bash("review-env.sh", [], { PATH: process.env.PATH ?? "/usr/bin:/bin", ...vars });
}

const SETTINGS: Record<string, string> = {
  RB_NWO: "owner/repo",
  RB_PR_NUMBER: "7",
  RB_BASE: "a".repeat(40),
  RB_HEAD: "b".repeat(40),
  RB_MODEL_BASE_URL: "https://models.example.test/v1",
  RB_CONFIG_MODEL: "vendor/model-a",
  RB_CONFIG_TIME_BUDGET: "780",
  RB_CONFIG_FIT: "vendor/model-a",
  RB_CONFIG_MAX_TURNS: "40",
  RB_CONFIG_SECOND_LOOK: "on",
  RB_CONFIG_VERIFY: "lenient",
  RB_CONFIG_EFFORT: "high",
  RB_CONFIG_WRAP_UP: "30",
};
const SETTING_NAMES = Object.keys(SETTINGS);
const AGENT_EXTRAS = [
  "RB_CONFIG_MODE=agent",
  "RB_CONFIG_SWARM=on",
  "RB_CONFIG_SWARM_PROVIDERS=together",
  "RB_CONFIG_SWARM_TARGET=60",
  "RB_CONFIG_SWARM_LIMIT=90",
  "RB_CONFIG_SWARM_EFFORT=none",
  "RB_CONFIG_SWARM_CONTEXT=rich",
  "RB_CONFIG_SWARM_EVIDENCE=off",
];

test("review-env prints the human settings, one NAME=VALUE line each, and no secret", () => {
  const secrets = ["sk-test-secret", "ghs-test-secret", "gho-test-secret"];
  const result = reviewEnv({
    ...SETTINGS,
    MODE: "human",
    AGENT_MODEL: "vendor/agent-b",
    OPENROUTER_API_KEY: secrets[0]!,
    GITHUB_TOKEN: secrets[1]!,
    GH_TOKEN: secrets[2]!,
  });

  assert.equal(result.status, 0, result.stderr);
  const expected = [...SETTING_NAMES.map((name) => `${name}=${SETTINGS[name]}`), "RB_ATTEMPT=1"];
  assert.deepEqual(result.stdout.trimEnd().split("\n"), expected);
  for (const secret of secrets) assert.ok(!`${result.stdout}${result.stderr}`.includes(secret));
});

test("review-env leaves out the empty settings, so the reviewer keeps its defaults", () => {
  const result = reviewEnv({ ...SETTINGS, MODE: "human", RB_CONFIG_EFFORT: "", RB_CONFIG_WRAP_UP: "" });

  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trimEnd().split("\n");
  assert.ok(!lines.some((line) => line.startsWith("RB_CONFIG_EFFORT=") || line.startsWith("RB_CONFIG_WRAP_UP=")));
  assert.ok(lines.includes("RB_ATTEMPT=1"));
});

test("review-env runs an agent review with the agent model and the eight swarm settings", () => {
  const result = reviewEnv({ ...SETTINGS, MODE: "agent", AGENT_MODEL: "vendor/agent-b" });

  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trimEnd().split("\n");
  assert.ok(lines.includes("RB_CONFIG_MODEL=vendor/agent-b"));
  assert.ok(!lines.includes("RB_CONFIG_MODEL=vendor/model-a"));
  for (const extra of AGENT_EXTRAS) assert.ok(lines.includes(extra), `missing ${extra}`);
  assert.ok(lines.includes("RB_ATTEMPT=1"));
});

test("review-env refuses a mode other than agent or human, and a value with a line break", () => {
  const robot = reviewEnv({ ...SETTINGS, MODE: "robot" });
  assert.notEqual(robot.status, 0);
  assert.match(robot.stderr, /::error::/);

  const broken = reviewEnv({ ...SETTINGS, MODE: "human", RB_CONFIG_EFFORT: "high\nRB_CONFIG_MODE=agent" });
  assert.notEqual(broken.status, 0);
  assert.match(broken.stderr, /::error::/);
  assert.equal(broken.stdout, "");
});

function inputNamed(name: string): string {
  const inputs = actionYml.split("\ninputs:\n")[1]!.split("\nruns:")[0]!;
  const block = inputs.split(/\n(?=  [a-z-]+:\n)/).find((chunk) => chunk.startsWith(`  ${name}:\n`));
  assert.ok(block, `no input named ${name}`);
  return block;
}

test("action.yml has the five time inputs, each empty by default", () => {
  for (const name of ["max-turns", "second-look", "verify", "effort", "wrap-up"]) {
    assert.match(inputNamed(name), /^    default: ""$/m, name);
  }
});

test("the review settings step holds no secret", () => {
  const settings = stepNamed("Write the review settings");
  assert.match(settings, /review-env\.sh/);
  assert.doesNotMatch(settings, /openrouter-api-key|OPENROUTER_API_KEY|github-token|GITHUB_TOKEN|GH_TOKEN/);
});

const NODE_DIR = join(ROOT, "action", "node");
// The reviewer user is not a real account in these tests, so the current user stands in for it.
const REVIEW_USER = userInfo().username;
const IS_ROOT = process.getuid?.() === 0;
const KEY = "sk-test-model-key";
const TOKEN_MARKER = "ghs-token-marker";

// entry.sh starts with two constants, which the tests point at the sandbox.
function patchedEntry(root: string): string {
  const text = readFileSync(join(NODE_DIR, "entry.sh"), "utf8")
    .replace(/^jobs_root=.*$/m, `jobs_root=${join(root, "jobs")}`)
    .replace(/^node=.*$/m, `node=${join(root, "node-shim")}`);
  const path = join(root, "wrapper");
  writeFileSync(path, text, { mode: 0o755 });
  return path;
}

// A stand-in for the Node binary. It records its environment and argument, and writes the two
// result files and a link that points outside the job, as a hostile review could.
function fakeNode(root: string, exitCode: number, extra: string[] = []): void {
  writeFileSync(join(root, "node-shim"), [
    "#!/bin/bash",
    `env > '${join(root, "node-env")}'`,
    `printf '%s\\n' "$@" > '${join(root, "node-argv")}'`,
    `cat "$RB_REPO/README.md" > '${join(root, "node-readme")}'`,
    'printf "{}" > "$(dirname "$RB_OUT")/findings.json"',
    'printf "{}" > "$(dirname "$RB_OUT")/details.json"',
    'ln -s /etc/hosts "$(dirname "$RB_OUT")/evil.json"',
    ...extra,
    `exit ${exitCode}`,
    "",
  ].join("\n"), { mode: 0o755 });
}

// A stand-in for sudo. It checks the flags, records its argument, environment and stdin, and then
// runs the command it was given, with the stdin it received.
function fakeSudo(root: string): void {
  shim(root, "sudo", [
    `[ "$1 $2 $3" = "-n -u ${REVIEW_USER}" ] || exit 98`,
    `printf '%s\\n' "$@" > '${join(root, "sudo-argv")}'`,
    `env > '${join(root, "sudo-env")}'`,
    `for dir in "$5" "$5/out"; do if [ -g "$dir" ]; then echo "$dir setgid"; else echo "$dir no-setgid"; fi; done > '${join(root, "setgid")}'`,
    `cat > '${join(root, "sudo-stdin")}'`,
    `"$4" "$5" < '${join(root, "sudo-stdin")}'`,
  ].join("\n"));
}

// A job directory with the four directories the review step creates and a settings file.
function makeJob(jobs: string, name: string): string {
  const dir = join(jobs, name);
  for (const sub of ["repo", "pr", "code", "out"]) mkdirSync(join(dir, sub), { recursive: true });
  writeFileSync(join(dir, "env"), "RB_ATTEMPT=1\n");
  return dir;
}

function runEntry(entry: string, args: string[], stdin: string | undefined) {
  return spawnSync("bash", [entry, ...args], { encoding: "utf8", input: stdin, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
}

test("entry.sh accepts every settings line review-env.sh prints, for a human and an agent review", () => {
  const root = sandbox();
  mkdirSync(join(root, "jobs"));
  fakeNode(root, 0);
  const entry = patchedEntry(root);

  for (const mode of ["human", "agent"]) {
    const settings = reviewEnv({ ...SETTINGS, MODE: mode, AGENT_MODEL: "vendor/agent-b" });
    assert.equal(settings.status, 0, settings.stderr);
    const dir = makeJob(join(root, "jobs"), `${mode}job`);
    writeFileSync(join(dir, "env"), settings.stdout);

    const result = runEntry(entry, [dir], `${KEY}\n`);

    assert.equal(result.status, 0, `${mode}: ${result.stderr}`);
  }
});

test("entry.sh refuses a settings line outside its allowlist, naming it", () => {
  const root = sandbox();
  const jobs = join(root, "jobs");
  mkdirSync(jobs);
  fakeNode(root, 0);
  const entry = patchedEntry(root);

  for (const [index, line] of ["RB_REPO=/etc", "RB_TRANSCRIPT_OUT=x", "OPENROUTER_API_KEY=x", "PATH=x"].entries()) {
    const dir = makeJob(jobs, `settings${index}`);
    writeFileSync(join(dir, "env"), `RB_ATTEMPT=1\n${line}\n`);

    const result = runEntry(entry, [dir], `${KEY}\n`);

    assert.equal(result.status, 2, line);
    assert.ok(result.stderr.includes(line.split("=")[0]!), `stderr does not name ${line}`);
  }
});

test("entry.sh refuses a job outside its directory, a link to a job or out directory, and an empty key", () => {
  const root = sandbox();
  const jobs = join(root, "jobs");
  mkdirSync(jobs);
  fakeNode(root, 0);
  const entry = patchedEntry(root);

  const outside = makeJob(join(root, "elsewhere"), "outside1");
  const dotdot = makeJob(root, "dotdot1");
  const real = makeJob(jobs, "realjob1");
  symlinkSync(real, join(jobs, "linked"));
  const outLink = makeJob(jobs, "outlink1");
  rmSync(join(outLink, "out"), { recursive: true });
  symlinkSync(join(root, "elsewhere"), join(outLink, "out"));
  const valid = makeJob(jobs, "nokey1");
  const refused: Array<[string, string[], string | undefined]> = [
    ["a job outside the jobs directory", [outside], `${KEY}\n`],
    ["a path that leaves the jobs directory", [`${jobs}/../dotdot1`], `${KEY}\n`],
    ["a job that is a symbolic link", [join(jobs, "linked")], `${KEY}\n`],
    ["an out directory that is a symbolic link", [outLink], `${KEY}\n`],
    ["an empty key on stdin", [valid], ""],
  ];
  void dotdot;

  for (const [label, args, stdin] of refused) {
    assert.equal(runEntry(entry, args, stdin).status, 2, label);
  }
});

test("review.sh runs the review as the reviewer user, with the key on stdin and no GitHub token", () => {
  const sandboxed = reviewSandbox(0);
  const result = runReview(sandboxed);

  assert.equal(result.status, 0, result.stderr);
  const argv = lines(join(sandboxed.root, "sudo-argv"));
  const job = argv[4]!;
  assert.deepEqual(argv.slice(0, 4), ["-n", "-u", REVIEW_USER, sandboxed.wrapper]);
  assert.equal(readFileSync(join(sandboxed.root, "sudo-stdin"), "utf8"), `${KEY}\n`);
  assert.ok(!argv.join("\n").includes(KEY), "key in sudo arguments");
  const sudoEnv = readFileSync(join(sandboxed.root, "sudo-env"), "utf8");
  assert.ok(!sudoEnv.includes(KEY) && !sudoEnv.includes(TOKEN_MARKER), "secret in sudo environment");

  // bash adds PWD, SHLVL and _ to the environment of any script it starts, so they are not counted.
  const nodeEnv = parseEnv(readFileSync(join(sandboxed.root, "node-env"), "utf8"));
  const names = Object.keys(nodeEnv).filter((name) => !["PWD", "SHLVL", "_", "OLDPWD"].includes(name));
  const allowed = ["PATH", "HOME", "LANG", "OPENROUTER_API_KEY"];
  for (const name of allowed) assert.ok(names.includes(name), `missing ${name}`);
  for (const name of names) assert.ok(allowed.includes(name) || name.startsWith("RB_"), `unexpected ${name}`);
  assert.equal(nodeEnv.OPENROUTER_API_KEY, KEY);
  assert.equal(nodeEnv.RB_NWO, "owner/repo");
  for (const name of ["RB_REPO", "RB_DIFF", "RB_OUT"]) {
    assert.ok(nodeEnv[name]?.startsWith(`${job}/`), `${name} is outside the job`);
  }
  assert.equal(lines(join(sandboxed.root, "node-argv")).at(-1), `${job}/code/src/main.ts`);
  assert.equal(readFileSync(join(sandboxed.root, "node-readme"), "utf8"), "# repo\n");
  assert.match(result.stderr, /rev-engine: review runs as /);
  assert.match(result.stderr, /rev-engine: review finished \(exit 0\)/);
  assert.deepEqual(readdirSync(join(sandboxed.temp, "out")).sort(), ["details.json", "findings.json"]);
  assert.deepEqual(readdirSync(sandboxed.jobs), []);
});

test("review.sh keeps the job directory and out/ setgid, so out/ takes the reviewer's group", () => {
  const sandboxed = reviewSandbox(0);
  const result = runReview(sandboxed);

  assert.equal(result.status, 0, result.stderr);
  const job = lines(join(sandboxed.root, "sudo-argv"))[4]!;
  assert.deepEqual(lines(join(sandboxed.root, "setgid")), [`${job} setgid`, `${job}/out setgid`]);
});

test("review.sh keeps the model key out of every argument list", () => {
  const sandboxed = reviewSandbox(0);
  const result = runReview(sandboxed);

  assert.equal(result.status, 0, result.stderr);
  const envArgv = existsSync(join(sandboxed.root, "env-argv")) ? readFileSync(join(sandboxed.root, "env-argv"), "utf8") : "";
  assert.ok(!envArgv.includes(KEY), "key in the argument list of env");
  assert.ok(!lines(join(sandboxed.root, "node-argv")).join("\n").includes(KEY), "key in the arguments of node");
});

test("review.sh copies back only the review's own regular files with one link, not a hard link to a staged file", () => {
  const sandboxed = reviewSandbox(0, [`ln "$RB_REPO/README.md" "$(dirname "$RB_OUT")/leak.json"`]);
  const result = runReview(sandboxed);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readdirSync(join(sandboxed.temp, "out")).sort(), ["details.json", "findings.json"]);
});

test("review.sh leaves the checkout's file modes alone, so a read-only file stays read-only", () => {
  const sandboxed = reviewSandbox(0);
  const readme = join(sandboxed.checkout, "README.md");
  chmodSync(readme, 0o444);
  const result = runReview(sandboxed);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(statSync(readme).mode & 0o777, 0o444);
});

test("review.sh refuses a checkout file that others can write, before sudo runs", () => {
  const sandboxed = reviewSandbox(0);
  chmodSync(join(sandboxed.checkout, "README.md"), 0o666);
  const result = runReview(sandboxed);

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /::error::.*README\.md/);
  assert.equal(existsSync(join(sandboxed.root, "sudo-argv")), false, "sudo ran");
  assert.deepEqual(readdirSync(sandboxed.jobs), []);
});

test("review.sh passes the review's exit status through and removes the job", () => {
  const sandboxed = reviewSandbox(3);
  const result = runReview(sandboxed);

  assert.equal(result.status, 3, result.stderr);
  assert.match(result.stderr, /rev-engine: review finished \(exit 3\)/);
  assert.deepEqual(readdirSync(join(sandboxed.temp, "out")).sort(), ["details.json", "findings.json"]);
  assert.deepEqual(readdirSync(sandboxed.jobs), []);
});

test("provision.sh --print-sudoers prints the one sudo rule and needs no root", () => {
  const result = spawnSync("bash", [join(NODE_DIR, "provision.sh"), "--print-sudoers", "--runner-user", "runner", "--review-user", "reviewer"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "runner ALL=(reviewer) NOPASSWD: /usr/local/libexec/rev-engine/review ^/var/lib/rev-engine/jobs/[A-Za-z0-9]+$\n");
});

// provision.sh's checks that need no root run before anything is changed, so they can be tested here.
// Shims stand in for sudo and getent, which the host provides.
function provisionSandbox(sudoVersion: string, homeMode: number) {
  const root = sandbox();
  const home = join(root, "home");
  mkdirSync(home);
  chmodSync(home, homeMode);
  shim(root, "sudo", `echo "Sudo version ${sudoVersion}"`);
  shim(root, "getent", `echo "$2:x:1000:1000::${home}:/bin/sh"`);
  const nodeDir = join(root, "node");
  mkdirSync(join(nodeDir, "bin"), { recursive: true });
  return { root, home, nodeDir };
}

function provision(root: string, args: string[], cwd = root) {
  return spawnSync("bash", [join(NODE_DIR, "provision.sh"), ...args], { encoding: "utf8", cwd, env: shimEnv(root, {}) });
}

test("provision.sh refuses sudo older than 1.9.10, and goes on with 1.9.10 or later", () => {
  for (const version of ["1.8.31", "1.9.9p1"]) {
    const { root, nodeDir } = provisionSandbox(version, 0o700);
    const result = provision(root, ["--node-dir", nodeDir]);
    assert.equal(result.status, 1, version);
    assert.match(result.stderr, /provision\.sh: sudo 1\.9\.10 or later is required, found /, version);
  }
  for (const version of ["1.9.10", "1.9.17p2"]) {
    const { root, nodeDir } = provisionSandbox(version, 0o700);
    const result = provision(root, ["--node-dir", nodeDir]);
    assert.doesNotMatch(result.stderr, /sudo/, version);
  }
});

test("provision.sh refuses a runner home that others can use, and says to chmod o-rwx", () => {
  const { root, home, nodeDir } = provisionSandbox("1.9.17p2", 0o755);
  const result = provision(root, ["--node-dir", nodeDir]);

  assert.equal(result.status, 1, result.stderr);
  assert.ok(result.stderr.includes(`chmod o-rwx ${home}`), result.stderr);
});

test("provision.sh resolves --node-dir to an absolute path before it checks the directory", { skip: IS_ROOT ? "root owns the files it would check" : false }, () => {
  const { root, nodeDir } = provisionSandbox("1.9.17p2", 0o700);
  const result = provision(root, ["--node-dir", "node"]);

  assert.equal(result.status, 1, result.stderr);
  assert.ok(result.stderr.includes(`${nodeDir} is not owned by root`), result.stderr);
});

function reviewSandbox(exitCode: number, extra: string[] = []) {
  const root = sandbox();
  const jobs = join(root, "jobs");
  mkdirSync(jobs);
  const action = join(root, "action");
  mkdirSync(join(action, "src"), { recursive: true });
  mkdirSync(join(action, "experiments", "prototypes"), { recursive: true });
  writeFileSync(join(action, "package.json"), "{}\n");
  writeFileSync(join(action, "src", "main.ts"), "\n");
  writeFileSync(join(action, "experiments", "prototypes", "swarm.ts"), "\n");
  const checkout = join(root, "ws", "rev-engine-prime-checkout");
  mkdirSync(join(checkout, "src"), { recursive: true });
  writeFileSync(join(checkout, "README.md"), "# repo\n");
  writeFileSync(join(checkout, "src", "app.ts"), "\n");
  const temp = join(root, "tmp", "rev-engine-prime");
  mkdirSync(join(temp, "pr"), { recursive: true });
  mkdirSync(join(temp, "out"), { recursive: true });
  writeFileSync(join(temp, "pr", "diff.patch"), "diff\n");
  writeFileSync(join(temp, "pr", "pr.json"), "{}\n");
  writeFileSync(join(temp, "review.env"), "RB_NWO=owner/repo\nRB_ATTEMPT=1\n");
  fakeSudo(root);
  fakeNode(root, exitCode, extra);
  // Records the argument list of every env call, so a key passed to env would show up here.
  shim(root, "env", [
    `[ "$#" -eq 0 ] || printf '%s\\n' "$@" >> '${join(root, "env-argv")}'`,
    `exec /usr/bin/env "$@"`,
  ].join("\n"));
  return { root, action, checkout, temp, jobs, wrapper: patchedEntry(root) };
}

function runReview(sandboxed: ReturnType<typeof reviewSandbox>) {
  return spawnSync("bash", [join(NODE_DIR, "review.sh")], {
    encoding: "utf8",
    env: {
      PATH: `${join(sandboxed.root, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      OPENROUTER_API_KEY: KEY,
      GITHUB_TOKEN: TOKEN_MARKER,
      GITHUB_ACTION_PATH: sandboxed.action,
      GITHUB_WORKSPACE: join(sandboxed.root, "ws"),
      RUNNER_TEMP: join(sandboxed.root, "tmp"),
      REV_ENGINE_JOBS: sandboxed.jobs,
      REV_ENGINE_WRAPPER: sandboxed.wrapper,
      REV_ENGINE_REVIEW_USER: REVIEW_USER,
    },
  });
}

function lines(path: string): string[] {
  return readFileSync(path, "utf8").trimEnd().split("\n");
}

function parseEnv(text: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const line of text.trimEnd().split("\n")) {
    const at = line.indexOf("=");
    env[line.slice(0, at)] = line.slice(at + 1);
  }
  return env;
}

function allSteps(): string[] {
  return actionYml.split("\n    - name: ").slice(1);
}

function nameOf(step: string): string {
  return step.split("\n")[0]!;
}

function stepsStartingWith(prefix: string): string[] {
  const found = allSteps().filter((step) => nameOf(step).startsWith(prefix));
  assert.ok(found.length > 0, `no step starts with ${prefix}`);
  return found;
}

test("the collect and post steps hold the token and no model key; the review steps hold the key and no token", () => {
  for (const prefix of ["Collect earlier decisions", "Post the review"]) {
    for (const step of stepsStartingWith(prefix)) {
      assert.match(step, /inputs\.github-token/, nameOf(step));
      assert.doesNotMatch(step, /openrouter-api-key/, nameOf(step));
    }
  }
  for (const step of stepsStartingWith("Review")) {
    assert.match(step, /openrouter-api-key/, nameOf(step));
    assert.doesNotMatch(step, /github-token|GITHUB_TOKEN|GH_TOKEN/, nameOf(step));
  }
});

test("the node review step runs review.sh, and collect and post run the provisioned Node", () => {
  assert.match(stepNamed("Review (node)"), /bash "\$GITHUB_ACTION_PATH\/action\/node\/review\.sh"/);
  assert.match(stepNamed("Collect earlier decisions (node)"), /\/opt\/rev-engine-node\/bin\/node "\$GITHUB_ACTION_PATH\/action\/collect\.ts"/);
  assert.match(stepNamed("Post the review (node)"), /\/opt\/rev-engine-node\/bin\/node "\$GITHUB_ACTION_PATH\/action\/post\.ts"/);
});

test("the runtime input defaults to docker, and the ask step rejects any other value", () => {
  assert.match(inputNamed("runtime"), /^    default: docker$/m);
  const ask = stepNamed("Check who asked");
  assert.match(ask, /RUNTIME: \$\{\{ inputs\.runtime \}\}/);
  assert.match(ask, /docker\|node\)/);
});

test("each docker step runs only for runtime docker, and each node step only for runtime node", () => {
  const nodeSteps = allSteps().filter((step) => /\(node\)$/.test(nameOf(step)));
  assert.ok(nodeSteps.length >= 3, "expected the three node steps");
  for (const step of allSteps()) {
    if (/\(node\)$/.test(nameOf(step))) {
      assert.match(step, /\n      if: .*inputs\.runtime == 'node'/, nameOf(step));
    } else if (/docker (run|build) /.test(step)) {
      assert.match(step, /\n      if: .*inputs\.runtime == 'docker'/, nameOf(step));
    }
  }
});
