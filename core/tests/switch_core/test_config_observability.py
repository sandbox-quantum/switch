import pytest

from switch_core.config import SwitchConfig

BASE_ENV = {
    "DB_HOST": "localhost",
    "DB_PORT": "5432",
    "DB_USER": "postgres",
    "DB_PASSWORD": "secret",
    "DB_NAME": "switch",
    "MATRIX_SERVER_NAME": "switch.local",
    "AGENT_REGISTRATION_TOKEN": "token",
    "JWT_SECRET_KEY": "jwt",
    "GATEWAY_ADMIN_EMAIL": "admin@example.com",
    "GATEWAY_ADMIN_PASSWORD": "pw",
}

DEPLOYMENT_ID = "0e5d1b3a-6c1f-4c22-9a4c-3a9f5a2b7d10"

OBSERVABILITY_KEYS = (
    "OTLP_ENDPOINT",
    "OTLP_METRICS_ENABLED",
    "OTLP_LOGS_ENABLED",
    "OTLP_HEADERS",
    "OTLP_TIMEOUT_SECONDS",
    "OTLP_EXPORT_INTERVAL_SECONDS",
    "DEPLOYMENT_ID",
)


def _config(monkeypatch: pytest.MonkeyPatch, **overrides: str) -> SwitchConfig:
    for key in (*BASE_ENV, *OBSERVABILITY_KEYS):
        monkeypatch.delenv(key, raising=False)
    for key, value in {**BASE_ENV, **overrides}.items():
        monkeypatch.setenv(key.upper(), value)
    return SwitchConfig()  # type: ignore[call-arg]


def test_reporting_is_off_until_a_collector_is_named(monkeypatch):
    config = _config(monkeypatch)
    assert config.observability_enabled is False
    assert config.otlp_endpoint is None


def test_an_endpoint_turns_metrics_on_but_not_logs(monkeypatch):
    config = _config(
        monkeypatch,
        OTLP_ENDPOINT="https://collector.example",
        DEPLOYMENT_ID=DEPLOYMENT_ID,
    )
    assert config.observability_enabled is True
    assert config.otlp_metrics_enabled is True
    # Logs already reach the container's output; a second copy over the network
    # costs money somebody has to choose to spend.
    assert config.otlp_logs_enabled is False
    # There is deliberately no traces setting: nothing produces spans, so a
    # flag here would be one a deployment could turn on and see no difference
    # from — a configuration surface that lies about what it controls.
    assert "otlp_traces_enabled" not in type(config).model_fields


def test_an_endpoint_without_a_deployment_id_refuses_to_start(monkeypatch):
    """The collector drops unidentified payloads silently, with a 200.

    Starting anyway would give a deployment that looks configured, logs nothing
    wrong, and appears on no dashboard.
    """
    with pytest.raises(ValueError, match="DEPLOYMENT_ID must be set"):
        _config(monkeypatch, OTLP_ENDPOINT="https://collector.example")


def test_deployment_id_must_be_a_uuid(monkeypatch):
    with pytest.raises(ValueError, match="DEPLOYMENT_ID must be a UUID"):
        _config(
            monkeypatch,
            OTLP_ENDPOINT="https://collector.example",
            DEPLOYMENT_ID="pilot-cluster",
        )


def test_a_deployment_id_alone_is_not_partial_configuration(monkeypatch):
    # Nothing is reported, so nothing is wrong: an id without a collector has
    # not half-configured reporting, it has not configured it.
    config = _config(monkeypatch, DEPLOYMENT_ID=DEPLOYMENT_ID)
    assert config.observability_enabled is False


def test_the_endpoint_is_a_base_url_and_says_so(monkeypatch):
    """Pasting the full logs URL is the obvious mistake, so it is named."""
    with pytest.raises(ValueError, match="drop the '/v1/logs'"):
        _config(
            monkeypatch,
            OTLP_ENDPOINT="https://collector.example/v1/logs",
            DEPLOYMENT_ID=DEPLOYMENT_ID,
        )


def test_endpoint_must_be_http(monkeypatch):
    with pytest.raises(ValueError, match="must be an http"):
        _config(
            monkeypatch,
            OTLP_ENDPOINT="collector.example",
            DEPLOYMENT_ID=DEPLOYMENT_ID,
        )


def test_endpoint_must_have_a_host(monkeypatch):
    with pytest.raises(ValueError, match="must include a host"):
        _config(monkeypatch, OTLP_ENDPOINT="https://", DEPLOYMENT_ID=DEPLOYMENT_ID)


def test_a_trailing_slash_is_not_a_path(monkeypatch):
    config = _config(
        monkeypatch,
        OTLP_ENDPOINT="https://collector.example/",
        DEPLOYMENT_ID=DEPLOYMENT_ID,
    )
    assert config.otlp_endpoint == "https://collector.example/"


@pytest.mark.parametrize(
    "name", ["OTLP_TIMEOUT_SECONDS", "OTLP_EXPORT_INTERVAL_SECONDS"]
)
def test_intervals_must_be_positive(monkeypatch, name):
    with pytest.raises(ValueError, match=f"{name} must be greater than 0"):
        _config(
            monkeypatch,
            OTLP_ENDPOINT="https://collector.example",
            DEPLOYMENT_ID=DEPLOYMENT_ID,
            **{name: "0"},
        )


def test_headers_parse_into_pairs(monkeypatch):
    config = _config(
        monkeypatch,
        OTLP_ENDPOINT="https://collector.example",
        DEPLOYMENT_ID=DEPLOYMENT_ID,
        OTLP_HEADERS="dd-api-key=abc, x-tag = two ",
    )
    assert config.otlp_header_map == {"dd-api-key": "abc", "x-tag": "two"}


def test_malformed_headers_fail_at_startup_not_every_interval(monkeypatch):
    with pytest.raises(ValueError, match="key=value"):
        _config(
            monkeypatch,
            OTLP_ENDPOINT="https://collector.example",
            DEPLOYMENT_ID=DEPLOYMENT_ID,
            OTLP_HEADERS="just-a-key",
        )


def test_no_headers_is_an_empty_map(monkeypatch):
    config = _config(monkeypatch)
    assert config.otlp_header_map == {}


@pytest.mark.parametrize(
    "endpoint",
    ["https://collector.example?api-key=abc", "https://collector.example#frag"],
)
def test_a_query_or_fragment_is_refused(monkeypatch, endpoint):
    """Resolving the signal path against the base discards both.

    A credential written into the query — which is how several OTLP-compatible
    endpoints are published — would silently never be sent.
    """
    with pytest.raises(ValueError, match="query string or fragment"):
        _config(monkeypatch, OTLP_ENDPOINT=endpoint, DEPLOYMENT_ID=DEPLOYMENT_ID)


def test_surrounding_whitespace_is_refused(monkeypatch):
    """It ends up inside the host, not the path, and resolves nowhere."""
    with pytest.raises(ValueError, match="whitespace"):
        _config(
            monkeypatch,
            OTLP_ENDPOINT="https://collector.example ",
            DEPLOYMENT_ID=DEPLOYMENT_ID,
        )
