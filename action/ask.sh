#!/bin/bash
# The command gate shared by the root action and the hosted feedback action. It decides whether a
# review is asked for, and writes run, mode, number, base and head to $GITHUB_OUTPUT. A rejected
# request writes run=false and exits 0. Only an authorized request on a valid pull request writes run=true.
#
# Env: GH_TOKEN REPO EVENT_NAME ACTOR COMMENT COMMENT_ON_PR EVENT_NUMBER INPUT_NUMBER COMMAND MODE
#      ALLOW_FORKS RUNTIME RUNNER_TEMP GITHUB_OUTPUT
# Event and input values come only from the environment and are never written into this script.
set -euo pipefail
skip() { echo "::notice::No review: $1"; echo "run=false" >> "$GITHUB_OUTPUT"; exit 0; }

number="${INPUT_NUMBER:-$EVENT_NUMBER}"
if [ "$EVENT_NAME" = issue_comment ]; then
  [ -n "$COMMENT_ON_PR" ] || skip "the comment is not on a pull request"
  # Only the first line counts, without the carriage return and trailing spaces that
  # some browsers and the mobile app add.
  first=$(printf '%s\n' "$COMMENT" | head -n 1 | tr -d '\r' | sed 's/[[:space:]]*$//')
  case "$first" in "$COMMAND"|"$COMMAND "*|"$COMMAND	"*) ;; *) skip "the comment is not $COMMAND" ;; esac
  number="$EVENT_NUMBER"
  # The first word after the command picks the review; any other text keeps the default.
  word=$(printf '%s' "${first#"$COMMAND"}" | awk '{print tolower($1)}')
  case "$word" in agent|human) MODE="$word" ;; esac
fi
case "$MODE" in agent|human) ;; *) echo "::error::mode must be agent or human"; exit 1 ;; esac
case "$RUNTIME" in docker|node) ;; *) echo "::error::runtime must be docker or node"; exit 1 ;; esac
case "$number" in ''|*[!0-9]*) echo "::error::No pull request number. Set pr-number."; exit 1 ;; esac

# Only people who can push to the repository may start a review, because each one costs money.
permission=$(gh api "repos/$REPO/collaborators/$ACTOR/permission" --jq .permission 2>/dev/null || echo none)
case "$permission" in admin|write) ;; *) skip "$ACTOR does not have write access to $REPO" ;; esac

mkdir -p "$RUNNER_TEMP/rev-engine-prime/pr" "$RUNNER_TEMP/rev-engine-prime/out"
gh api "repos/$REPO/pulls/$number" > "$RUNNER_TEMP/rev-engine-prime/pull.json"
jq '{title, body}' "$RUNNER_TEMP/rev-engine-prime/pull.json" > "$RUNNER_TEMP/rev-engine-prime/pr/pr.json"
if [ "$(jq -r '.head.repo.full_name // ""' "$RUNNER_TEMP/rev-engine-prime/pull.json")" != "$REPO" ] && [ "$ALLOW_FORKS" != true ]; then
  skip "pull request $number comes from a fork and allow-forks is not set"
fi
{
  echo "run=true"
  echo "mode=$MODE"
  echo "number=$number"
  echo "base=$(jq -r .base.sha "$RUNNER_TEMP/rev-engine-prime/pull.json")"
  echo "head=$(jq -r .head.sha "$RUNNER_TEMP/rev-engine-prime/pull.json")"
} >> "$GITHUB_OUTPUT"
