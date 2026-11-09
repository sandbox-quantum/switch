"""No log call passes an email address.

Application logs leave the database's region, so they carry ids and never a
person's email address. This scans every logger call in `switch_core` for an
argument (or f-string value) that reads an email: a name or attribute called
`email` or ending in `_email`.
"""

import ast
from pathlib import Path

import switch_core

LOG_METHODS = {"debug", "info", "warning", "error", "exception", "critical", "log"}


def _is_email(node: ast.AST) -> bool:
    for child in ast.walk(node):
        name = (
            child.id
            if isinstance(child, ast.Name)
            else child.attr
            if isinstance(child, ast.Attribute)
            else None
        )
        if name is not None and (name == "email" or name.endswith("_email")):
            return True
    return False


def _is_log_call(node: ast.AST) -> bool:
    return (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr in LOG_METHODS
        and "log" in ast.unparse(node.func.value).lower()
    )


def test_no_logger_call_passes_an_email_address() -> None:
    package = Path(switch_core.__file__).parent
    offenders = []
    for path in sorted(package.rglob("*.py")):
        for node in ast.walk(ast.parse(path.read_text(), filename=str(path))):
            if not _is_log_call(node):
                continue
            assert isinstance(node, ast.Call)
            values = [*node.args, *(keyword.value for keyword in node.keywords)]
            if any(_is_email(value) for value in values):
                offenders.append(f"{path.relative_to(package)}:{node.lineno}")
    assert offenders == [], f"log calls that pass an email address: {offenders}"
