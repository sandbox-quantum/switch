"""The Teams app package we ship has to be uploadable as it stands.

`docs/bridges/teams-app/` is a paste-and-upload package, not an illustration:
an operator zips those three files and Teams accepts or rejects them. Teams
gives no useful error for most of these mistakes — an icon of the wrong size or
an eleventh command comes back as a generic validation failure — so the limits
are asserted here instead.
"""

from __future__ import annotations

import json
import struct
from pathlib import Path

import pytest

PACKAGE = Path(__file__).resolve().parents[5] / "docs" / "bridges" / "teams-app"
MANIFEST = PACKAGE / "manifest.json"

# The placeholder an operator must replace with their Azure Bot app id. It is
# the null GUID precisely so an unreplaced one is obvious rather than plausible.
PLACEHOLDER_ID = "00000000-0000-0000-0000-000000000000"


@pytest.fixture(scope="module")
def manifest() -> dict:
    return json.loads(MANIFEST.read_text())


def _png_size(path: Path) -> tuple[int, int]:
    """(width, height) from a PNG's IHDR, without an image library."""
    header = path.read_bytes()[:24]
    assert header[:8] == b"\x89PNG\r\n\x1a\n", f"{path.name} is not a PNG"
    width, height = struct.unpack(">II", header[16:24])
    return width, height


def test_the_manifest_is_valid_json_at_the_version_it_claims(manifest: dict) -> None:
    assert manifest["manifestVersion"] == "1.19"
    assert manifest["$schema"].endswith("/v1.19/MicrosoftTeams.schema.json")


def test_every_field_teams_requires_is_present(manifest: dict) -> None:
    for field in (
        "manifestVersion",
        "version",
        "id",
        "developer",
        "name",
        "description",
        "icons",
        "accentColor",
    ):
        assert field in manifest, f"the manifest has no {field}"
    for field in ("name", "websiteUrl", "privacyUrl", "termsOfUseUrl"):
        assert manifest["developer"][field]


def test_the_app_is_called_agent_switch(manifest: dict) -> None:
    assert manifest["name"]["short"] == "Agent Switch"
    assert manifest["developer"]["name"] == "Agent Switch"


def test_the_strings_are_inside_the_lengths_teams_enforces(manifest: dict) -> None:
    # A manifest over any of these is rejected on upload with no useful reason.
    assert len(manifest["name"]["short"]) <= 30
    assert len(manifest["name"]["full"]) <= 100
    assert manifest["name"]["short"] != manifest["name"]["full"]
    assert len(manifest["description"]["short"]) <= 80
    assert len(manifest["description"]["full"]) <= 4000
    assert len(manifest["developer"]["name"]) <= 32


def test_the_developer_urls_are_https(manifest: dict) -> None:
    # The schema types all three as httpsUrl; http fails validation.
    for field in ("websiteUrl", "privacyUrl", "termsOfUseUrl"):
        assert manifest["developer"][field].startswith("https://")


def test_the_accent_colour_is_a_six_digit_hex(manifest: dict) -> None:
    accent = manifest["accentColor"]
    assert len(accent) == 7 and accent[0] == "#"
    int(accent[1:], 16)


def test_the_app_id_placeholder_is_the_same_in_all_three_places(
    manifest: dict,
) -> None:
    # An operator replaces one value; the guide says so because Teams ties the
    # app, the bot and the Entra registration together through it.
    assert manifest["id"] == PLACEHOLDER_ID
    assert manifest["bots"][0]["botId"] == PLACEHOLDER_ID
    assert manifest["webApplicationInfo"]["id"] == PLACEHOLDER_ID


def test_there_is_exactly_one_bot_covering_all_three_scopes(manifest: dict) -> None:
    assert len(manifest["bots"]) == 1, "Teams allows one bot per app"
    assert set(manifest["bots"][0]["scopes"]) == {"team", "personal", "groupChat"}


def test_the_command_menu_is_within_the_platform_limits(manifest: dict) -> None:
    command_lists = manifest["bots"][0]["commandLists"]
    assert len(command_lists) <= 3
    for entry in command_lists:
        assert len(entry["commands"]) <= 10, "Teams caps a command list at ten"
        for command in entry["commands"]:
            assert len(command["title"]) <= 32
            assert len(command["description"]) <= 128
            # Teams prefixes the slash itself when it inserts the command;
            # carrying one here produces "//help" in the compose box.
            assert not command["title"].startswith("/")


def test_the_menu_only_offers_commands_switch_answers(manifest: dict) -> None:
    # `/status` shipped in the old snippet and is not a command — picking it
    # from the menu returned "unknown command".
    from switch_core.bridges.agent.commands import COMMANDS_BY_NAME

    offered = {
        command["title"]
        for entry in manifest["bots"][0]["commandLists"]
        for command in entry["commands"]
    }
    unknown = sorted(offered - set(COMMANDS_BY_NAME))
    assert not unknown, f"the menu offers commands Switch cannot answer: {unknown}"


def test_both_icons_exist_at_the_sizes_teams_requires(manifest: dict) -> None:
    colour = PACKAGE / manifest["icons"]["color"]
    outline = PACKAGE / manifest["icons"]["outline"]
    assert _png_size(colour) == (192, 192)
    assert _png_size(outline) == (32, 32)


def test_the_icons_are_named_relatively_so_they_zip_flat(manifest: dict) -> None:
    # Teams rejects a package whose files sit inside a folder, so the manifest
    # must not reference a path either.
    for path in manifest["icons"].values():
        assert "/" not in path and not path.startswith(".")
