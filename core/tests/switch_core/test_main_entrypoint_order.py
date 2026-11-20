"""`python -m <module>` runs a module top to bottom, so a `__main__` guard must
come after everything the code it calls reaches. The image starts Core with
`python -m switch_core.main` (Dockerfile.switch's CMD), while tests import the
module, which never runs the guard. Helpers defined below the guard passed every
test and crashed the server at boot with NameError.
So every module in the package is checked: a `__main__` guard is its last
statement."""

from __future__ import annotations

import ast
from pathlib import Path

import switch_core

_PACKAGE = Path(switch_core.__file__).parent


def _is_main_guard(node: ast.stmt) -> bool:
    """`if __name__ == "__main__":`, either way round."""
    if not (isinstance(node, ast.If) and isinstance(node.test, ast.Compare)):
        return False
    sides = [node.test.left, *node.test.comparators]
    return any(isinstance(s, ast.Name) and s.id == "__name__" for s in sides) and any(
        isinstance(s, ast.Constant) and s.value == "__main__" for s in sides
    )


def _late_statements(source: str) -> list[int]:
    """Line numbers of top-level statements after a module's `__main__` guard."""
    body = ast.parse(source).body
    guards = [i for i, node in enumerate(body) if _is_main_guard(node)]
    if not guards:
        return []
    return [node.lineno for node in body[guards[0] + 1 :]]


def test_core_main_has_its_guard_last() -> None:
    source = (_PACKAGE / "main.py").read_text()
    assert any(_is_main_guard(node) for node in ast.parse(source).body)
    assert _late_statements(source) == []


def test_no_module_defines_anything_after_its_main_guard() -> None:
    late = {
        str(path.relative_to(_PACKAGE)): lines
        for path in sorted(_PACKAGE.rglob("*.py"))
        if (lines := _late_statements(path.read_text()))
    }
    assert late == {}, f"statements after the __main__ guard: {late}"


def test_the_check_sees_a_late_definition() -> None:
    source = 'def main():\n    helper()\n\nif __name__ == "__main__":\n    main()\n\ndef helper():\n    pass\n'
    assert _late_statements(source) == [7]


def test_the_check_sees_a_guard_written_the_other_way_round() -> None:
    source = 'def main():\n    helper()\n\nif "__main__" == __name__:\n    main()\n\ndef helper():\n    pass\n'
    assert _late_statements(source) == [7]
