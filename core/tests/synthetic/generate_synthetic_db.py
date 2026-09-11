#!/usr/bin/env python3
"""Generate a synthetic Switch database matching a measured production shape.

This exists so the multi-tenancy migrations (and any future schema change)
can be rehearsed against a database that is the right *size* without anyone
touching a real customer dump. Nothing in this file is derived from actual
customer content — every id, name, body and blob below is built from an
obviously-fake vocabulary (``synthetic.test`` addresses, ``lorem``/``fake``
word lists, ``SYNTHETIC-FAKE-...`` filler bytes). Only the row counts and
length/size *distributions* below are grounded in reality: they were measured
against a throwaway restore of a production dump on 2026-09-10, then each
rounded to a clean number of the same order of magnitude before being written
here as named constants — so what follows is indicative of the shape of a
real deployment, not an exact snapshot of one, and can be refreshed later
without touching the generation logic.

Usage::

    cd core
    DB_HOST=localhost DB_PORT=5432 DB_USER=postgres DB_PASSWORD=postgres \\
        DB_NAME=switch_synthetic \\
        .venv/bin/python tests/synthetic/generate_synthetic_db.py

    # 5x the baseline row counts (text/blob sizes are unaffected):
    .venv/bin/python tests/synthetic/generate_synthetic_db.py --scale-factor 5

The target database must not already hold a Switch schema newer than
``BASE_REVISION`` below. If ``alembic_version`` is absent, the script runs
``alembic upgrade`` to ``BASE_REVISION`` itself (the pre-tenant-model schema,
the one a fresh production restore is on before the multi-tenancy migrations
land) before inserting anything, so the database this produces is ready for
the exact test the multi-tenancy work needs: measuring `alembic upgrade head`
against realistic volume. Pass ``--upgrade-head`` to also run the full stack
of pending migrations afterward and print how long that took.

Every large table is bulk-loaded with `asyncpg`'s `COPY` protocol rather than
row-by-row `INSERT`, since the two tables that matter for migration timing
(``messages``, ``bridge_message_map``) run into the tens of thousands of rows
at the 1x baseline — and considerably more at a higher ``--scale-factor``.
"""

import argparse
import asyncio
import json
import math
import os
import random
import subprocess
import time
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import asyncpg

CORE_DIR = Path(__file__).resolve().parents[2]

# The revision a fresh production restore is on — i.e. the schema *before*
# the tenant-model and row-level-security migrations. Generating at this
# revision, not at alembic head, is the point: it lets `alembic upgrade head`
# be timed against this database the same way it was timed against the real
# restore.
BASE_REVISION = "b47e0c39a1f5"

# ── Row counts and distributions, measured 2026-09-10 ───────────────────────
# Source: `pg_restore` of a production dump into a throwaway container,
# aggregate-only queries (row counts, `pg_size_pretty`, `percentile_cont`).
# No row from that database is reproduced here — only these figures, and each
# one is rounded to a clean number of the same order of magnitude so no exact
# measurement from that database is published, only its rough shape.
ROOMS = 700
ROOMS_WITH_MESSAGES_FRACTION = 0.7  # ~500 / 700 rooms had messages, rounded
USERS = 80
CLIENTS = 500
API_KEYS = 600
AGENTS = 300
TOOLS_PER_AGENT_MEAN = 10  # ~3000 tools / 300 agents, rounded
MODELS = 20
COLLABORATION_BRIDGES = 6
ROOM_GROUPS = 20
CLIENT_ROOMS = 5000  # ~7 memberships per room, rounded
ROOM_AGENTS = 2000  # ~3 agents per room, rounded
AGENT_SESSIONS = 700
AGENT_RUNTIME_STATES = 900
MESSAGES = 63000
# event_type mix measured across all messages, rounded to the nearest
# percentage point
EVENT_TYPE_WEIGHTS = {
    "m.room.message": 0.7,
    "com.switch.report.tool_call": 0.2,
    "m.room.member": 0.09,
    "com.switch.command": 0.02,
}
MESSAGE_BODY_LEN_MEDIAN = 300
MESSAGE_BODY_LEN_MEAN = 600
BRIDGE_MESSAGE_MAP = 40000
MEDIA_BLOBS = 200
MEDIA_BLOB_SIZE_MEDIAN = 100_000
MEDIA_BLOB_SIZE_MEAN = 500_000
MEDIA_BLOB_SIZE_MAX = 10_000_000
MESSAGE_ATTACHMENTS = 1000
ATTACHMENT_SIZE_MEDIAN = 100_000
ATTACHMENT_SIZE_MEAN = 400_000
ATTACHMENT_SIZE_MAX = 20_000_000
DOCUMENTS = 60
TASKS = 80
ROOM_ROLES = 50
ROLE_LEASES = 20
ROOM_LINKS = 700
EXTERNAL_USERS = 200
EXTERNAL_USER_CLAIMS = 40
OIDC_IDENTITIES = 50
REFERENCES = 50
ROOM_REFERENCES = 400
PACKAGE_DOCUMENTS = 20
# Tables that were empty (or a single bootstrap row) in the measured
# production shape. Kept at that order of magnitude rather than invented,
# and held fixed regardless of --scale-factor: a bigger deployment does not
# have more feature-flag rows or more "the one active package" rows, these
# are singleton config tables rather than volume tables.
PACKAGES = 1
ROOM_PACKAGES = 1
ROOM_DOCUMENTS = 1
SERVER_CONNECTORS = 1
FEATURE_FLAGS = 1

_WORDS = [
    "lorem",
    "synthetic",
    "fake",
    "placeholder",
    "alpha",
    "beta",
    "gamma",
    "widget",
    "sample",
    "dummy",
    "stub",
    "mock",
    "filler",
    "foo",
    "bar",
    "baz",
    "qux",
    "example",
    "test",
    "zzz",
]


def _rand_id(prefix: str, i: int) -> str:
    return f"syn-{prefix}-{i:07d}"


def _scaled(n: int, scale: float) -> int:
    """Apply --scale-factor to a baseline row count.

    Only row counts go through this — text lengths, blob sizes and
    distribution weights are shape parameters, not volume, and stay fixed
    regardless of scale.
    """
    return max(1, round(n * scale))


def _lognormal_params(median: float, mean: float) -> tuple[float, float]:
    """Derive lognormal (mu, sigma) from a target median and mean.

    Solved from median = exp(mu) and mean = exp(mu + sigma^2/2).
    """
    mu = math.log(median)
    sigma_sq = 2 * math.log(mean / median)
    return mu, math.sqrt(max(sigma_sq, 1e-6))


def _lognormal_len(median: float, mean: float, lo: int, hi: int) -> int:
    mu, sigma = _lognormal_params(median, mean)
    return int(min(max(random.lognormvariate(mu, sigma), lo), hi))


def _lorem_text(length: int) -> str:
    if length <= 0:
        return ""
    words = []
    total = 0
    while total < length:
        w = random.choice(_WORDS)
        words.append(w)
        total += len(w) + 1
    return " ".join(words)[:length]


def _fake_bytes(tag: str, size: int) -> bytes:
    """An obviously-fake blob of a given size that still costs disk space.

    A repeated marker string alone would compress to almost nothing under
    Postgres's TOAST/pglz storage, understating what real (already-compressed
    image/PDF/etc.) attachments cost — the marker is a prefix, the rest is
    `os.urandom`, which is exactly as incompressible as real binary media.
    """
    marker = f"SYNTHETIC-FAKE-BLOB-{tag}-".encode()
    if size <= 0:
        return b""
    if size <= len(marker):
        return marker[:size]
    return marker + os.urandom(size - len(marker))


class IdPool:
    """Tracks generated ids per table so children can pick real parents."""

    def __init__(self) -> None:
        self.ids: dict[str, list[str]] = {}

    def add(self, table: str, ids: Sequence[str]) -> None:
        self.ids.setdefault(table, []).extend(ids)

    def sample(self, table: str) -> str:
        return random.choice(self.ids[table])

    def sample_n(self, table: str, n: int) -> list[str]:
        pool = self.ids[table]
        return [random.choice(pool) for _ in range(n)]


async def _copy(
    conn: asyncpg.Connection,
    table: str,
    columns: Sequence[str],
    rows: Sequence[Sequence[Any]],
) -> None:
    if not rows:
        return
    await conn.copy_records_to_table(table, records=rows, columns=columns)


def _ensure_fake_app_env() -> None:
    """Fill in the non-DB config Alembic's `env.py` requires, if unset.

    `SwitchConfig` has no defaults for these — by design, per the project's
    fail-loud convention — so a bare `alembic upgrade` fails outside a
    configured stack. This script only needs the schema, so it supplies
    obviously-fake values rather than asking the caller to.
    """
    os.environ.setdefault("MATRIX_SERVER_NAME", "synthetic.test")
    os.environ.setdefault(
        "AGENT_REGISTRATION_TOKEN", "synthetic-fake-token-0000000000000000"
    )
    os.environ.setdefault(
        "JWT_SECRET_KEY", "synthetic-fake-jwt-secret-0000000000000000"
    )
    os.environ.setdefault("GATEWAY_ADMIN_EMAIL", "admin@synthetic.test")
    os.environ.setdefault("GATEWAY_ADMIN_PASSWORD", "synthetic-fake-admin-pw-0000")


def _run_alembic(*args: str) -> None:
    venv_alembic = CORE_DIR / ".venv" / "bin" / "alembic"
    alembic_bin = str(venv_alembic) if venv_alembic.exists() else "alembic"
    subprocess.run([alembic_bin, *args], cwd=CORE_DIR, check=True)


async def _schema_revision(conn: asyncpg.Connection) -> str | None:
    exists = await conn.fetchval("SELECT to_regclass('public.alembic_version')")
    if exists is None:
        return None
    version_num: str | None = await conn.fetchval(
        "SELECT version_num FROM alembic_version"
    )
    return version_num


async def generate(dsn: str, scale: float) -> None:
    if scale <= 0:
        raise ValueError(f"--scale-factor must be positive, got {scale!r}")

    conn = await asyncpg.connect(dsn)
    try:
        revision = await _schema_revision(conn)
        if revision is None:
            print(f"No schema found; building it at {BASE_REVISION}...")
            await conn.close()
            _ensure_fake_app_env()
            _run_alembic("upgrade", BASE_REVISION)
            conn = await asyncpg.connect(dsn)
        elif revision != BASE_REVISION:
            raise RuntimeError(
                f"Database is at revision {revision!r}, expected "
                f"{BASE_REVISION!r} (the pre-tenant-model schema). Point this "
                "script at an empty database or one already at that revision."
            )
        else:
            print(f"Schema already at {BASE_REVISION}.")

        # ── scaled row counts ────────────────────────────────────────────
        # Row counts scale with --scale-factor; text/blob-size distributions
        # and event-type/fraction weights do not (see _scaled's docstring).
        rooms_n = _scaled(ROOMS, scale)
        users_n = _scaled(USERS, scale)
        clients_n = _scaled(CLIENTS, scale)
        api_keys_n = _scaled(API_KEYS, scale)
        agents_n = _scaled(AGENTS, scale)
        models_n = _scaled(MODELS, scale)
        collaboration_bridges_n = _scaled(COLLABORATION_BRIDGES, scale)
        room_groups_n = _scaled(ROOM_GROUPS, scale)
        client_rooms_n = _scaled(CLIENT_ROOMS, scale)
        room_agents_n = _scaled(ROOM_AGENTS, scale)
        agent_sessions_n = _scaled(AGENT_SESSIONS, scale)
        agent_runtime_states_n = _scaled(AGENT_RUNTIME_STATES, scale)
        messages_n = _scaled(MESSAGES, scale)
        bridge_message_map_n = _scaled(BRIDGE_MESSAGE_MAP, scale)
        media_blobs_n = _scaled(MEDIA_BLOBS, scale)
        message_attachments_n = _scaled(MESSAGE_ATTACHMENTS, scale)
        documents_n = _scaled(DOCUMENTS, scale)
        tasks_n = _scaled(TASKS, scale)
        room_roles_n = _scaled(ROOM_ROLES, scale)
        role_leases_n = _scaled(ROLE_LEASES, scale)
        room_links_n = _scaled(ROOM_LINKS, scale)
        external_users_n = _scaled(EXTERNAL_USERS, scale)
        external_user_claims_n = _scaled(EXTERNAL_USER_CLAIMS, scale)
        oidc_identities_n = _scaled(OIDC_IDENTITIES, scale)
        references_n = _scaled(REFERENCES, scale)
        room_references_n = _scaled(ROOM_REFERENCES, scale)
        package_documents_n = _scaled(PACKAGE_DOCUMENTS, scale)
        # Bootstrap/config tables: fixed size regardless of deployment scale.
        packages_n = PACKAGES
        room_packages_n = ROOM_PACKAGES
        room_documents_n = ROOM_DOCUMENTS
        server_connectors_n = SERVER_CONNECTORS
        feature_flags_n = FEATURE_FLAGS

        pool = IdPool()
        t0 = time.monotonic()

        # ── users ────────────────────────────────────────────────────────
        user_ids = [_rand_id("user", i) for i in range(users_n)]
        pool.add("users", user_ids)
        await _copy(
            conn,
            "users",
            ["id", "name", "email", "role", "metadata"],
            [
                (
                    uid,
                    f"Synthetic User {i}",
                    f"user{i}@synthetic.test",
                    "admin" if i == 0 else "member",
                    None,
                )
                for i, uid in enumerate(user_ids)
            ],
        )

        # ── clients ──────────────────────────────────────────────────────
        client_ids = [_rand_id("client", i) for i in range(clients_n)]
        pool.add("clients", client_ids)
        await _copy(
            conn,
            "clients",
            ["id", "matrix_user_id", "display_name", "type", "config"],
            [
                (
                    cid,
                    f"@synthetic-client-{i}:synthetic.test",
                    f"Synthetic Client {i}",
                    "agent" if i < agents_n else "bridge",
                    None,
                )
                for i, cid in enumerate(client_ids)
            ],
        )

        # ── api_keys ─────────────────────────────────────────────────────
        api_key_ids = [_rand_id("apikey", i) for i in range(api_keys_n)]
        pool.add("api_keys", api_key_ids)
        await _copy(
            conn,
            "api_keys",
            ["id", "user_id", "key_hash", "label", "encrypted_key", "type"],
            [
                (
                    kid,
                    pool.sample("users"),
                    f"synthetic-fake-hash-{i:07d}",
                    f"Synthetic key {i}",
                    f"synthetic-fake-encrypted-{i:07d}",
                    "registration",
                )
                for i, kid in enumerate(api_key_ids)
            ],
        )

        # ── agents (one per agent-typed client) ─────────────────────────
        agent_ids = [_rand_id("agent", i) for i in range(agents_n)]
        pool.add("agents", agent_ids)
        await _copy(
            conn,
            "agents",
            [
                "id",
                "name",
                "description",
                "connector_type",
                "integration_profile",
                "client_id",
                "api_key_id",
                "agent_type",
                "display_name",
            ],
            [
                (
                    aid,
                    f"synthetic-agent-{i}",
                    "Synthetic agent generated for shape testing.",
                    "claude-code",
                    '{"synthetic": true}',
                    client_ids[i],
                    api_key_ids[i % api_keys_n],
                    "worker",
                    f"Synthetic Agent {i}",
                )
                for i, aid in enumerate(agent_ids)
            ],
        )

        # ── tools ────────────────────────────────────────────────────────
        tool_rows = []
        tool_i = 0
        for agent_id in agent_ids:
            n = max(1, int(random.gauss(TOOLS_PER_AGENT_MEAN, 2)))
            for _ in range(n):
                tool_rows.append(
                    (
                        _rand_id("tool", tool_i),
                        f"synthetic_tool_{tool_i}",
                        "Synthetic tool generated for shape testing.",
                        agent_id,
                        None,
                        None,
                    )
                )
                tool_i += 1
        await _copy(
            conn,
            "tools",
            ["id", "name", "description", "agent_id", "args_schema", "metadata"],
            tool_rows,
        )

        # ── models ───────────────────────────────────────────────────────
        await _copy(
            conn,
            "models",
            ["id", "name", "description", "agent_id", "metadata"],
            [
                (
                    _rand_id("model", i),
                    f"synthetic-model-{i}",
                    "Synthetic model generated for shape testing.",
                    pool.sample("agents"),
                    None,
                )
                for i in range(models_n)
            ],
        )

        # ── collaboration_bridges ────────────────────────────────────────
        bridge_ids = [_rand_id("bridge", i) for i in range(collaboration_bridges_n)]
        pool.add("collaboration_bridges", bridge_ids)
        await _copy(
            conn,
            "collaboration_bridges",
            [
                "id",
                "type",
                "display_name",
                "connection_config",
                "client_id",
                "status",
                "is_default",
            ],
            [
                (
                    bid,
                    "slack",
                    f"Synthetic Bridge {i}",
                    None,
                    client_ids[(agents_n + i) % clients_n],
                    "active",
                    i == 0,
                )
                for i, bid in enumerate(bridge_ids)
            ],
        )

        # ── room_groups ──────────────────────────────────────────────────
        group_ids = [_rand_id("group", i) for i in range(room_groups_n)]
        pool.add("room_groups", group_ids)
        await _copy(
            conn,
            "room_groups",
            ["id", "name", "description"],
            [
                (gid, f"Synthetic Group {i}", "Synthetic room group.")
                for i, gid in enumerate(group_ids)
            ],
        )

        # ── rooms ────────────────────────────────────────────────────────
        room_ids = [_rand_id("room", i) for i in range(rooms_n)]
        pool.add("rooms", room_ids)
        await _copy(
            conn,
            "rooms",
            [
                "id",
                "matrix_room_id",
                "name",
                "description",
                "bridge_id",
                "admin_mode",
                "read_visibility",
                "write_visibility",
                "group_id",
            ],
            [
                (
                    rid,
                    f"!synthetic-room-{i}:synthetic.test",
                    f"synthetic-room-{i}",
                    _lorem_text(116),
                    bridge_ids[i % collaboration_bridges_n] if i % 3 == 0 else None,
                    False,
                    "public",
                    "public",
                    group_ids[i % room_groups_n] if i % 10 == 0 else None,
                )
                for i, rid in enumerate(room_ids)
            ],
        )

        # ── client_rooms ─────────────────────────────────────────────────
        seen_client_room: set[tuple[str, str]] = set()
        client_room_rows: list[tuple[str, str]] = []
        while len(client_room_rows) < client_rooms_n:
            pair = (random.choice(client_ids), random.choice(room_ids))
            if pair in seen_client_room:
                continue
            seen_client_room.add(pair)
            client_room_rows.append(pair)
        await _copy(conn, "client_rooms", ["client_id", "room_id"], client_room_rows)

        # ── room_agents ──────────────────────────────────────────────────
        seen_room_agent: set[tuple[str, str]] = set()
        room_agent_rows: list[tuple[str, str, bool]] = []
        while len(room_agent_rows) < room_agents_n:
            pair = (random.choice(room_ids), random.choice(agent_ids))
            if pair in seen_room_agent:
                continue
            seen_room_agent.add(pair)
            room_agent_rows.append((*pair, False))
        await _copy(
            conn,
            "room_agents",
            ["room_id", "agent_id", "receives_join_events"],
            room_agent_rows,
        )

        # ── agent_sessions ───────────────────────────────────────────────
        # Unique on (agent_id, coalesce(room_id, '')), so pairs are deduped
        # the same way client_rooms/room_agents are below.
        seen_sessions: set[tuple[str, str]] = set()
        session_rows: list[tuple[str, str, str, str]] = []
        while len(session_rows) < agent_sessions_n:
            pair = (random.choice(agent_ids), random.choice(room_ids))
            if pair in seen_sessions:
                continue
            seen_sessions.add(pair)
            session_rows.append(
                (
                    _rand_id("session", len(session_rows)),
                    *pair,
                    random.choice(["running", "stopped", "idle"]),
                )
            )
        await _copy(
            conn,
            "agent_sessions",
            ["id", "agent_id", "room_id", "lifecycle"],
            session_rows,
        )

        # ── agent_runtime_states ─────────────────────────────────────────
        seen_ars: set[tuple[str, str]] = set()
        ars_rows: list[tuple[str, str, str, str]] = []
        while len(ars_rows) < agent_runtime_states_n:
            pair = (random.choice(agent_ids), random.choice(room_ids))
            if pair in seen_ars:
                continue
            seen_ars.add(pair)
            ars_rows.append((_rand_id("ars", len(ars_rows)), *pair, "connected"))
        await _copy(
            conn,
            "agent_runtime_states",
            ["id", "agent_id", "room_id", "state"],
            ars_rows,
        )

        # ── messages ─────────────────────────────────────────────────────
        active_rooms = random.sample(
            room_ids, int(len(room_ids) * ROOMS_WITH_MESSAGES_FRACTION)
        )
        message_ids: list[str] = []
        message_rows = []
        seq_by_room: dict[str, int] = dict.fromkeys(active_rooms, 0)
        event_types = list(EVENT_TYPE_WEIGHTS)
        event_weights = list(EVENT_TYPE_WEIGHTS.values())
        i = 0
        # Per-room counts drawn from a heavy-tailed distribution (a handful
        # of very active rooms, most modest), then scaled so the sum lands
        # close to messages_n (rounding keeps it within a room-count's worth).
        per_room_counts = [
            max(1, _lognormal_len(34, 136, 1, 5000)) for _ in active_rooms
        ]
        per_room_scale = messages_n / max(sum(per_room_counts), 1)
        per_room_counts = [max(1, int(c * per_room_scale)) for c in per_room_counts]
        for room_id, count in zip(active_rooms, per_room_counts, strict=False):
            for _ in range(count):
                event_type = random.choices(event_types, weights=event_weights)[0]
                body_len = _lognormal_len(
                    MESSAGE_BODY_LEN_MEDIAN, MESSAGE_BODY_LEN_MEAN, 0, 36000
                )
                body = _lorem_text(body_len)
                sender_client_id = random.choice(client_ids)
                mid = _rand_id("msg", i)
                seq_by_room[room_id] += 1
                content: dict[str, Any] = {
                    "msgtype": "m.text",
                    "body": body,
                    "sender_name": f"Synthetic Sender {i % users_n}",
                }
                if event_type == "com.switch.report.tool_call":
                    content["result"] = _lorem_text(
                        _lognormal_len(500, 2000, 10, 50000)
                    )
                    content["duration_ms"] = random.randint(10, 60000)
                    content["agent_id"] = random.choice(agent_ids)
                message_rows.append(
                    (
                        mid,
                        seq_by_room[room_id],
                        room_id,
                        f"synthetic-txn-{i:08d}",
                        sender_client_id,
                        sender_client_id,
                        f"Synthetic Sender {i % users_n}",
                        event_type,
                        "m.text" if event_type == "m.room.message" else None,
                        body,
                        None,
                        None,
                        _json(content),
                    )
                )
                message_ids.append(mid)
                i += 1
                if i >= messages_n:
                    break
            if i >= messages_n:
                break
        pool.add("messages", message_ids)
        await _copy(
            conn,
            "messages",
            [
                "id",
                "seq",
                "room_id",
                "transport_event_id",
                "sender_id",
                "sender_client_id",
                "sender_name",
                "event_type",
                "msgtype",
                "body",
                "formatted_body",
                "thread_root_event_id",
                "content",
            ],
            message_rows,
        )

        # ── bridge_message_map ───────────────────────────────────────────
        # No FK to `messages` in this schema (see the migration's own
        # docstring) — transport_event_id is a free-standing text column, so
        # this can be sized independently of how many message ids exist.
        await _copy(
            conn,
            "bridge_message_map",
            [
                "id",
                "bridge_id",
                "external_channel_id",
                "transport_event_id",
                "external_post_id",
            ],
            [
                (
                    _rand_id("bmm", i),
                    random.choice(bridge_ids),
                    f"synthetic-channel-{i % rooms_n}",
                    f"synthetic-txn-{i:08d}",
                    f"synthetic-post-{i:08d}",
                )
                for i in range(bridge_message_map_n)
            ],
        )

        # ── media_blobs ──────────────────────────────────────────────────
        media_rows = []
        for i in range(media_blobs_n):
            size = _lognormal_len(
                MEDIA_BLOB_SIZE_MEDIAN, MEDIA_BLOB_SIZE_MEAN, 100, MEDIA_BLOB_SIZE_MAX
            )
            media_rows.append(
                (
                    _rand_id("blob", i),
                    f"synthetic://blobs/{i:07d}",
                    "application/octet-stream",
                    f"synthetic-file-{i}.bin",
                    size,
                    _fake_bytes(str(i), size),
                )
            )
        await _copy(
            conn,
            "media_blobs",
            ["id", "uri", "content_type", "filename", "size", "data"],
            media_rows,
        )

        # ── message_attachments ──────────────────────────────────────────
        attachment_message_ids = pool.sample_n("messages", message_attachments_n)
        await _copy(
            conn,
            "message_attachments",
            ["id", "message_id", "position", "uri", "filename", "mimetype", "size"],
            [
                (
                    _rand_id("att", i),
                    mid,
                    0,
                    f"synthetic://attachments/{i:07d}",
                    f"synthetic-attachment-{i}.bin",
                    "application/octet-stream",
                    _lognormal_len(
                        ATTACHMENT_SIZE_MEDIAN,
                        ATTACHMENT_SIZE_MEAN,
                        20,
                        ATTACHMENT_SIZE_MAX,
                    ),
                )
                for i, mid in enumerate(attachment_message_ids)
            ],
        )

        # ── documents ────────────────────────────────────────────────────
        document_ids = [_rand_id("doc", i) for i in range(documents_n)]
        pool.add("documents", document_ids)
        await _copy(
            conn,
            "documents",
            [
                "id",
                "description",
                "content",
                "name",
                "instructions",
                "room_id",
                "owner_id",
                "read_visibility",
                "write_visibility",
            ],
            [
                (
                    did,
                    "Synthetic document.",
                    _lorem_text(400),
                    f"synthetic-doc-{i}",
                    "Synthetic instructions.",
                    room_ids[i % rooms_n] if i % 2 == 0 else None,
                    pool.sample("users"),
                    "public",
                    "public",
                )
                for i, did in enumerate(document_ids)
            ],
        )

        # ── tasks ────────────────────────────────────────────────────────
        await _copy(
            conn,
            "tasks",
            [
                "id",
                "room_id",
                "requester_agent_id",
                "performer_agent_id",
                "description",
                "status",
                "summary",
            ],
            [
                (
                    _rand_id("task", i),
                    random.choice(room_ids),
                    random.choice(agent_ids),
                    random.choice(agent_ids),
                    _lorem_text(200),
                    random.choice(["open", "accepted", "finalised"]),
                    _lorem_text(100),
                )
                for i in range(tasks_n)
            ],
        )

        # ── room_roles ───────────────────────────────────────────────────
        role_rows: list[tuple[str, str, str, str]] = []
        used_role_names: set[tuple[str, str]] = set()
        role_ids: list[tuple[str, str]] = []
        i = 0
        while len(role_rows) < room_roles_n:
            room_id = random.choice(room_ids)
            key = (room_id, f"synthetic-role-{i}")
            if key in used_role_names:
                i += 1
                continue
            used_role_names.add(key)
            rid = _rand_id("role", i)
            role_ids.append((rid, room_id))
            role_rows.append((rid, room_id, f"synthetic-role-{i}", "Synthetic role."))
            i += 1
        await _copy(
            conn, "room_roles", ["id", "room_id", "name", "instructions"], role_rows
        )

        # ── role_leases (unique per agent) ───────────────────────────────
        lease_agents = random.sample(agent_ids, min(role_leases_n, len(agent_ids)))
        await _copy(
            conn,
            "role_leases",
            ["id", "role_id", "room_id", "agent_id"],
            [
                (
                    _rand_id("lease", i),
                    role_ids[i % len(role_ids)][0],
                    role_ids[i % len(role_ids)][1],
                    agent_id,
                )
                for i, agent_id in enumerate(lease_agents)
            ],
        )

        # ── room_links ───────────────────────────────────────────────────
        seen_links: set[tuple[str, str]] = set()
        link_rows: list[tuple[str, str, str]] = []
        while len(link_rows) < room_links_n:
            a, b = random.choice(room_ids), random.choice(room_ids)
            if a == b or (a, b) in seen_links:
                continue
            seen_links.add((a, b))
            link_rows.append((a, b, "synthetic-link"))
        await _copy(
            conn,
            "room_links",
            ["source_room_id", "target_room_id", "label"],
            link_rows,
        )

        # ── external_users / claims ──────────────────────────────────────
        external_user_ids = [_rand_id("extuser", i) for i in range(external_users_n)]
        pool.add("external_users", external_user_ids)
        await _copy(
            conn,
            "external_users",
            [
                "id",
                "bridge_id",
                "external_user_id",
                "external_username",
                "client_id",
            ],
            [
                (
                    eid,
                    random.choice(bridge_ids),
                    f"synthetic-external-{i:07d}",
                    f"synthetic.external.user.{i}",
                    random.choice(client_ids),
                )
                for i, eid in enumerate(external_user_ids)
            ],
        )
        claim_pairs = list(
            zip(
                random.sample(
                    external_user_ids,
                    min(external_user_claims_n, external_users_n),
                ),
                pool.sample_n("users", external_user_claims_n),
                strict=False,
            )
        )
        await _copy(
            conn,
            "external_user_claims",
            ["external_user_id", "user_id"],
            claim_pairs,
        )

        # ── oidc_identities ──────────────────────────────────────────────
        await _copy(
            conn,
            "oidc_identities",
            ["id", "user_id", "iss", "sub"],
            [
                (
                    _rand_id("oidc", i),
                    pool.sample("users"),
                    "https://synthetic.test/issuer",
                    f"synthetic-subject-{i:07d}",
                )
                for i in range(oidc_identities_n)
            ],
        )

        # ── references / room_references ────────────────────────────────
        reference_ids = [_rand_id("ref", i) for i in range(references_n)]
        pool.add("references", reference_ids)
        await _copy(
            conn,
            "references",
            [
                "id",
                "owner_id",
                "type",
                "description",
                "value",
                "name",
                "instructions",
                "read_visibility",
                "write_visibility",
            ],
            [
                (
                    rid,
                    pool.sample("users"),
                    "synthetic-type",
                    "Synthetic reference.",
                    '{"synthetic": true}',
                    f"synthetic-ref-{i}",
                    "Synthetic instructions.",
                    "public",
                    "public",
                )
                for i, rid in enumerate(reference_ids)
            ],
        )
        seen_room_refs: set[tuple[str, str]] = set()
        room_ref_rows: list[tuple[str, str]] = []
        while len(room_ref_rows) < room_references_n:
            pair = (random.choice(room_ids), random.choice(reference_ids))
            if pair in seen_room_refs:
                continue
            seen_room_refs.add(pair)
            room_ref_rows.append(pair)
        await _copy(conn, "room_references", ["room_id", "reference_id"], room_ref_rows)

        # ── packages / package_documents / room_packages / room_documents ─
        package_ids = [_rand_id("pkg", i) for i in range(packages_n)]
        await _copy(
            conn,
            "packages",
            [
                "id",
                "owner_id",
                "description",
                "name",
                "instructions",
                "read_visibility",
                "write_visibility",
            ],
            [
                (
                    pid,
                    pool.sample("users"),
                    "Synthetic package.",
                    f"synthetic-package-{i}",
                    "Synthetic instructions.",
                    "public",
                    "public",
                )
                for i, pid in enumerate(package_ids)
            ],
        )
        if package_ids:
            pkg_doc_docs = random.sample(
                document_ids, min(package_documents_n, documents_n)
            )
            await _copy(
                conn,
                "package_documents",
                ["package_id", "document_id"],
                [(package_ids[0], did) for did in pkg_doc_docs],
            )
            await _copy(
                conn,
                "room_packages",
                ["room_id", "package_id"],
                [(room_ids[0], package_ids[0])] if room_packages_n else [],
            )
        if document_ids:
            await _copy(
                conn,
                "room_documents",
                ["room_id", "document_id"],
                [(room_ids[0], document_ids[0])] if room_documents_n else [],
            )

        # ── server_connectors / feature_flags ────────────────────────────
        await _copy(
            conn,
            "server_connectors",
            ["id", "type", "display_name", "api_key_id", "status"],
            [
                (
                    _rand_id("connector", i),
                    "resource",
                    f"Synthetic Connector {i}",
                    api_key_ids[0],
                    "active",
                )
                for i in range(server_connectors_n)
            ],
        )
        await _copy(
            conn,
            "feature_flags",
            ["key", "enabled"],
            [("synthetic-flag", True)] if feature_flags_n else [],
        )

        elapsed = time.monotonic() - t0
        print(f"Generated synthetic database in {elapsed:.1f}s.")
    finally:
        if not conn.is_closed():
            await conn.close()


def _json(obj: dict[str, Any]) -> str:
    return json.dumps(obj)


def _dsn_from_env() -> str:
    host = os.environ["DB_HOST"]
    port = os.environ["DB_PORT"]
    user = os.environ["DB_USER"]
    password = os.environ["DB_PASSWORD"]
    name = os.environ["DB_NAME"]
    return f"postgresql://{user}:{password}@{host}:{port}/{name}"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--scale-factor",
        type=float,
        default=1.0,
        help=(
            "Multiply row counts by this factor (default 1x, the measured "
            "baseline shape). Text/blob-size distributions and event-type "
            "weights are unaffected — a bigger deployment has more rows, "
            "not longer ones."
        ),
    )
    parser.add_argument(
        "--upgrade-head",
        action="store_true",
        help="After generating, run `alembic upgrade head` and time it.",
    )
    args = parser.parse_args()

    dsn = _dsn_from_env()
    asyncio.run(generate(dsn, args.scale_factor))

    if args.upgrade_head:
        _ensure_fake_app_env()
        print("Running `alembic upgrade head`...")
        t0 = time.monotonic()
        _run_alembic("upgrade", "head")
        print(f"alembic upgrade head took {time.monotonic() - t0:.2f}s")


if __name__ == "__main__":
    main()
