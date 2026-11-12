#!/usr/bin/env bash
# Disposable Linux for the Runner integration test: an Ubuntu container with sshd and an
# ephemeral key, reached by `remoto` through REMOTO_HOST and REMOTO_SSH_OPTS. Never touches
# ~/.ssh. Usage: scripts/runner-linux-it.sh up | down
set -euo pipefail
NAME=${RUNNER_IT_CONTAINER:-t3-runner-it-$$}
STATE="$(cd "$(dirname "$0")/.." && pwd)/.t3/runner-it"
IMAGE=t3-runner-it:ubuntu-24.04

case "${1:-}" in
  up)
    mkdir -p "$STATE"
    [ -f "$STATE/key" ] || ssh-keygen -q -t ed25519 -N '' -C t3-runner-it -f "$STATE/key"
    docker build -q -t "$IMAGE" - >/dev/null <<'DOCKERFILE'
FROM ubuntu:24.04
RUN apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -yq --no-install-recommends \
      openssh-server rsync procps util-linux ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -s /bin/bash dev && install -d -m700 -o dev -g dev /home/dev/.ssh \
    && install -d -o dev -g dev /home/dev/runs \
    && mkdir -p /run/sshd \
    && printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\n' > /etc/ssh/sshd_config.d/it.conf
CMD ["/usr/sbin/sshd", "-D", "-e"]
DOCKERFILE
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker run -d --name "$NAME" -p 127.0.0.1::22 "$IMAGE" >/dev/null
    docker exec -i "$NAME" sh -c 'cat > /home/dev/.ssh/authorized_keys && chown dev:dev /home/dev/.ssh/authorized_keys && chmod 600 /home/dev/.ssh/authorized_keys' < "$STATE/key.pub"
    PORT=$(docker port "$NAME" 22/tcp | head -1 | sed 's/.*://')
    OPTS="-i $STATE/key -p $PORT -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR"
    for _ in $(seq 1 50); do
      # shellcheck disable=SC2086
      ssh -o BatchMode=yes -o ConnectTimeout=2 $OPTS dev@127.0.0.1 true 2>/dev/null && break
      sleep 0.2
    done
    cat <<ENV
export RUNNER_IT=1
export RUNNER_IT_CONTAINER=$NAME
export RUNNER_IT_HOST=dev@127.0.0.1
export RUNNER_IT_SSH_OPTS="$OPTS"
ENV
    ;;
  down)
    docker ps -aq --filter "name=^t3-runner-it-" | xargs -r docker rm -f >/dev/null
    rm -rf "$STATE"
    ;;
  *)
    echo "usage: $0 up | down" >&2
    exit 2
    ;;
esac
