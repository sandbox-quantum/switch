#!/usr/bin/env python3
"""VULNMGMT/Jira ticketing for security PRs opened by Renovate and by
``tf_provider_scan.py``.

Renovate (and our Terraform-provider scanner) open the PRs; this driver adds the
Jira layer that mirrors ``socket-autofix``: for each freshly-opened ``renovate/*`` PR
it searches the VULNMGMT project for an existing ticket (path-scoped so a shared CVE
doesn't attach every project's ticket to one PR), links it or creates one, **routes
the created ticket to AISIM** by setting the Business Unit field
(``customfield_12236`` = "AISIM - AI & Simulation", which fires the VULNMGMT
automation that assigns the ``dept-ai_sim`` team), adds a PR web-link, and stamps a
tracking section + a ``<!-- renovate-jira-close: KEY -->`` marker into the PR body.
On merge the shared close-on-merge workflow transitions that ticket to Done.

Two modes:
  * ``--reconcile`` — the pull_request:opened path. Reads PR metadata (url, title,
    head ref, current body, changed files) and writes an updated body to
    ``--body-out`` for the workflow to apply with ``gh pr edit``. Idempotent: if the
    body already carries the close marker, nothing is done.
  * ``--close-jira KEYS`` — transition the given issues to Done (close-on-merge).

Stdlib-only and best-effort — a Jira outage logs and exits 0 so it never blocks a PR.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Optional

import jira_client

JIRA_CLOSE_MARKER = "renovate-jira-close"

# Labels that scope the standing tickets opened by --report (Trivy container/IaC
# scans). Kept distinct per engine so dedup/close only ever touch our own tickets.
_REPORT_ENGINE_LABELS = {
    "container": "container image",
    "iac": "Terraform misconfiguration",
}
_REPORT_BASE_LABEL = "renovate-security"

# Registry short-name / manager -> a human label for the ticket summary.
_ECO_LABELS = {
    "docker": "container image",
    "github-actions": "GitHub Actions",
    "circleci": "CircleCI orb",
    "terraform-provider": "Terraform provider",
    "renovate": "dependency",
}


def _ecosystem(branch: str, files: list[str]) -> str:
    """Best-effort ecosystem label from the branch name / changed files."""
    if branch.startswith("renovate/tf-provider-"):
        return "terraform-provider"
    lowered = [f.lower() for f in files]
    if any(
        "dockerfile" in f or "docker-compose" in f or f.endswith(".dockerfile")
        for f in lowered
    ):
        return "docker"
    if any(
        f.startswith(".github/workflows/") or f.startswith(".github/actions/")
        for f in lowered
    ):
        return "github-actions"
    if any(f.startswith(".circleci/") for f in lowered):
        return "circleci"
    if any(f.endswith(".tf") or f.endswith(".terraform.lock.hcl") for f in lowered):
        return "terraform-provider"
    return "renovate"


def _project_dir(files: list[str]) -> str:
    """Deepest directory common to all changed files — the 'project path' used to
    scope Jira dedup (Renovate groups one PR per dir, so files share a prefix)."""
    dirs = [str(Path(f).parent) for f in files if f]
    if not dirs:
        return ""
    if len(dirs) == 1:
        return dirs[0]
    parts = [d.split("/") for d in dirs]
    common: list[str] = []
    for seg in zip(*parts, strict=False):
        if len(set(seg)) == 1:
            common.append(seg[0])
        else:
            break
    return "/".join(common)


def _read_files_arg(files_arg: str) -> list[str]:
    """--files may be a path to a newline-list (from `gh pr diff --name-only`) or a
    comma-separated inline list."""
    if not files_arg:
        return []
    p = Path(files_arg)
    if p.exists():
        return [ln.strip() for ln in p.read_text().splitlines() if ln.strip()]
    return [f.strip() for f in files_arg.split(",") if f.strip()]


def _tracking_section(
    created: Optional[jira_client.JiraIssue],
    linked: list[jira_client.JiraIssue],
    assigned: bool,
) -> str:
    if linked:
        lines = "\n".join(
            f"- Linked existing: [{i.key}]({i.url}) — {i.summary} ({i.status})"
            for i in linked
        )
    elif created:
        lines = (
            f"- No open VULNMGMT ticket found; created [{created.key}]({created.url})"
            + (
                " and routed to its **Business Unit** for triage."
                if assigned
                else " (Business Unit routing field could not be set — a human may need to route it)."
            )
        )
    else:
        lines = (
            "- No open VULNMGMT ticket found and none created (Jira unavailable or "
            "disabled). Please file/track manually."
        )
    marker = f"\n<!-- {JIRA_CLOSE_MARKER}: {created.key} -->" if created else ""
    return f"\n\n## Vulnerability tracking (VULNMGMT)\n\n{lines}\n{marker}\n"


def _dedup_projects(
    client: jira_client.JiraClient, create_project: str
) -> tuple[str, ...]:
    """Projects to scan when de-duplicating before create: the BU-split project
    (VULNMGMT) plus the legacy full-scope VULN project when visible. Probing
    visibility first avoids a JQL error from an `project in (...)` clause naming a
    project the account can't browse (which would drop dedup to empty and dup tickets).
    Override the legacy project via JIRA_LEGACY_PROJECT ("" disables it)."""
    projects = [create_project]
    legacy = os.environ.get("JIRA_LEGACY_PROJECT")
    legacy = "VULN" if legacy is None else legacy
    if legacy and legacy != create_project and client.project_exists(legacy):
        projects.append(legacy)
    return tuple(projects)


def _route_aisim(
    client: jira_client.JiraClient, issue_id: str, orig_key: str
) -> tuple[bool, str]:
    """Set the Business Unit routing field and return (routed, settled_key).

    Right after creation the VULNMGMT automation CHURNS the issue for ~15s (observed in
    the changelog): a create-time rule clobbers the BU to a default (INFOSEC), assignee
    automation fires, and the issue is MOVED between the VULNMGMT project and the target
    BU project several times — its key changing each time
    (VULNMGMT-498 -> QNV-7012 -> VULNMGMT-499 -> QNV-7013). During every move the issue
    transiently 404s by BOTH key and id. So we:

      1. set the BU field, re-asserting through the default-BU clobber and the mid-move
         404s (each successful re-assert is what ultimately makes our value stick);
      2. wait for the churn to settle — poll until the key is readable and unchanged
         across two consecutive polls;
      3. read the settled BU to confirm routing.

    Every call keys off the STABLE numeric id (the key is a moving target). `routed` is
    best-effort: a read can still land mid-move, so callers must not treat False as
    'definitely unrouted'. Tunable via JIRA_AISIM_VERIFY_ATTEMPTS / _VERIFY_SLEEP
    (tests pass sleep 0)."""
    field_id = os.environ.get("JIRA_AISIM_FIELD_ID") or "customfield_12236"
    field_value = os.environ.get("JIRA_AISIM_FIELD_VALUE") or "AISIM - AI & Simulation"
    attempts = int(os.environ.get("JIRA_AISIM_VERIFY_ATTEMPTS") or "4")
    sleep_s = float(os.environ.get("JIRA_AISIM_VERIFY_SLEEP") or "10")
    routed = False  # verified by a read-back (only possible while still in VULNMGMT)
    set_ok = False  # a set_field PUT was accepted (the honest routing signal from CI)
    if field_id and field_value:
        for _ in range(max(1, attempts)):
            if client.set_field(issue_id, field_id, field_value):
                set_ok = True
            time.sleep(sleep_s)  # let the create-time default automation fire first
            if client.field_value(issue_id, field_id) == field_value:
                routed = True  # survived a cycle
                break

    # Settle: wait for the move churn to stop so the key/reads are reliable. NOTE: the
    # sbt-machine account has no browse permission in the destination BU project, so
    # once the automation moves the issue out of VULNMGMT these reads 404 permanently;
    # this loop still resolves the final key WHEN the account is granted BU-project
    # access (the proper fix), and otherwise falls back to the original key.
    settled_key = client.resolve_key(issue_id) or orig_key
    last = settled_key
    for _ in range(max(1, attempts)):
        time.sleep(sleep_s)
        k = client.resolve_key(issue_id)
        if k:
            settled_key = k
            if k == last:  # unchanged across two consecutive polls -> settled
                break
            last = k
    # Final confirm on the settled issue (impossible if the account can't browse the
    # destination project). Fall back to the write-succeeded signal: routing is driven
    # by the BU field we set, which the org automation then acts on.
    if field_id and not routed:
        routed = client.field_value(issue_id, field_id) == field_value
    routed = routed or set_ok

    account = os.environ.get("JIRA_AISIM_ACCOUNT_ID")
    user = os.environ.get("JIRA_AISIM_USER")
    if account:
        client.set_assignee(issue_id, account_id=account)
    elif user:
        aid = client.find_account_id(user)
        if not (aid and client.set_assignee(issue_id, account_id=aid)):
            client.set_assignee(issue_id, name=user)
    return routed, settled_key


def reconcile(args) -> int:
    body = ""
    if args.body_file and Path(args.body_file).exists():
        body = Path(args.body_file).read_text()
    if f"{JIRA_CLOSE_MARKER}:" in body:
        print("PR already carries a renovate-jira-close marker; nothing to do.")
        return 0

    files = _read_files_arg(args.files)
    project_dir = _project_dir(files)
    eco = _ecosystem(args.branch, files)
    eco_label = _ECO_LABELS.get(eco, "dependency")
    repo_name = args.repo.split("/")[-1] if args.repo else ""

    client = jira_client.JiraClient.from_env()
    if client is None:
        print("  ! Jira creds not set; skipping ticket create/link.")
        return 0

    create_project = os.environ.get("JIRA_VULN_PROJECT") or jira_client.CREATE_PROJECT
    if not client.project_exists(create_project):
        print(f"  ! VULNMGMT project {create_project} not visible; skipping.")
        return 0

    # Path-scoped dedup: link a pre-existing open ticket for this eco+path, else create.
    # Scan BOTH the new BU-split project (VULNMGMT) and the legacy full-scope VULN
    # project so we link an existing ticket instead of opening a duplicate.
    terms = [t for t in [eco_label, Path(project_dir).name] if t]
    jql = jira_client.build_search_jql(
        terms, repo=repo_name, projects=_dedup_projects(client, create_project),
        path=project_dir,
    )
    linked = client.search(jql) if project_dir else []

    created: Optional[jira_client.JiraIssue] = None
    assigned = False
    if not linked and not args.no_create:
        issue_type = os.environ.get("JIRA_ISSUE_TYPE") or ""
        if not issue_type:
            avail = client.issue_types(create_project)
            for pref in ("Task", "Bug", "Vulnerability", "Security", "Story"):
                if pref in avail:
                    issue_type = pref
                    break
            else:
                issue_type = avail[0] if avail else "Task"
        summary = (
            f"[{repo_name}] {eco_label} security update under {project_dir or '(repo)'}"
        )
        desc = (
            f"Automated by renovate-security. A {eco_label} security update was opened "
            f"on branch {args.branch}.\n\nPR: {args.pr_url}\nProject path: "
            f"{project_dir or '(repo root)'}\nTitle: {args.pr_title}"
        )
        aisim_label = os.environ.get("JIRA_AISIM_LABEL") or "aisim"
        created = client.create(
            summary,
            desc,
            labels=["renovate-security", repo_name, aisim_label],
            project=create_project,
            issue_type=issue_type,
            epic_key=os.environ.get("JIRA_VULN_EPIC") or None,
        )
        if created:
            # Route/verify/comment via the STABLE id: setting the BU fires automation
            # that moves the issue to the BU project, changing its key mid-flight.
            ref = created.id or created.key
            assigned, settled_key = _route_aisim(client, ref, created.key)
            # Stamp the settled post-move key so the PR body + close marker point at the
            # real ticket (e.g. QNV-7011), not the now-404 VULNMGMT-xxx key.
            if settled_key and settled_key != created.key:
                created.key = settled_key
                created.url = f"{client.base}/browse/{settled_key}"
            client.add_comment(
                ref,
                "renovate-security — VULNMGMT routing\n\n"
                + (
                    "Business Unit set; VULNMGMT automation routes this to the owning "
                    "team for triage."
                    if assigned
                    else "Could not set the Business Unit field — a human may "
                    "need to route this ticket."
                )
                + f"\n\nContext — repo: {repo_name}; path: {project_dir}; PR: {args.pr_url}",
            )
            print(
                f"  jira {created.key}: created; BU routing "
                f"{'set' if assigned else 'not set'}"
            )

    # PR web-link on every ticket we touched (stable id for the created one).
    link_refs = [i.key for i in linked] + (
        [created.id or created.key] if created else []
    )
    for ref in link_refs:
        client.add_remote_link(ref, args.pr_url, f"{args.pr_title}: {args.pr_url}")

    display_keys = [i.key for i in linked] + ([created.key] if created else [])
    if not display_keys:
        print("  no Jira ticket linked or created.")
        return 0

    new_body = body.rstrip() + _tracking_section(created, linked, assigned)
    if args.body_out:
        Path(args.body_out).write_text(new_body)
        print(
            f"  wrote updated PR body -> {args.body_out} (keys: {','.join(display_keys)})"
        )
    return 0


def _report_jql(
    projects: tuple[str, ...], engine_label: str, repo: str, path: str
) -> str:
    """Open standing tickets for one (engine, repo, path), scoped by our own labels so
    close/refresh never touches unrelated issues. Scans VULNMGMT + legacy VULN."""

    def q(t: str) -> str:
        return '"' + t.replace("\\", "\\\\").replace('"', '\\"') + '"'

    jql = (
        f"project in ({', '.join(projects)}) AND statusCategory != Done "
        f"AND labels = {q(_REPORT_BASE_LABEL)} AND text ~ {q(engine_label)}"
    )
    if repo:
        jql += f" AND text ~ {q(repo)}"
    if path:
        jql += f" AND text ~ {q(path)}"
    return jql + " ORDER BY updated DESC"


def report(args) -> int:
    """Standing-ticket reconciliation for the Trivy scanners (no PR involved).

    For each report group produced by ``trivy_scan.py``: if it has findings and no open
    ticket exists, create one and route it to AISIM; if one already exists, refresh it
    with the current counts and a link to the scan run; if the group is now clean
    (``findings_count == 0``) and a ticket is open, close it. Best-effort throughout."""
    data = json.loads(Path(args.report_groups).read_text())
    engine = data.get("engine", "container")
    groups = data.get("groups", [])
    engine_label = _REPORT_ENGINE_LABELS.get(engine, "security")
    repo_name = args.repo.split("/")[-1] if args.repo else ""

    client = jira_client.JiraClient.from_env()
    if client is None:
        print("  ! Jira creds not set; skipping report ticketing.")
        return 0
    project = os.environ.get("JIRA_VULN_PROJECT") or jira_client.CREATE_PROJECT
    if not client.project_exists(project):
        print(f"  ! VULNMGMT project {project} not visible; skipping.")
        return 0

    issue_type = os.environ.get("JIRA_ISSUE_TYPE") or ""
    if not issue_type:
        avail = client.issue_types(project)
        for pref in ("Task", "Bug", "Vulnerability", "Security", "Story"):
            if pref in avail:
                issue_type = pref
                break
        else:
            issue_type = avail[0] if avail else "Task"
    aisim_label = os.environ.get("JIRA_AISIM_LABEL") or "aisim"

    created = refreshed = closed = 0
    for g in groups:
        directory = g.get("key", "")
        count = int(g.get("findings_count", 0))
        existing = client.search(
            _report_jql(
                _dedup_projects(client, project), engine_label, repo_name, directory
            )
        )
        if count > 0:
            if existing:
                key = existing[0].key
                client.add_comment(
                    key,
                    f"renovate-security — {engine_label} scan refresh\n\n"
                    f"{count} finding(s) still present under {directory}: "
                    f"{g.get('severity_line', '')}.\n\nScan run: {args.run_url}",
                )
                if args.run_url:
                    client.add_remote_link(
                        key, args.run_url, f"Latest scan: {directory}"
                    )
                refreshed += 1
                print(f"  jira {key}: refreshed ({directory})")
                continue
            summary = f"[{repo_name}] {g.get('title', 'security findings')}"
            desc = (
                f"Automated by renovate-security ({engine_label} scan).\n\n"
                f"{_strip_md(g.get('body', ''))}\n\nRepo: {repo_name}\nPath: "
                f"{directory}\nScan run: {args.run_url}"
            )
            issue = client.create(
                summary,
                desc,
                labels=[_REPORT_BASE_LABEL, repo_name, engine, aisim_label],
                project=project,
                issue_type=issue_type,
                epic_key=os.environ.get("JIRA_VULN_EPIC") or None,
            )
            if not issue:
                print(f"  ! could not create ticket for {directory}")
                continue
            ref = issue.id or issue.key
            assigned, settled_key = _route_aisim(client, ref, issue.key)
            if settled_key and settled_key != issue.key:
                issue.key = settled_key
                issue.url = f"{client.base}/browse/{settled_key}"
            client.add_comment(
                ref,
                "renovate-security — VULNMGMT routing\n\n"
                + (
                    "Business Unit set; routed to the owning team."
                    if assigned
                    else "Could not set the Business Unit field — route manually."
                ),
            )
            if args.run_url:
                client.add_remote_link(ref, args.run_url, f"Scan: {directory}")
            created += 1
            routed = "set" if assigned else "not set"
            print(f"  jira {issue.key}: created ({directory}); BU {routed}")
        elif existing:
            for iss in existing:
                if client.close_issue(
                    iss.key,
                    comment=(
                        f"Closed by renovate-security: no {engine_label} findings "
                        f"remain under {directory} (scan run {args.run_url})."
                    ),
                ):
                    closed += 1
                    print(f"  jira {iss.key}: closed — {directory} now clean")
    print(f"report: {created} created, {refreshed} refreshed, {closed} closed.")
    return 0


def _strip_md(body: str) -> str:
    """Flatten a markdown body to plain text for a Jira ADF description (tables render
    poorly in ADF paragraphs; keep the human-readable lines)."""
    keep = []
    for ln in body.splitlines():
        s = ln.strip()
        if not s or set(s) <= set("|-") or s.startswith("|--"):
            continue
        keep.append(s.replace("|", " ").replace("`", ""))
    return "\n".join(keep)


def close_jira(keys_arg: str) -> int:
    client = jira_client.JiraClient.from_env()
    if client is None:
        raise SystemExit(
            "--close-jira needs SBT_MACHINE_USER_EMAIL / SBT_MACHINE_USER_JIRA_TOKEN"
        )
    keys = [k.strip() for k in keys_arg.split(",") if k.strip()]
    failed = 0
    for key in keys:
        ok = client.close_issue(
            key, comment="Closed by renovate-security (fix PR merged)."
        )
        print(f"  jira close {key}: {'ok' if ok else 'FAILED'}")
        failed += 0 if ok else 1
    if failed:
        # Best-effort: a merge must never be blocked by Jira. The marker key is the
        # VULNMGMT key at creation; if the account can't reach the (moved) BU-project
        # issue it 404s here and the owning team closes it on triage. Exit 0.
        print(
            f"::warning::{failed} ticket(s) could not be auto-closed "
            "(likely moved to a BU project the CI account can't access); "
            "the owning team will close on triage."
        )
    return 0


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--reconcile", action="store_true", help="create/link a ticket for a PR"
    )
    ap.add_argument(
        "--report",
        action="store_true",
        help="standing-ticket reconcile from a trivy_scan.py report-groups JSON",
    )
    ap.add_argument(
        "--report-groups", default="", help="path to the report-groups JSON (--report)"
    )
    ap.add_argument("--run-url", default="", help="scan run URL to link on tickets")
    ap.add_argument(
        "--close-jira", default="", help="ops: comma-separated keys -> Done"
    )
    ap.add_argument("--pr-url", default="")
    ap.add_argument("--pr-title", default="Security update")
    ap.add_argument("--branch", default="", help="PR head ref")
    ap.add_argument("--body-file", default="", help="path to the current PR body")
    ap.add_argument("--body-out", default="", help="write the updated PR body here")
    ap.add_argument("--files", default="", help="changed files (path to list, or CSV)")
    ap.add_argument("--repo", default="", help="owner/repo")
    ap.add_argument("--no-create", action="store_true", help="link only; never create")
    args = ap.parse_args(argv)

    if args.close_jira:
        return close_jira(args.close_jira)
    if args.report:
        if not args.report_groups:
            raise SystemExit("--report requires --report-groups")
        return report(args)
    if args.reconcile:
        if not args.pr_url:
            raise SystemExit("--reconcile requires --pr-url")
        return reconcile(args)
    ap.error("nothing to do: pass --reconcile, --report or --close-jira")
    return 2


if __name__ == "__main__":
    sys.exit(main())
