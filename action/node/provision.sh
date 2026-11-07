#!/bin/bash
# Prepares a self-hosted runner host for the node runtime. Run it as root; every step can run
# again. --print-sudoers prints the one sudo rule and needs no root.
#
#   sudo action/node/provision.sh --node-dir /opt/node-v24.x.y-linux-x64 [--runner-user U] [--review-user R]
#   action/node/provision.sh --print-sudoers [--runner-user U] [--review-user R]
#
# The runner user is not added to the docker group, and this script never changes group membership.
set -euo pipefail

node_dir=""
runner_user=runner
review_user=reviewer
print_sudoers=no
while [ "$#" -gt 0 ]; do
  case "$1" in
    --node-dir)
      node_dir=${2:?--node-dir needs a directory}
      shift 2
      ;;
    --runner-user)
      runner_user=${2:?--runner-user needs a name}
      shift 2
      ;;
    --review-user)
      review_user=${2:?--review-user needs a name}
      shift 2
      ;;
    --print-sudoers)
      print_sudoers=yes
      shift
      ;;
    *)
      echo "provision.sh: unknown argument $1" >&2
      exit 2
      ;;
  esac
done

wrapper=/usr/local/libexec/rev-engine/review
jobs_root=/var/lib/rev-engine/jobs
sudoers_line="$runner_user ALL=($review_user) NOPASSWD: $wrapper ^$jobs_root/[A-Za-z0-9]+\$"

if [ "$print_sudoers" = yes ]; then
  printf '%s\n' "$sudoers_line"
  exit 0
fi

[ -n "$node_dir" ] || { echo "provision.sh: --node-dir is required" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || { echo "provision.sh: run as root" >&2; exit 1; }
major=$("$node_dir/bin/node" -v | sed 's/^v//; s/\..*//')
[ "$major" -ge 24 ] 2>/dev/null || { echo "provision.sh: Node 24 or later is required" >&2; exit 1; }

ln -sfn "$node_dir" /opt/rev-engine-node
id "$review_user" >/dev/null 2>&1 || useradd --system --user-group --no-create-home \
  --home-dir /nonexistent --shell /usr/sbin/nologin "$review_user"
install -d -o root -g root -m 0755 /var/lib/rev-engine
install -d -o "$runner_user" -g "$review_user" -m 2750 "$jobs_root"
install -d -o root -g root -m 0755 /usr/local/libexec/rev-engine
install -o root -g root -m 0755 "$(dirname "$0")/entry.sh" "$wrapper"

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
printf '%s\n' "$sudoers_line" > "$tmp"
visudo -c -f "$tmp" >/dev/null
install -o root -g root -m 0440 "$tmp" /etc/sudoers.d/rev-engine

printf 'd %s 2750 %s %s 1d\n' "$jobs_root" "$runner_user" "$review_user" > /etc/tmpfiles.d/rev-engine.conf
if command -v systemd-tmpfiles >/dev/null 2>&1; then
  systemd-tmpfiles --create /etc/tmpfiles.d/rev-engine.conf
fi
echo "provision.sh: done" >&2
