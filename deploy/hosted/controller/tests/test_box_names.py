"""`box_names`: the one place box namespace patterns live, and every gate using it."""

from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest

from switch_hosted_controller import box_names
from switch_hosted_controller.box_names import (
    BOX_NAMESPACE_RE,
    KNOWN_BOX_NAMESPACE_RE,
    box_namespace,
    identity,
    is_box_keyed,
    is_legacy,
    name_label,
    user_namespace,
)

PACKAGE = Path(box_names.__file__).parent
HOSTED = PACKAGE.parents[2]
USER, BOX = "k1-0123456789abcdef", "k1-fedcba9876543210"


def test_the_two_shapes_exact():
    for good in (f"agents-user-{USER}", f"agents-box-{BOX}"):
        assert BOX_NAMESPACE_RE.fullmatch(good) and KNOWN_BOX_NAMESPACE_RE.fullmatch(good)
    for bad in (
        "agents-user-ada",  # legacy: readers only
        f"agents-box-{BOX}x",
        "agents-box-k1-0123",
        "agents-box-ada",  # never loose for the new shape, even for readers
        f"agents-check-{BOX}",
        "switch-hosted",
        "kube-system",
        f"agents-user-{USER}\n",
    ):
        assert not BOX_NAMESPACE_RE.fullmatch(bad), bad
    assert KNOWN_BOX_NAMESPACE_RE.fullmatch("agents-user-ada")
    assert not KNOWN_BOX_NAMESPACE_RE.fullmatch("agents-box-ada")


def test_identity_and_the_one_name_label():
    assert identity(f"agents-user-{USER}") == f"user-{USER}"
    assert name_label(f"agents-user-{USER}") == ("switch.dev/user", f"user-{USER}")
    assert name_label(f"agents-box-{BOX}") == ("switch.dev/box", f"box-{BOX}")
    assert is_box_keyed(box_namespace(BOX)) and not is_box_keyed(user_namespace(USER))
    for bad in ("agents-user-ada", "kube-system"):
        with pytest.raises(ValueError):
            identity(bad)
    for bad in ("ada", "k1-XYZ", "K1-0123456789ABCDEF"):
        with pytest.raises(ValueError):
            box_namespace(bad)
        with pytest.raises(ValueError):
            user_namespace(bad)


def test_a_legacy_name_is_one_only_the_readers_accept():
    assert is_legacy("agents-user-ada")
    assert not is_legacy(f"agents-user-{USER}") and not is_legacy(f"agents-box-{BOX}")
    assert not is_legacy("kube-system") and not is_legacy("agents-box-ada")


def _compiled_patterns(path: Path) -> list[str]:
    """Every string literal passed to re.compile in a module."""
    found = []
    for node in ast.walk(ast.parse(path.read_text())):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "compile"
            and node.args
        ):
            for part in ast.walk(node.args[0]):
                if isinstance(part, ast.Constant) and isinstance(part.value, str):
                    found.append(part.value)
    return found


def test_no_other_module_compiles_its_own_box_namespace_pattern():
    """The placer had its own copy of the scaler's pattern. Every gate now imports `box_names`."""
    offenders = []
    for path in sorted(PACKAGE.glob("*.py")):
        if path.name == "box_names.py":
            continue
        for pattern in _compiled_patterns(path):
            if "agents-user" in pattern or "agents-box" in pattern:
                offenders.append(f"{path.name}: {pattern}")
    assert offenders == []


def test_every_gate_uses_the_shared_patterns():
    from switch_hosted_controller import (
        box_operator,
        box_operator_main,
        box_scaler,
        drain_actions,
        egress_lists,
        placer,
        restart_actions,
    )

    # What creates or names a box: exact.
    assert box_operator.NAMESPACE_RE is BOX_NAMESPACE_RE
    assert box_operator_main.NAMESPACE_RE is BOX_NAMESPACE_RE
    # What reads the box map: the readers' pattern.
    for module in (box_scaler, placer, drain_actions, restart_actions, egress_lists):
        assert module.NAMESPACE_RE is KNOWN_BOX_NAMESPACE_RE, module.__name__


def test_p1_refuses_a_loose_person_keyed_name_at_creation():
    """Creation stays exact: the admission policy's namespace pattern takes `agents-user-k1-<16 hex>` and nothing
    looser, so the readers' legacy allowance can only ever see names that already exist."""
    policy = (HOSTED / "k8s" / "30-admission-policies.yaml").read_text()
    patterns = re.findall(r"object\.metadata\.name\.matches\('([^']+)'\)", policy)
    box_patterns = [p for p in patterns if p.startswith("^agents-")]
    assert box_patterns, "P1's namespace name check not found"
    assert any(re.fullmatch(p, f"agents-user-{USER}") for p in box_patterns)
    for pattern in box_patterns:
        for loose in (
            "agents-user-ada",
            "agents-user-k1-0123",
            "agents-box-ada",
            "agents-box-k1-0123",
        ):
            assert not re.fullmatch(pattern, loose), (pattern, loose)
