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

# The key is passed on only through sudo's stdin; this process's own environment is readable only by
# the runner user. No other secret is passed on.
key=${OPENROUTER_API_KEY-}
unset OPENROUTER_API_KEY GITHUB_TOKEN GH_TOKEN

job=$(mktemp -d "$jobs_root/XXXXXXXXXX")
# Setgid, so the directories made inside the job take its group, the reviewer's, and out/ is one
# the reviewer can write. Set explicitly, since chmod may clear a directory's setgid bit (BSD does).
chmod 2750 "$job"
# The trap below runs this function on exit.
# shellcheck disable=SC2329
cleanup() {
  # Only directories are made writable. The staged files are hard links into the checkout, and
  # changing their modes would change the checkout's.
  find "$job" -type d -exec chmod u+w {} + 2>/dev/null || true
  rm -rf "$job" || echo "::warning::could not remove the review job $job"
}
trap cleanup EXIT

# Copies a tree by hard links, which needs no extra space. When links cannot be made, for example
# across file systems, it copies the bytes instead.
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

# A staged file that is a hard link shares the checkout's file, so the reviewer could change the
# checkout through it only if the file is writable by others. The reviewer is neither the owner of
# these files nor in their group, so any file that others can write is refused here, before sudo.
# Symbolic links are skipped: on Linux a link's mode is always 0777 and says nothing about its target.
unsafe=$(find "$job/repo" "$job/code" ! -type l -perm -o+w)
if [ -n "$unsafe" ]; then
  echo "::error::these are writable by others, so the reviewer could write them:" >&2
  printf '%s\n' "$unsafe" >&2
  exit 1
fi
echo "rev-engine: staged" >&2

status=0
printf '%s\n' "$key" | sudo -n -u "$reviewer" "$wrapper" "$job" || status=$?
key=

# chmod 0750 removes the group's write access to out/, so the reviewer can no longer create entries
# there. Only a regular file that the review user owns, with one link, is copied back, so a link
# the reviewer made to anything else is never followed.
chmod 0750 "$job/out"
mkdir -p "$source_dir/out"
find "$job/out" -maxdepth 1 -type f -name '*.json' -user "$reviewer" -links 1 -exec cp {} "$source_dir/out/" \;

echo "rev-engine: review finished (exit $status)" >&2
exit "$status"
