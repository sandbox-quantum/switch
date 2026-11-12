"""Per-box internet allow-lists: each box gets its own proxy login, and squid lets each login reach only that
box's list. Design v3.

This module is the generator. It reads the operator's egress settings (which parts each box has switched on),
makes sure every box has its proxy login in its own `switch-proxy-login` Secret, and writes two things squid
reads: the per-box include files (ConfigMap `squid-boxes`) and the password hashes (Secret `squid-passwd`).
Squid notices the changed files and reloads itself; nothing here ever touches squid's pods.

**In the cluster (step 2, before A1):** it reads the box map (`box-map` in `switch-hosted`) and its settings
(`egress-settings` in its own namespace) through the API, by name, with its account's token read fresh on every
call. A box's `switch-proxy-login` holds only what admission policy P7 lets it write: `https_proxy`, and
`ctl_https_proxy` on a split box, each the box's proxy URL with its login in it. The hash of each login lives only
in `squid-passwd`. A box keeps its login while its URL names the expected user and `squid-passwd` holds a hash that
the URL's password matches, so its `HTTPS_PROXY` never changes under it.

Passwords never appear in a log line, an error or an event: only box ids and counts do.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import signal
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol
from urllib.error import HTTPError
from uuid import UUID

from .box_scaler import NAMESPACE_RE, ScalerConfigError

logger = logging.getLogger(__name__)

LOGIN_SECRET = "switch-proxy-login"  # in each box namespace; created empty by the provisioner
# The only keys P7 lets the generator write there (rights v1.14, security).
URL_KEY, CTL_URL_KEY = "https_proxy", "ctl_https_proxy"
BOX_MAP_SECRET = (
    "box-map"  # in switch-hosted: one key per machine id, the value the box's namespace
)
SETTINGS_SECRET = "egress-settings"  # in the generator's own namespace
SETTINGS_KEY = "egress.json"
BOXES_CONFIGMAP = "squid-boxes"  # in egress-proxy
PASSWD_SECRET = "squid-passwd"  # in egress-proxy
PASSWD_KEY = "passwd"
SQUID_BOXES_DIR = "/etc/squid/boxes"

# The named parts a box's list is built from. `base` is on for every box.
PARTS: dict[str, tuple[str, ...]] = {
    "base": ("registry.npmjs.org",),
    "python": ("pypi.org", "files.pythonhosted.org"),
    "github": ("github.com", "api.github.com", "codeload.github.com"),
    # Off and opt-in on its own: both serve files straight to a shell.
    "github-downloads": ("raw.githubusercontent.com", "objects.githubusercontent.com"),
    "ai-providers": ("aiplatform.googleapis.com", "oauth2.googleapis.com"),
}
OPTIONAL_PARTS = frozenset(PARTS) - {
    "base",
    "ai-providers",
}  # ai-providers follows the split rule, not a choice
MAX_EXTRAS = 10
HOST_RE = re.compile(r"(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}")
BOX_ID_RE = re.compile(r"[a-z0-9]([a-z0-9-]{0,49}[a-z0-9])?")
# The node gate's own login: a fixed short list, only the hosts its proxy check must reach.
GATE_NAMESPACE = "switch-node-gate"
GATE_ID = "_gate"  # an underscore no box id can have, so it can never collide with a box's files
GATE_USER = "gate-check"


class EgressConfigError(ValueError):
    pass


@dataclass(frozen=True)
class BoxEgress:
    namespace: str
    parts: tuple[str, ...]  # optional parts switched on, sorted
    extras: tuple[str, ...] = ()  # box-only hosts, the exception
    split: bool = (
        False  # agents in their own container: provider hosts move to the controller's login
    )
    fixed_hosts: tuple[str, ...] | None = None  # the gate only: exactly these hosts, no parts

    @property
    def box_id(self) -> str:
        return (
            GATE_ID
            if self.namespace == GATE_NAMESPACE
            else self.namespace.removeprefix("agents-user-")
        )

    @property
    def user(self) -> str:
        return GATE_USER if self.namespace == GATE_NAMESPACE else f"box-{self.box_id}"

    @property
    def ctl_user(self) -> str:
        return f"box-{self.box_id}-ctl"

    def agent_hosts(self) -> list[str]:
        """The box's own login's list. On an unsplit box the provider hosts stay on it, as today."""
        if self.fixed_hosts is not None:
            return sorted(self.fixed_hosts)
        names = ["base", *self.parts] + ([] if self.split else ["ai-providers"])
        return sorted({h for n in names for h in PARTS[n]} | set(self.extras))

    def ctl_hosts(self) -> list[str]:
        """The controller's login's list, on a split box only: the box's list plus the provider hosts."""
        return sorted(set(self.agent_hosts()) | set(PARTS["ai-providers"]))


def load_egress(
    path: Path,
    boxes: Mapping[str, str],
    default_parts: tuple[str, ...],
    default_split: bool = False,
) -> list[BoxEgress]:
    """The operator's egress file, on a machine that keeps it as a file. Others may not read or write it."""
    if path.stat().st_mode & 0o077:
        raise EgressConfigError("the egress file must be readable by its owner only (0600)")
    return parse_egress(path.read_text(), boxes, default_parts, default_split)


def parse_egress(
    text: str,
    boxes: Mapping[str, str],
    default_parts: tuple[str, ...],
    default_split: bool = False,
) -> list[BoxEgress]:
    """The operator's egress settings: `{namespace: {"parts": [...], "extras": [...], "split": bool}}`.

    Refused whole if anything is off: not JSON, a namespace that isn't in the box map, an unknown part, a bad host.
    Boxes in the box map but not in the settings get `default_parts` and `default_split`; an entry without `split`
    gets `default_split` too, so a provisioned box (always split) gets its controller's login with no entry of its own.
    """
    try:
        raw = json.loads(text)
    except ValueError:
        raise EgressConfigError("the egress settings are not JSON") from None
    if not isinstance(raw, dict):
        raise EgressConfigError("the egress file must be an object of namespace to settings")
    known = set(boxes.values())
    for part in default_parts:
        if part not in OPTIONAL_PARTS:
            raise EgressConfigError(f"not a part a box can switch on: {part!r}")
    result: dict[str, BoxEgress] = {}
    gate = raw.pop("_gate", None)
    if gate is not None:
        hosts = gate.get("hosts") if isinstance(gate, dict) and set(gate) == {"hosts"} else None
        if not isinstance(hosts, list) or not 1 <= len(hosts) <= MAX_EXTRAS:
            raise EgressConfigError(
                f'_gate must be {{"hosts": [...]}}, with 1 to {MAX_EXTRAS} hosts'
            )
        if not all(isinstance(h, str) and HOST_RE.fullmatch(h) for h in hosts):
            raise EgressConfigError("_gate: a host is not a host name")
        result[GATE_NAMESPACE] = BoxEgress(
            GATE_NAMESPACE, (), fixed_hosts=tuple(sorted(set(hosts)))
        )
    for namespace, settings in raw.items():
        if (
            not isinstance(namespace, str)
            or not NAMESPACE_RE.fullmatch(namespace)
            or namespace not in known
        ):
            raise EgressConfigError(f"not a box in the box map: {namespace!r}")
        if not BOX_ID_RE.fullmatch(namespace.removeprefix("agents-user-")):
            raise EgressConfigError(f"box id too long or malformed: {namespace!r}")
        if not isinstance(settings, dict) or set(settings) - {"parts", "extras", "split"}:
            raise EgressConfigError(f"{namespace}: settings may hold only parts, extras and split")
        parts = settings.get("parts", list(default_parts))
        extras = settings.get("extras", [])
        split = settings.get("split", default_split)
        if not isinstance(parts, list) or not all(
            isinstance(p, str) and p in OPTIONAL_PARTS for p in parts
        ):
            raise EgressConfigError(f"{namespace}: parts must be some of {sorted(OPTIONAL_PARTS)}")
        if not isinstance(extras, list) or len(extras) > MAX_EXTRAS:
            raise EgressConfigError(
                f"{namespace}: extras must be a list of at most {MAX_EXTRAS} hosts"
            )
        if not all(isinstance(h, str) and HOST_RE.fullmatch(h) for h in extras):
            raise EgressConfigError(f"{namespace}: an extra is not a host name")
        if not isinstance(split, bool):
            raise EgressConfigError(f"{namespace}: split must be true or false")
        result[namespace] = BoxEgress(
            namespace, tuple(sorted(set(parts))), tuple(sorted(set(extras))), split
        )
    for namespace in known - set(result) - {GATE_NAMESPACE}:
        if BOX_ID_RE.fullmatch(namespace.removeprefix("agents-user-")):
            result[namespace] = BoxEgress(
                namespace, tuple(sorted(set(default_parts))), split=default_split
            )
        else:
            raise EgressConfigError(f"box id too long or malformed: {namespace!r}")
    return [result[n] for n in sorted(result)]


# ---- SHA-512 crypt ($6$), as squid's basic_ncsa_auth reads it ----
# Python 3.13 removed the crypt module, so this follows Ulrich Drepper's published algorithm directly. The tests
# check it against the specification's own test vectors.

_ITOA64 = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
_ORDER = (
    (0, 21, 42), (22, 43, 1), (44, 2, 23), (3, 24, 45), (25, 46, 4), (47, 5, 26), (6, 27, 48),
    (28, 49, 7), (50, 8, 29), (9, 30, 51), (31, 52, 10), (53, 11, 32), (12, 33, 54), (34, 55, 13),
    (56, 14, 35), (15, 36, 57), (37, 58, 16), (59, 17, 38), (18, 39, 60), (40, 61, 19), (62, 20, 41),
)  # fmt: skip


def _b64(b2: int, b1: int, b0: int, n: int) -> str:
    w = (b2 << 16) | (b1 << 8) | b0
    out = []
    for _ in range(n):
        out.append(_ITOA64[w & 0x3F])
        w >>= 6
    return "".join(out)


def sha512_crypt(password: str, salt: str, rounds: int | None = None) -> str:
    key = password.encode()
    salt_b = salt.encode()[:16]
    r = 5000 if rounds is None else max(1000, min(999_999_999, rounds))
    b = hashlib.sha512(key + salt_b + key).digest()
    a = hashlib.sha512(key + salt_b)
    n = len(key)
    while n > 64:
        a.update(b)
        n -= 64
    a.update(b[:n])
    n = len(key)
    while n > 0:
        a.update(b if n & 1 else key)
        n >>= 1
    a_d = a.digest()
    dp = hashlib.sha512(key * len(key)).digest()
    p = (dp * (len(key) // 64 + 1))[: len(key)]
    ds = hashlib.sha512(salt_b * (16 + a_d[0])).digest()
    s = (ds * (len(salt_b) // 64 + 1))[: len(salt_b)]
    c = a_d
    for i in range(r):
        h = hashlib.sha512(p if i & 1 else c)
        if i % 3:
            h.update(s)
        if i % 7:
            h.update(p)
        h.update(c if i & 1 else p)
        c = h.digest()
    encoded = "".join(_b64(c[x], c[y], c[z], 4) for x, y, z in _ORDER) + _b64(0, 0, c[63], 2)
    prefix = "$6$" if rounds is None else f"$6$rounds={r}$"
    return f"{prefix}{salt_b.decode()}${encoded}"


def new_password() -> str:
    """32 random bytes, URL-safe, so it goes into `HTTPS_PROXY` without escaping."""
    return secrets.token_urlsafe(32)


def new_salt() -> str:
    return "".join(secrets.choice(_ITOA64) for _ in range(16))


def hash_matches(password: str, line_hash: str) -> bool:
    """Whether `password` is the one a `$6$` hash was made from, re-hashed with that hash's own salt, compared in
    constant time. Only the default cost (no rounds=, or rounds=5000) is read; anything else matches nothing, so the
    box gets a new login."""
    parts = line_hash.split("$")
    if len(parts) == 4 and parts[:2] == ["", "6"]:
        salt, rounds = parts[2], None
    elif len(parts) == 5 and parts[:2] == ["", "6"] and parts[2] == "rounds=5000":
        # Only the generator's own cost: a hand-written rounds= value could make every pass hash for minutes.
        salt, rounds = parts[3], 5000
    else:
        return False
    return hmac.compare_digest(sha512_crypt(password, salt, rounds), line_hash)


def login_from_url(url: object, user: str, proxy: str) -> str | None:
    """The password in a box's proxy URL, when the URL is exactly the form this generator writes for `user` and
    `proxy`; None otherwise (another user, another proxy, anything hand-edited)."""
    if not isinstance(url, str):
        return None
    prefix, suffix = f"http://{user}:", f"@{proxy}"
    if not (url.startswith(prefix) and url.endswith(suffix)):
        return None
    password = url[len(prefix) : len(url) - len(suffix)]
    if not password or not all(c.isalnum() or c in "-_" for c in password):
        return None
    return password


def passwd_hashes(text: str) -> dict[str, str]:
    """`squid-passwd`'s lines as user to hash."""
    out = {}
    for line in text.splitlines():
        user, sep, line_hash = line.partition(":")
        if sep and user:
            out[user] = line_hash
    return out


# ---- what squid reads ----


def box_files(box: BoxEgress) -> dict[str, str]:
    """The box's include file and list files, as ConfigMap keys. Built only from validated ids and hosts."""
    i = box.box_id
    conf = [
        f"# {box.namespace}: generated by the hosted controller, do not edit",
        f"acl b_{i} proxy_auth {box.user}",
        f'acl l_{i} dstdomain -n "{SQUID_BOXES_DIR}/{i}.list"',
        f"http_access allow CONNECT b_{i} l_{i}",
    ]
    files = {f"{i}.list": "\n".join(box.agent_hosts()) + "\n"}
    if box.split:
        conf += [
            f"acl c_{i} proxy_auth {box.ctl_user}",
            f'acl lc_{i} dstdomain -n "{SQUID_BOXES_DIR}/{i}.ctl.list"',
            f"http_access allow CONNECT c_{i} lc_{i}",
        ]
        files[f"{i}.ctl.list"] = "\n".join(box.ctl_hosts()) + "\n"
    files[f"{i}.conf"] = "\n".join(conf) + "\n"
    return files


class EgressKube(Protocol):
    def login(
        self, namespace: str
    ) -> dict[str, str] | None: ...  # the box's login Secret, decoded; None if missing
    def set_login(self, namespace: str, values: dict[str, str]) -> None: ...
    def boxes_files(self) -> dict[str, str]: ...
    def patch_boxes_files(self, changes: dict[str, str | None]) -> None: ...  # None removes a key
    def passwd(self) -> str: ...
    def set_passwd(self, text: str) -> None: ...


@dataclass
class EgressResult:
    boxes: int = 0
    logins_made: int = 0
    skipped: int = 0  # boxes whose login Secret is missing: render-user hasn't created it yet
    files_changed: int = 0
    passwd_changed: bool = False


def _ensure_login(
    kube: EgressKube,
    box: BoxEgress,
    proxy: str,
    known: Mapping[str, str],
    make_password: Callable[[], str],
    make_salt: Callable[[], str],
) -> tuple[dict[str, str], bool, dict[str, str]] | None:
    """The box's login Secret as it should be (only the URL keys P7 allows), whether that changes it, and each of
    its users' hashes for `squid-passwd`. A login is kept while its URL is ours for that user and `known` (today's
    `squid-passwd`) holds a hash its password matches: so an existing box keeps its `HTTPS_PROXY`. Otherwise it
    gets a new password. None when the box has no login Secret yet."""
    current = kube.login(box.namespace)
    if current is None:
        return None
    wanted = [(URL_KEY, box.user)] + ([(CTL_URL_KEY, box.ctl_user)] if box.split else [])
    values: dict[str, str] = {}
    hashes: dict[str, str] = {}
    for key, user in wanted:
        password = login_from_url(current.get(key), user, proxy)
        line_hash = known.get(user)
        if password is not None and line_hash is not None and hash_matches(password, line_hash):
            values[key] = current[key]
            hashes[user] = line_hash
        else:
            password = make_password()
            values[key] = f"http://{user}:{password}@{proxy}"
            hashes[user] = sha512_crypt(password, make_salt())
    # Anything else in the Secret (an older generator's username, password and hash keys, or a controller login
    # on a box that is no longer split) goes, so the Secret holds only what P7 allows.
    return values, values != current, hashes


def reconcile_once(
    kube: EgressKube,
    boxes: list[BoxEgress],
    proxy: str,
    make_password: Callable[[], str] = new_password,
    make_salt: Callable[[], str] = new_salt,
) -> EgressResult:
    result = EgressResult(boxes=len(boxes))
    files: dict[str, str] = {}
    passwd_lines: list[str] = []
    current = kube.boxes_files()
    current_passwd = kube.passwd()
    known = passwd_hashes(current_passwd)
    for box in boxes:
        # One box's Secret failing never stops the others, and its error is named by type only, never its text,
        # which could quote what was being written.
        try:
            ensured = _ensure_login(kube, box, proxy, known, make_password, make_salt)
            if ensured is not None and ensured[1]:
                kube.set_login(box.namespace, ensured[0])
                result.logins_made += 1
        except Exception as error:
            # A passing API error must not cut the box off: it keeps what squid already has for it.
            result.skipped += 1
            logger.warning(
                "Egress: could not read or write the login for %s (%s); its box keeps its current list",
                box.namespace,
                type(error).__name__,
            )
            i = box.box_id
            files.update(
                {
                    k: v
                    for k, v in current.items()
                    if k in (f"{i}.conf", f"{i}.list", f"{i}.ctl.list")
                }
            )
            passwd_lines += [
                line
                for line in current_passwd.splitlines()
                if line.split(":", 1)[0] in (box.user, box.ctl_user)
            ]
            continue
        if ensured is None:
            result.skipped += 1
            logger.warning(
                "Egress: %s has no %s Secret yet; its box reaches nothing",
                box.namespace,
                LOGIN_SECRET,
            )
            continue
        files.update(box_files(box))
        passwd_lines += [f"{user}:{line_hash}" for user, line_hash in ensured[2].items()]
    changes: dict[str, str | None] = {k: v for k, v in files.items() if current.get(k) != v}
    changes.update({k: None for k in current if k not in files})
    if changes:
        kube.patch_boxes_files(changes)
        result.files_changed = len(changes)
    passwd = "\n".join(sorted(passwd_lines, key=lambda line: line.split(":", 1)[0])) + (
        "\n" if passwd_lines else ""
    )
    if current_passwd != passwd:
        kube.set_passwd(passwd)
        result.passwd_changed = True
    logger.info(
        "Egress: %d boxes, %d logins made, %d skipped, %d files changed, passwords %s",
        result.boxes,
        result.logins_made,
        result.skipped,
        result.files_changed,
        "changed" if result.passwd_changed else "unchanged",
    )
    return result


# ---- the Kubernetes calls, and no others ----


class EgressKubeApi:
    """get and patch on three named objects: each box's login Secret, and squid's ConfigMap and Secret in
    `egress-proxy`. Never a list, a create, or squid's pods."""

    def __init__(
        self,
        call: Callable[..., dict],
        proxy_namespace: str = "egress-proxy",
        hosted_namespace: str = "switch-hosted",
        own_namespace: str = "egress-lists",
    ):
        self._call = call  # one client, its token read fresh on every call
        self._ns = proxy_namespace
        self._hosted_ns = hosted_namespace
        self._own_ns = own_namespace

    def _secret_data(self, namespace: str, name: str) -> dict[str, str]:
        """A Secret's data, each value base64-decoded strictly. Any error (a 403, a 404) is raised as it is."""
        secret = self._call("GET", f"/api/v1/namespaces/{namespace}/secrets/{name}")
        data = secret.get("data") if isinstance(secret, dict) else None
        out = {}
        for key, value in (data or {}).items():
            try:
                out[key] = base64.b64decode(value, validate=True).decode()
            except (ValueError, UnicodeDecodeError):
                raise EgressConfigError(f"{name}: a value is not valid base64 text") from None
        return out

    def box_map(self) -> dict[str, str]:
        """`box-map`, read by name (the generator's `get` on that one name): machine id to box namespace,
        refused whole if any entry is off, as the mounted map is."""
        boxes: dict[str, str] = {}
        for key, value in self._secret_data(self._hosted_ns, BOX_MAP_SECRET).items():
            namespace = value.strip()
            if not NAMESPACE_RE.fullmatch(namespace):
                raise EgressConfigError("box-map: an entry is not a user box namespace")
            try:
                boxes[str(UUID(key))] = namespace
            except ValueError:
                raise EgressConfigError("box-map: a key is not a machine id") from None
        if len(set(boxes.values())) != len(boxes):
            raise EgressConfigError("box-map: a namespace is listed more than once")
        return boxes

    def settings(self) -> str:
        """The operator's egress settings, as the text of `egress-settings`' one key."""
        data = self._secret_data(self._own_ns, SETTINGS_SECRET)
        if set(data) != {SETTINGS_KEY}:
            raise EgressConfigError(f"{SETTINGS_SECRET} must hold exactly one key, {SETTINGS_KEY}")
        return data[SETTINGS_KEY]

    @staticmethod
    def _login_path(namespace: str) -> str:
        if not NAMESPACE_RE.fullmatch(namespace) and namespace != GATE_NAMESPACE:
            raise ValueError("not a user box namespace, or the gate's")
        return f"/api/v1/namespaces/{namespace}/secrets/{LOGIN_SECRET}"

    def login(self, namespace: str) -> dict[str, str] | None:
        try:
            secret = self._call("GET", self._login_path(namespace))
        except HTTPError as error:
            if error.code == 404:
                return None
            raise
        return {k: base64.b64decode(v).decode() for k, v in (secret.get("data") or {}).items()}

    def set_login(self, namespace: str, values: dict[str, str]) -> None:
        current = self.login(namespace) or {}
        data: dict[str, str | None] = {
            k: base64.b64encode(v.encode()).decode() for k, v in values.items()
        }
        data.update({k: None for k in current if k not in values})
        self._call("PATCH", self._login_path(namespace), {"data": data})

    def boxes_files(self) -> dict[str, str]:
        cm = self._call("GET", f"/api/v1/namespaces/{self._ns}/configmaps/{BOXES_CONFIGMAP}")
        return dict(cm.get("data") or {})

    def patch_boxes_files(self, changes: dict[str, str | None]) -> None:
        self._call(
            "PATCH",
            f"/api/v1/namespaces/{self._ns}/configmaps/{BOXES_CONFIGMAP}",
            {"data": changes},
        )

    def passwd(self) -> str:
        secret = self._call("GET", f"/api/v1/namespaces/{self._ns}/secrets/{PASSWD_SECRET}")
        value = (secret.get("data") or {}).get(PASSWD_KEY)
        return base64.b64decode(value).decode() if value else ""

    def set_passwd(self, text: str) -> None:
        self._call(
            "PATCH",
            f"/api/v1/namespaces/{self._ns}/secrets/{PASSWD_SECRET}",
            {"data": {PASSWD_KEY: base64.b64encode(text.encode()).decode()}},
        )


# ---- the box template check ----

TEMPLATE_KEYS = {"https_proxy", "ctl_https_proxy"}


CREDENTIAL_WORDS = ("TOKEN", "PASSWORD", "SECRET", "KEY")


def _literal_credential(env: dict) -> str | None:
    """Why an env entry carries a credential as a plain value, or None. A spec is
    readable by anything that can read pods, so a credential must only ever come in by reference
    (`secretKeyRef`): never a literal value under a credential-like name, and never a proxy URL
    with a login in it."""
    value = env.get("value")
    if not isinstance(value, str) or value == "":
        return None
    env_name = str(env.get("name", "")).upper()
    if any(word in env_name for word in CREDENTIAL_WORDS):
        return f"sets {env.get('name')!r} as a plain value; credentials come only by secretKeyRef"
    if env_name.endswith("_PROXY") and "@" in value:
        return (
            f"puts a login in {env.get('name')!r} as a plain value; it comes only by secretKeyRef"
        )
    return None


def check_box_pod_spec(pod_spec: dict, split: bool, controller: str = "controller") -> list[str]:
    """Problems with how a box's pod takes its proxy logins, for render-user to refuse before applying. The login
    Secret holds both logins on a split box, so each container must take only its own key, one value at a time:
    - no container loads the whole Secret (`envFrom`), and no volume mounts it;
    - a container other than the controller takes `https_proxy` only, never a `ctl_` key;
    - the controller takes `ctl_https_proxy` only on a split box.
    """
    problems = []
    for volume in pod_spec.get("volumes") or []:
        sources = [volume.get("secret") or {}] + [
            src.get("secret") or {} for src in (volume.get("projected") or {}).get("sources") or []
        ]
        if any(src.get("secretName", src.get("name")) == LOGIN_SECRET for src in sources):
            problems.append(f"volume {volume.get('name')!r} mounts {LOGIN_SECRET}")
    containers = list(pod_spec.get("initContainers") or []) + list(pod_spec.get("containers") or [])
    for container in containers:
        name = container.get("name")
        for source in container.get("envFrom") or []:
            if (source.get("secretRef") or {}).get("name") == LOGIN_SECRET:
                problems.append(f"container {name!r} loads all of {LOGIN_SECRET} (envFrom)")
        for env in container.get("env") or []:
            literal = _literal_credential(env)
            if literal:
                problems.append(f"container {name!r} {literal}")
            ref = (env.get("valueFrom") or {}).get("secretKeyRef") or {}
            if ref.get("name") != LOGIN_SECRET:
                continue
            key = ref.get("key")
            if key not in TEMPLATE_KEYS:
                problems.append(
                    f"container {name!r} takes key {key!r}, which no container may take"
                )
            elif key.startswith("ctl_") and name != controller:
                problems.append(f"container {name!r} takes the controller's login ({key})")
            elif key.startswith("ctl_") and not split:
                problems.append(f"container {name!r} takes {key} on a box that isn't split")
    return problems


def check_template_main(argv: list[str] | None = None) -> int:
    """`switch-egress-check-template POD_SPEC.json [--split]`: render-user runs it on the rendered StatefulSet
    (as JSON, from `kubectl create --dry-run=client -o json`) and refuses to apply on any problem."""
    import sys

    args = list(sys.argv[1:] if argv is None else argv)
    split = "--split" in args
    paths = [a for a in args if a != "--split"]
    if len(paths) != 1:
        print("usage: switch-egress-check-template STATEFULSET.json [--split]", file=sys.stderr)
        return 2
    doc = json.loads(Path(paths[0]).read_text())
    spec = doc.get("spec", {}).get("template", {}).get("spec", doc)
    problems = check_box_pod_spec(spec, split)
    for problem in problems:
        print(f"REFUSE: {problem}", file=sys.stderr)
    return 1 if problems else 0


# ---- the loop ----


def run(
    kube: EgressKube,
    load: Callable[[], list[BoxEgress]],
    proxy: str,
    interval: float = 30.0,
    stop: Callable[[], bool] = lambda: False,
    sleep: Callable[[float], None] = time.sleep,
) -> None:
    """Re-reads the settings and box map every pass, so an edit applies within one interval. A read that is refused
    leaves squid's current files as they are: the error says which part, and nothing is rewritten."""
    while not stop():
        try:
            boxes = load()
        except (EgressConfigError, ScalerConfigError, OSError, ValueError) as error:
            logger.error("Egress: the settings or box map was refused, nothing changed: %s", error)
        else:
            try:
                reconcile_once(kube, boxes, proxy)
            except Exception as error:
                logger.error("Egress: pass failed (%s); retrying", type(error).__name__)
        sleep(interval)


ENV_DEFAULT_PARTS = (
    "SWITCH_EGRESS_DEFAULT_PARTS"  # comma-separated; roll-out step 2 is "github", step 3 is ""
)
# A box with no entry of its own (every box provisioning makes) is split unless this says otherwise: template v2.3's controller
# reads `ctl_https_proxy`, so without it the box's pod can't start.
ENV_DEFAULT_SPLIT = "SWITCH_EGRESS_DEFAULT_SPLIT"
ENV_PROXY = "SWITCH_EGRESS_PROXY"  # host:port of squid, as boxes reach it
PROXY_RE = re.compile(r"[a-z0-9.-]+:[0-9]{1,5}")
SA_DIR = Path("/var/run/secrets/kubernetes.io/serviceaccount")


def default_split_from_env(env: Mapping[str, str]) -> bool:
    value = env.get(ENV_DEFAULT_SPLIT, "true").strip() or "true"
    if value not in ("true", "false"):
        raise EgressConfigError(f"{ENV_DEFAULT_SPLIT} must be true or false")
    return value == "true"


def main(env: Mapping[str, str] | None = None, sa_dir: Path = SA_DIR) -> int:
    """`switch-egress-lists`: in the cluster, under its own service account, egress-lists. The box map and
    the settings are read through the API each pass, by name; the account's token is read fresh on every call."""
    from .workers_main import (
        InClusterKubeApi,
        in_cluster_server,
    )  # the same fresh-token client the workers use

    env = os.environ if env is None else env
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    proxy = env.get(ENV_PROXY, "squid.egress-proxy.svc:3128")
    parts = tuple(p for p in env.get(ENV_DEFAULT_PARTS, "").split(",") if p)
    if not PROXY_RE.fullmatch(proxy):
        logger.error("%s must be host:port", ENV_PROXY)
        return 2
    try:
        split = default_split_from_env(env)
        server = in_cluster_server(env)
    except (
        ValueError
    ) as error:  # EgressConfigError, WorkersConfigError: their messages name no value
        logger.error("Not starting: %s", error)
        return 2
    api = EgressKubeApi(InClusterKubeApi(server, sa_dir / "token", str(sa_dir / "ca.crt"))._call)
    stopping = {"now": False}
    signal.signal(signal.SIGTERM, lambda *_: stopping.__setitem__("now", True))
    run(
        api,
        lambda: parse_egress(api.settings(), api.box_map(), parts, split),
        proxy,
        stop=lambda: stopping["now"],
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
