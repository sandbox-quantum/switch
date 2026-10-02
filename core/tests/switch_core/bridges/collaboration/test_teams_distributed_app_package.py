"""The distributed Teams app's package, as Switch builds it for an organisation."""

from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path
from typing import Any

import pytest

from switch_core.bridges.collaboration.teams import app_package as app_package_module
from switch_core.bridges.collaboration.teams.app_package import (
    build_distributed_app_package,
)

APP_ID = "aaaaaaaa-1111-1111-1111-111111111111"
_BYO_MANIFEST = (
    Path(__file__).resolve().parents[5] / "docs/old/bridges/teams-app/manifest.json"
)


def _package() -> tuple[dict[str, Any], zipfile.ZipFile]:
    package = build_distributed_app_package(
        app_id=APP_ID,
        messaging_public_url="https://switch.example",
        privacy_url="https://switch.example/privacy",
        terms_url="https://switch.example/terms",
    )
    archive = zipfile.ZipFile(io.BytesIO(package.archive))
    return json.loads(archive.read("manifest.json")), archive


def test_the_package_is_flat_with_its_manifest_and_icons() -> None:
    """Teams rejects a package whose files sit inside a folder."""
    _, archive = _package()
    assert sorted(archive.namelist()) == ["color.png", "manifest.json", "outline.png"]


def test_this_deployments_values_are_filled_in() -> None:
    manifest, _ = _package()
    assert manifest["id"] == APP_ID
    assert manifest["bots"][0]["botId"] == APP_ID
    assert manifest["validDomains"] == ["switch.example"]
    assert manifest["developer"]["privacyUrl"] == "https://switch.example/privacy"
    assert manifest["developer"]["termsOfUseUrl"] == "https://switch.example/terms"


def test_it_asks_for_nothing_per_team() -> None:
    """The organisation's admin grants the app's permissions once, so asking
    again per team would only add a consent prompt and a broader install
    permission."""
    manifest, _ = _package()
    assert "authorization" not in manifest
    assert "webApplicationInfo" not in manifest


def test_it_works_in_private_and_shared_channels() -> None:
    manifest, _ = _package()
    assert manifest["supportsChannelFeatures"] == "tier1"
    assert tuple(int(p) for p in manifest["manifestVersion"].split(".")) >= (1, 25)


def test_it_does_not_claim_to_be_the_self_hosted_app() -> None:
    manifest, _ = _package()
    assert "talks only to your own Switch server" not in manifest["description"]["full"]
    assert len(manifest["description"]["full"]) <= 4000


def test_its_commands_match_the_bring_your_own_apps() -> None:
    """Both apps offer the same in-room commands; this keeps the two lists
    from drifting apart."""
    manifest, _ = _package()
    byo = json.loads(_BYO_MANIFEST.read_text())
    assert manifest["bots"][0]["commandLists"] == byo["bots"][0]["commandLists"]
    assert manifest["bots"][0]["scopes"] == byo["bots"][0]["scopes"]


def test_a_value_with_json_syntax_in_it_stays_a_string() -> None:
    package = build_distributed_app_package(
        app_id=APP_ID,
        messaging_public_url="https://switch.example",
        privacy_url='https://switch.example/privacy?a="b"',
        terms_url="https://switch.example/terms\\x",
    )
    manifest = json.loads(
        zipfile.ZipFile(io.BytesIO(package.archive)).read("manifest.json")
    )
    assert manifest["developer"]["privacyUrl"] == 'https://switch.example/privacy?a="b"'
    assert manifest["developer"]["termsOfUseUrl"] == "https://switch.example/terms\\x"


def test_an_unfilled_placeholder_in_the_template_is_a_loud_failure(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """A deployment value that never got substituted must not ship silently —
    Teams would treat the literal ``{{...}}`` as the value itself."""
    manifest = {
        "id": "placeholder",
        "bots": [{"botId": "placeholder"}],
        "developer": {},
        "unfilled": "{{SOMETHING}}",
    }
    (tmp_path / "manifest.json").write_text(json.dumps(manifest))
    monkeypatch.setattr(app_package_module, "_TEMPLATE_DIR", tmp_path)

    with pytest.raises(ValueError, match="does not fill in"):
        build_distributed_app_package(
            app_id=APP_ID,
            messaging_public_url="https://switch.example",
            privacy_url="https://switch.example/privacy",
            terms_url="https://switch.example/terms",
        )
