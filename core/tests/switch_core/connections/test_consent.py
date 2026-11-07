from types import SimpleNamespace

import pytest

from switch_core.connections.flows import Exchange, FlowError, ServiceFlows

READ = ["grafana:read"]
WRITE = ["grafana:read", "grafana:query", "grafana:write"]


def _consent(granted: list[str]) -> str:
    exchange = Exchange(
        flow=SimpleNamespace(
            details={
                "name": "Grafana Cloud",
                "read_scopes": READ,
                "write_scopes": WRITE,
            }
        ),  # type: ignore[arg-type]
        signed_in=SimpleNamespace(granted_scopes=granted),  # type: ignore[arg-type]
        account=None,  # type: ignore[arg-type]
    )
    return ServiceFlows(None, SimpleNamespace()).consent(exchange)  # type: ignore[arg-type]


def test_reading_alone_is_read():
    assert _consent(["grafana:read"]) == "read"


def test_every_write_scope_is_write():
    assert _consent(WRITE) == "write"


def test_scopes_no_level_names_are_ignored():
    assert _consent(["grafana:read", "mcp:dashboards"]) == "read"


@pytest.mark.parametrize(
    "granted",
    [["grafana:read", "grafana:query"], ["grafana:read", "grafana:write"]],
)
def test_part_of_writing_is_refused(granted):
    with pytest.raises(FlowError) as caught:
        _consent(granted)
    assert str(caught.value) == (
        "Grafana Cloud granted part of the write access Switch asks for. "
        "Connect again and allow all of it, or allow only read access."
    )


def test_less_than_reading_is_still_refused():
    with pytest.raises(FlowError, match="granted less than Switch needs to read"):
        _consent(["mcp:dashboards"])
