"""A cloud machine's enrolment code lives 15 minutes."""

from datetime import timedelta

from switch_core.management import tokens


def test_the_code_lives_fifteen_minutes() -> None:
    assert tokens.MACHINE_ENROLLMENT_CODE_LIFETIME == timedelta(minutes=15)
