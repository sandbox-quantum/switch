"""The seam only holds if something enforces it.

Matrix may be imported in exactly one place. Without this check the port
erodes the first time someone reaches for a nio type in a hurry, and the
erosion is invisible until the homeserver is being replaced.
"""

import ast
import pathlib

PACKAGE = pathlib.Path(__file__).resolve().parents[3] / "switch_core"
ALLOWED = {PACKAGE / "transport" / "matrix.py"}


def _imports_nio(path: pathlib.Path) -> bool:
    tree = ast.parse(path.read_text(), filename=str(path))
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            if any(a.name == "nio" or a.name.startswith("nio.") for a in node.names):
                return True
        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            if module == "nio" or module.startswith("nio."):
                return True
    return False


def test_only_the_matrix_transport_imports_nio() -> None:
    offenders = sorted(
        str(path.relative_to(PACKAGE))
        for path in PACKAGE.rglob("*.py")
        if path not in ALLOWED and _imports_nio(path)
    )

    assert offenders == [], (
        "matrix-nio may only be imported by switch_core/transport/matrix.py; "
        f"these modules import it directly: {offenders}. "
        "Add what you need to MessageTransport instead."
    )


def test_the_guard_can_actually_see_an_import(tmp_path: pathlib.Path) -> None:
    offender = tmp_path / "offender.py"
    offender.write_text("from nio import AsyncClient\n")

    assert _imports_nio(offender)


def test_no_module_reaches_for_a_raw_client() -> None:
    """`nio_client` was the escape hatch during the port. It is gone."""
    offenders = sorted(
        str(path.relative_to(PACKAGE))
        for path in PACKAGE.rglob("*.py")
        if "nio_client" in path.read_text()
    )

    assert offenders == []
