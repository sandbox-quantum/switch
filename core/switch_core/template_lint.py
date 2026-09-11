"""Advisory checks on a template document, for a form to show before upload.

Deliberately weaker than provisioning. It answers "will this obviously not do
what you meant", never "is this a valid room template" — the registry stores
documents whose shape this server may not know yet, and a check that insisted
on today's shape would start refusing tomorrow's. Group templates already have
a different top-level key from room templates, and agent templates are coming,
so nothing here asks what kind of document it is looking at.

What that leaves is the mistakes that are wrong under every shape: text that
is not YAML, a params block that provisioning will reject, and placeholders
that do not line up with the parameters declared for them — the typo that
otherwise ships silently, because an undeclared `{owner}` is left in the
document verbatim rather than failing.

Nothing here rejects an upload. The registry accepts what it is given; this
only lets a person see the problem first.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

import yaml
from pydantic import ValidationError

from switch_core.rooms_yaml import PLACEHOLDER_RE, ParamSpec

# Top-level keys any shape of template may carry. Anything else is reported as
# a warning, never an error: an unrecognised key is as likely to be a format
# this server predates as it is to be a typo.
_KNOWN_TOP_LEVEL = frozenset({"room", "group", "rooms", "params", "version"})


@dataclass(frozen=True)
class Finding:
    code: str
    message: str
    # The param or key the finding is about, when it is about one.
    subject: str | None = None


@dataclass(frozen=True)
class LintResult:
    errors: list[Finding] = field(default_factory=list)
    warnings: list[Finding] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors


def _walk_strings(node: Any) -> list[str]:
    """Every string anywhere in the document, so no placeholder is missed."""
    if isinstance(node, str):
        return [node]
    if isinstance(node, dict):
        found: list[str] = []
        for key, value in node.items():
            if isinstance(key, str):
                found.append(key)
            found.extend(_walk_strings(value))
        return found
    if isinstance(node, list):
        return [s for item in node for s in _walk_strings(item)]
    return []


def _check_params(raw: Any, errors: list[Finding]) -> set[str]:
    """Validate the params block against the spec provisioning will apply.

    Uses `ParamSpec` itself rather than re-describing it, so a form cannot
    accept a param that provisioning would then refuse.
    """
    if not isinstance(raw, dict):
        errors.append(
            Finding(
                "params_not_a_mapping",
                "'params' must be a mapping of parameter name to its spec.",
            )
        )
        return set()

    declared: set[str] = set()
    for name, spec in raw.items():
        if not isinstance(name, str):
            errors.append(
                Finding(
                    "param_name_not_a_string", f"Parameter name {name!r} is not text."
                )
            )
            continue
        declared.add(name)
        if spec is None:
            errors.append(
                Finding(
                    "param_has_no_spec",
                    f"Parameter '{name}' has no spec. Give it at least a type.",
                    name,
                )
            )
            continue
        try:
            parsed = ParamSpec.model_validate(spec)
        except ValidationError as e:
            first = e.errors()[0]
            where = ".".join(str(p) for p in first["loc"]) or "spec"
            errors.append(
                Finding(
                    "invalid_param_spec",
                    f"Parameter '{name}' is not valid: {where} — {first['msg']}.",
                    name,
                )
            )
            continue

        # Two things a well-formed ParamSpec can still say that provisioning
        # will refuse. They surface here because they only bite at the moment
        # somebody tries to use the template, which is far from the mistake.
        if parsed.type == "enum":
            if not parsed.enum:
                errors.append(
                    Finding(
                        "enum_without_choices",
                        f"Parameter '{name}' is an enum but lists no choices.",
                        name,
                    )
                )
            elif parsed.default is not None and parsed.default not in parsed.enum:
                errors.append(
                    Finding(
                        "default_not_in_enum",
                        f"Parameter '{name}' defaults to {parsed.default!r}, which is "
                        f"not one of its choices ({', '.join(parsed.enum)}).",
                        name,
                    )
                )
    return declared


def lint_template(text: str) -> LintResult:
    """Check a template document without storing or provisioning anything."""
    errors: list[Finding] = []
    warnings: list[Finding] = []

    if not text.strip():
        errors.append(Finding("empty", "The document is empty."))
        return LintResult(errors, warnings)

    try:
        document = yaml.safe_load(text)
    except yaml.YAMLError as e:
        # A mark carries the line and column, which is the whole value of the
        # message to someone staring at an editor.
        mark = getattr(e, "problem_mark", None)
        where = f" at line {mark.line + 1}, column {mark.column + 1}" if mark else ""
        problem = getattr(e, "problem", None) or "could not be parsed"
        errors.append(Finding("invalid_yaml", f"Not valid YAML{where}: {problem}."))
        return LintResult(errors, warnings)

    if document is None:
        errors.append(Finding("empty", "The document is empty."))
        return LintResult(errors, warnings)

    if not isinstance(document, dict):
        errors.append(
            Finding(
                "not_a_mapping",
                "The document must be a mapping of keys at the top level, "
                f"not {type(document).__name__}.",
            )
        )
        return LintResult(errors, warnings)

    for key in sorted(k for k in document if isinstance(k, str)):
        if key not in _KNOWN_TOP_LEVEL:
            warnings.append(
                Finding(
                    "unknown_top_level_key",
                    f"'{key}' is not a key this server recognises. It will be "
                    "stored as-is, but check it is not a typo.",
                    key,
                )
            )

    declared = (
        _check_params(document["params"], errors) if "params" in document else set()
    )

    # Placeholders are looked for everywhere except the params block, which
    # declares them rather than using them.
    body = {k: v for k, v in document.items() if k != "params"}
    used = {
        match
        for text_node in _walk_strings(body)
        for match in re.findall(PLACEHOLDER_RE, text_node)
    }

    for name in sorted(used - declared):
        warnings.append(
            Finding(
                "undeclared_placeholder",
                f"'{{{name}}}' is used but no parameter declares it, so it will "
                "be left in the document as written.",
                name,
            )
        )
    for name in sorted(declared - used):
        warnings.append(
            Finding(
                "unused_param",
                f"Parameter '{name}' is declared but never used.",
                name,
            )
        )

    return LintResult(errors, warnings)
