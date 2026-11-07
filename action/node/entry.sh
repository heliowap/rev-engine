#!/bin/bash
# Runs one review as the reviewer user. provision.sh installs it root-owned as
# /usr/local/libexec/rev-engine/review, and sudo reaches it through one rule. It reads the model key
# from stdin and the settings from the job's env file, and takes nothing else from its caller. Its
# first run clears the environment and runs it again with the marker "clean", so the review starts
# with only the variables it sets. The key is passed only in that environment, never in an argument
# list.
set -euo pipefail

jobs_root=/var/lib/rev-engine/jobs
node=/opt/rev-engine-node/bin/node

die() {
  echo "rev-engine: $1" >&2
  exit 2
}

# The sudo rule allows exactly one argument, the job directory, so a caller cannot pass "clean" and
# skip this step. The environment is cleared here, before the key is read, and names that are not
# shell names and exported functions are removed with it.
if [ "$#" -eq 1 ]; then
  exec /usr/bin/env -i PATH=/usr/bin:/bin /bin/bash "$0" "$1" clean
fi
[ "$#" -eq 2 ] && [ "$2" = clean ] || die "expects one job directory"
job=$1

case "$job" in
  "$jobs_root"/*) ;;
  *) die "the job is not under $jobs_root" ;;
esac
name=${job#"$jobs_root"/}
case "$name" in
  '' | *[!A-Za-z0-9]*) die "the job name is not a plain token" ;;
esac
[ -d "$job" ] && [ ! -L "$job" ] || die "the job is not a directory"
for sub in repo pr code out; do
  [ -d "$job/$sub" ] && [ ! -L "$job/$sub" ] || die "$sub is not a directory"
done
[ -f "$job/env" ] && [ ! -L "$job/env" ] || die "env is not a regular file"

# The key comes on stdin, so it is never in an argument list or in the environment of sudo.
[ ! -t 0 ] || die "refuses to read the key from a terminal"
key=
IFS= read -r key || true
[ -n "$key" ] || die "no model key on stdin"

envargs=()
while IFS= read -r line || [ -n "$line" ]; do
  setting=${line%%=*}
  case "$line" in
    *=*) ;;
    *) die "a settings line has no value" ;;
  esac
  case "$setting" in
    RB_NWO | RB_PR_NUMBER | RB_BASE | RB_HEAD | RB_MODEL_BASE_URL | RB_ATTEMPT) ;;
    RB_CONFIG_*)
      case "${setting#RB_CONFIG_}" in
        '' | *[!A-Z0-9_]*) die "$setting is not a valid setting name" ;;
      esac
      ;;
    *) die "$setting is not allowed in the settings" ;;
  esac
  envargs+=("$line")
done < "$job/env"

umask 022
echo "rev-engine: review runs as $(id -un)" >&2

export PATH=/usr/bin:/bin HOME=/nonexistent LANG=C.UTF-8 OPENROUTER_API_KEY="$key"
for kv in ${envargs[@]+"${envargs[@]}"}; do
  export "${kv%%=*}=${kv#*=}"
done
export RB_REPO="$job/repo" RB_DIFF="$job/pr/diff.patch" RB_PR_JSON="$job/pr/pr.json" RB_PRIOR_JSON="$job/pr/prior.json" \
  RB_OUT="$job/out/findings.json" RB_DETAILS_OUT="$job/out/details.json"
exec "$node" "$job/code/src/main.ts"
