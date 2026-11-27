#!/usr/bin/env python3
"""Run a Codemender security scan, fix findings, push a branch, and notify a Switch room.

Intended for scheduled invocation by a Switch Room task. The script is
idempotent: if a Codemender session is already running it exits cleanly.

    python scripts/codemender_scan.py --room-id <ROOM_UUID>

Switch credentials are read from, in order:
  1. Environment variables: SWITCH_API_ENDPOINT, SWITCH_API_TOKEN, SWITCH_AGENT_ID
  2. A credentials JSON file at --credentials <path>
  3. Auto-discovered from .switch/agents/*.json in the repo root (Console)
     or ~/.local/state/switch/agent-controller/*/agents/*/credentials.json
     (headless agent controller)

Set by this script:
  GOOGLE_APPLICATION_CREDENTIALS  path to the service-account key
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

REPO_DIR = "/data/code/switch"
SA_KEY_PATH = os.path.expanduser(
    "~/.config/gcloud/switch-security-agent-service-account.json"
)
CM_PROJECT_FILE = os.path.join(REPO_DIR, ".cm_project")
CM_PROJECT_CONTENT = json.dumps(
    {
        "project_id": "ca4ae815-6447-416f-a623-b87404472120",
        "created_at": "2026-11-27T13:55:07Z",
        "name": "Switch Code Audit",
    },
    indent=2,
) + "\n"

SEVERITY_ORDER = ["CRITICAL", "HIGH", "MEDIUM", "LOW"]


@dataclass
class ScanStats:
    total: int = 0
    fixed: int = 0
    failed: int = 0
    by_severity: dict[str, int] = field(default_factory=dict)
    failed_findings: list[dict[str, str]] = field(default_factory=list)


def ensure_cm_project() -> None:
    """Write the .cm_project file to the repo root, overwriting any stale copy."""
    with open(CM_PROJECT_FILE, "w") as f:
        f.write(CM_PROJECT_CONTENT)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--room-id", required=True, help="Switch room UUID")
    parser.add_argument(
        "--credentials",
        help="Path to a Switch credentials JSON file (auto-discovered if omitted)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what would happen without executing",
    )
    return parser.parse_args(argv)


def _read_credentials_file(path: Path) -> dict[str, str]:
    data = json.loads(path.read_text())
    return data.get("env", {})


def _find_credentials_in(directory: Path) -> Path | None:
    if not directory.is_dir():
        return None
    for candidate in directory.glob("*.json"):
        if candidate.name == ".gitignore":
            continue
        try:
            data = json.loads(candidate.read_text())
            if "env" in data and "SWITCH_API_TOKEN" in data["env"]:
                return candidate
        except (json.JSONDecodeError, OSError):
            continue
    return None


def _discover_credentials_file() -> Path | None:
    # Console writes to <repo>/.switch/agents/<slug>.json
    found = _find_credentials_in(Path(REPO_DIR) / ".switch" / "agents")
    if found:
        return found

    # Agent controller writes to
    # ~/.local/state/switch/agent-controller/*/agents/<id>/credentials.json
    controller_root = Path.home() / ".local" / "state" / "switch" / "agent-controller"
    if controller_root.is_dir():
        for cred in controller_root.glob("*/agents/*/credentials.json"):
            try:
                data = json.loads(cred.read_text())
                if "env" in data and "SWITCH_API_TOKEN" in data["env"]:
                    return cred
            except (json.JSONDecodeError, OSError):
                continue

    return None


def load_switch_env(credentials_path: str | None) -> dict[str, str]:
    required = ["SWITCH_API_ENDPOINT", "SWITCH_API_TOKEN", "SWITCH_AGENT_ID"]

    env: dict[str, str] = {}
    for var in required:
        value = os.environ.get(var)
        if value:
            env[var] = value
    if len(env) == len(required):
        return env

    cred_path: Path | None = None
    if credentials_path:
        cred_path = Path(credentials_path)
    else:
        cred_path = _discover_credentials_file()

    if cred_path:
        file_env = _read_credentials_file(cred_path)
        for var in required:
            if var not in env and var in file_env:
                env[var] = file_env[var]

    missing = [var for var in required if var not in env]
    if missing:
        hint = (
            "Set them in the environment, pass --credentials <path>, "
            "or place a credentials file in .switch/agents/"
        )
        raise RuntimeError(
            f"Missing Switch credentials: {', '.join(missing)}. {hint}"
        )
    return env


def post_to_room(env: dict[str, str], room_id: str, content: str) -> None:
    url = (
        f"{env['SWITCH_API_ENDPOINT']}/agents/{env['SWITCH_AGENT_ID']}/message"
    )
    payload = json.dumps({"room_id": room_id, "content": content}).encode()
    req = urllib.request.Request(
        url,
        data=payload,
        headers={
            "Authorization": f"Bearer {env['SWITCH_API_TOKEN']}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as resp:
            resp.read()
    except urllib.error.HTTPError as exc:
        print(f"WARNING: failed to post to room: {exc.code} {exc.read().decode()}", file=sys.stderr)


def run_cmd(
    cmd: list[str],
    *,
    capture: bool = True,
    check: bool = True,
    cwd: str | None = None,
    env_override: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    if env_override:
        env.update(env_override)
    return subprocess.run(
        cmd, capture_output=capture, text=True, check=check, cwd=cwd, env=env
    )


ACTIVE_STATUSES = {"queued", "running", "pending", "waiting_for_tool", "in_progress"}


def check_running_sessions(dry_run: bool) -> bool:
    if dry_run:
        print("[dry-run] Would check for running Codemender sessions")
        return False
    result = run_cmd(["cm", "session", "list"], check=False)
    if result.returncode != 0:
        print(f"WARNING: cm session list failed: {result.stderr}", file=sys.stderr)
        return False
    for line in result.stdout.splitlines():
        lower = line.lower()
        if any(status in lower for status in ACTIVE_STATUSES):
            return True
    return False


def pull_latest(dry_run: bool) -> None:
    if dry_run:
        print("[dry-run] Would pull latest code from origin/main")
        return
    run_cmd(["git", "fetch", "origin", "main"], cwd=REPO_DIR)
    run_cmd(["git", "checkout", "main"], cwd=REPO_DIR)
    run_cmd(["git", "reset", "--hard", "origin/main"], cwd=REPO_DIR)


def run_scan(dry_run: bool) -> str:
    """Run cm find --deep and return raw output."""
    if dry_run:
        print("[dry-run] Would run: cm --sandbox=false --format json --model gemini-3.8-flash-cyber find --yes .")
        return "{}"
    cm_env = {"GOOGLE_APPLICATION_CREDENTIALS": SA_KEY_PATH}
    result = run_cmd(
        [
            "cm",
            "--sandbox=false",
            "--format", "json",
            "--model", "gemini-3.8-flash-cyber",
            "find",
            "--yes",
            ".",
        ],
        check=False,
        cwd=REPO_DIR,
        env_override=cm_env,
    )
    output = result.stdout + result.stderr
    if result.returncode != 0:
        raise RuntimeError(f"cm find failed (exit {result.returncode}):\n{output}")
    return output



def get_findings(dry_run: bool) -> list[dict[str, str]]:
    if dry_run:
        print("[dry-run] Would get findings from project report")
        return []
    cm_env = {"GOOGLE_APPLICATION_CREDENTIALS": SA_KEY_PATH}
    result = run_cmd(
        [
            "cm", "report",
            "--format", "json",
            "--status", "OPEN",
            "--sort", "severity",
        ],
        check=False,
        cwd=REPO_DIR,
        env_override=cm_env,
    )
    if result.returncode != 0:
        print(f"WARNING: cm report failed: {result.stderr}", file=sys.stderr)
        return []
    try:
        data = json.loads(result.stdout)
        if isinstance(data, list):
            return data
        if isinstance(data, dict) and "findings" in data:
            return data["findings"]
    except (json.JSONDecodeError, TypeError):
        pass
    return []


def severity_key(finding: dict[str, str]) -> int:
    sev = finding.get("severity", "LOW").upper()
    if sev in SEVERITY_ORDER:
        return SEVERITY_ORDER.index(sev)
    return len(SEVERITY_ORDER)


def create_branch(dry_run: bool) -> str:
    now = datetime.now(timezone.utc)
    branch = f"security/codemender-{now.strftime('%Y-%m-%d-%H%M%S')}"
    if dry_run:
        print(f"[dry-run] Would create branch: {branch}")
        return branch
    run_cmd(["git", "checkout", "-b", branch], cwd=REPO_DIR)
    return branch


def fix_findings(findings: list[dict[str, str]], dry_run: bool) -> ScanStats:
    stats = ScanStats(total=len(findings))
    sorted_findings = sorted(findings, key=severity_key)

    for finding in sorted_findings:
        finding_id = finding.get("id", finding.get("finding_id", "unknown"))
        severity = finding.get("severity", "UNKNOWN").upper()
        title = finding.get("title", finding.get("summary", "unknown finding"))
        scope = finding.get("file", finding.get("location", "security"))
        scope = Path(scope).stem if scope and scope != "security" else "security"

        stats.by_severity[severity] = stats.by_severity.get(severity, 0) + 1

        if dry_run:
            print(f"[dry-run] Would fix finding {finding_id} ({severity}): {title}")
            stats.fixed += 1
            continue

        cm_env = {"GOOGLE_APPLICATION_CREDENTIALS": SA_KEY_PATH}
        result = run_cmd(
            [
                "cm",
                "--sandbox=false",
                "--model", "gemini-3.8-flash-cyber",
                "fix",
                "--yes",
                finding_id,
            ],
            check=False,
            cwd=REPO_DIR,
            env_override=cm_env,
        )

        if result.returncode != 0:
            stats.failed += 1
            stats.failed_findings.append({
                "id": finding_id,
                "severity": severity,
                "title": title,
                "error": result.stderr[:200],
            })
            print(f"ERROR: failed to fix {finding_id}: {result.stderr[:200]}", file=sys.stderr)
            continue

        run_cmd(["git", "add", "-A"], cwd=REPO_DIR)

        commit_msg = f"fix({scope}): {title}"
        if len(commit_msg) > 72:
            commit_msg = commit_msg[:69] + "..."
        run_cmd(["git", "commit", "-m", commit_msg], cwd=REPO_DIR, check=False)

        stats.fixed += 1
        print(f"Fixed {finding_id} ({severity}): {title}")

    return stats


def push_branch(branch: str, dry_run: bool) -> bool:
    if dry_run:
        print(f"[dry-run] Would push branch {branch}")
        return True
    result = run_cmd(
        ["git", "push", "-u", "origin", branch], cwd=REPO_DIR, check=False
    )
    if result.returncode != 0:
        print(f"ERROR: git push failed: {result.stderr}", file=sys.stderr)
        return False
    return True


def format_scan_notification(
    total: int, severity_counts: dict[str, int]
) -> str:
    parts = []
    for sev in SEVERITY_ORDER:
        count = severity_counts.get(sev, 0)
        if count:
            parts.append(f"{count} {sev.lower()}")
    breakdown = ", ".join(parts) if parts else "0"
    return f"Codemender scan complete — {total} finding(s) found ({breakdown})."


def format_results_notification(stats: ScanStats, branch: str) -> str:
    lines = [
        f"**Codemender fix results:** {stats.fixed}/{stats.total} findings fixed"
        f" ({stats.failed} failed).",
        "",
    ]

    sev_parts = []
    for sev in SEVERITY_ORDER:
        count = stats.by_severity.get(sev, 0)
        if count:
            sev_parts.append(f"{count} {sev.lower()}")
    if sev_parts:
        lines.append(f"Severity breakdown: {', '.join(sev_parts)}")
        lines.append("")

    compare_url = (
        f"https://github.com/sandbox-quantum/switch/compare/main...{branch}?expand=1"
    )
    lines.append(f"[Create PR]({compare_url})")

    if stats.failed_findings:
        lines.append("")
        lines.append("**Failed to fix:**")
        for f in stats.failed_findings:
            lines.append(f"- `{f['id']}` ({f['severity']}): {f['title']}")

    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    ensure_cm_project()
    env = load_switch_env(args.credentials)

    os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = SA_KEY_PATH

    # 1. If a scan is still running, exit early.
    if check_running_sessions(args.dry_run):
        msg = "Code audit still running — will check back next invocation."
        print(msg)
        if not args.dry_run:
            post_to_room(env, args.room_id, msg)
        return 0

    # 2. Check for unfixed findings from a completed scan.
    findings = get_findings(args.dry_run)
    total = len(findings)

    if total > 0:
        severity_counts: dict[str, int] = {}
        for f in findings:
            sev = f.get("severity", "UNKNOWN").upper()
            severity_counts[sev] = severity_counts.get(sev, 0) + 1

        scan_msg = format_scan_notification(total, severity_counts)
        print(scan_msg)
        if not args.dry_run:
            post_to_room(env, args.room_id, scan_msg)

        pull_latest(args.dry_run)
        branch = create_branch(args.dry_run)
        stats = fix_findings(findings, args.dry_run)
        stats.total = total

        if stats.fixed == 0:
            msg = (
                f"Codemender scan found {total} finding(s) but all fixes failed. "
                f"No branch pushed."
            )
            print(msg)
            if not args.dry_run:
                post_to_room(env, args.room_id, msg)
            return 1

        pushed = push_branch(branch, args.dry_run)
        if not pushed and not args.dry_run:
            msg = f"Codemender: fixed {stats.fixed}/{total} findings but push failed."
            post_to_room(env, args.room_id, msg)
            return 1

        results_msg = format_results_notification(stats, branch)
        print(results_msg)
        if not args.dry_run:
            post_to_room(env, args.room_id, results_msg)
        return 0

    # 3. No active sessions and no open findings — start a new scan.
    pull_latest(args.dry_run)
    run_scan(args.dry_run)
    msg = "Code audit started — results will be picked up on the next invocation."
    print(msg)
    if not args.dry_run:
        post_to_room(env, args.room_id, msg)
    return 0


if __name__ == "__main__":
    sys.exit(main())
