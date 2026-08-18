"""Icon URL validation (CHOO-2171).

The rejection cases matter more than the acceptance ones: the Mattermost
adapter fetches an agent's icon server-side, so a stored URL is a request
Switch will make on behalf of whoever typed it.
"""

import pytest

from switch_core.agent_icon import (
    MAX_ICON_URL_LENGTH,
    InvalidIconUrl,
    normalise_icon_url,
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
