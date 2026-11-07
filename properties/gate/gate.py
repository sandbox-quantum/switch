#!/usr/bin/env python3
"""The property catalog's gate: reads the catalog and the checkers' tags, runs nothing.

The catalog (`properties/catalog/*.yaml`) lists what Switch promises. Each
checker names the property it checks with a tag on the definition that checks
it, and this script holds the two to account:

* every entry is well formed and its id is unique;
* a tag names a property that exists, at a level that property lists, and
  sits on a definition: a tag in a comment, a docstring or above nothing is
  an error, and a skipped or expected-to-fail test does not count as a checker;
* a `checked` property has a checker at every level it lists, and no gaps;
* a gap is never listed for a level that has a checker, so a stale excuse
  cannot outlive the checker that replaced it;
* a formal property's `spec` names a definition that exists once its model
  does, and a `checked` one has its model tag on exactly that definition.

Tags, by level (`<id>` is the property's id):

    model  `/// @property <id>` directly above a Quint definition
    code   `@pytest.mark.property("<id>")` on a test
    system `@checks("<id>")` on a history check
    ui     `@property <id>` in the doc comment directly above a Bombadil export

An assertion in the server (`always`, `sometimes`, `reachable`, ... from
`antithesis.assertions`) whose message starts with a property id, alone or
before `: `, is evidence at the `system` level: the run's assertion log is read
after the fast lane (`properties/history/assertions.py`). A message that does
not start with an id is not about a catalog property and is left alone.

It needs only PyYAML and Pydantic:

    uv run --no-project --with 'pyyaml>=6,<7' --with 'pydantic>=2,<3' \\
        python properties/gate/gate.py check
    just properties
"""

from __future__ import annotations

import argparse
import ast
import os
import re
import sys
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Self

import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

REPO_ROOT = Path(__file__).resolve().parents[2]

Level = Literal["model", "code", "system", "ui"]
LEVELS: tuple[Level, ...] = ("model", "code", "system", "ui")

ID_PATTERN = re.compile(r"^[a-z][a-z0-9]*\.[a-z][a-z0-9]*(-[a-z0-9]+)*$")
SPEC_PATTERN = re.compile(r"^(?P<path>[^:]+\.qnt)::(?P<name>\w+)$")

SPECS_DIR = "properties/specs"
MODEL_GLOB = f"{SPECS_DIR}/**/*.qnt"
CODE_GLOB = "core/tests/switch_core/properties/**/*.py"
SYSTEM_GLOB = "properties/history/**/*.py"
UI_GLOB = "console/tooling-e2e/src/explore/spec/*.ts"
ASSERT_GLOB = "core/switch_core/**/*.py"
ASSERT_FUNCTIONS = frozenset(
    {"always", "always_or_unreachable", "sometimes", "reachable", "unreachable"}
)
ASSERT_MESSAGE = re.compile(
    r"^(?P<id>[a-z][a-z0-9]*\.[a-z][a-z0-9]*(-[a-z0-9]+)*)(: |$)"
)

BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.DOTALL)
QUINT_DEFINITION = r"(?:pure[ \t]+)?(?:val|def|temporal|action|run)[ \t]+(?P<name>\w+)"
QUINT_TAG = re.compile(
    r"^[ \t]*///[ \t]*@property[ \t]+(?P<id>\S+)[ \t]*\n"
    r"(?:[ \t]*///[^\n]*\n)*"
    rf"(?:[ \t]*{QUINT_DEFINITION})?",
    re.MULTILINE,
)
QUINT_NAME = re.compile(rf"^[ \t]*{QUINT_DEFINITION}", re.MULTILINE)
TS_DOC_COMMENT = re.compile(
    r"/\*\*(?P<body>(?:(?!\*/).)*)\*/\s*(?:export\s+(?:const|function)\s+(?P<name>\w+))?",
    re.DOTALL,
)
TS_TAG = re.compile(r"^\s*\*\s*@property\s+(?P<id>\S+)", re.MULTILINE)

NOT_RUN = {"pytest.mark.skip", "pytest.mark.skipif", "pytest.mark.xfail"}


class Property(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    title: str
    statement: str
    kind: Literal["safety", "liveness", "reachability"]
    formality: Literal["informal", "semi-formal", "formal"]
    levels: list[Level] = Field(min_length=1)
    owner: str
    status: Literal["proposed", "checked", "retired"]
    spec: str | None = None
    notes: str | None = None
    gaps: dict[Level, str] = {}

    @model_validator(mode="after")
    def _consistent(self) -> Self:
        if not ID_PATTERN.match(self.id):
            raise ValueError(f"id {self.id!r} is not `area.kebab-name`")
        if len(set(self.levels)) != len(self.levels):
            raise ValueError("levels lists a level twice")
        for level, reason in self.gaps.items():
            if level not in self.levels:
                raise ValueError(f"gap for {level!r}, which is not one of its levels")
            if not reason.strip():
                raise ValueError(f"gap for {level!r} gives no reason")
        if self.status == "checked" and self.gaps:
            raise ValueError("a checked property has no gaps")
        if self.formality == "formal" and self.spec is None:
            raise ValueError("a formal property names its `spec`")
        if self.formality != "formal" and self.spec is not None:
            raise ValueError("only a formal property has a `spec`")
        if self.spec is not None and not SPEC_PATTERN.match(self.spec):
            raise ValueError(f"spec {self.spec!r} is not `path.qnt::Definition`")
        if self.formality == "formal" and "model" not in self.levels:
            raise ValueError("a formal property is checked at the model level")
        return self


class Catalog(BaseModel):
    model_config = ConfigDict(extra="forbid")

    properties: list[Property]


@dataclass(frozen=True)
class Tag:
    level: Level
    file: str
    target: str


def load_catalog(root: Path) -> tuple[list[Property], list[str]]:
    """The catalog's properties, and every problem found reading it."""
    properties: list[Property] = []
    problems: list[str] = []
    files = sorted((root / "properties" / "catalog").glob("*.yaml"))
    if not files:
        problems.append("properties/catalog has no *.yaml files")
    for path in files:
        label = path.relative_to(root).as_posix()
        try:
            raw = yaml.safe_load(path.read_text(encoding="utf-8"))
            catalog = Catalog.model_validate(raw)
        except (yaml.YAMLError, ValidationError) as error:
            problems.append(f"{label}: {error}")
            continue
        properties.extend(catalog.properties)
    seen: set[str] = set()
    for prop in properties:
        if prop.id in seen:
            problems.append(f"{prop.id}: listed more than once")
        seen.add(prop.id)
    return properties, problems


def _dotted(node: ast.expr) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return f"{_dotted(node.value)}.{node.attr}"
    return ""


def _decorator_name(node: ast.expr) -> str:
    return _dotted(node.func if isinstance(node, ast.Call) else node)


def _python_tags(
    tree: ast.AST, label: str, level: Level, decorator: str
) -> tuple[list[tuple[str, Tag]], list[str]]:
    tags: list[tuple[str, Tag]] = []
    problems: list[str] = []

    def visit(node: ast.AST, not_run: bool) -> None:
        if isinstance(node, ast.ClassDef | ast.FunctionDef | ast.AsyncFunctionDef):
            not_run = not_run or any(
                _decorator_name(d) in NOT_RUN for d in node.decorator_list
            )
            if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef):
                for d in node.decorator_list:
                    if _decorator_name(d) != decorator:
                        continue
                    first = d.args[0] if isinstance(d, ast.Call) and d.args else None
                    if not (
                        isinstance(first, ast.Constant) and isinstance(first.value, str)
                    ):
                        problems.append(
                            f"{label}:{d.lineno}: `{decorator}` on {node.name} "
                            "takes the property id as a string literal"
                        )
                    elif not not_run:
                        tags.append((first.value, Tag(level, label, node.name)))
        for child in ast.iter_child_nodes(node):
            visit(child, not_run)

    visit(tree, False)
    return tags, problems


def _assertion_tags(tree: ast.AST, label: str) -> list[tuple[str, Tag]]:
    """Assertions from the Antithesis SDK whose message names a property."""
    imported = {
        alias.asname or alias.name
        for node in ast.walk(tree)
        if isinstance(node, ast.ImportFrom)
        and node.module is not None
        and node.module.split(".")[0] == "antithesis"
        for alias in node.names
    } & ASSERT_FUNCTIONS
    tags: list[tuple[str, Tag]] = []

    def visit(node: ast.AST, owner: str) -> None:
        if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef):
            owner = node.name
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id in imported
        ):
            message = None
            if len(node.args) > 1:
                message = node.args[1]
            else:
                message = next(
                    (kw.value for kw in node.keywords if kw.arg == "message"), None
                )
            if isinstance(message, ast.Constant) and isinstance(message.value, str):
                match = ASSERT_MESSAGE.match(message.value)
                if match:
                    tags.append((match["id"], Tag("system", label, owner)))
        for child in ast.iter_child_nodes(node):
            visit(child, owner)

    if imported:
        visit(tree, "<module>")
    return tags


def find_tags(root: Path) -> tuple[dict[str, list[Tag]], list[str]]:
    """Each tagged property id with its tags, and every problem found reading them."""
    found: dict[str, list[Tag]] = defaultdict(list)
    problems: list[str] = []

    for path in sorted(root.glob(MODEL_GLOB)):
        label = path.relative_to(root).as_posix()
        text = BLOCK_COMMENT.sub("", path.read_text(encoding="utf-8"))
        for match in QUINT_TAG.finditer(text):
            if match["name"] is None:
                problems.append(
                    f"{label}: tag for {match['id']} is not above a definition"
                )
            else:
                found[match["id"]].append(Tag("model", label, match["name"]))

    for glob, level, decorator in (
        (CODE_GLOB, "code", "pytest.mark.property"),
        (SYSTEM_GLOB, "system", "checks"),
    ):
        for path in sorted(root.glob(glob)):
            label = path.relative_to(root).as_posix()
            try:
                tree = ast.parse(path.read_text(encoding="utf-8"), filename=label)
            except SyntaxError as error:
                problems.append(f"{label}: cannot be read for tags: {error}")
                continue
            tags, tag_problems = _python_tags(tree, label, level, decorator)
            problems.extend(tag_problems)
            for tagged, tag in tags:
                found[tagged].append(tag)

    for path in sorted(root.glob(ASSERT_GLOB)):
        label = path.relative_to(root).as_posix()
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=label)
        except SyntaxError as error:
            problems.append(f"{label}: cannot be read for assertions: {error}")
            continue
        for tagged, tag in _assertion_tags(tree, label):
            found[tagged].append(tag)

    for path in sorted(root.glob(UI_GLOB)):
        label = path.relative_to(root).as_posix()
        for comment in TS_DOC_COMMENT.finditer(path.read_text(encoding="utf-8")):
            for tag in TS_TAG.finditer(comment["body"]):
                if comment["name"] is None:
                    problems.append(
                        f"{label}: tag for {tag['id']} is not above an export"
                    )
                else:
                    found[tag["id"]].append(Tag("ui", label, comment["name"]))
    return found, problems


def _spec_problems(root: Path, prop: Property, tags: list[Tag]) -> list[str]:
    assert prop.spec is not None
    match = SPEC_PATTERN.match(prop.spec)
    assert match is not None
    label = f"{SPECS_DIR}/{match['path']}"
    path = root / label
    if not path.is_file():
        if prop.status == "checked":
            return [f"{prop.id}: checked, but {label} does not exist"]
        return []
    text = BLOCK_COMMENT.sub("", path.read_text(encoding="utf-8"))
    if match["name"] not in {m["name"] for m in QUINT_NAME.finditer(text)}:
        return [f"{prop.id}: {match['name']} is not defined in {label}"]
    if prop.status == "checked" and Tag("model", label, match["name"]) not in tags:
        return [
            f"{prop.id}: checked, but {match['name']} in {label} carries no tag for it"
        ]
    return []


def check(root: Path) -> list[str]:
    """Every way the catalog and the checkers disagree; empty when they agree."""
    properties, problems = load_catalog(root)
    by_id = {prop.id: prop for prop in properties}
    tags, tag_problems = find_tags(root)
    problems.extend(tag_problems)

    for tagged, found in sorted(tags.items()):
        prop = by_id.get(tagged)
        for tag in found:
            where = f"{tag.level} ({tag.file}: {tag.target})"
            if prop is None:
                problems.append(f"{tagged}: tagged at {where}, but not in the catalog")
            elif prop.status == "retired":
                problems.append(f"{tagged}: retired, but still checked at {where}")
            elif tag.level not in prop.levels:
                problems.append(f"{tagged}: checked at {where}, which it does not list")

    for prop in properties:
        found = tags.get(prop.id, [])
        checked_at = {tag.level for tag in found}
        for level in prop.levels:
            if level in checked_at and level in prop.gaps:
                problems.append(
                    f"{prop.id}: lists a gap at {level}, which has a checker"
                )
            if prop.status == "checked" and level not in checked_at:
                problems.append(f"{prop.id}: checked, but nothing checks it at {level}")
        if prop.spec is not None:
            problems.extend(_spec_problems(root, prop, found))
    return problems


def table(root: Path) -> str:
    """Property by level: `yes` a checker exists, `gap` an excuse is listed, `-` neither, blank not needed."""
    properties, _ = load_catalog(root)
    tags, _ = find_tags(root)
    width = max((len(prop.id) for prop in properties), default=0)
    lines = [
        f"{'property':<{width}}  {'status':<8}  "
        + "  ".join(f"{level:<6}" for level in LEVELS)
    ]
    for prop in properties:
        checked_at = {tag.level for tag in tags.get(prop.id, [])}
        cells = []
        for level in LEVELS:
            if level not in prop.levels:
                cells.append("")
            elif level in checked_at:
                cells.append("yes")
            elif level in prop.gaps:
                cells.append("gap")
            else:
                cells.append("-")
        lines.append(
            f"{prop.id:<{width}}  {prop.status:<8}  "
            + "  ".join(f"{cell:<6}" for cell in cells)
        )
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("command", choices=["check", "table"])
    command = parser.parse_args(argv).command
    if command == "table":
        print(table(REPO_ROOT))
        return 0
    problems = check(REPO_ROOT)
    for problem in problems:
        print(
            f"::error::{problem}" if _in_github_actions() else problem, file=sys.stderr
        )
    if problems:
        return 1
    print("The property catalog and its checkers agree.")
    return 0


def _in_github_actions() -> bool:
    return os.environ.get("GITHUB_ACTIONS") == "true"


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
