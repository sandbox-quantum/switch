#!/bin/sh
# Installs the Switch agents controller (switch-agent-controller) with npm,
# from the newest controller release on GitHub, and optionally enrolls this
# machine and installs the controller as a service of this user.
#
#   curl -fsSL <url of this file> | sh
#   curl -fsSL <url of this file> | sh -s -- --server <Switch API URL> --code <code> [--name <name>] [--description <text>]
#
# Options:
#   --server <url> --code <code>   Enroll with a one-time code from the Machines page.
#   --name <name>                  The machine's name in Switch (default: the host name).
#   --description <text>           What the machine is for, shown on the Machines page.
#   --data-dir <dir>               Keep the controller's state here rather than in the default folder.
#   --no-service                   Enroll, but do not install the service.
#   --version <x.y.z>              Install this release rather than the newest.
#
# It installs where npm installs global packages. When this user cannot write
# there (Node from the system's packages installs into /usr), it installs into
# ~/.local instead, without changing npm's settings.
#
# SWITCH_CONTROLLER_RELEASES_REPOSITORY (owner/name) installs from a fork's releases.
set -eu

REPO="${SWITCH_CONTROLLER_RELEASES_REPOSITORY:-sandbox-quantum/switch}"
TAG_PREFIX="switch-agent-controller-v"

fail() {
  echo "switch-agent-controller install: $*" >&2
  exit 1
}

SERVER=""
CODE=""
NAME=""
DESCRIPTION=""
DATA_DIR=""
SERVICE=1
VERSION=""
while [ $# -gt 0 ]; do
  case "$1" in
    --server) [ $# -ge 2 ] || fail "--server needs a URL."; SERVER="$2"; shift 2 ;;
    --code) [ $# -ge 2 ] || fail "--code needs a code."; CODE="$2"; shift 2 ;;
    --name) [ $# -ge 2 ] || fail "--name needs a name."; NAME="$2"; shift 2 ;;
    --description) [ $# -ge 2 ] || fail "--description needs a text."; DESCRIPTION="$2"; shift 2 ;;
    --data-dir) [ $# -ge 2 ] || fail "--data-dir needs a folder."; DATA_DIR="$2"; shift 2 ;;
    --no-service) SERVICE=0; shift ;;
    --version) [ $# -ge 2 ] || fail "--version needs x.y.z."; VERSION="$2"; shift 2 ;;
    *) fail "Unknown option '$1'." ;;
  esac
done
if [ -n "$SERVER" ] && [ -z "$CODE" ]; then fail "--server needs --code too."; fi
if [ -z "$SERVER" ] && [ -n "$CODE" ]; then fail "--code needs --server too."; fi

case "$(uname -s)" in
  Linux | Darwin) ;;
  *) fail "The controller runs on Linux and macOS only." ;;
esac
command -v curl >/dev/null 2>&1 || fail "curl is needed."
command -v node >/dev/null 2>&1 || fail "Node 22.13 or later is needed (https://nodejs.org)."
command -v npm >/dev/null 2>&1 || fail "npm is needed; it comes with Node."
node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 13) ? 0 : 1)' ||
  fail "Node $(node --version) is too old; the controller needs 22.13 or later."

if [ -n "$VERSION" ]; then
  case "$VERSION" in
    *[!0-9.]* | "") fail "--version must be x.y.z." ;;
  esac
  URL="https://github.com/$REPO/releases/download/$TAG_PREFIX$VERSION/switch-agent-controller-$VERSION.tgz"
else
  # The repository also releases Switch and Switch Console: take the highest
  # controller release that carries its package, leaving out drafts and prereleases.
  URL="$(curl -fsSL -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$REPO/releases?per_page=100" |
    TAG_PREFIX="$TAG_PREFIX" node -e '
      let input = "";
      process.stdin.on("data", (chunk) => (input += chunk));
      process.stdin.on("end", () => {
        const prefix = process.env.TAG_PREFIX;
        const parse = (v) => (/^\d+\.\d+\.\d+$/.test(v) ? v.split(".").map(Number) : null);
        let best = null;
        for (const release of JSON.parse(input)) {
          if (release.draft || release.prerelease || !release.tag_name.startsWith(prefix)) continue;
          const version = release.tag_name.slice(prefix.length);
          const parts = parse(version);
          const asset = release.assets.find((a) => a.name === `switch-agent-controller-${version}.tgz`);
          if (!parts || !asset) continue;
          const order = (x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
          if (!best || order(parts, best.parts) > 0) best = { parts, url: asset.browser_download_url };
        }
        if (best) process.stdout.write(best.url);
      });
    ')" || fail "Could not list the releases of $REPO."
  [ -n "$URL" ] || fail "$REPO has no switch-agent-controller release yet."
fi

PREFIX="$(npm config get prefix)"
if [ ! -w "$PREFIX" ] && [ ! -w "$PREFIX/lib/node_modules" ]; then
  echo "npm installs global packages into $PREFIX, which this user cannot write; installing into $HOME/.local instead."
  PREFIX="$HOME/.local"
  mkdir -p "$PREFIX"
fi

echo "Installing $URL"
npm install --global --prefix "$PREFIX" "$URL"
BIN="$PREFIX/bin/switch-agent-controller"
[ -x "$BIN" ] || fail "npm did not install $BIN."
case ":$PATH:" in
  *":$PREFIX/bin:"*) ON_PATH=1 ;;
  *) ON_PATH=0 ;;
esac

# The service runs the controller by its full path; this is only for typing it.
path_note() {
  if [ "$ON_PATH" = 0 ]; then
    echo
    echo "$PREFIX/bin is not on your PATH, so the switch-agent-controller command is not found by name. Add it with:"
    echo "  export PATH=\"$PREFIX/bin:\$PATH\""
  fi
}

if [ -z "$SERVER" ]; then
  echo
  echo "Installed $("$BIN" --version). Next, with a code from the Machines page in Switch:"
  echo "  switch-agent-controller enroll --server <Switch API URL> --code <code>"
  echo "  switch-agent-controller install-service"
  echo "Check this machine with: switch-agent-controller doctor"
  path_note
  exit 0
fi

set -- enroll --server "$SERVER" --code "$CODE"
if [ -n "$NAME" ]; then set -- "$@" --name "$NAME"; fi
if [ -n "$DESCRIPTION" ]; then set -- "$@" --description "$DESCRIPTION"; fi
if [ -n "$DATA_DIR" ]; then set -- "$@" --data-dir "$DATA_DIR"; fi
"$BIN" "$@"
if [ "$SERVICE" = 1 ]; then
  if [ -n "$DATA_DIR" ]; then "$BIN" install-service --data-dir "$DATA_DIR"; else "$BIN" install-service; fi
fi
echo
if [ -n "$DATA_DIR" ]; then "$BIN" doctor --data-dir "$DATA_DIR"; else "$BIN" doctor; fi
path_note
