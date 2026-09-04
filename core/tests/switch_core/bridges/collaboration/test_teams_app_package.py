"""The Teams app package we ship has to be uploadable as it stands.

`docs/old/bridges/teams-app/` is a paste-and-upload package, not an illustration:
an operator zips those three files and Teams accepts or rejects them. Teams
gives no useful error for most of these mistakes — an icon of the wrong size or
an eleventh command comes back as a generic validation failure — so the limits
are asserted here instead.
"""

from __future__ import annotations

import json
import re
import struct
import sys
import zipfile
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[5]
PACKAGE = REPO_ROOT / "docs" / "old" / "bridges" / "teams-app"
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
    # The two must agree: Teams pins `manifestVersion` to a `const` per schema,
    # so a mismatched pair fails validation with nothing useful said about why.
    version = manifest["manifestVersion"]
    assert manifest["$schema"].endswith(f"/v{version}/MicrosoftTeams.schema.json")


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
        # Twelve from schema v1.25; ten before that.
        assert len(entry["commands"]) <= 12, "Teams caps a command list at twelve"
        for command in entry["commands"]:
            assert len(command["title"]) <= 32
            assert len(command["description"]) <= 128


def test_a_mention_menu_title_carries_the_prefix_it_will_insert(
    manifest: dict,
) -> None:
    # The @mention menu inserts a title verbatim and prepends nothing, so the
    # title has to be the text Switch dispatches on.
    from switch_core.bridges.collaboration.teams.adapter import _COMMAND_PREFIXES

    for entry in manifest["bots"][0]["commandLists"]:
        if "slash" in entry.get("triggers", ["mention"]):
            continue
        for command in entry["commands"]:
            assert command["title"][:1] in _COMMAND_PREFIXES, command["title"]


def test_a_slash_picker_title_is_bare_because_teams_adds_the_slash(
    manifest: dict,
) -> None:
    # The `/` picker prepends the slash for display and inserts the bare name,
    # which is why every Microsoft sample declares these without one. A title
    # of "/help" would render as "//help" and arrive with a prefix the picker
    # did not intend.
    for entry in manifest["bots"][0]["commandLists"]:
        if "slash" not in entry.get("triggers", ["mention"]):
            continue
        for command in entry["commands"]:
            assert not command["title"].startswith("/"), command["title"]


def test_the_slash_picker_needs_the_bot_to_accept_targeted_messages(
    manifest: dict,
) -> None:
    # Declaring triggers: ["slash"] surfaces nothing on its own — the schema is
    # explicit that supportsTargetedMessages is what puts the agent in the
    # picker. Getting one without the other is a silent no-op.
    bot = manifest["bots"][0]
    declares_slash = any(
        "slash" in entry.get("triggers", ["mention"])
        for entry in bot.get("commandLists", [])
    )
    if declares_slash:
        assert bot.get("supportsTargetedMessages") is True


def test_both_surfaces_offer_the_same_commands(manifest: dict) -> None:
    # Two lists exist only because the two surfaces spell a title differently.
    # They should not drift into offering different things.
    lists = {
        tuple(sorted(entry.get("triggers", ["mention"]))): {
            c["title"].lstrip("/") for c in entry["commands"]
        }
        for entry in manifest["bots"][0]["commandLists"]
    }
    assert lists[("mention",)] == lists[("slash",)]


def test_the_menu_only_offers_commands_switch_answers(manifest: dict) -> None:
    # `/status` shipped in the old snippet and is not a command — picking it
    # from the menu returned "unknown command".
    from switch_core.bridges.agent.commands import COMMANDS_BY_NAME

    offered = {
        command["title"].lstrip("/!")
        for entry in manifest["bots"][0]["commandLists"]
        for command in entry["commands"]
    }
    unknown = sorted(offered - set(COMMANDS_BY_NAME))
    assert not unknown, f"the menu offers commands Switch cannot answer: {unknown}"


def test_the_guide_ships_the_same_manifest_it_tells_you_to_paste() -> None:
    """The setup guide embeds the manifest so it can be copied without a
    download. Two copies drift, and the one people paste is the one in the
    guide — so they are compared rather than trusted."""
    guide = (PACKAGE.parent / "TEAMS_SETUP.md").read_text()
    fenced = re.search(r"```json\n(\{.*?\n\})\n```", guide, re.S)
    assert fenced, "no JSON block in TEAMS_SETUP.md — did the manifest section move?"
    assert json.loads(fenced.group(1)) == json.loads(MANIFEST.read_text())


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


# ── the builder that turns the three files into an uploadable zip ─────────────


def _build(tmp_path: Path, *args: str) -> tuple[int, Path]:
    """Run the packager as an operator would, and return (exit code, zip)."""
    import subprocess

    out = tmp_path / "pkg.zip"
    script = REPO_ROOT / "scripts" / "build_teams_app_package.py"
    result = subprocess.run(
        [sys.executable, str(script), "-o", str(out), *args],
        capture_output=True,
        text=True,
    )
    return result.returncode, out


def test_the_package_is_flat_because_teams_rejects_a_nested_one(
    tmp_path: Path,
) -> None:
    code, out = _build(tmp_path, "--app-id", "3fa85f64-5717-4562-b3fc-2c963f66afa6")

    names = zipfile.ZipFile(out).namelist()
    assert sorted(names) == ["color.png", "manifest.json", "outline.png"]
    assert all("/" not in name for name in names)
    assert code == 1  # host and URLs left as placeholders, and it says so


def test_the_app_id_is_written_to_all_three_places(tmp_path: Path) -> None:
    # One value, three fields, and Teams does not explain a mismatch — which is
    # the whole reason this is not a hand edit.
    app_id = "3fa85f64-5717-4562-b3fc-2c963f66afa6"
    _, out = _build(tmp_path, "--app-id", app_id)

    built = json.loads(zipfile.ZipFile(out).read("manifest.json"))
    assert built["id"] == app_id
    assert built["bots"][0]["botId"] == app_id
    assert built["webApplicationInfo"]["id"] == app_id


def test_a_fully_supplied_package_reports_success(tmp_path: Path) -> None:
    code, out = _build(
        tmp_path,
        "--app-id",
        "3fa85f64-5717-4562-b3fc-2c963f66afa6",
        "--public-host",
        "teams.example.org",
        "--privacy-url",
        "https://example.org/privacy",
        "--terms-url",
        "https://example.org/terms",
    )

    assert code == 0
    built = json.loads(zipfile.ZipFile(out).read("manifest.json"))
    assert built["validDomains"] == ["teams.example.org"]
    assert built["developer"]["privacyUrl"] == "https://example.org/privacy"


def test_an_unreplaced_placeholder_is_a_non_zero_exit(tmp_path: Path) -> None:
    # So a CI step or a careless operator cannot ship the null GUID quietly.
    code, _ = _build(tmp_path)

    assert code == 1


def test_a_bad_app_id_is_refused_rather_than_written(tmp_path: Path) -> None:
    code, out = _build(tmp_path, "--app-id", "not-a-guid")

    assert code != 0
    assert not out.exists()


def test_the_built_package_declares_channel_feature_support(tmp_path: Path) -> None:
    _, out = _build(tmp_path, "--app-id", "3fa85f64-5717-4562-b3fc-2c963f66afa6")

    built = json.loads(zipfile.ZipFile(out).read("manifest.json"))
    assert built["supportsChannelFeatures"] == "tier1"


def test_a_team_scoped_app_on_a_modern_schema_declares_channel_features(
    manifest: dict,
) -> None:
    """Teams rejects the upload without it, in its own words: "Applications with
    manifest version 1.25 or higher that support the 'team' scope must include
    the 'supportsChannelFeatures' property."

    It is a validator rule rather than a schema one, so nothing catches it
    before the upload does — which is how a package that validated cleanly
    against the published schema still came back refused.
    """
    version = tuple(int(n) for n in manifest["manifestVersion"].split("."))
    team_scoped = any("team" in bot.get("scopes", []) for bot in manifest["bots"])
    if version >= (1, 25) and team_scoped:
        assert manifest.get("supportsChannelFeatures") == "tier1"


def test_the_builder_refuses_a_package_teams_would_reject_for_it(
    tmp_path: Path,
) -> None:
    # Pins the check itself, not just today's manifest: the rule has to survive
    # someone editing the shipped file.
    import subprocess

    stripped = json.loads(MANIFEST.read_text())
    stripped.pop("supportsChannelFeatures", None)
    scratch = tmp_path / "manifest.json"
    scratch.write_text(json.dumps(stripped))
    for icon in stripped["icons"].values():
        (tmp_path / icon).write_bytes((PACKAGE / icon).read_bytes())

    script = REPO_ROOT / "scripts" / "build_teams_app_package.py"
    source = script.read_text().replace(
        'PACKAGE_DIR = REPO_ROOT / "docs" / "old" / "bridges" / "teams-app"',
        f"PACKAGE_DIR = Path({str(tmp_path)!r})",
    )
    patched = tmp_path / "build.py"
    patched.write_text(source)

    result = subprocess.run(
        [
            sys.executable,
            str(patched),
            "-o",
            str(tmp_path / "x.zip"),
            "--app-id",
            "3fa85f64-5717-4562-b3fc-2c963f66afa6",
        ],
        capture_output=True,
        text=True,
    )

    assert result.returncode != 0
    assert "supportsChannelFeatures" in (result.stdout + result.stderr)


def test_bump_raises_the_patch_version(tmp_path: Path) -> None:
    # Teams matches on `id` and ignores an upload whose version has not risen,
    # without saying so — which is the usual reason an edit "did nothing".
    _, out = _build(
        tmp_path, "--app-id", "3fa85f64-5717-4562-b3fc-2c963f66afa6", "--bump"
    )

    shipped = json.loads(MANIFEST.read_text())["version"]
    built = json.loads(zipfile.ZipFile(out).read("manifest.json"))["version"]
    assert built != shipped
    major, minor, patch = (int(n) for n in built.split("."))
    was = [int(n) for n in shipped.split(".")]
    assert [major, minor, patch] == [was[0], was[1], was[2] + 1]


def test_an_unbumped_build_says_teams_will_ignore_it(tmp_path: Path) -> None:
    import subprocess

    script = REPO_ROOT / "scripts" / "build_teams_app_package.py"
    result = subprocess.run(
        [
            sys.executable,
            str(script),
            "-o",
            str(tmp_path / "p.zip"),
            "--app-id",
            "3fa85f64-5717-4562-b3fc-2c963f66afa6",
        ],
        capture_output=True,
        text=True,
    )

    assert "--bump" in result.stdout


def test_the_slash_list_is_offered_in_every_scope_the_bot_has(
    manifest: dict,
) -> None:
    # Narrowing this hid the commands in 1:1 chats. Microsoft's own example on
    # the slash-commands page scopes its slash list to personal as well, even
    # though the prose enumerates only channels and group chats — an inert
    # scope costs nothing, a missing one costs the feature.
    bot = manifest["bots"][0]
    for entry in bot["commandLists"]:
        assert set(entry["scopes"]) == set(bot["scopes"]), entry["triggers"]
