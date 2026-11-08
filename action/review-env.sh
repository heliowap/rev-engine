#!/bin/bash
# Prints the reviewer's settings as NAME=VALUE lines, the form docker's --env-file reads. The node
# runtime's entry.sh reads the same lines against an allowlist and does not run them as shell. This
# is the one place that decides how the review is configured, for both runtimes. It reads no secret,
# so the model key and the GitHub token never pass through it.
#
# Env: RB_NWO RB_PR_NUMBER RB_BASE RB_HEAD RB_MODEL_BASE_URL RB_CONFIG_MODEL RB_CONFIG_TIME_BUDGET
#      RB_CONFIG_FIT RB_CONFIG_MAX_TURNS RB_CONFIG_SECOND_LOOK RB_CONFIG_EFFORT
#      RB_CONFIG_WRAP_UP MODE AGENT_MODEL SWARM_EFFORT
set -euo pipefail

fail() {
  echo "::error::$1" >&2
  exit 1
}

case "${MODE-}" in
  agent | human) ;;
  *) fail "mode must be agent or human" ;;
esac

# Checked before anything is printed, so a broken value yields no partial file.
for name in RB_NWO RB_PR_NUMBER RB_BASE RB_HEAD RB_MODEL_BASE_URL RB_CONFIG_MODEL RB_CONFIG_TIME_BUDGET \
  RB_CONFIG_FIT RB_CONFIG_MAX_TURNS RB_CONFIG_SECOND_LOOK RB_CONFIG_EFFORT \
  RB_CONFIG_WRAP_UP AGENT_MODEL SWARM_EFFORT; do
  value=${!name-}
  case "$value" in
    *$'\n'*) fail "$name has a line break" ;;
  esac
done

# An empty setting is left out, so the reviewer keeps its own default for it.
emit() {
  if [ -n "$2" ]; then
    printf '%s=%s\n' "$1" "$2"
  fi
}

model=${RB_CONFIG_MODEL-}
if [ "$MODE" = agent ]; then
  model=${AGENT_MODEL-}
fi
# An empty model would fall back to the reviewer's default without a word, so it is refused instead.
[ -n "$model" ] || fail "the model for this review is empty"

emit RB_NWO "${RB_NWO-}"
emit RB_PR_NUMBER "${RB_PR_NUMBER-}"
emit RB_BASE "${RB_BASE-}"
emit RB_HEAD "${RB_HEAD-}"
emit RB_MODEL_BASE_URL "${RB_MODEL_BASE_URL-}"
emit RB_CONFIG_MODEL "$model"
emit RB_CONFIG_TIME_BUDGET "${RB_CONFIG_TIME_BUDGET-}"
emit RB_CONFIG_FIT "${RB_CONFIG_FIT-}"
emit RB_CONFIG_MAX_TURNS "${RB_CONFIG_MAX_TURNS-}"
emit RB_CONFIG_SECOND_LOOK "${RB_CONFIG_SECOND_LOOK-}"
emit RB_CONFIG_EFFORT "${RB_CONFIG_EFFORT-}"
emit RB_CONFIG_WRAP_UP "${RB_CONFIG_WRAP_UP-}"

# An agent review runs the fast swarm in agent mode, which keeps every finding the verifiers did
# not reject. It has no fit assessment.
if [ "$MODE" = agent ]; then
  emit RB_CONFIG_MODE agent
  emit RB_CONFIG_SWARM on
  emit RB_CONFIG_SWARM_PROVIDERS together
  emit RB_CONFIG_SWARM_TARGET 60
  emit RB_CONFIG_SWARM_LIMIT 90
  emit RB_CONFIG_SWARM_EFFORT "${SWARM_EFFORT:-none}"
  emit RB_CONFIG_SWARM_CONTEXT rich
  emit RB_CONFIG_SWARM_EVIDENCE off
fi

emit RB_ATTEMPT 1
