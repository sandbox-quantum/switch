"""Core does not depend on agent management.

Management may call into Core (registration through `AgentCore`, the
bindings in `ControllerPresence`, the stores, the gateway's authentication),
but nothing in Core imports `switch_core.management` except the process wiring
that decides whether to build it at all. Keeping that one-way is what lets the module stay
behind its flag, and come out again, without touching Core.
"""

from __future__ import annotations

import ast
from pathlib import Path

import switch_core

_PACKAGE_ROOT = Path(switch_core.__file__).resolve().parent
_MANAGEMENT = "switch_core.management"

# The only Core modules allowed to import the management package.
_ALLOWED_IMPORTERS = {
    # Builds the module when the agent_management feature flag is on, hands its
    # authenticator to the bearer middleware, and installs its routes.
    "switch_core.main",
}


def _module_name(path: Path) -> str:
    parts = list(path.relative_to(_PACKAGE_ROOT.parent).with_suffix("").parts)
    if parts[-1] == "__init__":
        parts = parts[:-1]
    return ".".join(parts)


def _imports_management(path: Path) -> bool:
    tree = ast.parse(path.read_text(), filename=str(path))
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names = [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom) and node.module is not None:
            names = [node.module] + [f"{node.module}.{a.name}" for a in node.names]
        else:
            continue
        if any(
            name == _MANAGEMENT or name.startswith(_MANAGEMENT + ".") for name in names
        ):
            return True
    return False


def _core_modules_importing_management() -> set[str]:
    found = set()
    for path in _PACKAGE_ROOT.rglob("*.py"):
        name = _module_name(path)
        if name == _MANAGEMENT or name.startswith(_MANAGEMENT + "."):
            continue
        if _imports_management(path):
            found.add(name)
    return found


def test_only_the_wiring_imports_management() -> None:
    unexpected = _core_modules_importing_management() - _ALLOWED_IMPORTERS
    assert not unexpected, (
        f"{sorted(unexpected)} import switch_core.management. Core must not "
        "depend on agent management; inject what it needs through the wiring "
        "in switch_core.main instead (as the bearer middleware takes a "
        "ControllerAuthenticator)."
    )


def test_the_allowlist_is_not_stale() -> None:
    assert _ALLOWED_IMPORTERS <= _core_modules_importing_management()


def test_the_detector_catches_each_import_shape(tmp_path: Path) -> None:
    for source in (
        "import switch_core.management\n",
        "import switch_core.management.service as s\n",
        "from switch_core.management import service\n",
        "from switch_core.management.service import ManagementService\n",
        "from switch_core import management\n",
    ):
        module = tmp_path / "m.py"
        module.write_text(source)
        assert _imports_management(module), source
    clean = tmp_path / "clean.py"
    clean.write_text("from switch_core import config\nimport switch_core.managementx\n")
    assert not _imports_management(clean)
