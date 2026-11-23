import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { NativeLayout } from './native-paths';

export const OPERATOR_COMMANDS = [
  'switch-accounts',
  'switch-orgs',
  'switch-promote-org-admin',
  'switch-connector-apps',
  'switch-purge-organization',
] as const;

export function renderPosixMasterWrapper(defaultVersion = ''): string {
  return `#!/usr/bin/env sh
# Switch Console platform operator command runner
set -e

BIN_DIR="$(cd "$(dirname "$0")" && pwd)"
BASE_DIR="$(cd "$BIN_DIR/.." && pwd)"
RUN_DIR="$BASE_DIR/native/run"
ENV_FILE="$RUN_DIR/switch-core.env"
DEPLOYED_FILE="$RUN_DIR/deployed.json"
PID_FILE="$RUN_DIR/switch-core.json"

if [ ! -f "$ENV_FILE" ]; then
  echo "Error: Local Switch server is not running (switch-core.env not found in $RUN_DIR)." >&2
  echo "Start the server from Switch Console first." >&2
  exit 1
fi

VERSION="${defaultVersion}"
if [ -f "$DEPLOYED_FILE" ]; then
  RESOLVED=$(grep -o '"version": *"[^"]*"' "$DEPLOYED_FILE" 2>/dev/null | head -n 1 | cut -d'"' -f4 || true)
  if [ -n "$RESOLVED" ]; then VERSION="$RESOLVED"; fi
fi
if [ -z "$VERSION" ] && [ -f "$PID_FILE" ]; then
  RESOLVED=$(grep -o '"version": *"[^"]*"' "$PID_FILE" 2>/dev/null | head -n 1 | cut -d'"' -f4 || true)
  if [ -n "$RESOLVED" ]; then VERSION="$RESOLVED"; fi
fi

if [ -z "$VERSION" ]; then
  echo "Error: Could not determine active switch-core version from $RUN_DIR." >&2
  exit 1
fi

VENV_BIN="$BASE_DIR/native/switch-core/$VERSION/venv/bin"
CMD_NAME="$1"

if [ -z "$CMD_NAME" ]; then
  echo "Usage: switch-server-exec <command> [args...]" >&2
  echo "Available commands: ${OPERATOR_COMMANDS.join(', ')}" >&2
  exit 1
fi
shift

TARGET="$VENV_BIN/$CMD_NAME"
if [ ! -x "$TARGET" ]; then
  echo "Error: Command '$CMD_NAME' not found in $VENV_BIN." >&2
  exit 1
fi

while IFS='=' read -r key val || [ -n "$key" ]; do
  case "$key" in
    '#'*|'') ;;
    *) export "$key=$val" ;;
  esac
done < "$ENV_FILE"

exec "$TARGET" "$@"
`;
}

export function renderPosixCommandWrapper(command: string): string {
  return `#!/usr/bin/env sh
DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$DIR/switch-server-exec" "${command}" "$@"
`;
}

export function renderWindowsMasterWrapper(defaultVersion = ''): string {
  return `@echo off
setlocal enabledelayedexpansion

set "BIN_DIR=%~dp0"
set "BASE_DIR=%BIN_DIR%.."
set "RUN_DIR=%BASE_DIR%\\native\\run"
set "ENV_FILE=%RUN_DIR%\\switch-core.env"
set "DEPLOYED_FILE=%RUN_DIR%\\deployed.json"
set "PID_FILE=%RUN_DIR%\\switch-core.json"

if not exist "%ENV_FILE%" (
    echo Error: Local Switch server is not running ^(switch-core.env not found in %RUN_DIR%^). >&2
    echo Start the server from Switch Console first. >&2
    exit /b 1
)

set "VERSION=${defaultVersion}"
if exist "%DEPLOYED_FILE%" (
    for /f "tokens=2 delims=:, " %%a in ('findstr /i "\"version\"" "%DEPLOYED_FILE%" 2^>nul') do (
        set "VERSION=%%~a"
    )
)
if "!VERSION!"=="" (
    if exist "%PID_FILE%" (
        for /f "tokens=2 delims=:, " %%a in ('findstr /i "\"version\"" "%PID_FILE%" 2^>nul') do (
            set "VERSION=%%~a"
        )
    )
)

if "!VERSION!"=="" (
    echo Error: Could not determine active switch-core version from %RUN_DIR%. >&2
    exit /b 1
)

set "VENV_SCRIPTS=%BASE_DIR%\\native\\switch-core\\!VERSION!\\venv\\Scripts"
set "CMD_NAME=%~1"

if "%CMD_NAME%"=="" (
    echo Usage: switch-server-exec ^<command^> [args...] >&2
    echo Available commands: ${OPERATOR_COMMANDS.join(', ')} >&2
    exit /b 1
)
shift

for /f "usebackq tokens=1,* delims==" %%i in ("%ENV_FILE%") do (
    set "K=%%i"
    set "V=%%j"
    if not "!K:~0,1!"=="#" (
        set "!K!=!V!"
    )
)

set "TARGET=%VENV_SCRIPTS%\\%CMD_NAME%.exe"
if not exist "%TARGET%" (
    set "TARGET=%VENV_SCRIPTS%\\%CMD_NAME%"
    if not exist "!TARGET!" (
        echo Error: Command '%CMD_NAME%' not found in %VENV_SCRIPTS%. >&2
        exit /b 1
    )
)

"%TARGET%" %*
exit /b %ERRORLEVEL%
`;
}

export function renderWindowsCommandWrapper(command: string): string {
  return `@echo off
"%~dp0switch-server-exec.cmd" ${command} %*
`;
}

export async function writeServerCommandWrappers(layout: NativeLayout, activeVersion?: string): Promise<void> {
  await mkdir(layout.bin, { recursive: true, mode: 0o755 });

  const masterPosix = path.join(layout.bin, 'switch-server-exec');
  await writeFile(masterPosix, renderPosixMasterWrapper(activeVersion), { mode: 0o755 });
  await chmod(masterPosix, 0o755).catch(() => {});

  const masterWin = path.join(layout.bin, 'switch-server-exec.cmd');
  await writeFile(masterWin, renderWindowsMasterWrapper(activeVersion), { mode: 0o755 });

  for (const cmd of OPERATOR_COMMANDS) {
    const posixCmd = path.join(layout.bin, cmd);
    await writeFile(posixCmd, renderPosixCommandWrapper(cmd), { mode: 0o755 });
    await chmod(posixCmd, 0o755).catch(() => {});

    const winCmd = path.join(layout.bin, `${cmd}.cmd`);
    await writeFile(winCmd, renderWindowsCommandWrapper(cmd), { mode: 0o755 });
  }
}

export async function removeServerCommandWrappers(layout: NativeLayout): Promise<void> {
  await rm(layout.bin, { recursive: true, force: true });
}
