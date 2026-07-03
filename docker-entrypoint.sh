#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# Privilege-drop entrypoint.
# Starts as root only to (a) fix ownership of the writable bind-mounts so the
# non-root `node` user can write them, and (b) grant `node` access to the
# mounted Docker socket by joining its group. Then execs the app as `node`.
# The long-running application process therefore runs unprivileged (uid 1000).
# ─────────────────────────────────────────────────────────────────────────────
set -e

# (a) Writable project-local mounts. Previously written by a root container, so
#     they may contain root-owned files that uid 1000 can't overwrite.
#     (System mounts /ffxi-settings and /ffxi-server-scripts are already 1000:1000.)
for d in /app/data /app/public/uploads /app/public/maps; do
  [ -d "$d" ] && chown -R node:node "$d" 2>/dev/null || true
done

# (b) Docker socket: add `node` to whatever group owns the socket on the host.
if [ -S /var/run/docker.sock ]; then
  SOCK_GID="$(stat -c '%g' /var/run/docker.sock 2>/dev/null || echo '')"
  if [ -n "$SOCK_GID" ] && [ "$SOCK_GID" != "0" ]; then
    GRP="$(getent group "$SOCK_GID" | cut -d: -f1)"
    if [ -z "$GRP" ]; then addgroup -g "$SOCK_GID" dockerhost 2>/dev/null || true; GRP=dockerhost; fi
    addgroup node "$GRP" 2>/dev/null || true
  fi
fi

exec su-exec node "$@"
