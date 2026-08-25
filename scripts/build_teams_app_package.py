#!/usr/bin/env python3
"""Build the uploadable Teams app package: manifest + the two icons, zipped.

Every route into a tenant wants a `.zip` — the Developer Portal's **Import
app**, the client's **Upload a custom app**, and the admin centre's **Upload
new app** alike. None of them takes a bare `manifest.json`. So the repository
ships the three files and this makes the archive, rather than committing a
binary that would drift from the files beside it.

It also fills in the values that would otherwise be edited by hand in three
places, because the app id has to match in all of them and a mismatch is not
something Teams explains.

The zip is written flat, with the three files at its root: Teams rejects a
package whose contents sit inside a folder, and that is the single most common
way a hand-made one fails.

Usage:
    python scripts/build_teams_app_package.py --app-id <guid>
    python scripts/build_teams_app_package.py --app-id <guid> \\
        --public-host teams.example.com \\
        --privacy-url https://example.com/privacy \\
        --terms-url https://example.com/terms \\
        --app-name "Acme Agents"

With no --app-id it still builds, leaving the placeholder in place and saying
so — useful for checking the package shape without a tenant to hand.
"""

from __future__ import annotations

import argparse
import json
import re
import struct
import sys
import zipfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
PACKAGE_DIR = REPO_ROOT / "docs" / "bridges" / "teams-app"
MANIFEST = PACKAGE_DIR / "manifest.json"

# The three files Teams expects at the root of the archive.
ICON_KEYS = ("color", "outline")
EXPECTED_ICON_SIZE = {"color": (192, 192), "outline": (32, 32)}

PLACEHOLDER_APP_ID = "00000000-0000-0000-0000-000000000000"
PLACEHOLDER_HOST = "switch.example.com"
PLACEHOLDER_URLS = ("https://example.com/privacy", "https://example.com/terms")

_GUID = re.compile(r"^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$")


def _png_size(path: Path) -> tuple[int, int]:
    """(width, height) from a PNG's IHDR, without an image library."""
    header = path.read_bytes()[:24]
    if header[:8] != b"\x89PNG\r\n\x1a\n":
        raise SystemExit(f"{path.name} is not a PNG")
    width, height = struct.unpack(">II", header[16:24])
    return width, height


def _apply(manifest: dict, args: argparse.Namespace) -> list[str]:
    """Substitute what the operator supplied. Returns what is still a placeholder."""
    if args.app_id:
        if not _GUID.match(args.app_id):
            raise SystemExit(
                f"--app-id must be a GUID, got {args.app_id!r}. It is the Azure "
                "Bot's Application (client) ID, not its Object ID or its name."
            )
        manifest["id"] = args.app_id
        manifest["bots"][0]["botId"] = args.app_id
        manifest["webApplicationInfo"]["id"] = args.app_id
    if args.public_host:
        manifest["validDomains"] = [args.public_host]
    if args.privacy_url:
        manifest["developer"]["privacyUrl"] = args.privacy_url
    if args.terms_url:
        manifest["developer"]["termsOfUseUrl"] = args.terms_url
    if args.website_url:
        manifest["developer"]["websiteUrl"] = args.website_url
    if args.app_name:
        manifest["name"]["short"] = args.app_name
        manifest["name"]["full"] = args.app_name_full or args.app_name
    if args.bump:
        parts = manifest["version"].split(".")
        parts[-1] = str(int(parts[-1]) + 1)
        manifest["version"] = ".".join(parts)
    if args.version:
        manifest["version"] = args.version
    blob = json.dumps(manifest)
    left: list[str] = []
    if PLACEHOLDER_APP_ID in blob:
        left.append(f"the app id is still {PLACEHOLDER_APP_ID} — pass --app-id")
    if PLACEHOLDER_HOST in blob:
        left.append(f"validDomains is still {PLACEHOLDER_HOST} — pass --public-host")
    for url in PLACEHOLDER_URLS:
        if url in blob:
            left.append(f"{url} is a placeholder — pass --privacy-url / --terms-url")
    return left


def _check(manifest: dict) -> None:
    """The constraints Teams enforces silently, checked before upload."""
    name, desc = manifest["name"], manifest["description"]
    problems = []
    if len(name["short"]) > 30:
        problems.append("name.short is over 30 characters")
    if name.get("full") and len(name["full"]) > 100:
        problems.append("name.full is over 100 characters")
    if name.get("full") and name["full"] == name["short"]:
        problems.append("name.short and name.full must differ")
    if len(desc["short"]) > 80:
        problems.append("description.short is over 80 characters")
    if len(desc["full"]) > 4000:
        problems.append("description.full is over 4000 characters")
    if not re.match(r"^#[0-9a-fA-F]{6}$", manifest["accentColor"]):
        problems.append("accentColor must be #RRGGBB")
    for field in ("websiteUrl", "privacyUrl", "termsOfUseUrl"):
        if not manifest["developer"][field].startswith("https://"):
            problems.append(f"developer.{field} must be https")
    for entry in manifest["bots"][0].get("commandLists", []):
        if len(entry["commands"]) > 12:
            problems.append("a command list may hold at most 12 commands")
    # Teams' own words on rejecting the upload: "Applications with manifest
    # version 1.25 or higher that support the 'team' scope must include the
    # 'supportsChannelFeatures' property." It is a validator rule, not a schema
    # one, so nothing catches it before the upload does — hence catching it
    # here.
    schema_version = tuple(int(n) for n in manifest["manifestVersion"].split("."))
    has_team_scope = any(
        "team" in bot.get("scopes", []) for bot in manifest.get("bots", [])
    )
    if schema_version >= (1, 25) and has_team_scope:
        if not manifest.get("supportsChannelFeatures"):
            problems.append(
                "manifestVersion is "
                f"{manifest['manifestVersion']} and a bot declares the 'team' "
                "scope, so supportsChannelFeatures is required — set it to "
                "'tier1'"
            )
    if problems:
        raise SystemExit(
            "This manifest would be rejected:\n  - " + "\n  - ".join(problems)
        )


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Build the Agent Switch Teams app package (.zip).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--app-id", help="Azure Bot Application (client) ID; fills all three places"
    )
    parser.add_argument("--public-host", help="host of your public_base_url")
    parser.add_argument("--privacy-url", help="your organization's privacy policy")
    parser.add_argument("--terms-url", help="your organization's terms of use")
    parser.add_argument("--website-url", help="your organization's site")
    parser.add_argument("--app-name", help='override the app name ("Agent Switch")')
    parser.add_argument("--app-name-full", help="the long form, if it differs")
    parser.add_argument("--version", help="set the manifest version outright")
    parser.add_argument(
        "--bump",
        action="store_true",
        help="raise the patch version — required for Teams to update an app "
        "that is already installed",
    )
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        default=Path("agent-switch-teams.zip"),
        help="where to write the package (default: ./agent-switch-teams.zip)",
    )
    args = parser.parse_args()

    manifest = json.loads(MANIFEST.read_text())
    unresolved = _apply(manifest, args)
    _check(manifest)

    icons = {}
    for key in ICON_KEYS:
        name = manifest["icons"][key]
        path = PACKAGE_DIR / name
        if not path.is_file():
            raise SystemExit(f"{name} is missing from {PACKAGE_DIR}")
        if _png_size(path) != EXPECTED_ICON_SIZE[key]:
            w, h = _png_size(path)
            expect = "x".join(str(n) for n in EXPECTED_ICON_SIZE[key])
            raise SystemExit(f"{name} is {w}x{h}; Teams requires {expect}")
        icons[name] = path

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(args.output, "w", zipfile.ZIP_DEFLATED) as zf:
        # arcname without a directory: Teams rejects a nested package.
        zf.writestr("manifest.json", json.dumps(manifest, indent=4) + "\n")
        for name, path in icons.items():
            zf.write(path, arcname=name)

    print(f"Wrote {args.output} ({args.output.stat().st_size} bytes)")
    print(
        f"  manifest.json  schema v{manifest['manifestVersion']}, "
        f"app version {manifest['version']}, app id {manifest['id']}"
    )
    for name in icons:
        print(f"  {name}")
    if not (args.bump or args.version):
        # The single most common reason an edit appears not to have worked.
        # Teams matches on `id` and ignores an upload whose `version` is not
        # higher than the installed one — without saying so.
        print(
            f"\nNote: app version is still {manifest['version']}. If this app is "
            "already installed,\nTeams will ignore this upload. Re-run with "
            "--bump to raise it."
        )
    if unresolved:
        print("\nStill a placeholder — Teams will accept this, your users will not:")
        for line in unresolved:
            print(f"  ! {line}")
        return 1
    print("\nUpload it: Teams → Apps → Manage your apps → Upload an app.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
