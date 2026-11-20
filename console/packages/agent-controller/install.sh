#!/bin/sh
# Installs the Switch agent controller (switch-agent-controller) with npm,
# from the newest controller release on GitHub, and optionally enrolls this
# machine and installs the controller as a service of this user.
#
#   curl -fsSL <url of this file> | sh
#   curl -fsSL <url of this file> | sh -s -- --server <Switch API URL> --code <code> [--name <name>] [--description <text>]
#
# Options:
#   --server <url> --code <code>   Enroll with a one-time code from the Devices page.
#   --name <name>                  The machine's name in Switch (default: the host name).
#   --description <text>           What the machine is for, shown on the Devices page.
#   --data-dir <dir>               Keep the controller's state here rather than in the default folder.
#   --no-service                   Enroll, but do not install the service.
#   --version <x.y.z>              Install this release rather than the newest.
#
# It installs only a release signed with one of the release signing keys
# below, and runs no npm install scripts.
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

# The release signing keys this installer trusts, one "<id> <base64 SPKI>" per
# line: a copy of src/release-keys.ts, which release-keys.test.ts keeps equal.
# BEGIN TRUSTED RELEASE KEYS
TRUSTED_RELEASE_KEYS='
release-2026-10 MCowBQYDK2VwAyEAaRFfp1Yd/b91KkZs8Vj/OQSdsZS2ifd+rZu24pKTMpU=
'
# END TRUSTED RELEASE KEYS

# Verifies <package> against <signature file> for <version>: the Ed25519
# signature over "switch-agent-controller-release-v1\n<version>\n<sha256>\n"
# by one of TRUSTED_RELEASE_KEYS. Prints the id of the key that verifies it.
# BEGIN VERIFY RELEASE
VERIFY_RELEASE_JS='
const crypto = require("node:crypto");
const fs = require("node:fs");
const [file, signatureFile, version] = process.argv.slice(1);
const refuse = (why) => {
  process.stderr.write(why + "\n");
  process.exit(1);
};
const sha256 = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const text = fs.readFileSync(signatureFile, "utf8").trim();
const signature = /^[A-Za-z0-9+/]+={0,2}$/.test(text) ? Buffer.from(text, "base64") : null;
if (!signature || signature.length !== 64) refuse("The release signature is not a base64 Ed25519 signature.");
const message = Buffer.from(`switch-agent-controller-release-v1\n${version}\n${sha256}\n`, "utf8");
const ids = [];
for (const line of (process.env.TRUSTED_RELEASE_KEYS || "").split("\n")) {
  const [id, key] = line.trim().split(/\s+/);
  if (!id) continue;
  ids.push(id);
  const publicKey = crypto.createPublicKey({ key: Buffer.from(key || "", "base64"), format: "der", type: "spki" });
  if (publicKey.asymmetricKeyType !== "ed25519") refuse(`Trusted release key ${id} is not an Ed25519 key.`);
  if (crypto.verify(null, message, publicKey, signature)) {
    process.stdout.write(id);
    process.exit(0);
  }
}
if (ids.length === 0) refuse("This installer trusts no release signing key.");
refuse(`The release signature does not verify switch-agent-controller ${version} with SHA-256 ${sha256} against any trusted release key (${ids.join(", ")}).`);
'
# END VERIFY RELEASE

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
[ -n "$(printf '%s' "$TRUSTED_RELEASE_KEYS" | tr -d '[:space:]')" ] ||
  fail "This installer trusts no release signing key yet, so it installs no release: it could not tell a signed release from any other package."

if [ -n "$VERSION" ]; then
  case "$VERSION" in
    *[!0-9.]* | "") fail "--version must be x.y.z." ;;
  esac
  URL="https://github.com/$REPO/releases/download/$TAG_PREFIX$VERSION/switch-agent-controller-$VERSION.tgz"
else
  # The repository also releases Switch and Switch Console, and a controller
  # prerelease for every merge, so the newest page of releases need not hold a
  # single published controller release. The controller's tags are listed
  # whole instead: take the highest x.y.z tag whose release is published, is
  # not a prerelease, and carries its package and the package's signature.
  # A release without a signature is never one this installer can install.
  VERSIONS="$(curl -fsSL -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$REPO/git/matching-refs/tags/$TAG_PREFIX" |
    TAG_PREFIX="$TAG_PREFIX" node -e '
      let input = "";
      process.stdin.on("data", (chunk) => (input += chunk));
      process.stdin.on("end", () => {
        const prefix = `refs/tags/${process.env.TAG_PREFIX}`;
        const versions = [];
        for (const tag of JSON.parse(input)) {
          if (!tag.ref.startsWith(prefix)) continue;
          const version = tag.ref.slice(prefix.length);
          if (/^\d+\.\d+\.\d+$/.test(version)) versions.push(version.split(".").map(Number));
        }
        versions.sort((x, y) => y[0] - x[0] || y[1] - x[1] || y[2] - x[2]);
        process.stdout.write(versions.map((v) => v.join(".")).join("\n"));
      });
    ')" || fail "Could not list the controller tags of $REPO."
  [ -n "$VERSIONS" ] || fail "$REPO has no switch-agent-controller release yet."
  RELEASE="$(mktemp)"
  URL=""
  for CANDIDATE in $VERSIONS; do
    STATUS="$(curl -sSL -o "$RELEASE" -w '%{http_code}' -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$REPO/releases/tags/$TAG_PREFIX$CANDIDATE")" ||
      { rm -f "$RELEASE"; fail "Could not read the release $TAG_PREFIX$CANDIDATE of $REPO."; }
    case "$STATUS" in
      200) ;;
      404) continue ;;
      *) rm -f "$RELEASE"; fail "GitHub answered HTTP $STATUS for the release $TAG_PREFIX$CANDIDATE of $REPO." ;;
    esac
    URL="$(VERSION="$CANDIDATE" node -e '
      const release = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
      const name = `switch-agent-controller-${process.env.VERSION}.tgz`;
      const names = new Set((release.assets || []).map((a) => a.name));
      const asset = (release.assets || []).find((a) => a.name === name);
      if (!release.draft && !release.prerelease && asset && names.has(`${name}.sig`))
        process.stdout.write(asset.browser_download_url);
    ' "$RELEASE")" || { rm -f "$RELEASE"; fail "Could not read the release $TAG_PREFIX$CANDIDATE of $REPO."; }
    if [ -n "$URL" ]; then
      VERSION="$CANDIDATE"
      break
    fi
  done
  rm -f "$RELEASE"
  [ -n "$URL" ] || fail "$REPO has no published, signed switch-agent-controller release yet. Releases made before signing began carry no signature, and this installer installs only signed releases."
fi
case "$URL" in
  https://*) ;;
  *) fail "The release package must be downloaded over https, not from $URL." ;;
esac

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
PACKAGE="$WORK/switch-agent-controller-$VERSION.tgz"
echo "Downloading $URL"
curl -fsSL -o "$PACKAGE" "$URL" || fail "Could not download $URL."
curl -fsSL -o "$PACKAGE.sig" "$URL.sig" ||
  fail "Could not download $URL.sig: the release has no signature, and only signed releases are installed."
KEY_ID="$(TRUSTED_RELEASE_KEYS="$TRUSTED_RELEASE_KEYS" node -e "$VERIFY_RELEASE_JS" "$PACKAGE" "$PACKAGE.sig" "$VERSION")" ||
  fail "$URL is not a release signed with a trusted key; nothing was installed."
echo "The package is signed with trusted release key $KEY_ID."

PREFIX="$(npm config get prefix)"
if [ ! -w "$PREFIX" ] && [ ! -w "$PREFIX/lib/node_modules" ]; then
  echo "npm installs global packages into $PREFIX, which this user cannot write; installing into $HOME/.local instead."
  PREFIX="$HOME/.local"
  mkdir -p "$PREFIX"
fi

echo "Installing switch-agent-controller $VERSION"
npm install --global --ignore-scripts --prefix "$PREFIX" "$PACKAGE"
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
  echo "Installed $("$BIN" --version). Next, with a code from the Devices page in Switch:"
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
