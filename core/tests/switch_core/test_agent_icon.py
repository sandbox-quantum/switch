"""Icon URL validation (CHOO-2171).

The rejection cases matter more than the acceptance ones: the Mattermost
adapter fetches an agent's icon server-side, so a stored URL is a request
Switch will make on behalf of whoever typed it.
"""

import pytest

from switch_core.agent_icon import (
    GENERATED_ICON_CHOICES,
    MAX_ICON_URL_LENGTH,
    InvalidIconUrl,
    generated_icon_choices,
    generated_icon_url,
    initials_icon_url,
    normalise_icon_url,
    upgrade_legacy_icon_url,
    validate_icon_url,
)


@pytest.mark.parametrize(
    "url",
    [
        "https://example.com/icon.png",
        "https://cdn.example.com/9.x/bottts/png?seed=switch-worker&size=200",
        "https://example.com:8443/a/b/c.svg",
        # Literal IPs are allowed when genuinely routable. Note the documentation
        # ranges (198.51.100.0/24, 2001:db8::/32) are NOT usable as stand-ins
        # here — Python classifies them private, so they are refused.
        "https://8.8.8.8/icon.png",
        "https://[2606:4700:4700::1111]/icon.png",
    ],
)
def test_accepts_public_https_urls(url: str) -> None:
    assert validate_icon_url(url) == url


@pytest.mark.parametrize(
    "url",
    [
        "  https://example.com/i.png  ",
        "https://example.com/i.png\n",
        "\thttps://example.com/i.png",
    ],
)
def test_strips_surrounding_whitespace(url: str) -> None:
    """Surrounding whitespace is trimmed, including a trailing newline from a
    copy-paste. Whitespace *inside* the URL is a different matter — see below."""
    assert validate_icon_url(url) == "https://example.com/i.png"


@pytest.mark.parametrize(
    "url",
    [
        "http://example.com/icon.png",
        "javascript:alert(1)",
        "data:image/svg+xml,<svg onload=alert(1)/>",
        "file:///etc/passwd",
        "ftp://example.com/icon.png",
        "//example.com/icon.png",
        "example.com/icon.png",
    ],
)
def test_rejects_non_https_schemes(url: str) -> None:
    with pytest.raises(InvalidIconUrl):
        validate_icon_url(url)


@pytest.mark.parametrize(
    "url",
    [
        "https://localhost/icon.png",
        "https://LOCALHOST/icon.png",
        "https://127.0.0.1/icon.png",
        "https://127.13.13.13/icon.png",
        "https://10.0.0.5/icon.png",
        "https://192.168.1.1/icon.png",
        "https://172.16.4.2/icon.png",
        "https://169.254.169.254/latest/meta-data/",
        "https://[::1]/icon.png",
        "https://[fe80::1]/icon.png",
        "https://0.0.0.0/icon.png",
    ],
)
def test_rejects_internal_addresses(url: str) -> None:
    """A URL naming the host or its private network would turn the
    Mattermost avatar fetch into an internal probe."""
    with pytest.raises(InvalidIconUrl):
        validate_icon_url(url)


def test_rejects_embedded_credentials() -> None:
    with pytest.raises(InvalidIconUrl):
        validate_icon_url("https://user:secret@example.com/icon.png")


def test_rejects_missing_hostname() -> None:
    with pytest.raises(InvalidIconUrl):
        validate_icon_url("https:///icon.png")


def test_rejects_overlong_url() -> None:
    too_long = "https://example.com/" + ("a" * MAX_ICON_URL_LENGTH)
    with pytest.raises(InvalidIconUrl):
        validate_icon_url(too_long)


def test_accepts_url_at_the_length_limit() -> None:
    prefix = "https://example.com/"
    exact = prefix + "a" * (MAX_ICON_URL_LENGTH - len(prefix))
    assert len(exact) == MAX_ICON_URL_LENGTH
    assert validate_icon_url(exact) == exact


@pytest.mark.parametrize(
    "url",
    [
        "https://example.com/ic on.png",
        "https://exa\tmple.com/icon.png",
        "https://example.com/icon.png\r\nHost: evil",
        "https://example.com/ic\x00on.png",
    ],
)
def test_rejects_internal_whitespace_and_control_characters(url: str) -> None:
    with pytest.raises(InvalidIconUrl):
        validate_icon_url(url)


@pytest.mark.parametrize("blank", ["", "   ", "\t"])
def test_rejects_blank(blank: str) -> None:
    with pytest.raises(InvalidIconUrl):
        validate_icon_url(blank)


@pytest.mark.parametrize("blank", [None, "", "   "])
def test_normalise_collapses_absent_and_blank_to_none(blank: str | None) -> None:
    """One stored representation for "no icon" — NULL — so the display layer
    never has to distinguish a missing icon from an empty string."""
    assert normalise_icon_url(blank) is None


def test_normalise_validates_a_present_url() -> None:
    assert normalise_icon_url(" https://example.com/i.png ") == (
        "https://example.com/i.png"
    )
    with pytest.raises(InvalidIconUrl):
        normalise_icon_url("http://10.0.0.1/i.png")


def test_generated_icon_is_a_stable_raster_gaze_per_seed() -> None:
    # Switch Console builds the same URL (`agent-avatar.ts`) and its test pins
    # this same string: change one and the other has to follow, or an agent
    # wears a different face in the app than on the chat platforms.
    url = generated_icon_url("pm-agent")
    assert (
        url == "https://api.dicebear.com/10.x/gaze/png?seed=pm-agent&size=256&scale=1.1"
    )
    assert generated_icon_url("pm-agent") == url
    assert validate_icon_url(url) == url


@pytest.mark.parametrize(
    ("stored", "seed"),
    [
        # Switch's own robot, and Switch Console's (same shape).
        ("https://api.dicebear.com/9.x/bottts/png?seed=pm-agent&size=256", "pm-agent"),
        (
            "https://api.dicebear.com/9.x/bottts/png?seed=0b6c4f0e-8e1a-4f7e-9d65-0c2b5a3e9f11&size=256",
            "0b6c4f0e-8e1a-4f7e-9d65-0c2b5a3e9f11",
        ),
        (
            "https://api.dicebear.com/9.x/bottts/png?seed=pm-agent-1-4&size=256",
            "pm-agent-1-4",
        ),
    ],
)
def test_a_generated_robot_is_upgraded_to_gaze_for_its_seed(
    stored: str, seed: str
) -> None:
    assert upgrade_legacy_icon_url(stored) == generated_icon_url(seed)
    assert normalise_icon_url(stored) == generated_icon_url(seed)


@pytest.mark.parametrize(
    "url",
    [
        # Options of its own: someone built this by hand.
        "https://api.dicebear.com/9.x/bottts/png?seed=x&size=256&backgroundColor=ff0000",
        "https://api.dicebear.com/9.x/bottts/png?seed=x&size=128",
        "https://api.dicebear.com/9.x/bottts/png?seed=&size=256",
        "https://api.dicebear.com/9.x/bottts/png?size=256",
        "https://api.dicebear.com/9.x/bottts/svg?seed=x&size=256",
        "https://api.dicebear.com/9.x/bottts/png?seed=x&size=256#frag",
        # Same fields, another order: no client built it this way.
        "https://api.dicebear.com/9.x/bottts/png?size=256&seed=x",
        "https://API.dicebear.com/9.x/bottts/png?seed=x&size=256",
        # Another style, another host, or a lookalike host.
        "https://api.dicebear.com/9.x/identicon/png?seed=x&size=256",
        "https://cdn.example.com/9.x/bottts/png?seed=x&size=256",
        "https://api.dicebear.com.example/9.x/bottts/png?seed=x&size=256",
    ],
)
def test_anything_but_the_generated_robot_is_left_alone(url: str) -> None:
    assert upgrade_legacy_icon_url(url) == url


def test_a_robot_is_converted_before_it_is_validated() -> None:
    # Surrounding whitespace is stripped first, so it does not hide a robot.
    stored = " https://api.dicebear.com/9.x/bottts/png?seed=pm-agent&size=256 "
    assert normalise_icon_url(stored) == generated_icon_url("pm-agent")


def test_a_robot_whose_gaze_form_is_over_the_limit_is_refused() -> None:
    # The robot fits, but the gaze URL it becomes is longer. Checking before
    # converting would store it over the limit.
    seed = "a" * 1990
    robot = f"https://api.dicebear.com/9.x/bottts/png?seed={seed}&size=256"
    assert len(robot) <= MAX_ICON_URL_LENGTH < len(generated_icon_url(seed))
    with pytest.raises(InvalidIconUrl, match="at most"):
        normalise_icon_url(robot)


def test_the_gaze_icon_is_left_alone() -> None:
    url = generated_icon_url("pm-agent")
    assert upgrade_legacy_icon_url(url) == url


def test_initials_badge_reads_underscores_as_word_breaks() -> None:
    # Two words, so the badge draws two letters for `switch_worker`.
    assert "name=switch+worker&" in initials_icon_url("switch_worker")
    assert initials_icon_url("worker") != initials_icon_url("manager")


def test_generated_icon_escapes_the_seed() -> None:
    url = generated_icon_url("a&b=c d")
    assert "seed=a%26b%3Dc%20d&" in url


def test_generated_choices_lead_with_the_name_and_stay_put() -> None:
    first = generated_icon_choices("pm-agent", 0)
    assert len(first) == GENERATED_ICON_CHOICES
    assert first[0] == generated_icon_url("pm-agent")
    assert generated_icon_choices("pm-agent", 0) == first
    second = generated_icon_choices("pm-agent", 1)
    assert len(second) == GENERATED_ICON_CHOICES
    assert not set(first) & set(second)
