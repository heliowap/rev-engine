# Install the GitHub Action

RevEngine reviews pull requests in your repository when a person with write access comments `/review` on one. The findings come back as one review with comments on the changed lines. Comments from anyone else are ignored, because each review costs money.

Comment `/review agent` instead to get a review for an agent that manages the pull request. It lists every finding in one comment, as described under [Agent reviews](#agent-reviews).

## Setup

This single-job setup runs reviews without receipts. For receipts, install the [review feedback](#review-feedback) workflows instead, and do not add this file next to them: the status watcher matches every run of a workflow named `Review`.

Add an `OPENROUTER_API_KEY` secret to the repository, then add this workflow on the default branch:

```yaml
name: Review
on:
  issue_comment:
    types: [created]
  workflow_dispatch:
    inputs:
      pr-number:
        description: Pull request number
        required: true
      mode:
        description: human or agent
        default: human
permissions:
  contents: read
  pull-requests: write
jobs:
  review:
    if: github.event_name == 'workflow_dispatch' || (github.event.issue.pull_request && startsWith(github.event.comment.body, '/review'))
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: heliowap/rev-engine@main
        with:
          openrouter-api-key: ${{ secrets.OPENROUTER_API_KEY }}
          pr-number: ${{ inputs.pr-number }}
          mode: ${{ inputs.mode || 'human' }}
```

The `uses:` line names this fork at `main`, the same repository and ref as the [canonical feedback workflows](#repositories-and-references). You can also start a review from the Actions tab by running the workflow with a pull request number. A workflow without the `mode` lines still runs agent reviews from comments.

## What you get

By default the action reviews with `anthropic/claude-opus-5.5`, comments on at most 10 findings of medium or high severity, and lists the less severe ones in a collapsed section of the summary. It also gives a short answer to whether the change belongs in the project. The summary opens with one line of merge advice, which plain rules decide from the severities and that answer.

On a later review of the same pull request, the action first collects what the maintainer decided about earlier findings, and the review does not report a decided finding again unless the code gives a reason. A finding marked fixed, or a thread resolved without a reply, comes back only when the code at head shows the problem is still there. A finding marked wrong, won't fix or deferred comes back only when the code has changed in a way that makes it right. A finding that comes back names the earlier one it repeats. A decision counts when someone with write access wrote it: a reply on one of the action's comments that starts with **Fixed**, **Partly fixed**, **Won't fix**, **Deferred** or **Wrong**, a thread they resolved, or a comment that starts with `## Review evaluation` and labels findings as `must`, `valid` or `invalid`. A comment nobody answered is not a decision. The fit check also gets the maintainer's answer from the "Fit and recommendation" section of each review evaluation, so it does not raise a concern again that the maintainer already answered, and it keeps the maintainer's latest verdict unless the change has moved since. The summary says how many findings were left out this way and which earlier ones they repeated. If collecting fails, the run logs a warning and reviews as before. Separately, when an earlier comment from the action is still open and raises the same problem on the same lines in nearly the same words, the action does not comment again; it lists the finding in a collapsed part of the summary, with a link to that comment. A different problem on those lines gets its own comment.

## Agent reviews

`/review agent` runs a swarm of short reviews by a cheap model. The review itself usually takes about a minute and costs under $1. Each part of the diff gets agents with one task each, such as checking callers or tests, and three verifiers vote on every finding.

The result is one comment with no comments on lines:

- Every finding the verifiers did not reject, up to 80, most severe first.
- Each finding's severity, how many verifiers confirmed it, its location and the full explanation.
- The same one line of merge advice as a human review.

An agent can read the whole list and decide what to fix. There is no assessment of whether the change belongs in the project. The `model`, `min-severity`, `max-findings`, `fit`, `effort`, `second-look` and `wrap-up` inputs do not apply to an agent review. Its counterparts are `agent-model`, which picks the swarm's model, `swarm-effort`, which sets the reasoning effort of the swarm's agents, and `swarm-providers`, which names the OpenRouter providers allowed to serve the swarm's calls. `time-budget` only caps the swarm's own pace of 60 seconds per agent, 90 at most.

`/review human`, or `/review` alone, runs the default review.

## Inputs

| Input | Default | Meaning |
|---|---|---|
| `model` | `anthropic/claude-opus-5.5` | OpenRouter model that reviews and verifies. |
| `model-base-url` | `https://openrouter.ai/api/v1` | OpenAI-compatible endpoint the models are called through. The `openrouter-api-key` input holds that endpoint's key. |
| `min-severity` | `medium` | The least severe findings that get a comment. One of `high`, `medium` or `low`. |
| `max-findings` | `10` | Cap on findings that get a comment. The rest join the collapsed section. |
| `fit` | `on` | Say whether the change belongs in the project. |
| `time-budget` | `780` | Seconds allowed for the review. |
| `command` | `/review` | A comment starts a review only when its first line is this text, or this text followed by a space or tab. The word after it, `agent` or `human`, picks the review. |
| `mode` | `human` | The review to run when the comment names none, or when the workflow is started by hand. |
| `agent-model` | `deepseek/deepseek-v4.1-flash-1017` | OpenRouter model the swarm of an agent review uses. |
| `swarm-effort` | `none` | Agent reviews only. Reasoning effort for the swarm's agents, for models that accept one: `none`, `minimal`, `low`, `medium` or `high`. |
| `swarm-providers` | `together` | Agent reviews only. Comma-separated OpenRouter providers allowed to serve the swarm's calls, such as `together`. Empty lets OpenRouter pick any provider, except for an agent model with providers built into the swarm, such as the default `agent-model`, which keeps `together`. |
| `allow-forks` | `false` | Set to `true` to review pull requests from forks. |
| `max-turns` | empty | Model turns allowed per review or verification pass. Empty keeps the reviewer's default (see [SETTINGS.md](SETTINGS.md)). |
| `second-look` | empty | Human reviews only. What a reviewer does after its first submission: `on`, `sweep`, `sweep-low`, `small` or `off`. Empty keeps the reviewer's default (see [SETTINGS.md](SETTINGS.md)). |
| `effort` | empty | Human reviews only. Reasoning effort, for models that accept one. Empty keeps the provider's default (see [SETTINGS.md](SETTINGS.md)). |
| `wrap-up` | empty | Human reviews only. Seconds each review, verification and fit pass keeps back at the end to write its submission. Lower it together with `time-budget`. Empty keeps the reviewer's default (see [SETTINGS.md](SETTINGS.md)). |
| `runtime` | `docker` | Where the review step runs: `docker` builds and runs the image; `node` runs the code with Node 24 on a prepared self-hosted runner. See [Self-hosted runner without Docker](#self-hosted-runner-without-docker). |

## Self-hosted runner without Docker

With `runtime: node`, the review runs on a self-hosted runner without Docker, as a separate user. Prepare the runner once, on the host, with these generic steps:

1. Download Node 24 from nodejs.org, check it against `SHASUMS256.txt`, and extract it under `/opt`:

   ```sh
   VERSION=24.x.y   # the release you chose
   curl -fsSLO "https://nodejs.org/dist/v$VERSION/node-v$VERSION-linux-x64.tar.xz"
   curl -fsSL "https://nodejs.org/dist/v$VERSION/SHASUMS256.txt" | grep " node-v$VERSION-linux-x64.tar.xz$" | sha256sum -c -
   sudo tar --no-same-owner -xJf "node-v$VERSION-linux-x64.tar.xz" -C /opt
   ```

   `--no-same-owner` makes root own the extracted files. `provision.sh` checks that the Node directory is owned by root and not writable by its group or others.

2. From a checkout of this repository, run the provisioning script as root. It creates the `reviewer` user, the job directory, the sudo rule and the Node link:

   ```sh
   sudo action/node/provision.sh --node-dir "/opt/node-v$VERSION-linux-x64" --runner-user <runner user>
   ```

   The host needs sudo 1.9.10 or later, git 2.31 or later, since the diff step passes its auth header with `GIT_CONFIG_COUNT`, and `gh` and `jq`, which the action's first steps use. The script refuses a Node directory that is not owned by root or is writable by its group or others, and a runner home that others can read, write or enter. If it refuses the home, run `chmod o-rwx <runner home>` and run the script again.

3. Remove the runner user from the `docker` group, then restart the runner services.

4. Set `runtime: node` in the workflow.

The node runtime gives these properties:

- the `reviewer` user has no login shell and no home directory, and it cannot read the runner's home; check with `sudo -u reviewer ls <runner home>`, which must fail;
- the model key arrives on the review command's stdin, and the reviewer gets it only in its environment, never in an argument list or in sudo's environment;
- the GitHub token stays with the collect and post steps, which hold no model key; with `runtime: node` the collector runs alongside the diff step, and the review step waits for both;
- sudo allows one command, the review wrapper, and only with a job directory argument.

## Security

The model only reads the pull request's code and never runs it. The review step holds the model key and no GitHub token, and the step that posts the review holds the GitHub token and no model key. The node runtime keeps the same separation, and its review runs as a separate user with one sudo rule. Pull requests from forks are skipped unless `allow-forks` is `true`.

## Review feedback

With feedback on, a `/review` comment gets a receipt on the pull request: a comment that names the mode, links to the run, and shows the request's state until the review is published, fails or is cancelled. The receipt is written by a hosted job before the review job may start, so it appears even while the review waits for a runner. Feedback is optional. Without the two canonical workflow files below, the review workflow works as before.

Install both canonical workflows on the default branch of your repository, together:

- [`.github/workflows/review.yml`](../.github/workflows/review.yml), the consumer workflow with an `accept` job and a `review` job;
- [`.github/workflows/review-status.yml`](../.github/workflows/review-status.yml), the completion watcher whose display name is `Review feedback`.

GitHub runs the watcher only when its file is on the default branch. The links show the files as they are in this repository. Until this implementation is published to the default branch of `heliowap/rev-engine`, the `@main` references in them do not contain the feedback action, so install the copies that come from the revision you choose, not unpublished local changes.

### Repositories and references

The canonical files reference this fork, `heliowap/rev-engine`, at `main`: the root action in the review job of `review.yml`, and the `feedback` action in the accept job of `review.yml` and in `review-status.yml`. Keep one repository and one ref for all three. Write them as `OWNER/REPOSITORY@REVISION` for the root action and `OWNER/REPOSITORY/feedback@REVISION` for the feedback action. To use another fork, or a commit SHA, replace all three together, and prefer a commit SHA so that the reviewed code is the code that runs. Do not mix repositories: the feedback action exists only in repositories that contain this implementation.

### Names

Some names must match across the two workflow files. Renaming one is allowed when the matching name changes in the same commit:

| Name | Set in | Must match |
|---|---|---|
| Display name `Review` | `name:` of `review.yml` | `workflow_run: workflows` in `review-status.yml` |
| File path `.github/workflows/review.yml` | `review-workflow` input of `review-status.yml` | the path of the review workflow file |
| File name `review-status.yml` | `feedback-workflow` input of the root action (default `review-status.yml`) | the file name of the status workflow |
| Display name `Review pull request` | `name:` of the `review` job | `review-job` input of `review-status.yml` |

`review-job` takes the job's display name, not its key `review`. `review-workflow` takes the file path, not the display name. If you rename the status file, also set its new name in `feedback-workflow` in the root step.

### Identities

Receipts are written by one fixed account, `github-actions[bot]`, the default Actions identity of GitHub.com. The feedback action pins its numeric ID, 41898282. Each request resolves that login through the users API and refuses any other ID, so an account that only claims the login cannot take over a receipt. The feedback action's `feedback-author` input accepts only that login, and any other value fails before any GitHub call. The canonical workflows leave it at its default. This is a GitHub.com identity; this release makes no claim about GitHub Enterprise Server.

The account that posts the review is separate and configurable. Set the repository variable `REV_ENGINE_REVIEW_AUTHOR` to its login. It defaults to `github-actions[bot]`. Like the receipt author, it is read from trusted configuration only, never from a comment or a manual input. Each login is resolved to its numeric ID when a request is accepted and when it is synced, and the IDs are stored in the receipt. A later run that finds a different ID fails visibly instead of switching ownership. A configuration change applies to new requests. To recover an older request, restore the configuration it was accepted under.

Receipts written under an earlier experimental receipt-author setting are not migrated, and no setting of this release recognizes them. Once the fixed author writes the receipts, comments by any other account stay unowned, so such an older request cannot be recovered through this action.

### Permissions

- `accept` has `contents: read`, `pull-requests: write`, `issues: write` and `actions: read`. It holds no model key.
- `review` adds `actions: write` only to start the status workflow. The model key goes only to the review step, as before.
- `review-status` has `contents: read`, `actions: read`, `pull-requests: read` and `issues: write`, and runs no code from the pull request.

The default Actions token writes the receipt, reads the run and syncs it. No App secret is needed for that.

### Posting with a GitHub App or a personal-access account

To post the review as an App bot or a personal-access account, pass that account's token to the root action's `github-token`, and only there. Feedback keeps the default token.

Two things are set up outside the YAML below:

1. In the review job, before the root step, add your existing token step with the id `review-app-token`, and have it write the token to its `token` output. This guide does not prescribe a token action; use the one you already use. Run it in the review job only, so no other job gets the token.
2. Set the repository variable `REV_ENGINE_REVIEW_AUTHOR` to the exact login of the posting account. For an App, that is its bot login, usually `<app-slug>[bot]`. Set it before the requests you want posted by that account are accepted, because an accepted request keeps the author it was accepted with.

Then, in the review job of [`review.yml`](../.github/workflows/review.yml), put this step after your token step and replace the canonical root step, so the job has one root step:

```yaml
      - uses: heliowap/rev-engine@main
        with:
          openrouter-api-key: ${{ secrets.OPENROUTER_API_KEY }}
          pr-number: ${{ inputs.pr-number }}
          mode: ${{ inputs.mode || 'human' }}
          github-token: ${{ steps.review-app-token.outputs.token }}
          feedback: 'true'
          feedback-token: ${{ github.token }}
          review-author: ${{ vars.REV_ENGINE_REVIEW_AUTHOR }}
```

The inputs keep the tokens apart:

- `github-token` is the posting token. The root action uses it to read the pull request, check the commenter's permission, check out the code and post the review. The model step never gets it.
- `feedback-token` is the default Actions token. The root action uses it only to start the status workflow, under the `actions: write` grant of the review job.
- `review-author` is the login that posts the review. Unlike the canonical step, this one has no fallback login, so keep the variable set.

The posting account needs the repository access it already needed to post reviews: reading the pull request, the contents and the commenter's permission, and writing pull request reviews. The receipt and its sync never use the posting token. The job grants that feedback adds (`issues: write`, `actions: read`, and `actions: write` in the review job) belong to the default token, as listed under [Permissions](#permissions); the posting account's own repository grants stay separate from them.

A review posted by any other account is not confirmed as published, so the receipt does not show it as published.

### Node runtime

For `runtime: node`, change only the review job's `runs-on` to your prepared self-hosted runner labels, and set `runtime: node` on the same job's step. The accept job and the watcher stay on `ubuntu-latest`.

### Reruns and replacements

A rerun of the same run moves its receipt to the new attempt, in the same comment. A newer request for the same pull request cancels the older review job, and the older run's receipt then reads cancelled. A manually started run is a separate request with its own receipt.

### Command grammar

The grammar is the same as before. Only the first line of a comment counts, and trailing spaces and a carriage return at its end are ignored. The comment starts a review when that line is `/review`, or `/review` followed by a space or tab. The first word after it picks `agent` or `human`, in any case. Other words, and later lines, are ignored.

### Manual sync

If the feedback service was down, run `Review feedback` by hand from the Actions tab with the review run's ID. It brings that run's receipt up to date with the run's current state and never creates one. If the receipt was never written, the request was never accepted, so there is no receipt to repair. A manual sync repairs a receipt; it does not guarantee delivery of anything.

### Limits

The receipt shows only the states the status workflow observed. It shows that the review job started only when that job was seen running, and it does not promise a result. A request that is cancelled before its accept job writes the receipt is not accepted.

Live delivery is not guaranteed. A start or completion event can arrive late or not at all, and the status workflow can fail. Each update depends on GitHub running the hosted jobs and on the status workflow being installed on the default branch. An outage can delay an update until the manual sync or the next run event.

A malformed answer from GitHub is never evidence. A malformed comment or review in a list, or a malformed answer to a receipt write, fails the step visibly. A sync then leaves the receipt in its last written state. A failed acceptance is not retried automatically and is not accepted; start the review again with a new comment, which is a new run. To retry a sync, use the manual sync above.
