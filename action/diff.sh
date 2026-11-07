#!/bin/bash
# Writes the pull request diff to $OUT. The compare API gives the diff between the pinned base and
# head without any history. When it fails, or its file count differs from the pull request's, git
# in the checkout gives the same diff. Every fetch passes its header on the command line, so the
# token is never written into a config file.
#
# Env: GH_TOKEN REPO BASE HEAD PULL_JSON CHECKOUT OUT
set -euo pipefail

auth=$(printf 'x-access-token:%s' "$GH_TOKEN" | base64 | tr -d '\n')
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
    git -C "$CHECKOUT" -c "http.extraheader=AUTHORIZATION: basic $auth" fetch --quiet --no-tags --unshallow origin "$BASE" "$HEAD"
  else
    git -C "$CHECKOUT" -c "http.extraheader=AUTHORIZATION: basic $auth" fetch --quiet --no-tags origin "$BASE"
  fi
  git -C "$CHECKOUT" diff "$BASE...$HEAD" > "$OUT"
fi

# The reviewer reads the base commit with git show, so it must be present, but the history
# before it is not needed.
if ! git -C "$CHECKOUT" cat-file -e "$BASE^{commit}" 2>/dev/null; then
  git -C "$CHECKOUT" -c "http.extraheader=AUTHORIZATION: basic $auth" fetch --quiet --no-tags --depth=1 origin "$BASE"
fi
