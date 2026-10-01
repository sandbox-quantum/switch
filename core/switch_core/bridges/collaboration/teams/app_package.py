"""The distributed Teams app's package, built for this deployment.

A Teams app reaches an organisation as a zip: its manifest and two icons.
For the distributed app Switch puts that zip into the organisation's own app
catalogue itself, with the approving admin's sign-in, so it is built here
rather than by an operator with a script. What differs per deployment — the
app id, the host the bot is reached on, the privacy and terms pages — is
filled into the template in `distributed_app/`.

The template carries no resource-specific permissions: the organisation's
admin grants the app's permissions once, organisation-wide, and asking for
the same access again per team would only add a consent prompt and a broader
install permission. Nor does it carry `webApplicationInfo`, which only those
permissions and single sign-on use.

`version` is the template's. Raise it whenever the template changes, so an
organisation holding the old one can be offered the new.
"""

from __future__ import annotations

import io
import json
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

_TEMPLATE_DIR = Path(__file__).parent / "distributed_app"
_ICONS = ("color.png", "outline.png")


@dataclass(frozen=True)
class DistributedAppPackage:
    #: The manifest id, which is also the bot's: the Entra app id. It is the
    #: same in every organisation, and is how the app is found again in an
    #: organisation's catalogue, where it is given an id of its own.
    manifest_id: str
    version: str
    archive: bytes


def build_distributed_app_package(
    *,
    app_id: str,
    messaging_public_url: str,
    privacy_url: str,
    terms_url: str,
) -> DistributedAppPackage:
    manifest: dict[str, Any] = json.loads(
        (_TEMPLATE_DIR / "manifest.json").read_text(encoding="utf-8")
    )
    # Set on the parsed manifest rather than substituted into its text, so a
    # value is always a JSON string whatever characters it holds.
    manifest["id"] = app_id
    manifest["bots"][0]["botId"] = app_id
    manifest["validDomains"] = [str(urlsplit(messaging_public_url).hostname)]
    manifest["developer"]["privacyUrl"] = privacy_url
    manifest["developer"]["termsOfUseUrl"] = terms_url
    if "{{" in json.dumps(manifest):
        raise ValueError(
            "the distributed Teams app manifest names a value this build does "
            "not fill in"
        )

    buffer = io.BytesIO()
    # Flat, with the three files at the root: Teams rejects a package whose
    # contents sit inside a folder.
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", json.dumps(manifest, indent=4))
        for icon in _ICONS:
            archive.writestr(icon, (_TEMPLATE_DIR / icon).read_bytes())
    return DistributedAppPackage(
        manifest_id=app_id, version=str(manifest["version"]), archive=buffer.getvalue()
    )
