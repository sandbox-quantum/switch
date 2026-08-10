"""Tests for the artifact registry and the generator that compiles it in.

The registry is the root of every version and compatibility answer the system
gives, so a malformed entry must fail at build time rather than reach a running
artifact — where a wrong number reads as "compatible", or as a release that was
never cut.
"""

from __future__ import annotations

import importlib.util
import re
import sys
from pathlib import Path
from types import ModuleType

import pytest
import yaml

from switch_core.artifacts import ARTIFACT_VERSIONS, CONTRACTS, contract_range

REPO_ROOT = Path(__file__).resolve().parents[2]

MINIMAL_ARTIFACTS = {"demo": {"description": "d", "version": "1.0.0"}}
MINIMAL_CONTRACTS = {
    "demo-contract": {
        "description": "d",
        "artifacts": {"demo": {"speaks": 1, "accepts": 1}},
    }
}


def _load_generator() -> ModuleType:
    """Import scripts/gen_artifacts.py, which is not an installed package."""
    path = REPO_ROOT / "scripts" / "gen_artifacts.py"
    spec = importlib.util.spec_from_file_location("gen_artifacts", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    # Register before executing: dataclasses resolve annotations through
    # sys.modules, and a module absent from it fails to build its fields.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


gen = _load_generator()


def _write_registry(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    *,
    artifacts: object = None,
    contracts: object = None,
) -> None:
    source = tmp_path / "artifacts.yaml"
    source.write_text(
        yaml.safe_dump(
            {
                "artifacts": MINIMAL_ARTIFACTS if artifacts is None else artifacts,
                "contracts": MINIMAL_CONTRACTS if contracts is None else contracts,
            }
        )
    )
    monkeypatch.setattr(gen, "SOURCE", source)


# ── The committed state ──────────────────────────────────────────────────────


def test_generated_modules_are_current() -> None:
    """The committed modules match what the generator would write.

    CI runs the same check; having it here too means `just test` catches a
    forgotten regeneration before the push rather than after.
    """
    registry = gen.load_registry()
    for target in gen.TARGETS:
        assert target.path.read_text() == target.render(registry), (
            f"{target.path.relative_to(REPO_ROOT)} is stale — run `just artifacts`"
        )


def test_the_registry_agrees_with_every_file_it_records() -> None:
    """pyproject, the package.jsons, the plugin.jsons and both app-identity twins.

    These are owned by their packaging ecosystems, so the registry is checked
    against them rather than generating into them.
    """
    assert gen.check_declared_versions(gen.load_registry()) == []


def test_every_artifact_version_is_three_part_semver() -> None:
    for name, version in ARTIFACT_VERSIONS.items():
        assert re.fullmatch(r"\d+\.\d+\.\d+", version), f"{name} is {version}"


def test_the_switchdash_pin_is_not_wired_to_switch_cores_version() -> None:
    """They coincide today, and must stay separately declared.

    Bumping core/pyproject.toml is the first step of cutting a switch-core
    release. A derived pin would immediately point local-server mode at images
    that are not on the registry yet, breaking it for everyone on main.
    """
    registry = gen.load_registry()
    switchdash = next(a for a in registry.artifacts if a.name == "switchdash")
    assert "switch-core" in switchdash.pins


def test_every_contract_peer_is_an_artifact_the_registry_knows() -> None:
    """The two halves must agree about what an artifact is.

    `compose` was a peer on stack-compose while the artifacts section had never
    heard of it, so the same name resolved in one half and threw in the other.
    """
    named_in_contracts = {peer for peers in CONTRACTS.values() for peer in peers}
    assert named_in_contracts <= set(ARTIFACT_VERSIONS)


def test_everything_published_under_the_switch_core_tag_shares_its_version() -> None:
    """One tag pins the whole stack, so these are stamped rather than declared."""
    core = ARTIFACT_VERSIONS["switch-core"]
    for stamped in ("gateway", "setup", "helm-chart", "compose"):
        assert ARTIFACT_VERSIONS[stamped] == core


def test_the_sidecar_has_no_declared_in_so_the_registry_owns_it() -> None:
    """Nothing else declares the sidecar's version — it is deployed, not published."""
    registry = gen.load_registry()
    sidecar = next(a for a in registry.artifacts if a.name == "sidecar")
    assert sidecar.declared_in is None


# ── Contract lookups ─────────────────────────────────────────────────────────


def test_accepts_never_exceeds_speaks() -> None:
    for name, artifacts in CONTRACTS.items():
        for artifact, declared in artifacts.items():
            assert declared.accepts <= declared.speaks, (
                f"{name}/{artifact} declares an empty range"
            )


@pytest.mark.parametrize(
    ("contract", "artifact"),
    [
        ("agent-protocol", "not-an-artifact"),
        ("not-a-contract", "switch-core"),
        # switch-core plays no part in sidecar-control, so asking is a bug.
        ("sidecar-control", "switch-core"),
    ],
)
def test_contract_range_refuses_unregistered_pairs(
    contract: str, artifact: str
) -> None:
    """An unregistered pair raises rather than returning a default.

    Any default here would be a number nobody chose, silently reported as if
    someone had.
    """
    with pytest.raises(KeyError, match="declares no range"):
        contract_range(contract, artifact)


def test_db_schema_is_declared_only_by_switch_core() -> None:
    """db-schema is internal, and must never gain an external peer.

    It is excluded from every externally facing response; a second artifact
    appearing here would mean that exclusion had stopped being true.
    """
    assert set(CONTRACTS["db-schema"]) == {"switch-core"}


# ── Validation ───────────────────────────────────────────────────────────────


def test_registry_rejects_a_two_part_version(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Every artifact carries three parts, without exception."""
    _write_registry(
        tmp_path,
        monkeypatch,
        artifacts={"demo": {"description": "d", "version": "1.7"}},
    )
    with pytest.raises(ValueError, match="three-part semver"):
        gen.load_registry()


def test_registry_rejects_both_version_and_version_from(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An artifact either has its own version or inherits one. Never both."""
    _write_registry(
        tmp_path,
        monkeypatch,
        artifacts={
            "base": {"description": "d", "version": "1.0.0"},
            "demo": {"description": "d", "version": "2.0.0", "version_from": "base"},
        },
        contracts={
            "demo-contract": {
                "description": "d",
                "artifacts": {"demo": {"speaks": 1, "accepts": 1}},
            }
        },
    )
    with pytest.raises(ValueError, match="exactly one of"):
        gen.load_registry()


def test_registry_rejects_neither_version_nor_version_from(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_registry(tmp_path, monkeypatch, artifacts={"demo": {"description": "d"}})
    with pytest.raises(ValueError, match="exactly one of"):
        gen.load_registry()


def test_an_inherited_version_resolves_to_its_source(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_registry(
        tmp_path,
        monkeypatch,
        artifacts={
            "base": {"description": "d", "version": "3.4.5"},
            "derived": {"description": "d", "version_from": "base"},
        },
        contracts={
            "demo-contract": {
                "description": "d",
                "artifacts": {"derived": {"speaks": 1, "accepts": 1}},
            }
        },
    )
    registry = gen.load_registry()
    derived = next(a for a in registry.artifacts if a.name == "derived")
    assert derived.version == "3.4.5"


def test_registry_rejects_inheriting_from_something_unknown(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_registry(
        tmp_path,
        monkeypatch,
        artifacts={"demo": {"description": "d", "version_from": "nowhere"}},
        contracts={
            "demo-contract": {
                "description": "d",
                "artifacts": {"demo": {"speaks": 1, "accepts": 1}},
            }
        },
    )
    with pytest.raises(ValueError, match="not an artifact in this registry"):
        gen.load_registry()


def test_registry_rejects_a_contract_peer_it_does_not_know(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The check that would have caught `compose` being in one half only."""
    _write_registry(
        tmp_path,
        monkeypatch,
        contracts={
            "demo-contract": {
                "description": "d",
                "artifacts": {"a-stranger": {"speaks": 1, "accepts": 1}},
            }
        },
    )
    with pytest.raises(ValueError, match="not in the artifacts section"):
        gen.load_registry()


def test_registry_rejects_a_pin_of_something_it_does_not_know(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A pin naming a typo'd artifact would silently never be checked."""
    _write_registry(
        tmp_path,
        monkeypatch,
        artifacts={
            "demo": {
                "description": "d",
                "version": "1.0.0",
                "pins": {"switch-corp": "1.0.0"},
            }
        },
    )
    with pytest.raises(ValueError, match="not an artifact in this registry"):
        gen.load_registry()


def test_registry_rejects_an_empty_range(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_registry(
        tmp_path,
        monkeypatch,
        contracts={
            "demo-contract": {
                "description": "d",
                "artifacts": {"a": {"speaks": 1, "accepts": 2}},
            }
        },
    )
    with pytest.raises(ValueError, match="is above speaks"):
        gen.load_registry()


def test_registry_rejects_a_non_integer_revision(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_registry(
        tmp_path,
        monkeypatch,
        contracts={
            "demo-contract": {
                "description": "d",
                "artifacts": {"a": {"speaks": "1", "accepts": 1}},
            }
        },
    )
    with pytest.raises(ValueError, match="must be an integer"):
        gen.load_registry()


def test_registry_rejects_a_zero_revision(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Revisions start at 1 so that a missing or zero-valued field is distinct."""
    _write_registry(
        tmp_path,
        monkeypatch,
        contracts={
            "demo-contract": {
                "description": "d",
                "artifacts": {"a": {"speaks": 0, "accepts": 0}},
            }
        },
    )
    with pytest.raises(ValueError, match="must be an integer"):
        gen.load_registry()


def test_registry_rejects_extra_declaration_keys(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Only speaks and accepts. A stray key is a misunderstanding, not an extra."""
    _write_registry(
        tmp_path,
        monkeypatch,
        contracts={
            "demo-contract": {
                "description": "d",
                "artifacts": {"a": {"speaks": 1, "accepts": 1, "version": "1.2.3"}},
            }
        },
    )
    with pytest.raises(ValueError, match="expected exactly"):
        gen.load_registry()


def test_registry_rejects_a_missing_section(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "artifacts.yaml"
    source.write_text(yaml.safe_dump({"contracts": MINIMAL_CONTRACTS}))
    monkeypatch.setattr(gen, "SOURCE", source)
    with pytest.raises(ValueError, match="'artifacts'"):
        gen.load_registry()
