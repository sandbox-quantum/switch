"""Accounts several people post as cannot be linked to one Switch user
(CHOO-3881)."""

from __future__ import annotations

import pytest

from switch_core.bridges.collaboration.adapter import PlatformAdapter
from switch_core.bridges.collaboration.slack.adapter import SlackAdapter
from switch_core.bridges.collaboration.telegram.adapter import TelegramAdapter


@pytest.mark.parametrize("account", ["1087968824", "136817688", "777000"])
def test_telegram_stand_ins_are_refused(account: str) -> None:
    assert TelegramAdapter.unlinkable_account_reason(account) is not None


def test_a_telegram_person_can_be_linked() -> None:
    assert TelegramAdapter.unlinkable_account_reason("424242") is None


@pytest.mark.parametrize("account", ["B0123ABCD", "USLACKBOT"])
def test_slack_apps_and_bots_are_refused(account: str) -> None:
    assert SlackAdapter.unlinkable_account_reason(account) is not None


@pytest.mark.parametrize("account", ["U0123ABCD", "W0123ABCD"])
def test_a_slack_person_can_be_linked(account: str) -> None:
    assert SlackAdapter.unlinkable_account_reason(account) is None


def test_by_default_any_account_can_be_linked() -> None:
    assert PlatformAdapter.unlinkable_account_reason("anyone") is None
