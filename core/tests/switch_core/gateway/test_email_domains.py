import re
from importlib.resources import files

import pytest

from switch_core.gateway.email_domains import join_domain_refusal

DOMAIN = re.compile(
    r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$"
)


@pytest.mark.parametrize(
    "domain",
    [
        "gmail.com",  # free-mail list
        "mailinator.com",  # disposable list
        "proton.me",  # in neither list, added by hand
    ],
)
def test_a_public_provider_is_refused(domain: str) -> None:
    refusal = join_domain_refusal(domain)
    assert refusal is not None
    assert domain in refusal


@pytest.mark.parametrize("domain", ["acme.example", "switch.local"])
def test_an_organisation_domain_is_allowed(domain: str) -> None:
    assert join_domain_refusal(domain) is None


@pytest.mark.parametrize("name", ["free.txt", "disposable.txt"])
def test_every_listed_entry_is_a_lower_case_domain(name: str) -> None:
    text = (
        files("switch_core.gateway")
        .joinpath("email_domain_lists", name)
        .read_text(encoding="utf-8")
    )
    entries = [line for line in text.splitlines() if not line.startswith("#")]
    assert entries
    assert [e for e in entries if not DOMAIN.match(e)] == []
