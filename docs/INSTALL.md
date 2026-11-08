# Install the GitHub Action

RevEngine reviews pull requests in your repository when a person with write access comments `/review` on one. The findings come back as one review with comments on the changed lines. Comments from anyone else are ignored, because each review costs money.

Comment `/review agent` instead to get a review for an agent that manages the pull request. It lists every finding in one comment, as described under [Agent reviews](#agent-reviews).

## Setup

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
      - uses: laude-institute/rev-engine@main
        with:
          openrouter-api-key: ${{ secrets.OPENROUTER_API_KEY }}
          pr-number: ${{ inputs.pr-number }}
          mode: ${{ inputs.mode || 'human' }}
```

You can also start a review from the Actions tab by running the workflow with a pull request number. A workflow without the `mode` lines still runs agent reviews from comments.

## What you get

By default the action reviews with `anthropic/claude-opus-5.5`, comments on at most 10 findings of medium or high severity, and lists the less severe ones in a collapsed section of the summary. It also gives a short answer to whether the change belongs in the project. The summary opens with one line of merge advice, which plain rules decide from the severities and that answer.

On a later review of the same pull request, the action first collects what the maintainer decided about earlier findings, and the review does not report a decided finding again unless the code gives a reason. A finding marked fixed, or a thread resolved without a reply, comes back only when the code at head shows the problem is still there. A finding marked wrong, won't fix or deferred comes back only when the code has changed in a way that makes it right. A finding that comes back names the earlier one it repeats. A decision counts when someone with write access wrote it: a reply on one of the action's comments that starts with **Fixed**, **Partly fixed**, **Won't fix**, **Deferred** or **Wrong**, a thread they resolved, or a comment that starts with `## Review evaluation` and labels findings as `must`, `valid` or `invalid`. A comment nobody answered is not a decision. The fit check also gets the maintainer's answer from the "Fit and recommendation" section of each review evaluation, so it does not raise a concern again that the maintainer already answered, and it keeps the maintainer's latest verdict unless the change has moved since. The summary says how many findings were left out this way and which earlier ones they repeated. If collecting fails, the run logs a warning and reviews as before. Separately, when an earlier comment from the action is still open and raises the same problem on the same lines in nearly the same words, the action does not comment again; it lists the finding in a collapsed part of the summary, with a link to that comment. A different problem on those lines gets its own comment.

## Agent reviews

`/review agent` runs a swarm of short reviews by a cheap model. The review itself usually takes about a minute and costs under $1. Each part of the diff gets agents with one task each, such as checking callers or tests, and three verifiers vote on every finding.

The result is one comment with no comments on lines:

- Every finding the verifiers did not reject, up to 80, most severe first.
- Each finding's severity, how many verifiers confirmed it, its location and the full explanation.
- The same one line of merge advice as a human review.

An agent can read the whole list and decide what to fix. There is no assessment of whether the change belongs in the project. The `model`, `min-severity`, `max-findings`, `fit`, `effort`, `second-look` and `wrap-up` inputs do not apply to an agent review. Its counterparts are `agent-model`, which picks the swarm's model, and `swarm-effort`, which sets the reasoning effort of the swarm's agents. `time-budget` only caps the swarm's own pace of 60 seconds per agent, 90 at most.

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
| `command` | `/review` | A comment starts a review only when it is this text, or this text followed by a space. The word after it, `agent` or `human`, picks the review. |
| `mode` | `human` | The review to run when the comment names none, or when the workflow is started by hand. |
| `agent-model` | `deepseek/deepseek-v4.1-flash-1017` | OpenRouter model the swarm of an agent review uses. |
| `swarm-effort` | `none` | Agent reviews only. Reasoning effort for the swarm's agents, for models that accept one: `none`, `minimal`, `low`, `medium` or `high`. |
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
