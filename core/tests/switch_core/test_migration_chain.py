"""The migration chain is well-formed.

The test suite builds its schema with `Base.metadata.create_all`, so nothing
else here ever loads the migrations — a duplicated revision id or a second
head passes every other test and only fails on a real deployment. These are
cheap enough to run everywhere and catch exactly that class of mistake.
"""

from __future__ import annotations

import ast
import re
from collections import defaultdict
from pathlib import Path

from alembic.config import Config
from alembic.script import ScriptDirectory

_CORE = Path(__file__).resolve().parents[2]
_VERSIONS = _CORE / "switch_core" / "migrations" / "versions"

_REVISION_RE = re.compile(r'^revision: str = "([^"]+)"', re.MULTILINE)


def _script_directory() -> ScriptDirectory:
    config = Config(str(_CORE / "alembic.ini"))
    config.set_main_option("script_location", str(_CORE / "switch_core" / "migrations"))
    return ScriptDirectory.from_config(config)


def test_revision_ids_are_unique() -> None:
    """Two files declaring the same revision id make the graph ambiguous.

    Read from the files rather than through Alembic: Alembic resolves the
    collision itself and the duplicate would go unnoticed here.
    """
    by_revision: dict[str, list[str]] = defaultdict(list)
    for path in _VERSIONS.glob("*.py"):
        match = _REVISION_RE.search(path.read_text())
        if match is not None:
            by_revision[match.group(1)].append(path.name)

    duplicates = {rev: files for rev, files in by_revision.items() if len(files) > 1}
    assert not duplicates, f"duplicate migration revision ids: {duplicates}"


def test_single_head() -> None:
    """Two heads mean `alembic upgrade head` is ambiguous and deployment fails."""
    heads = _script_directory().get_heads()
    assert len(heads) == 1, f"expected exactly one migration head, got {heads}"


def test_every_down_revision_exists() -> None:
    """A migration pointing at a revision that was renamed or removed breaks
    the walk, and does so only when the chain is actually replayed.

    A merge revision names several parents, so compare against
    `_all_down_revisions`, which is a tuple either way.
    """
    script = _script_directory()
    known = {revision.revision for revision in script.walk_revisions()}
    dangling = {
        revision.revision: tuple(
            parent for parent in revision._all_down_revisions if parent not in known
        )
        for revision in script.walk_revisions()
        if any(parent not in known for parent in revision._all_down_revisions)
    }
    assert not dangling, f"migrations pointing at unknown parents: {dangling}"


def test_filename_matches_revision_id() -> None:
    """The `<revision>_<slug>.py` convention is what makes a duplicate visible
    in a directory listing; a file whose name has drifted from its id hides
    one."""
    mismatched: dict[str, str] = {}
    for path in _VERSIONS.glob("*.py"):
        match = _REVISION_RE.search(path.read_text())
        if match is None:
            continue
        revision = match.group(1)
        if not path.name.startswith(f"{revision}_"):
            mismatched[path.name] = revision
    assert not mismatched, (
        f"migration filenames disagree with their revision ids: {mismatched}"
    )


_HOT_TABLES = frozenset({"messages", "agent_events"})

# Revisions that built an index on a hot table before the rule below existed,
# and are applied everywhere now. Two created the table itself, so it was empty.
_INDEXED_A_HOT_TABLE_BEFORE_THE_RULE = frozenset(
    {
        "a3f7c91b8e24",
        "a7e3c1d9f204",
        "b5d2e08c17af",
        "c4d8e2f6a913",
        "c71a4f9d2b83",
        "d8b4f2a6c1e9",
    }
)

_CREATE_INDEX_SQL_RE = re.compile(
    r"CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(IF\s+NOT\s+EXISTS\s+)?"
    r"\S+\s+ON\s+(?:ONLY\s+)?(?:public\.)?(\w+)",
    re.IGNORECASE,
)


def _literal_text(node: ast.AST | None) -> str | None:
    """A string literal's text, with an f-string's placeholders as `{}`."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.JoinedStr):
        return "".join(
            part.value if isinstance(part, ast.Constant) else "{}"
            for part in node.values
        )
    return None


def _batch_tables(upgrade: ast.FunctionDef) -> dict[ast.Call, str | None]:
    """The table each call on a `batch_alter_table` block's operations object
    acts on: `with op.batch_alter_table("messages") as batch_op:` names it
    once, and `batch_op.create_index(name, columns)` does not name it at all."""
    tables: dict[ast.Call, str | None] = {}
    for node in ast.walk(upgrade):
        if not isinstance(node, ast.With | ast.AsyncWith):
            continue
        for item in node.items:
            opened = item.context_expr
            if not (
                isinstance(opened, ast.Call)
                and isinstance(opened.func, ast.Attribute)
                and opened.func.attr == "batch_alter_table"
                and isinstance(item.optional_vars, ast.Name)
            ):
                continue
            keywords = {kw.arg: kw.value for kw in opened.keywords}
            table = _literal_text(
                opened.args[0] if opened.args else keywords.get("table_name")
            )
            name = item.optional_vars.id
            for statement in node.body:
                for call in ast.walk(statement):
                    if (
                        isinstance(call, ast.Call)
                        and isinstance(call.func, ast.Attribute)
                        and isinstance(call.func.value, ast.Name)
                        and call.func.value.id == name
                    ):
                        tables[call] = table
    return tables


def _unguarded_hot_index_builds(source: str) -> list[str]:
    tree = ast.parse(source)
    upgrade = next(
        (
            node
            for node in tree.body
            if isinstance(node, ast.FunctionDef) and node.name == "upgrade"
        ),
        None,
    )
    if upgrade is None:
        return []
    batch_tables = _batch_tables(upgrade)
    found: list[str] = []
    for node in ast.walk(upgrade):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr in {"create_index", "create_unique_constraint"}
        ):
            keywords = {kw.arg: kw.value for kw in node.keywords}
            table = (
                batch_tables[node]
                if node in batch_tables
                else _literal_text(
                    node.args[1] if len(node.args) > 1 else keywords.get("table_name")
                )
            )
            if table not in _HOT_TABLES:
                continue
            guard = keywords.get("if_not_exists")
            guarded = isinstance(guard, ast.Constant) and guard.value is True
            if node.func.attr == "create_unique_constraint" or not guarded:
                found.append(f"line {node.lineno}: {node.func.attr} on {table}")
        text = _literal_text(node)
        if text is None:
            continue
        for match in _CREATE_INDEX_SQL_RE.finditer(text):
            if match.group(2) in _HOT_TABLES and match.group(1) is None:
                found.append(f"line {node.lineno}: CREATE INDEX on {match.group(2)}")
    return found


def test_an_index_on_a_hot_table_can_be_built_ahead_of_the_upgrade() -> None:
    """Building an index inside a revision blocks every write to its table
    until the migration commits, and on `messages` that is every send. An
    operator with a large table builds it `CONCURRENTLY` by hand first, which
    only helps if the revision then skips it: `IF NOT EXISTS` in SQL,
    `if_not_exists=True` on `op.create_index`. A unique constraint cannot be
    skipped that way; add a unique index instead.

    Reads the revision's source, so a table name held in a variable is not
    seen. `b8f2d0c41e57` is the pattern to copy, docstring included.
    """
    offenders: dict[str, list[str]] = {}
    for path in sorted(_VERSIONS.glob("*.py")):
        source = path.read_text()
        match = _REVISION_RE.search(source)
        if match is None or match.group(1) in _INDEXED_A_HOT_TABLE_BEFORE_THE_RULE:
            continue
        builds = _unguarded_hot_index_builds(source)
        if builds:
            offenders[path.name] = builds
    assert not offenders, (
        f"index builds on {sorted(_HOT_TABLES)} an operator cannot do ahead "
        f"of the upgrade: {offenders}"
    )


def test_the_hot_table_check_sees_each_shape_of_index_build() -> None:
    unguarded = """
def upgrade():
    op.create_index("ix_a", "messages", ["room_id"])
    op.create_index("ix_b", table_name="agent_events", columns=["agent_id"])
    op.create_unique_constraint("uq_c", "messages", ["room_id", "seq"])
    op.execute(f"CREATE UNIQUE INDEX {_INDEX} ON messages (seq)")
    op.execute("CREATE INDEX CONCURRENTLY ix_d ON agent_events (seq)")
"""
    guarded = """
def upgrade():
    op.create_index("ix_a", "messages", ["room_id"], if_not_exists=True)
    op.execute(f"CREATE INDEX IF NOT EXISTS {_INDEX} ON messages (seq)")
    op.create_index("ix_e", "rooms", ["tenant_id"])

def downgrade():
    op.create_index("ix_a", "messages", ["room_id"])
"""
    assert len(_unguarded_hot_index_builds(unguarded)) == 5
    assert _unguarded_hot_index_builds(guarded) == []


def test_the_hot_table_check_sees_an_index_built_in_a_batch_block() -> None:
    """`batch_alter_table` names the table once, and its operations take the
    columns where `op.create_index` takes the table, so the table has to be
    read from the block."""
    unguarded = """
def upgrade():
    with op.batch_alter_table("messages") as batch_op:
        batch_op.create_index("ix_a", ["room_id"])
        batch_op.create_unique_constraint("uq_b", ["room_id", "seq"])
    with op.batch_alter_table(table_name="agent_events") as events:
        events.create_index("ix_c", ["agent_id"], unique=True)
"""
    guarded = """
def upgrade():
    with op.batch_alter_table("messages") as batch_op:
        batch_op.create_index("ix_a", ["room_id"], if_not_exists=True)
    with op.batch_alter_table("rooms") as batch_op:
        batch_op.create_index("ix_d", ["tenant_id"])
        op.create_index("ix_e", "rooms", ["name"])
"""
    assert _unguarded_hot_index_builds(unguarded) == [
        "line 4: create_index on messages",
        "line 5: create_unique_constraint on messages",
        "line 7: create_index on agent_events",
    ]
    assert _unguarded_hot_index_builds(guarded) == []
