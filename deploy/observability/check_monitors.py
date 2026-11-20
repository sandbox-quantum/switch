"""Check monitors.json before it reaches Datadog.

    python3 check_monitors.py [monitors.json]

Exits non-zero, listing every problem, if a monitor is missing a priority or
one of the tags routing and scoping depend on, if a monitor that reads a
security signal is not tagged `category:security`, if a message names a real
notification handle instead of the placeholder, or if a placeholder is one
`apply.sh` would not fill in. Standard library only: `apply.sh` runs it before
every import, and CI runs it on every pull request without any secrets.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

HANDLE_PLACEHOLDER = "@REPLACE-WITH-NOTIFICATION-HANDLE"
KNOWN_PLACEHOLDERS = {
    "REPLACE-WITH-NOTIFICATION-HANDLE",
    "REPLACE-WITH-SERVICE",
    "REPLACE-WITH-ENV",
}
CATEGORIES = {"ops", "security"}
REQUIRED_FIELDS = ("name", "type", "query", "message", "tags", "options", "priority")
REQUIRED_TAGS = ("service:REPLACE-WITH-SERVICE", "env:REPLACE-WITH-ENV")
REQUIRED_TAG_KEYS = ("team", "tier", "category")
NAME_PREFIX = "[Switch REPLACE-WITH-ENV] "

# A monitor whose query reads one of these is a security alert, and must be
# routed as one. Extend this when a new security signal gets a monitor.
SECURITY_SIGNALS = (
    re.compile(r"switch\.controller\.credential_refusals\b"),
    re.compile(r"switch\.auth\."),
    re.compile(r"switch\.event:security\."),
)

PLACEHOLDER = re.compile(r"REPLACE-WITH-[A-Z0-9-]*[A-Z0-9]")
# An @-mention in a message: Datadog notifies whatever it names.
MENTION = re.compile(r"(?<![\w.+-])@[\w.+@/-]+")


def problems_in(monitors: object) -> list[str]:
    if not isinstance(monitors, list) or not monitors:
        return ["monitors.json must be a non-empty JSON array of monitors"]
    problems: list[str] = []
    seen: set[str] = set()
    for index, monitor in enumerate(monitors):
        if not isinstance(monitor, dict):
            problems.append(f"monitor #{index}: not a JSON object")
            continue
        label = f"monitor #{index} ({monitor.get('name', 'no name')!r})"
        problems.extend(
            f"{label}: missing {field!r}"
            for field in REQUIRED_FIELDS
            if field not in monitor
        )

        name = monitor.get("name")
        if isinstance(name, str):
            if name in seen:
                problems.append(
                    f"{label}: duplicate name; apply.sh matches monitors by name"
                )
            seen.add(name)
            if not name.startswith(NAME_PREFIX):
                problems.append(f"{label}: name must start with {NAME_PREFIX!r}")

        priority = monitor.get("priority")
        if "priority" in monitor and (
            isinstance(priority, bool)
            or not isinstance(priority, int)
            or not 1 <= priority <= 5
        ):
            problems.append(
                f"{label}: priority must be an integer from 1 to 5, not {priority!r}"
            )

        tags = monitor.get("tags")
        if not isinstance(tags, list) or not all(isinstance(tag, str) for tag in tags):
            if "tags" in monitor:
                problems.append(f"{label}: tags must be a list of strings")
            tags = []
        problems.extend(
            f"{label}: missing tag {tag!r}" for tag in REQUIRED_TAGS if tag not in tags
        )
        for key in REQUIRED_TAG_KEYS:
            values = [tag.split(":", 1)[1] for tag in tags if tag.startswith(f"{key}:")]
            if len(values) != 1:
                problems.append(
                    f"{label}: needs exactly one {key}: tag, has {len(values)}"
                )
        categories = [
            tag.split(":", 1)[1] for tag in tags if tag.startswith("category:")
        ]
        problems.extend(
            f"{label}: unknown category {category!r}, expected one of {sorted(CATEGORIES)}"
            for category in categories
            if category not in CATEGORIES
        )

        query = monitor.get("query")
        if (
            isinstance(query, str)
            and any(signal.search(query) for signal in SECURITY_SIGNALS)
            and "category:security" not in tags
        ):
            problems.append(
                f"{label}: reads a security signal, so it must be tagged 'category:security'"
            )

        message = monitor.get("message")
        if isinstance(message, str):
            count = message.count(HANDLE_PLACEHOLDER)
            if count != 1:
                problems.append(
                    f"{label}: message must carry {HANDLE_PLACEHOLDER} exactly once, has it {count} times"
                )
            for mention in MENTION.findall(message):
                if mention != HANDLE_PLACEHOLDER:
                    problems.append(
                        f"{label}: message names {mention!r}; use {HANDLE_PLACEHOLDER} and let apply.sh route it"
                    )

        for placeholder in sorted(set(PLACEHOLDER.findall(json.dumps(monitor)))):
            if placeholder not in KNOWN_PLACEHOLDERS:
                problems.append(
                    f"{label}: unknown placeholder {placeholder!r}; apply.sh fills in only {sorted(KNOWN_PLACEHOLDERS)}"
                )
    return problems


def main(argv: list[str]) -> int:
    path = Path(argv[1]) if len(argv) > 1 else Path(__file__).with_name("monitors.json")
    try:
        monitors = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        print(f"{path}: cannot read monitors: {error}", file=sys.stderr)
        return 1
    problems = problems_in(monitors)
    for problem in problems:
        print(f"{path}: {problem}", file=sys.stderr)
    if problems:
        print(f"{path}: {len(problems)} problem(s)", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
