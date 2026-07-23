"""Tiny Jira REST client (stdlib only) for linking/creating vulnerability tickets.

Uses REST API v3 with basic auth (email + API token) against the SandboxAQ Jira
Cloud instance (sandboxquantum.atlassian.net): search via /rest/api/3/search/jql
(with a legacy fallback), create with an ADF description, assign, comment, remote
link and transition to Done. Stdlib-only so the CI step needs no extra pip install.

Every network call degrades gracefully: on any error it logs and returns an empty
result / None, so a Jira outage never fails the autofix run.

Vendored from ``root/scripts/socket-autofix/jira_client.py`` so this tool is
self-contained and independently mergeable (with one addition, ``field_value()``, for
verify-after-set routing). Once both tools land, the shared stdlib helpers (this
module, ``advisory.py``, ``codeowners.py``) should be extracted to a single
``root/scripts/lib/`` and imported by both.
"""

from __future__ import annotations

import base64
import dataclasses
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Optional

DEFAULT_BASE = "https://sandboxquantum.atlassian.net"
# Vulnerabilities are tracked in the VULNMGMT project. Both search and create
# default here; the driver overrides them from JIRA_VULN_PROJECT when set.
SEARCH_PROJECTS = ("VULNMGMT",)
CREATE_PROJECT = "VULNMGMT"


@dataclasses.dataclass
class JiraIssue:
    key: str
    summary: str
    url: str
    status: str = ""
    # Stable numeric issue id. Unlike `key`, it does NOT change when VULNMGMT
    # automation MOVES the issue to a BU project (VULNMGMT-496 -> QNV-7011), so all
    # post-create writes (route/verify/comment/remotelink/close) must key off id.
    id: str = ""


class JiraClient:
    def __init__(self, base: str, email: str, token: str):
        self.base = base.rstrip("/")
        self._auth = base64.b64encode(f"{email}:{token}".encode()).decode()

    @classmethod
    def from_env(cls) -> Optional["JiraClient"]:
        email = os.environ.get("SBT_MACHINE_USER_EMAIL")
        token = os.environ.get("SBT_MACHINE_USER_JIRA_TOKEN")
        # `or DEFAULT_BASE` (not a get default): the workflow sets
        # JIRA_BASE_URL: ${{ vars.JIRA_BASE_URL }}, which is the EMPTY STRING when
        # the repo var is undefined. get(k, default) returns "" there (key present),
        # leaving base="" and every request URL schemeless. Treat empty as unset.
        base = os.environ.get("JIRA_BASE_URL") or DEFAULT_BASE
        if not (email and token):
            return None
        return cls(base, email, token)

    def _request(
        self, method: str, path: str, body: Optional[dict] = None
    ) -> Optional[dict]:
        url = f"{self.base}{path}"
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Authorization", f"Basic {self._auth}")
        req.add_header("Accept", "application/json")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = resp.read().decode()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")[:500]
            print(f"  ! jira {method} {path} -> HTTP {e.code}: {detail}")
        except Exception as e:  # noqa: BLE001 - graceful degradation is the point
            print(f"  ! jira {method} {path} failed: {e}")
        return None

    def search(self, jql: str, max_results: int = 20) -> list[JiraIssue]:
        # Atlassian Cloud replaced /rest/api/{2,3}/search with /rest/api/3/search/jql
        # (the old ones were removed in 2025). Try the current endpoint first, then
        # fall back to the legacy one for older/Server instances.
        params = urllib.parse.urlencode(
            {"jql": jql, "maxResults": max_results, "fields": "summary,status"}
        )
        data = self._request("GET", f"/rest/api/3/search/jql?{params}")
        if data is None:
            data = self._request("GET", f"/rest/api/2/search?{params}")
        if not data:
            return []
        out: list[JiraIssue] = []
        for issue in data.get("issues", []):
            key = issue.get("key", "")
            fields = issue.get("fields", {})
            out.append(
                JiraIssue(
                    key=key,
                    summary=fields.get("summary", ""),
                    url=f"{self.base}/browse/{key}",
                    status=(fields.get("status") or {}).get("name", ""),
                )
            )
        return out

    def create(
        self,
        summary: str,
        description: str,
        labels: Optional[list[str]] = None,
        project: str = CREATE_PROJECT,
        issue_type: str = "Task",
        epic_key: Optional[str] = None,
    ) -> Optional[JiraIssue]:
        # REST v3 requires an ADF description.
        fields = {
            "project": {"key": project},
            "summary": summary[:250],
            "description": _adf(description),
            "issuetype": {"name": issue_type},
        }
        if epic_key:  # file under a vuln-tracking epic if one is configured
            fields["parent"] = {"key": epic_key}
        if labels:
            fields["labels"] = labels
        data = self._request("POST", "/rest/api/3/issue", {"fields": fields})
        if not data or "key" not in data:
            return None
        key = data["key"]
        return JiraIssue(
            key=key,
            summary=summary,
            url=f"{self.base}/browse/{key}",
            id=str(data.get("id") or ""),
        )

    def resolve_key(self, id_or_key: str) -> Optional[str]:
        """Current key for an issue id/key. After VULNMGMT automation MOVES a created
        issue to its BU project, the numeric id still resolves but returns the NEW key
        (e.g. QNV-7011). Used to stamp the real key into the PR body / close marker."""
        data = self._request(
            "GET", f"/rest/api/3/issue/{urllib.parse.quote(id_or_key)}?fields=key"
        )
        if isinstance(data, dict):
            return data.get("key")
        return None

    def myself(self) -> Optional[dict]:
        """The account this token authenticates as (email, displayName, accountId) —
        so permissions can be granted to the RIGHT account."""
        data = self._request("GET", "/rest/api/3/myself")
        return data if isinstance(data, dict) else None

    def find_account_id(self, query: str) -> Optional[str]:
        """Best-effort accountId lookup for a user by email or display name, so
        'assign to aisim' works from a human-readable identifier. Returns None if
        the account can't be resolved (user search is permission-gated)."""
        q = urllib.parse.quote(query)
        data = self._request("GET", f"/rest/api/3/user/search?query={q}")
        if isinstance(data, list) and data:
            aid = data[0].get("accountId")
            return str(aid) if aid else None
        return None

    def project_exists(self, project_key: str) -> bool:
        """True if the account can browse `project_key` (GET project/{key} -> 200).
        Reliable existence/visibility check for filtering search keys — one bad key
        (e.g. a misspelled VULNMGMT) otherwise makes the whole JQL error -> empty.
        (project/search under-reports permission-scheme-granted projects, so we
        probe each key directly.)"""
        data = self._request(
            "GET", f"/rest/api/3/project/{urllib.parse.quote(project_key)}"
        )
        return isinstance(data, dict) and bool(data.get("key"))

    def field_allowed_values(self, project_key: str, field_id: str) -> list[str]:
        """Allowed option names for a select custom field in `project_key` (from
        createmeta). Empty if the field is free-text or has no restricted options."""
        it = self._request(
            "GET",
            f"/rest/api/3/issue/createmeta/{urllib.parse.quote(project_key)}/issuetypes",
        )
        if not isinstance(it, dict):
            return []
        ids = [
            v.get("id")
            for v in (it.get("values") or it.get("issueTypes") or [])
            if v.get("id")
        ]
        for tid in ids:
            data = self._request(
                "GET",
                f"/rest/api/3/issue/createmeta/{urllib.parse.quote(project_key)}"
                f"/issuetypes/{urllib.parse.quote(str(tid))}",
            )
            if not isinstance(data, dict):
                continue
            for field in data.get("values") or data.get("fields") or []:
                if field.get("fieldId") == field_id or field.get("key") == field_id:
                    return [
                        av.get("value") or av.get("name")
                        for av in field.get("allowedValues", [])
                        if (av.get("value") or av.get("name"))
                    ]
        return []

    def issue_types(self, project_key: str) -> list[str]:
        """Issue-type names creatable in `project_key` (from createmeta) — used to
        pick a valid type, since a project may not offer 'Task'."""
        data = self._request(
            "GET",
            f"/rest/api/3/issue/createmeta/{urllib.parse.quote(project_key)}/issuetypes",
        )
        if not isinstance(data, dict):
            return []
        vals = data.get("values") or data.get("issueTypes") or []
        return [v.get("name", "") for v in vals if v.get("name")]

    def can_create_in(self, project_key: str) -> bool:
        """True if the authenticated account can create issues in `project_key`
        (createmeta returns issue types only for projects it can create in)."""
        data = self._request(
            "GET",
            f"/rest/api/3/issue/createmeta/{urllib.parse.quote(project_key)}/issuetypes",
        )
        if not isinstance(data, dict):
            return False
        return bool(data.get("values") or data.get("issueTypes"))

    def add_comment(self, key: str, text: str) -> bool:
        """Add an ADF comment to an issue. Best-effort (returns False on failure)."""
        data = self._request(
            "POST",
            f"/rest/api/3/issue/{urllib.parse.quote(key)}/comment",
            {"body": _adf(text)},
        )
        return data is not None

    def add_remote_link(self, key: str, url: str, title: str) -> bool:
        """Add/refresh a 'Web link' on the issue pointing at `url` (e.g. the fix PR).
        Idempotent: `globalId` = the url, so reruns update the same link instead of
        adding duplicates. Best-effort."""
        body = {"globalId": url, "object": {"url": url, "title": title[:250]}}
        data = self._request(
            "POST", f"/rest/api/3/issue/{urllib.parse.quote(key)}/remotelink", body
        )
        return data is not None

    def set_assignee(
        self,
        key: str,
        account_id: Optional[str] = None,
        name: Optional[str] = None,
    ) -> bool:
        """Assign an issue (e.g. to the aisim account). Jira Cloud wants an
        accountId; Server/DC wants a name/username. Try accountId first, then name.
        Best-effort — returns True if either shape is accepted."""
        ek = urllib.parse.quote(key)
        payloads = []
        if account_id:
            payloads.append({"accountId": account_id})
        if name:
            payloads.append({"name": name})
        for payload in payloads:
            data = self._request("PUT", f"/rest/api/3/issue/{ek}/assignee", payload)
            if data is not None:
                return True
        return False

    def transitions(self, key: str) -> list[dict]:
        data = self._request(
            "GET", f"/rest/api/3/issue/{urllib.parse.quote(key)}/transitions"
        )
        return data.get("transitions", []) if isinstance(data, dict) else []

    def close_issue(self, key: str, comment: Optional[str] = None) -> bool:
        """Transition an issue to a Done-category status (optionally commenting
        first). Picks the transition whose target status is in the 'done' category,
        else one named like Done/Closed/Resolved. Best-effort."""
        trs = self.transitions(key)
        chosen = None
        for t in trs:
            cat = ((t.get("to") or {}).get("statusCategory") or {}).get("key")
            if cat == "done":
                chosen = t
                break
        if not chosen:
            for t in trs:
                if t.get("name", "").strip().lower() in (
                    "done",
                    "close",
                    "closed",
                    "resolve",
                    "resolved",
                ):
                    chosen = t
                    break
        if not chosen:
            print(
                f"  ! jira {key}: no Done transition available "
                f"(transitions: {[t.get('name') for t in trs]})"
            )
            return False
        if comment:
            self.add_comment(key, comment)
        data = self._request(
            "POST",
            f"/rest/api/3/issue/{urllib.parse.quote(key)}/transitions",
            {"transition": {"id": chosen["id"]}},
        )
        return data is not None

    def find_field_id(self, name_substr: str) -> Optional[str]:
        """Best-effort: id of the first field whose name contains `name_substr`
        (case-insensitive), e.g. 'business unit' -> 'customfield_12345'. Lets the
        BU field be auto-discovered without hardcoding its custom-field id."""
        data = self._request("GET", "/rest/api/3/field")
        if not isinstance(data, list):
            return None
        want = name_substr.lower()
        for f in data:
            if want in str(f.get("name", "")).lower():
                fid = f.get("id")
                if fid:
                    return str(fid)
        return None

    def set_field(self, key: str, field_id: str, value: str) -> bool:
        """Best-effort set of a field. We don't know the field's type, so try the
        single-select object shape ({"value": ...}) then a plain string. A 400 from
        the wrong shape just falls through to the next; returns True if either took."""
        ek = urllib.parse.quote(key)
        for payload in ({"value": value}, value):
            data = self._request(
                "PUT", f"/rest/api/3/issue/{ek}", {"fields": {field_id: payload}}
            )
            if data is not None:
                return True
        return False

    def field_value(self, key: str, field_id: str) -> Optional[str]:
        """Read a field's current value as a plain string (for verify-after-set).
        Unwraps the single-select ``{"value"/"name": ...}`` shape. Returns None if the
        field is unset or unreadable. GETs follow the redirect Jira serves when an
        issue has been MOVED to another project (so the original key still resolves)."""
        ek = urllib.parse.quote(key)
        fq = urllib.parse.quote(field_id)
        data = self._request("GET", f"/rest/api/3/issue/{ek}?fields={fq}")
        if not isinstance(data, dict):
            return None
        val = (data.get("fields") or {}).get(field_id)
        if isinstance(val, dict):
            return val.get("value") or val.get("name")
        return val


def _adf(text: str) -> dict:
    """Wrap plain text (newline-separated) into an Atlassian Document Format doc,
    as REST v3 requires for issue descriptions."""
    content = []
    for line in text.split("\n"):
        node = {"type": "paragraph", "content": []}
        if line.strip():
            node["content"] = [{"type": "text", "text": line}]
        content.append(node)
    return {
        "type": "doc",
        "version": 1,
        "content": content or [{"type": "paragraph", "content": []}],
    }


def _quote(term: str) -> str:
    """Escape a term for JQL text search (double-quote wrapped)."""
    return '"' + term.replace("\\", "\\\\").replace('"', '\\"') + '"'


def build_search_jql(
    terms: list[str],
    repo: str = "",
    projects: tuple[str, ...] = SEARCH_PROJECTS,
    path: str = "",
) -> str:
    """JQL for open issues in the vuln projects mentioning any of `terms`
    (CVE/GHSA ids, package names) and, if given, the repo name and project `path`.

    Scoping by `path` is what keeps dedup per-project: a widely-shared CVE (urllib3,
    requests) lives in many projects' tickets, so matching on the advisory + repo
    alone would link every one of them onto a single project's PR. Requiring the
    manifest dir (which every ticket this tool creates carries in its summary) ties
    the search to the one ticket that actually tracks this project."""
    proj = ", ".join(projects)
    term_clause = " OR ".join(f"text ~ {_quote(t)}" for t in terms if t)
    jql = f"project in ({proj}) AND statusCategory != Done"
    if term_clause:
        jql += f" AND ({term_clause})"
    if repo:
        jql += f" AND text ~ {_quote(repo)}"
    if path:
        jql += f" AND text ~ {_quote(path)}"
    return jql + " ORDER BY updated DESC"
