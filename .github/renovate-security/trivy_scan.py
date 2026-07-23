#!/usr/bin/env python3
"""Trivy-backed security scanner for the two ecosystems that have **no version-bump
CVE feed** Renovate/OSV can act on directly: **container base images** and **Terraform
misconfiguration**.

Why this exists (see ``README.md`` for the full rationale):

* **Container images** have no "tag -> CVE" feed — a container's vulnerabilities live
  in the OS packages and libraries *inside* the image, so the feed is delivered by
  *scanning the resolved image* against NVD + GHSA + the distro security trackers.
  Renovate stays the sole *updater* (it opens the digest/patch bump PRs); this scanner
  is the *detector*: it scans each Dockerfile's base image and reports fixable CVEs so
  they get a VULNMGMT ticket routed to AISIM, and it gates Renovate's container PRs.
* **Terraform misconfiguration** is a config-risk axis (open security groups,
  unencrypted buckets), not a dependency-version CVE — so it can't drive a version
  bump. ``trivy config`` finds these; we ticket the HIGH/CRITICAL ones.

This module only **detects, groups and reports**. It never edits files or opens bump
PRs (that would race Renovate). Ticketing is done by ``renovate_jira.py --report`` off
the report-group JSON this emits; the workflows also render a job summary from it.

Two modes, one CLI:
  * ``--mode image``  — discover base images from Dockerfiles, ``trivy image`` each.
  * ``--mode config`` — ``trivy config`` over the Terraform tree.

Stdlib-only. Every Trivy invocation is best-effort: a failure for one image/target
logs and yields no findings for it rather than aborting the scan.
"""

from __future__ import annotations

import argparse
import dataclasses
import hashlib
import json
import re
import subprocess  # noqa: S404 - we invoke the trivy CLI with a fixed argv (no shell)
import sys
from pathlib import Path
from typing import Callable, Optional

# Container image refs we never scan: templated (resolved at build time, not a real
# image), the empty "scratch" base, and private registries that need auth (mirrors the
# renovate.json5 skip of the Artifact Registry images). Overridable via --skip-prefix.
_DEFAULT_SKIP_PREFIXES = ("us-central1-docker.pkg.dev/", ".pkg.dev/")
_TF_SUBDIR = "root/infra/terraform"

# Trivy severities we consider; anything below the --min-severity floor is dropped.
_SEV_ORDER = {"critical": 0, "high": 1, "medium": 2, "low": 3, "unknown": 4}
_SEV_ICON = {
    "critical": "🔴",
    "high": "🟠",
    "medium": "🟡",
    "low": "⚪",
    "unknown": "❔",
}

SIGNATURE_MARKER = "renovate-trivy-signature"
ENGINE_IMAGE = "container"
ENGINE_CONFIG = "iac"


# --------------------------------------------------------------------------- #
# Data model
# --------------------------------------------------------------------------- #
@dataclasses.dataclass
class Finding:
    directory: str  # repo-relative dir (Dockerfile's parent, or the .tf's dir)
    target: str  # image ref (image mode) or file path (config mode)
    vuln_id: str  # CVE / GHSA / AVD id
    severity: str  # critical | high | medium | low | unknown (lowercased)
    title: str
    pkg: str = ""  # affected package (image) or resource/type (config)
    installed: str = ""  # installed version (image only)
    fixed: str = ""  # fixed version (image only)
    kind: str = ENGINE_IMAGE  # image | iac

    def to_json(self) -> dict:
        return dataclasses.asdict(self)


def severity_rank(sev: str) -> int:
    return _SEV_ORDER.get((sev or "").lower(), 4)


def severity_badge(sev: str) -> str:
    s = (sev or "unknown").lower()
    return f"{_SEV_ICON.get(s, '❔')} {s.capitalize()}"


def _engine_noun(engine: str) -> str:
    return "container image" if engine == ENGINE_IMAGE else "Terraform misconfiguration"


# --------------------------------------------------------------------------- #
# Dockerfile discovery (image mode)
# --------------------------------------------------------------------------- #
_FROM_RE = re.compile(
    r"^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?\s*$",
    re.IGNORECASE,
)


def _is_dockerfile(path: Path) -> bool:
    n = path.name.lower()
    return n == "dockerfile" or n.endswith(".dockerfile") or n.startswith("dockerfile.")


def find_dockerfiles(repo_root: Path) -> list[Path]:
    return sorted(p for p in repo_root.rglob("*") if p.is_file() and _is_dockerfile(p))


def is_scannable(ref: str, skip_prefixes: tuple[str, ...]) -> bool:
    """A base image ref we can meaningfully scan: a concrete public image, not a
    build-arg-templated ref, the ``scratch`` base, or a private/authed registry."""
    if not ref or "$" in ref:  # ${BASE_IMAGE}, $VERSION, etc.
        return False
    if ref.lower() == "scratch":
        return False
    return not any(pre in ref for pre in skip_prefixes)


def base_images(text: str, skip_prefixes: tuple[str, ...]) -> list[str]:
    """External base images referenced by a Dockerfile's ``FROM`` lines.

    Multi-stage aware: a ``FROM x AS build`` declares the stage alias ``build``; a later
    ``FROM build`` refers to that stage, not an external image, so it's excluded. The
    result is de-duplicated, order-preserving, and filtered by :func:`is_scannable`."""
    stages: set[str] = set()
    out: list[str] = []
    for line in text.splitlines():
        m = _FROM_RE.match(line)
        if not m:
            continue
        ref, alias = m.group(1), m.group(2)
        if ref not in stages and is_scannable(ref, skip_prefixes) and ref not in out:
            out.append(ref)
        if alias:
            stages.add(alias)
    return out


def images_by_dir(
    repo_root: Path,
    skip_prefixes: tuple[str, ...] = _DEFAULT_SKIP_PREFIXES,
    only_dirs: Optional[set[str]] = None,
) -> dict[str, list[str]]:
    """Map ``dir -> [base image refs]`` across every Dockerfile. ``dir`` is the
    Dockerfile's parent (repo-relative), matching Renovate's ``packageFileDir`` grouping
    and the tf-provider tool's per-directory PRs. ``only_dirs`` limits discovery to the
    given dirs (used by the PR gate to scan just what changed)."""
    out: dict[str, list[str]] = {}
    for df in find_dockerfiles(repo_root):
        rel_dir = str(df.parent.relative_to(repo_root))
        if only_dirs is not None and rel_dir not in only_dirs:
            continue
        refs = base_images(df.read_text(errors="replace"), skip_prefixes)
        if not refs:
            continue
        merged = dict.fromkeys(out.get(rel_dir, []))
        for r in refs:
            merged[r] = None
        out[rel_dir] = list(merged)
    return out


# --------------------------------------------------------------------------- #
# Trivy boundary
# --------------------------------------------------------------------------- #
TrivyRunner = Callable[[list[str]], Optional[str]]


def _run_trivy(argv: list[str]) -> Optional[str]:
    """Invoke the trivy CLI with a fixed argv (no shell) and return stdout, or None on
    failure. Trivy exits non-zero when it finds vulns with --exit-code set; we never set
    it here (detection is non-blocking), so a non-zero code is a real error."""
    try:
        proc = subprocess.run(  # noqa: S603 - fixed argv, no shell, trusted binary
            argv,
            capture_output=True,
            text=True,
            timeout=600,
        )
    except (OSError, subprocess.SubprocessError) as e:
        print(f"  ! trivy {' '.join(argv[1:3])} failed to run: {e}")
        return None
    if proc.returncode != 0:
        print(f"  ! trivy exited {proc.returncode}: {proc.stderr.strip()[:400]}")
        return None
    return proc.stdout


def _min_sev_csv(min_severity: str) -> str:
    floor = severity_rank(min_severity)
    keep = [s.upper() for s, r in _SEV_ORDER.items() if r <= floor and s != "unknown"]
    return ",".join(keep)


# --------------------------------------------------------------------------- #
# Trivy JSON -> Findings
# --------------------------------------------------------------------------- #
def parse_image_results(text: str, directory: str, ref: str) -> list[Finding]:
    """Parse ``trivy image --format json`` output into fixable-vuln findings for one
    image. Only vulnerabilities with a FixedVersion are kept (Trivy is run with
    --ignore-unfixed, but we also guard here so offline fixtures behave the same)."""
    try:
        data = json.loads(text or "{}")
    except json.JSONDecodeError as e:
        print(f"  ! trivy image json parse failed for {ref}: {e}")
        return []
    out: list[Finding] = []
    for res in data.get("Results") or []:
        for v in res.get("Vulnerabilities") or []:
            fixed = v.get("FixedVersion") or ""
            if not fixed:
                continue
            out.append(
                Finding(
                    directory=directory,
                    target=ref,
                    vuln_id=v.get("VulnerabilityID") or "",
                    severity=(v.get("Severity") or "unknown").lower(),
                    title=(v.get("Title") or v.get("Description") or "").strip()[:200],
                    pkg=v.get("PkgName") or "",
                    installed=v.get("InstalledVersion") or "",
                    fixed=fixed,
                    kind=ENGINE_IMAGE,
                )
            )
    return out


def parse_config_results(text: str, repo_root: Path) -> list[Finding]:
    """Parse ``trivy config --format json`` output into misconfiguration findings.
    Only failed checks (Status == FAIL) are kept; the directory is the target file's
    parent, relative to the repo root when possible."""
    try:
        data = json.loads(text or "{}")
    except json.JSONDecodeError as e:
        print(f"  ! trivy config json parse failed: {e}")
        return []
    out: list[Finding] = []
    for res in data.get("Results") or []:
        target = res.get("Target") or ""
        directory = _rel_dir(target, repo_root)
        for mc in res.get("Misconfigurations") or []:
            if (mc.get("Status") or "").upper() not in ("", "FAIL"):
                continue
            out.append(
                Finding(
                    directory=directory,
                    target=target,
                    vuln_id=mc.get("ID") or mc.get("AVDID") or "",
                    severity=(mc.get("Severity") or "unknown").lower(),
                    title=(mc.get("Title") or mc.get("Message") or "").strip()[:200],
                    pkg=(mc.get("Type") or ""),
                    kind=ENGINE_CONFIG,
                )
            )
    return out


def _rel_dir(target: str, repo_root: Path) -> str:
    """Directory of a trivy target path, made repo-relative when it sits under the
    repo (trivy config emits repo-relative or absolute paths depending on how it's
    invoked)."""
    if not target:
        return ""
    p = Path(target)
    if p.is_absolute():
        try:
            p = p.relative_to(repo_root)
        except ValueError:
            pass
    d = str(p.parent)
    return "" if d == "." else d


# --------------------------------------------------------------------------- #
# Scan orchestration
# --------------------------------------------------------------------------- #
def scan_images(
    imgs_by_dir: dict[str, list[str]],
    min_severity: str = "high",
    trivy_bin: str = "trivy",
    runner: TrivyRunner = _run_trivy,
) -> list[Finding]:
    """Scan each unique base image once (cached across dirs) and attribute its findings
    to every directory that uses it."""
    sev = _min_sev_csv(min_severity)
    cache: dict[str, list[Finding]] = {}
    out: list[Finding] = []
    for directory in sorted(imgs_by_dir):
        for ref in imgs_by_dir[directory]:
            if ref not in cache:
                argv = [
                    trivy_bin, "image",
                    "--quiet", "--format", "json",
                    "--scanners", "vuln",
                    "--ignore-unfixed",
                    "--severity", sev,
                    ref,
                ]  # fmt: skip
                raw = runner(argv)
                cache[ref] = parse_image_results(raw or "{}", directory, ref)
            for f in cache[ref]:
                out.append(dataclasses.replace(f, directory=directory))
    return out


def scan_config(
    repo_root: Path,
    tf_subdir: str = _TF_SUBDIR,
    min_severity: str = "high",
    trivy_bin: str = "trivy",
    runner: TrivyRunner = _run_trivy,
    only_dirs: Optional[set[str]] = None,
) -> list[Finding]:
    target = repo_root / tf_subdir
    if not target.exists():
        target = repo_root
    argv = [
        trivy_bin, "config",
        "--quiet", "--format", "json",
        "--severity", _min_sev_csv(min_severity),
        str(target),
    ]  # fmt: skip
    raw = runner(argv)
    findings = parse_config_results(raw or "{}", repo_root)
    if only_dirs is not None:
        findings = [f for f in findings if f.directory in only_dirs]
    return findings


# --------------------------------------------------------------------------- #
# Grouping + report rendering
# --------------------------------------------------------------------------- #
def group_by_dir(findings: list[Finding]) -> dict[str, list[Finding]]:
    out: dict[str, list[Finding]] = {}
    for f in findings:
        out.setdefault(f.directory, []).append(f)
    return out


def _counts(findings: list[Finding]) -> dict[str, int]:
    c: dict[str, int] = {}
    for f in findings:
        c[f.severity] = c.get(f.severity, 0) + 1
    return c


def _counts_line(counts: dict[str, int]) -> str:
    parts = [
        f"{severity_badge(s)}: {counts[s]}"
        for s in ("critical", "high", "medium", "low", "unknown")
        if counts.get(s)
    ]
    return " · ".join(parts) or "none"


def _signature(findings: list[Finding]) -> str:
    basis = "\n".join(sorted(f"{f.target}|{f.vuln_id}|{f.fixed}" for f in findings))
    return hashlib.sha256(basis.encode()).hexdigest()[:16]


def _image_rows(findings: list[Finding]) -> str:
    rows = []
    for f in sorted(
        findings, key=lambda x: (severity_rank(x.severity), x.target, x.vuln_id)
    ):
        cve = (
            f"[{f.vuln_id}](https://nvd.nist.gov/vuln/detail/{f.vuln_id})"
            if f.vuln_id.upper().startswith("CVE-")
            else f.vuln_id or "—"
        )
        rows.append(
            f"| {severity_badge(f.severity)} | {cve} | `{f.target}` | "
            f"`{f.pkg}` | {f.installed} → {f.fixed} |"
        )
    return "\n".join(rows)


def _config_rows(findings: list[Finding]) -> str:
    rows = []
    for f in sorted(
        findings, key=lambda x: (severity_rank(x.severity), x.target, x.vuln_id)
    ):
        aid = (
            f"[{f.vuln_id}](https://avd.aquasec.com/misconfig/{f.vuln_id.lower()})"
            if f.vuln_id.upper().startswith("AVD-")
            else f.vuln_id or "—"
        )
        rows.append(
            f"| {severity_badge(f.severity)} | {aid} | {f.title} | `{f.target}` |"
        )
    return "\n".join(rows)


def _render_body(directory: str, findings: list[Finding], engine: str) -> str:
    counts = _counts(findings)
    n = len(findings)
    if engine == ENGINE_IMAGE:
        head = (
            f"**{n}** fixable container-image vulnerabilit{'y' if n == 1 else 'ies'} "
            f"in the base image(s) used by `{directory}`."
        )
        table = (
            "| Severity | CVE | Image | Package | Installed → Fixed |\n"
            "|----------|-----|-------|---------|-------------------|\n"
            + _image_rows(findings)
        )
        note = (
            "Fixes land via Renovate's digest/patch bump PRs for these images; a CVE "
            "needing a minor/major base-image change requires a manual bump."
        )
    else:
        head = (
            f"**{n}** Terraform misconfiguration{'s' if n != 1 else ''} "
            f"(HIGH/CRITICAL) under `{directory}`."
        )
        table = (
            "| Severity | Check | Title | File |\n"
            "|----------|-------|-------|------|\n" + _config_rows(findings)
        )
        note = "These are configuration-level risks and require a manual code change."
    return (
        f"## What\n\n{head}\n\nSeverity breakdown: {_counts_line(counts)}\n\n"
        f"## Findings\n\n{table}\n\n<sub>Detected by Trivy "
        f"({'image' if engine == ENGINE_IMAGE else 'config'} scanner). {note}</sub>\n"
    )


def build_report_groups(
    findings: list[Finding], engine: str, scanned_dirs: Optional[list[str]] = None
) -> list[dict]:
    """One report group per directory, for the ticket layer + job summary. When
    ``scanned_dirs`` is given, dirs that were scanned but produced no findings are
    emitted with ``findings_count: 0`` so ``renovate_jira.py --report`` can CLOSE a
    now-clean standing ticket."""
    by_dir = group_by_dir(findings)
    groups: list[dict] = []
    dirs = sorted(set(by_dir) | set(scanned_dirs or []))
    for directory in dirs:
        fs = by_dir.get(directory, [])
        counts = _counts(fs)
        groups.append(
            {
                "key": directory,
                "engine": engine,
                "signature": _signature(fs),
                "findings_count": len(fs),
                "severity_counts": counts,
                "severity_line": _counts_line(counts),
                "title": (
                    f"{_engine_noun(engine)} security findings "
                    f"under {directory or '(repo)'}"
                ),
                "body": _render_body(directory, fs, engine) if fs else "",
                "findings": [f.to_json() for f in fs],
            }
        )
    return groups


def render_summary(groups: list[dict], engine: str) -> str:
    """A compact GitHub-Actions job-summary (markdown) for the scan."""
    label = (
        "Container image" if engine == ENGINE_IMAGE else "Terraform misconfiguration"
    )
    with_findings = [g for g in groups if g["findings_count"]]
    total = sum(g["findings_count"] for g in groups)
    if not with_findings:
        return f"### {label} scan\n\n✅ No findings at or above the severity floor.\n"
    lines = [
        f"### {label} scan\n",
        f"**{total}** finding(s) across **{len(with_findings)}** director"
        f"{'y' if len(with_findings) == 1 else 'ies'}.\n",
        "| Directory | Findings | Severity |",
        "|-----------|----------|----------|",
    ]
    for g in sorted(with_findings, key=lambda x: -x["findings_count"]):
        lines.append(f"| `{g['key']}` | {g['findings_count']} | {g['severity_line']} |")
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
def find_repo_root(start: Path) -> Path:
    for p in [start, *start.parents]:
        if (p / ".git").exists() or (p / "root" / "conda-lock.yml").exists():
            return p
    raise SystemExit("could not locate repo root (no .git above cwd)")


def _load_findings_json(path: str) -> list[Finding]:
    raw = json.loads(Path(path).read_text())
    return [
        Finding(
            directory=d.get("directory", ""),
            target=d.get("target", ""),
            vuln_id=d.get("vuln_id", ""),
            severity=d.get("severity", "unknown"),
            title=d.get("title", ""),
            pkg=d.get("pkg", ""),
            installed=d.get("installed", ""),
            fixed=d.get("fixed", ""),
            kind=d.get("kind", ENGINE_IMAGE),
        )
        for d in raw
    ]


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--mode", choices=["image", "config"], required=True)
    ap.add_argument("--repo-root", type=Path, default=None)
    ap.add_argument(
        "--min-severity",
        default="high",
        choices=["critical", "high", "medium", "low"],
        help="lowest severity to report (default high)",
    )
    ap.add_argument("--trivy-bin", default="trivy")
    ap.add_argument("--tf-subdir", default=_TF_SUBDIR)
    ap.add_argument(
        "--paths",
        default="",
        help="comma-separated dirs to limit the scan to (PR gate); default all",
    )
    ap.add_argument(
        "--skip-prefix",
        action="append",
        default=[],
        help="extra image-ref substring to skip (repeatable)",
    )
    ap.add_argument("--report-output", default="", help="write report-group JSON here")
    ap.add_argument("--summary-output", default="", help="write a job-summary md here")
    ap.add_argument(
        "--findings-json",
        default="",
        help="offline: build report groups from a precomputed findings list",
    )
    ap.add_argument(
        "--trivy-json",
        default="",
        help="offline (config mode): parse a captured trivy JSON instead of running it",
    )
    args = ap.parse_args(argv)

    repo_root = (args.repo_root or find_repo_root(Path.cwd())).resolve()
    engine = ENGINE_IMAGE if args.mode == "image" else ENGINE_CONFIG
    only = (
        {p.strip() for p in args.paths.split(",") if p.strip()} if args.paths else None
    )
    skip_prefixes = _DEFAULT_SKIP_PREFIXES + tuple(args.skip_prefix)

    scanned_dirs: list[str] = []
    if args.findings_json:
        findings = _load_findings_json(args.findings_json)
        scanned_dirs = sorted({f.directory for f in findings})
    elif args.mode == "image":
        imgs = images_by_dir(repo_root, skip_prefixes, only_dirs=only)
        scanned_dirs = sorted(imgs)
        findings = scan_images(imgs, args.min_severity, args.trivy_bin)
    else:  # config
        if args.trivy_json:
            findings = parse_config_results(
                Path(args.trivy_json).read_text(), repo_root
            )
            if only is not None:
                findings = [f for f in findings if f.directory in only]
        else:
            findings = scan_config(
                repo_root,
                args.tf_subdir,
                args.min_severity,
                args.trivy_bin,
                only_dirs=only,
            )
        scanned_dirs = sorted({f.directory for f in findings})

    groups = build_report_groups(findings, engine, scanned_dirs=scanned_dirs)
    n = sum(g["findings_count"] for g in groups)
    print(f"trivy {args.mode} scan: {n} finding(s) across {len(scanned_dirs)} dir(s).")
    for g in groups:
        if g["findings_count"]:
            print(f"  {g['key']}: {g['findings_count']} [{g['severity_line']}]")

    if args.report_output:
        Path(args.report_output).write_text(
            json.dumps({"engine": engine, "groups": groups}, indent=2)
        )
        print(f"wrote report groups -> {args.report_output}")
    if args.summary_output:
        Path(args.summary_output).write_text(render_summary(groups, engine))
    return 0


if __name__ == "__main__":
    sys.exit(main())
