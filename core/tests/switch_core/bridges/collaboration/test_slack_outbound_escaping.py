"""Slack's own markup in an agent's text cannot mention anyone.

An agent's reply reaches `chat.postMessage` as mrkdwn, and Slack resolves any
`<@U…>` or `<!subteam^…>` in it into a real, notifying mention. Text an agent
echoes from a web page or a pasted message can carry one, so the body is
escaped before translation and only the markup this bridge writes is live.
"""

from __future__ import annotations

import pytest

from switch_core.bridges.collaboration.slack.adapter import (
    SlackAdapter,
    SlackConnectionConfig,
)


def _adapter() -> SlackAdapter:
    adapter = SlackAdapter(
        config=SlackConnectionConfig(
            bot_token="xoxb-test",
            app_token="xapp-test",
            workspace_id="T123",
        )
    )
    adapter.set_tenant_id("tenant-1")
    adapter._username_to_id["doe.jane"] = "U0JANE"
    adapter._agent_group_ids["opsbot"] = "S0OPSBOT"
    return adapter


def test_a_raw_user_mention_is_shown_not_resolved() -> None:
    text = _adapter().translate_outbound("Summary: <@U0ADMIN1234> check this out.")

    assert "<@U0ADMIN1234>" not in text
    assert "&lt;@U0ADMIN1234&gt;" in text


@pytest.mark.parametrize(
    "raw",
    ["<!subteam^S0123456>", "<!subteam^S0123456|@oncall>"],
)
def test_a_raw_user_group_mention_is_shown_not_resolved(raw: str) -> None:
    text = _adapter().translate_outbound(f"FYI {raw} please look")

    assert "<!subteam" not in text
    assert "&lt;!subteam^S0123456" in text


def test_a_name_switch_resolves_still_mentions() -> None:
    adapter = _adapter()

    assert (
        adapter.translate_outbound("@doe.jane here you go") == "<@U0JANE> here you go"
    )
    assert adapter.translate_outbound("ask @opsbot") == "ask <!subteam^S0OPSBOT>"


def test_a_resolved_name_beside_a_raw_mention() -> None:
    text = _adapter().translate_outbound("@doe.jane see <@U0OTHER>")

    assert text == "<@U0JANE> see &lt;@U0OTHER&gt;"


def test_markdown_links_still_become_slack_links() -> None:
    text = _adapter().translate_outbound(
        "see [the docs](https://example.com/a?b=1&c=2)"
    )

    assert text == "see <https://example.com/a?b=1&amp;c=2|the docs>"


def test_angle_brackets_and_ampersands_read_as_typed() -> None:
    text = _adapter().translate_outbound("if a < b && b > c, use <placeholder>")

    assert text == "if a &lt; b &amp;&amp; b &gt; c, use &lt;placeholder&gt;"


def test_an_escaped_display_name_is_not_escaped_twice() -> None:
    adapter = _adapter()
    label = adapter.escape_label_for_body("Reviewer <QA> & co")

    assert adapter.translate_outbound(f"*{label}* said hi") == (
        "*Reviewer &lt;QA&gt; &amp; co* said hi"
    )


def test_the_apps_own_mention_in_a_notice_stays_live() -> None:
    # The bridge core names the app in its self-mention guidance with
    # `render_app_mention`, which on Slack is the app's own `<@id>`.
    adapter = _adapter()
    adapter._bot_user_id = "U0BOT"

    text = adapter.translate_outbound(
        f"You tagged {adapter.render_app_mention('U0BOT')} directly, not <@U0SOMEONE>"
    )

    assert text == "You tagged <@U0BOT> directly, not &lt;@U0SOMEONE&gt;"


def test_a_raw_channel_wide_mention_stays_escaped() -> None:
    text = _adapter().translate_outbound("<!channel> and <!here|here>")

    assert "<!channel>" not in text
    assert "<!here" not in text
