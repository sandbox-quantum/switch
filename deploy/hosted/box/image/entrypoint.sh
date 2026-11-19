#!/bin/sh
# Switch agent box: enrol once, then run the controller.
#
# Inputs (from the pod spec):
#   SWITCH_SERVER        the Switch server's agent bridge, e.g. https://switch.example.com
#   SWITCH_MACHINE_NAME  the name the user sees on their Machines page
#   /etc/switch/enrol/code  a one-time enrolment code the user made in their
#                        own account (10 minutes). Only read on first start.
#
# The controller's credential and state live on the user's volume
# (/data/controller/state, see below), so a restarted or moved pod carries on as the same
# machine, and the spent code is never needed again.
set -eu

# The data volume's root belongs to root, group 2000
# (fsGroup), and the split box's controller runs as uid 2001. It can write
# there through the group, but only an owner may chmod, so `enroll` tightening
# its data folder to 0700 failed with EPERM and the box crash-looped. So the
# controller's state now lives in a `state` folder it creates, and therefore
# owns, inside the volume. Its own chmod 0700 then works, and its private key
# and sealed logins stay readable by uid 2001 only.
# A volume already holding state at its root (the older layout, where the
# controller owns the root) keeps using the root, so such a box keeps its
# identity. The folder is exported, so everything in the controller agrees.
base=${SWITCH_CONTROLLER_DATA_DIR:-/data/controller}
if [ -e "$base/controller.db" ]; then
  data=$base
else
  data=$base/state
fi
SWITCH_CONTROLLER_DATA_DIR=$data
export SWITCH_CONTROLLER_DATA_DIR
code_file=/etc/switch/enrol/code
# `state` is made 0700 from the start, so there is no
# moment where it exists with the default mode before the controller's chmod.
(umask 077 && mkdir -p "$data")
mkdir -p "${HOME:-/data/home}"
cd "${HOME:-/data/home}"

enrol_box() {
  : "${SWITCH_SERVER:?SWITCH_SERVER is not set}"
  : "${SWITCH_MACHINE_NAME:?SWITCH_MACHINE_NAME is not set}"
  if [ ! -s "$code_file" ]; then
    echo "switch-box: not enrolled and no enrolment code at $code_file" >&2
    exit 2
  fi
  echo "switch-box: enrolling as \"$SWITCH_MACHINE_NAME\" with $SWITCH_SERVER"
  switch-agent-controller enroll \
    --server "$SWITCH_SERVER" \
    --code "$(cat "$code_file")" \
    --name "$SWITCH_MACHINE_NAME" \
    --description "${SWITCH_MACHINE_DESCRIPTION:-Switch cloud box}" \
    --data-dir "$data" \
    --secret-store file
}

if ! switch-agent-controller status --data-dir "$data" >/dev/null 2>&1; then
  enrol_box
fi

# Updates come from rolling out a new image, so the controller must not update
# itself. --updated-by-console is the existing switch for "something else
# updates me": it follows no release Switch names and installs nothing.
#
# The controller's own node runs with --optimize-for-size, which
# keeps V8 from holding spare heap pages after each burst of work (harness:
# 242 -> ~103 MiB at rest after wakes). It's on this command line only, never
# in NODE_OPTIONS, so agent hosts and provider CLIs don't inherit it.
#
# Any args from the pod spec (the split template's --launcher-address,
# --agents-data-dir, --agents-workspaces) are passed on to `run` unchanged.
cli=$(readlink -f "$(command -v switch-agent-controller)")
[ -f "$cli" ] || { echo "switch-box: cannot find the controller's cli.mjs" >&2; exit 2; }
# A box revived after clean-up keeps its old
# data-controller disk, whose controller Core has since revoked or forgotten.
# When run exits 3 (revoked) or 6 (no controller by this credential) and an
# enrolment code is present, the old state is moved aside on the same disk
# (kept, never deleted), the box enrols afresh with the code, and run starts
# again. With no code it exits as before, so a revoked box never loops. The
# code itself is never printed. Only the newest retired copy is kept.
set +e
node --optimize-for-size "$cli" run --data-dir "$data" --updated-by-console "$@"
rc=$?
set -e
if { [ "$rc" -eq 3 ] || [ "$rc" -eq 6 ]; } && [ -s "$code_file" ]; then
  keep="$data/.retired/$(date -u +%Y%m%dT%H%M%SZ)"
  echo "switch-box: controller ended with $rc; keeping its old state in $keep and enrolling again"
  mkdir -p "$keep"
  for entry in "$data"/* "$data"/.[!.]*; do
    [ -e "$entry" ] || continue
    [ "$entry" = "$data/.retired" ] && continue
    mv "$entry" "$keep/"
  done
  # Keep only the newest retired copy, so revoked identities don't pile up on
  # the disk. Names are UTC times, so they sort in time order.
  for old in $(ls -1 "$data/.retired" | sort | sed '$d'); do
    rm -rf "$data/.retired/$old"
  done
  mkdir -p "${HOME:-/data/home}"
  cd "${HOME:-/data/home}"
  enrol_box
  exec node --optimize-for-size "$cli" run --data-dir "$data" --updated-by-console "$@"
fi
exit "$rc"
