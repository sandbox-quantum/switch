#!/usr/bin/env python3
"""The property catalog's gate: reads the catalog and the checkers' tags, runs nothing.

The catalog (`properties/catalog/*.yaml`) lists what Switch promises. Each
checker names the property it checks with a tag in its own source, and this
script holds the two to account:

* every entry is well formed and its id is unique;
* a tag names a property that exists, at a level that property lists;
* a `checked` property has a checker at every level it lists, and no gaps;
* a gap is never listed for a level that has a checker, so a stale excuse
  cannot outlive the checker that replaced it;
* a `checked` formal property's `spec` names a definition that exists in its
  model (a proposed one may name a model not yet written).

Tags, by level:

    model  `/// @property <id>` above a Quint definition
    code   `@pytest.mark.property("<id>")` on a test
    system `@checks("<id>")` on a history check
    ui     `@property <id>` in the doc comment above a Bombadil export

Usage:
    uv run --project core python properties/gate/gate.py check
    uv run --project core python properties/gate/gate.py table
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from collections import defaultdict
from collections.abc import Iterator
from pathlib import Path
from typing import Literal, Self

import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

REPO_ROOT = Path(__file__).resolve().parents[2]

Level = Literal["model", "code", "system", "ui"]
LEVELS: tuple[Level, ...] = ("model", "code", "system", "ui")

ID_PATTERN = re.compile(r"^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*(-[a-z0-9]+)*)+$")

# Where each level's checkers live, as globs from the repository root, and the
# tag that names a property there.
CHECKER_SOURCES: dict[Level, tuple[tuple[str, re.Pattern[str]], ...]] = {
    "model": (
        (
            "properties/specs/**/*.qnt",
            re.compile(r"^\s*///\s*@property\s+(?P<id>\S+)", re.MULTILINE),
        ),
    ),
    "code": (
        (
            "core/tests/switch_core/properties/**/*.py",
            re.compile(r"@pytest\.mark\.property\(\s*[\"'](?P<id>[^\"']+)[\"']"),
        ),
    ),
    "system": (
        (
            "properties/history/**/*.py",
            re.compile(r"@checks\(\s*[\"'](?P<id>[^\"']+)[\"']"),
        ),
    ),
    "ui": (
        (
            "console/tooling-e2e/src/explore/spec/*.ts",
            re.compile(r"^\s*\*\s*@property\s+(?P<id>\S+)", re.MULTILINE),
        ),
    ),
}

SPEC_PATTERN = re.compile(r"^(?P<path>[^:]+\.qnt)::(?P<name>\w+)$")


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
            raw = yaml.safe_load(path.read_text())
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


def find_tags(root: Path) -> dict[str, dict[Level, list[str]]]:
    """Each tagged property id, with the files that check it at each level."""
    found: dict[str, dict[Level, list[str]]] = defaultdict(lambda: defaultdict(list))
    for level, sources in CHECKER_SOURCES.items():
        for glob, pattern in sources:
            for path in sorted(root.glob(glob)):
                label = path.relative_to(root).as_posix()
                for match in pattern.finditer(path.read_text()):
                    found[match["id"]][level].append(label)
    return found


def _spec_definitions(root: Path, spec: str) -> Iterator[str]:
    match = SPEC_PATTERN.match(spec)
    assert match is not None
    path = root / "properties" / "specs" / match["path"]
    if not path.is_file():
        yield f"{spec}: properties/specs/{match['path']} does not exist"
        return
    defined = re.search(
        rf"^\s*(?:pure\s+)?(?:val|def|temporal|action|run)\s+{match['name']}\b",
        path.read_text(),
        re.MULTILINE,
    )
    if defined is None:
        yield f"{spec}: {match['name']} is not defined in {match['path']}"


def check(root: Path) -> list[str]:
    """Every way the catalog and the checkers disagree; empty when they agree."""
    properties, problems = load_catalog(root)
    by_id = {prop.id: prop for prop in properties}
    tags = find_tags(root)

    for tagged, levels in sorted(tags.items()):
        prop = by_id.get(tagged)
        for level, files in levels.items():
            where = ", ".join(files)
            if prop is None:
                problems.append(
                    f"{tagged}: tagged at {level} in {where}, but not in the catalog"
                )
            elif prop.status == "retired":
                problems.append(
                    f"{tagged}: retired, but still checked at {level} in {where}"
                )
            elif level not in prop.levels:
                problems.append(
                    f"{tagged}: checked at {level} in {where}, which it does not list"
                )

    for prop in properties:
        checked_at = tags.get(prop.id, {})
        for level in prop.levels:
            if level in checked_at and level in prop.gaps:
                problems.append(
                    f"{prop.id}: lists a gap at {level}, which has a checker"
                )
            if prop.status == "checked" and level not in checked_at:
                problems.append(f"{prop.id}: checked, but nothing checks it at {level}")
        if prop.spec is not None and prop.status == "checked":
            problems.extend(_spec_definitions(root, prop.spec))
    return problems


def table(root: Path) -> str:
    """Property by level: `✔` a checker exists, `gap` an excuse is listed, `·` neither, blank not needed."""
    properties, _ = load_catalog(root)
    tags = find_tags(root)
    width = max((len(prop.id) for prop in properties), default=0)
    lines = [
        f"{'property':<{width}}  {'status':<8}  "
        + "  ".join(f"{level:<6}" for level in LEVELS)
    ]
    for prop in properties:
        cells = []
        for level in LEVELS:
            if level not in prop.levels:
                cells.append("")
            elif level in tags.get(prop.id, {}):
                cells.append("✔")
            elif level in prop.gaps:
                cells.append("gap")
            else:
                cells.append("·")
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
