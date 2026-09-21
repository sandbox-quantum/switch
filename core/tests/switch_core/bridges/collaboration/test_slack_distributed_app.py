"""The registration walkthrough and the code have to agree, so this compares them.

`docs/old/bridges/SLACK_DISTRIBUTED_APP.md` carries a manifest an operator
pastes into Slack. Everything in it is a promise the running system has to
keep: the scopes it requests are the scopes the authorize URL asks for, and
the URLs it registers are the paths this application serves. Neither is
checked by anything at runtime — Slack simply refuses a redirect that does not
match, or grants a scope we never use, and the failure surfaces as a customer's
install not working for a reason nobody can see from here.

The manifest is parsed out of the markdown rather than kept in a fixture,
because a fixture would be a third copy and the operator pastes the markdown.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from switch_core.bridges.collaboration.install import (
    commands_path,
    events_path,
    interactive_path,
    oauth_callback_path,
    public_url,
)
from switch_core.bridges.collaboration.slack.install import BOT_SCOPES

_DOC = (
    Path(__file__).resolve().parents[5]
    / "docs"
    / "old"
    / "bridges"
    / "SLACK_DISTRIBUTED_APP.md"
)

_HOST = "HOST"


@pytest.fixture(scope="module")
def manifest() -> dict:
    text = _DOC.read_text()
    blocks = re.findall(r"```json\n(.*?)\n```", text, re.DOTALL)
    assert len(blocks) == 1, (
        f"expected exactly one json block in {_DOC.name}, found {len(blocks)}"
    )
    return json.loads(blocks[0])


def test_the_manifest_requests_the_scopes_the_authorize_url_asks_for(
    manifest: dict,
) -> None:
    """Same scopes, same order.

    Order matters less to Slack than to a reader diffing the two, and keeping
    it exact costs nothing.
    """
    assert tuple(manifest["oauth_config"]["scopes"]["bot"]) == BOT_SCOPES


def test_the_manifest_registers_the_redirect_the_callback_is_served_at(
    manifest: dict,
) -> None:
    """The one mismatch Slack refuses outright.

    A redirect URI is compared byte for byte against the registered list, so a
    path that drifted here is every install failing with `bad_redirect_uri`
    and nothing in our logs at all — the refusal happens at Slack.
    """
    expected = public_url(f"https://{_HOST}", oauth_callback_path("slack"))
    assert manifest["oauth_config"]["redirect_urls"] == [expected]


def test_the_manifest_points_events_and_interactivity_at_the_served_paths(
    manifest: dict,
) -> None:
    settings = manifest["settings"]
    assert settings["event_subscriptions"]["request_url"] == public_url(
        f"https://{_HOST}", events_path("slack")
    )
    assert settings["interactivity"]["request_url"] == public_url(
        f"https://{_HOST}", interactive_path("slack")
    )


def test_every_slash_command_posts_to_the_commands_path(manifest: dict) -> None:
    expected = public_url(f"https://{_HOST}", commands_path("slack"))
    urls = {command["url"] for command in manifest["features"]["slash_commands"]}
    assert urls == {expected}


def test_the_manifest_does_not_enable_socket_mode(manifest: dict) -> None:
    """The property the whole distributed app exists to have.

    Slack forbids Socket Mode for a Marketplace-listed app, and a single
    socket could not be shared across replicas even if it did not. Turning it
    on here would produce an app that works in a one-replica test and silently
    delivers to one arbitrary replica in production.
    """
    assert manifest["settings"]["socket_mode_enabled"] is False


def test_the_manifest_does_not_declare_the_app_an_agent(manifest: dict) -> None:
    """`agent_view` is irreversible per app and needs re-review to distribute.

    Left out deliberately rather than forgotten — see the doc. If it is added,
    that is a decision, and this test is where it gets recorded as one.
    """
    assert "agent_view" not in manifest["features"]


def test_the_manifest_does_not_enable_org_wide_deploy(manifest: dict) -> None:
    """An org-wide install has an enterprise id and no single workspace id.

    `messaging_installs` is unique on `(platform, external_workspace_id)` and
    the installer refuses an enterprise install outright, so enabling this
    would offer customers a button that always fails.
    """
    assert manifest["settings"]["org_deploy_enabled"] is False
