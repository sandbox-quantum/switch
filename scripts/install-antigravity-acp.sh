#!/usr/bin/env bash
# Install Google's Antigravity ACP runtime with the Switch Console launcher.
# This installs antigravity-acp; it does not replace Google's agy CLI.
set -euo pipefail

for tool in node curl unzip; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'Missing prerequisite: %s. Install it and run this script again.\n' "$tool" >&2
    exit 1
  fi
done
node -e 'if (Number(process.versions.node.split(".")[0]) < 20) { console.error("Node.js 20 or newer is required."); process.exit(1); }'

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) platform=macos; target=darwin-arm64 ;;
  Linux-x86_64) platform=linux; target=linux-x86_64 ;;
  Linux-aarch64|Linux-arm64) platform=linux; target=linux-arm64 ;;
  *) printf 'Supported hosts: Apple Silicon macOS, Linux x64 and Linux ARM64.\n' >&2; exit 1 ;;
esac

version=1.1.1
base="$HOME/.local/share/switch/antigravity-acp"
root="$base/$version"
bin="$HOME/.local/bin"
mkdir -p "$base" "$bin"
stage=$(mktemp -d "$base/.install-XXXXXX")
launcher_tmp=$(mktemp "$bin/.antigravity-acp-XXXXXX")
cleanup() { rm -rf "$stage"; rm -f "$launcher_tmp"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ ! -d "$root" ]; then
  printf 'Downloading Google Antigravity ACP %s for %s…\n' "$version" "$target"
  curl -fL --retry 2 --connect-timeout 20 \
    "https://dl.google.com/agy-extensions/releases/$platform/agy-acp-server-agy_acp_server_$version-$target.zip" \
    -o "$stage/runtime.zip"
  unzip -q "$stage/runtime.zip" -d "$stage"
  rm "$stage/runtime.zip"
  for file in agy_acp_server.par localharness_external; do
    if [ ! -f "$stage/$file" ]; then
      printf 'Incomplete ACP download: missing %s.\n' "$file" >&2
      exit 1
    fi
    chmod 755 "$stage/$file"
  done
  mv "$stage" "$root"
fi
for file in agy_acp_server.par localharness_external; do
  if [ ! -x "$root/$file" ]; then
    printf 'Existing ACP installation is incomplete: %s\n' "$root/$file" >&2
    exit 1
  fi
done

cat > "$launcher_tmp" <<'SWITCH_ACP_LAUNCHER'
#!/usr/bin/env node
const { spawn } = require('node:child_process');
const { mkdirSync, writeFileSync, mkdtempSync, rmSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');
const { createInterface } = require('node:readline');
const version = '1.1.1';
if (process.argv[2] === '--version') { console.log(version); process.exit(0); }
const login = process.argv[2] === '--login';
if (process.argv.length > (login ? 3 : 2)) throw new Error('Use antigravity-acp, --version, or --login.');
const root = join(homedir(), '.local', 'share', 'switch', 'antigravity-acp', version);
const profile = process.env.GEMINI_HOME || join(homedir(), '.local', 'state', 'switch', 'antigravity-acp');
mkdirSync(profile, { recursive: true, mode: 0o700 });
try { writeFileSync(join(profile, 'settings.json'), JSON.stringify({ auth: { type: 'oauth-personal' } }), { flag: 'wx', mode: 0o600 }); }
catch (error) { if (error.code !== 'EEXIST') throw error; }
const temp = mkdtempSync(join(profile, 'runtime-'));
const child = spawn(join(root, 'agy_acp_server.par'), process.platform === 'linux' ? ['--uid='] : [], {
  stdio: login ? ['pipe', 'pipe', 'inherit'] : 'inherit',
  env: { ...process.env, GEMINI_HOME: profile, AGY_ACP_FORCE_FILE_STORAGE: '1', PYTHONUNBUFFERED: '1', TMPDIR: temp,
    ANTIGRAVITY_HARNESS_PATH: join(root, 'localharness_external') },
});
let force;
const stop = () => { child.kill('SIGTERM'); force = setTimeout(() => child.kill('SIGKILL'), 2000); force.unref(); };
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, stop);
child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
child.on('close', (code) => { clearTimeout(force); if (timeout) clearTimeout(timeout); rmSync(temp, { recursive: true, force: true }); process.exitCode = process.exitCode ?? code ?? 1; });
let timeout;
if (login) {
  timeout = setTimeout(() => { console.error('Antigravity sign-in timed out. Run --login to retry.'); process.exitCode = 1; stop(); }, 180000);
  const send = (id, method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  createInterface({ input: child.stdout }).on('line', (line) => {
    let message;
    try { message = JSON.parse(line); }
    catch { if (line.startsWith('Open the following link to authenticate the ACP server:')) console.log(line); return; }
    if (message.error) { console.error('Antigravity sign-in failed:', message.error.message); process.exitCode = 1; stop(); }
    else if (message.id === 1) send(2, 'authenticate', { methodId: 'oauth-personal' });
    else if (message.id === 2) { console.log('Signed in to Antigravity ACP.'); process.exitCode = 0; stop(); }
  });
  send(1, 'initialize', { protocolVersion: 1, clientInfo: { name: 'switch-console-login', version: '1' }, clientCapabilities: {} });
}
SWITCH_ACP_LAUNCHER
chmod 755 "$launcher_tmp"
mv -f "$launcher_tmp" "$bin/antigravity-acp"
printf '\nInstalled Antigravity ACP %s.\n' "$version"
printf 'Sign in: %s/antigravity-acp --login\n' "$bin"
case ":$PATH:" in
  *":$bin:"*) ;;
  *) printf 'Add %s to your shell PATH to run antigravity-acp by name.\n' "$bin" ;;
esac
