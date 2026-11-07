#!/bin/bash
# Writes the pull request diff to $OUT. The compare API gives the diff between the pinned base and
# head without any history. When it fails, or its file count differs from the pull request's, git
# in the checkout gives the same diff. Each fetch gets the auth header in its environment, never in
# its arguments or in a config file. GIT_CONFIG_COUNT needs git 2.31 or later.
#
# Env: GH_TOKEN REPO BASE HEAD PULL_JSON CHECKOUT OUT
set -euo pipefail

auth=$(printf 'x-access-token:%s' "$GH_TOKEN" | base64 | tr -d '\n')
# Runs git fetch in the checkout with the header in the environment of that one git.
fetch_auth() {
  GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraheader GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $auth" \
    git -C "$CHECKOUT" fetch "$@"
}

api_out="$OUT.api"
written=no
reason=""
if gh api -H "Accept: application/vnd.github.diff" "repos/$REPO/compare/$BASE...$HEAD" > "$api_out"; then
  files=$(grep -c '^diff --git ' "$api_out" || true)
  wanted=$(jq -r .changed_files "$PULL_JSON")
  if [ "$files" = "$wanted" ]; then
    mv "$api_out" "$OUT"
    written=yes
  else
    reason="the compare diff has $files files and the pull request $wanted"
  fi
else
  reason="the compare API failed"
fi

if [ "$written" = no ]; then
  rm -f "$api_out"
  echo "::notice::Diff from git: $reason"
  if [ "$(git -C "$CHECKOUT" rev-parse --is-shallow-repository)" = true ]; then
    fetch_auth --quiet --no-tags --unshallow origin "$BASE" "$HEAD"
  else
    fetch_auth --quiet --no-tags origin "$BASE"
  fi
  git -C "$CHECKOUT" diff "$BASE...$HEAD" > "$OUT"
fi

# The reviewer reads the base commit with git show, so it must be present, but the history
# before it is not needed.
if ! git -C "$CHECKOUT" cat-file -e "$BASE^{commit}" 2>/dev/null; then
  fetch_auth --quiet --no-tags --depth=1 origin "$BASE"
fi
