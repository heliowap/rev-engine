#!/bin/bash
# The review step of the node runtime. It runs as the runner user, which holds the model key and no
# GitHub token. The review runs as the reviewer user, through the one sudo rule, in a job directory
# that this script stages and then removes. The reviewer reads the staged checkout and diff and
# writes only the job's out directory.
#
# Env: OPENROUTER_API_KEY GITHUB_ACTION_PATH GITHUB_WORKSPACE RUNNER_TEMP
# Optional, for tests: REV_ENGINE_JOBS REV_ENGINE_WRAPPER REV_ENGINE_REVIEW_USER REV_ENGINE_ENV_FILE
#                      REV_ENGINE_CHECKOUT
set -euo pipefail

jobs_root=${REV_ENGINE_JOBS:-/var/lib/rev-engine/jobs}
wrapper=${REV_ENGINE_WRAPPER:-/usr/local/libexec/rev-engine/review}
reviewer=${REV_ENGINE_REVIEW_USER:-reviewer}
settings=${REV_ENGINE_ENV_FILE:-$RUNNER_TEMP/rev-engine-prime/review.env}
checkout=${REV_ENGINE_CHECKOUT:-$GITHUB_WORKSPACE/rev-engine-prime-checkout}
source_dir=$RUNNER_TEMP/rev-engine-prime

# The key stays in this shell's variable only until it is written to sudo's stdin. No other secret
# is passed on.
key=${OPENROUTER_API_KEY-}
unset OPENROUTER_API_KEY GITHUB_TOKEN GH_TOKEN

job=$(mktemp -d "$jobs_root/XXXXXXXXXX")
chmod 0750 "$job"
# The trap below runs this function on exit.
# shellcheck disable=SC2329
cleanup() {
  chmod -R u+w "$job" 2>/dev/null || true
  rm -rf "$job" || echo "::warning::could not remove the review job $job"
}
trap cleanup EXIT

# Copies a tree by hard links, which needs no extra space. When links cannot be made, for example
# across file systems, it copies the bytes instead. The partial copy is removed first, so that no
# file of the job is ever a link into the checkout that the reviewer could write through.
stage() {
  if cp -al "$1" "$2" 2>/dev/null; then
    return 0
  fi
  rm -rf "$2"
  cp -a "$1" "$2"
}

stage "$checkout/." "$job/repo"
mkdir "$job/pr" "$job/code" "$job/out"
cp "$source_dir/pr/diff.patch" "$source_dir/pr/pr.json" "$job/pr/"
if [ -f "$source_dir/pr/prior.json" ]; then
  cp "$source_dir/pr/prior.json" "$job/pr/"
fi
stage "$GITHUB_ACTION_PATH/src" "$job/code/src"
stage "$GITHUB_ACTION_PATH/package.json" "$job/code/package.json"
mkdir "$job/code/experiments"
stage "$GITHUB_ACTION_PATH/experiments/prototypes" "$job/code/experiments/prototypes"
cp "$settings" "$job/env"
chmod 0644 "$job"/pr/* "$job/env"
# Setgid and group-writable for the reviewer only, so its output can be written but nothing else.
chmod 2770 "$job/out"
echo "rev-engine: staged" >&2

status=0
printf '%s\n' "$key" | sudo -n -u "$reviewer" "$wrapper" "$job" || status=$?
key=

# The reviewer can no longer write the out directory, so what is copied back is what it wrote.
# Only regular files are copied, so a link it made is never followed.
chmod 0750 "$job/out"
mkdir -p "$source_dir/out"
find "$job/out" -maxdepth 1 -type f -name '*.json' -exec cp {} "$source_dir/out/" \;

echo "rev-engine: review finished (exit $status)" >&2
exit "$status"
