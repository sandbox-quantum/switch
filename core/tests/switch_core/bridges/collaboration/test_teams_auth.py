from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
import jwt
import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from jwt.algorithms import RSAAlgorithm

from switch_core.bridges.collaboration.teams.auth import (
    BOT_CONNECTOR_SCOPE,
    BOTFRAMEWORK_ISSUER,
    GRAPH_CHANGE_TRACKING_APP_ID,
    BotFrameworkAuthenticator,
    ClientCertificate,
    ClientSecret,
    FederatedTokenFile,
    GraphNotificationAuthenticator,
    SigningKeys,
    SigningKeysUnavailable,
    TeamsTokenProvider,
    TokenRequestRefused,
    token_endpoint,
    verify_microsoft_id_token,
)

_SERVICE_URL = "https://smba.trafficmanager.net/amer/"
_METADATA = "https://login.example/.well-known/openid"
_JWKS = "https://login.example/keys"


def _run(coro: Any) -> Any:
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


class _FakeResp:
    def __init__(self, status_code: int, payload: dict[str, Any]) -> None:
        self.status_code = status_code
        self._payload = payload
        self.text = json.dumps(payload)

    def json(self) -> dict[str, Any]:
        return self._payload


class _FakeHttp:
    def __init__(self, resp: _FakeResp) -> None:
        self._resp = resp
        self.calls: list[dict[str, Any]] = []

    async def post(self, url: str, data: dict[str, Any]) -> _FakeResp:
        self.calls.append({"url": url, "data": data})
        return self._resp


def _provider(http: _FakeHttp, credential: Any = None) -> TeamsTokenProvider:
    return TeamsTokenProvider(
        tenant_id="tenant-1",
        app_id="app-1",
        credential=credential or ClientSecret("secret"),
        http=http,  # type: ignore[arg-type]
    )


def test_token_is_fetched_and_returned() -> None:
    http = _FakeHttp(_FakeResp(200, {"access_token": "tok-1", "expires_in": 3600}))
    provider = _provider(http)

    token = _run(provider.token(BOT_CONNECTOR_SCOPE))

    assert token == "tok-1"
    assert len(http.calls) == 1
    assert http.calls[0]["url"] == token_endpoint("tenant-1")
    assert http.calls[0]["data"]["scope"] == BOT_CONNECTOR_SCOPE
    assert http.calls[0]["data"]["grant_type"] == "client_credentials"
    assert http.calls[0]["data"]["client_secret"] == "secret"


def test_token_is_cached_until_expiry() -> None:
    http = _FakeHttp(_FakeResp(200, {"access_token": "tok-1", "expires_in": 3600}))
    provider = _provider(http)

    first = _run(provider.token(BOT_CONNECTOR_SCOPE))
    second = _run(provider.token(BOT_CONNECTOR_SCOPE))

    assert first == second == "tok-1"
    # Only one network round-trip — the second call is served from cache.
    assert len(http.calls) == 1


def test_token_error_raises_with_microsofts_codes() -> None:
    """The numeric codes are what tell an unapproved app from a bad secret."""
    http = _FakeHttp(
        _FakeResp(400, {"error": "unauthorized_client", "error_codes": [700016]})
    )
    provider = _provider(http)

    with pytest.raises(TokenRequestRefused) as excinfo:
        _run(provider.token(BOT_CONNECTOR_SCOPE))

    assert excinfo.value.app_not_approved
    assert excinfo.value.error_codes == frozenset({700016})


def test_a_wrong_secret_is_not_read_as_an_unapproved_app() -> None:
    http = _FakeHttp(
        _FakeResp(401, {"error": "invalid_client", "error_codes": [7000215]})
    )

    with pytest.raises(TokenRequestRefused) as excinfo:
        _run(_provider(http).token(BOT_CONNECTOR_SCOPE))

    assert not excinfo.value.app_not_approved


def test_graph_roles_are_read_from_the_issued_token() -> None:
    token = jwt.encode({"roles": ["Channel.Create", "User.ReadBasic.All"]}, "k" * 32)
    http = _FakeHttp(_FakeResp(200, {"access_token": token, "expires_in": 3600}))

    roles = _run(_provider(http).graph_roles())

    assert roles == frozenset({"Channel.Create", "User.ReadBasic.All"})


def test_a_token_with_no_roles_has_none() -> None:
    """A directory that withdrew every permission but kept the app still
    issues a token; it carries no roles, and that is the signal."""
    token = jwt.encode({"aud": "https://graph.microsoft.com"}, "k" * 32)
    http = _FakeHttp(_FakeResp(200, {"access_token": token, "expires_in": 3600}))

    assert _run(_provider(http).graph_roles()) == frozenset()


# ── Credentials ──────────────────────────────────────────────────────────────


def _rsa_key() -> rsa.RSAPrivateKey:
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def _certificate(key: rsa.RSAPrivateKey) -> x509.Certificate:
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "switch-test")])
    now = datetime.now(UTC)
    return (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(days=1))
        .not_valid_after(now + timedelta(days=1))
        .sign(key, hashes.SHA256())
    )


def _pem(key: rsa.RSAPrivateKey) -> str:
    return key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()


def test_a_certificate_assertion_is_signed_for_the_endpoint_it_goes_to() -> None:
    key = _rsa_key()
    certificate = _certificate(key)
    credential = ClientCertificate(
        certificate_pem=certificate.public_bytes(serialization.Encoding.PEM).decode(),
        private_key_pem=_pem(key),
    )
    url = token_endpoint("tenant-9")

    form = _run(credential.form(app_id="app-1", token_url=url))

    assert form["client_assertion_type"].endswith(":jwt-bearer")
    assertion = form["client_assertion"]
    header = jwt.get_unverified_header(assertion)
    assert header["alg"] == "PS256"
    assert "x5t#S256" in header and "x5t" in header
    claims = jwt.decode(assertion, key.public_key(), algorithms=["PS256"], audience=url)
    assert claims["iss"] == claims["sub"] == "app-1"
    assert "client_secret" not in form


def test_each_assertion_is_fresh() -> None:
    """Microsoft refuses a replayed assertion, so each request gets its own."""
    key = _rsa_key()
    credential = ClientCertificate(
        certificate_pem=_certificate(key)
        .public_bytes(serialization.Encoding.PEM)
        .decode(),
        private_key_pem=_pem(key),
    )
    url = token_endpoint("tenant-9")

    first = _run(credential.form(app_id="app-1", token_url=url))
    second = _run(credential.form(app_id="app-1", token_url=url))

    assert first["client_assertion"] != second["client_assertion"]


def test_a_federated_token_is_read_from_its_file_each_time(tmp_path: Path) -> None:
    path = tmp_path / "token"
    path.write_text("first\n")
    credential = FederatedTokenFile(str(path))
    url = token_endpoint("t")

    assert _run(credential.form(app_id="a", token_url=url))["client_assertion"] == (
        "first"
    )
    path.write_text("rotated")
    assert _run(credential.form(app_id="a", token_url=url))["client_assertion"] == (
        "rotated"
    )


def test_an_empty_federated_token_file_refuses(tmp_path: Path) -> None:
    path = tmp_path / "token"
    path.write_text("")

    with pytest.raises(TokenRequestRefused, match="empty"):
        _run(FederatedTokenFile(str(path)).form(app_id="a", token_url="u"))


# ── Signing keys and the Bot Framework authenticator ─────────────────────────


def _jwk(key: rsa.RSAPrivateKey, kid: str, endorsements: list[str]) -> dict[str, Any]:
    entry: dict[str, Any] = RSAAlgorithm.to_jwk(key.public_key(), as_dict=True)
    entry["kid"] = kid
    if endorsements:
        entry["endorsements"] = endorsements
    return entry


class _KeyServer:
    """Serves OpenID metadata and a JWKS, counting how often it is asked."""

    def __init__(self, keys: list[dict[str, Any]]) -> None:
        self.keys = keys
        self.fetches = 0
        self.fail = False

    def handler(self, request: httpx.Request) -> httpx.Response:
        if self.fail:
            return httpx.Response(503)
        if str(request.url) == _METADATA:
            return httpx.Response(200, json={"jwks_uri": _JWKS})
        self.fetches += 1
        return httpx.Response(200, json={"keys": self.keys})


def _signing_keys(server: _KeyServer) -> SigningKeys:
    http = httpx.AsyncClient(transport=httpx.MockTransport(server.handler))
    return SigningKeys(metadata_url=_METADATA, http=http)


def _bot_token(
    key: rsa.RSAPrivateKey,
    *,
    kid: str = "k1",
    aud: str = "app-1",
    iss: str = BOTFRAMEWORK_ISSUER,
    service_url: str | None = _SERVICE_URL,
    expired: bool = False,
) -> str:
    now = datetime.now(UTC)
    exp = now - timedelta(minutes=30) if expired else now + timedelta(hours=1)
    claims: dict[str, Any] = {"aud": aud, "iss": iss, "exp": exp}
    if service_url is not None:
        claims["serviceurl"] = service_url
    return jwt.encode(claims, key, algorithm="RS256", headers={"kid": kid})


def _authenticator(
    key: rsa.RSAPrivateKey, *, endorsements: list[str] | None = None
) -> BotFrameworkAuthenticator:
    server = _KeyServer(
        [_jwk(key, "k1", ["msteams"] if endorsements is None else endorsements)]
    )
    return BotFrameworkAuthenticator(app_id="app-1", keys=_signing_keys(server))


def _verify(authenticator: BotFrameworkAuthenticator, header: str | None) -> None:
    _run(authenticator.verify(header, service_url=_SERVICE_URL, channel_id="msteams"))


def test_a_genuine_activity_token_is_accepted() -> None:
    key = _rsa_key()
    _verify(_authenticator(key), f"Bearer {_bot_token(key)}")


def test_a_missing_header_is_refused() -> None:
    with pytest.raises(PermissionError):
        _verify(_authenticator(_rsa_key()), None)


def test_a_non_bearer_header_is_refused() -> None:
    with pytest.raises(PermissionError):
        _verify(_authenticator(_rsa_key()), "Basic Zm9vOmJhcg==")


def test_a_wrong_audience_names_both_app_ids() -> None:
    """A mismatch is a misconfiguration, and the operator cannot fix it without
    both halves: the app id Azure addressed the activity to, and the one this
    bridge was registered with."""
    key = _rsa_key()

    with pytest.raises(PermissionError) as excinfo:
        _verify(_authenticator(key), f"Bearer {_bot_token(key, aud='someone-else')}")

    assert "someone-else" in str(excinfo.value)
    assert "app-1" in str(excinfo.value)


def test_the_audience_quoted_back_is_a_signature_verified_one(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The rejection message names the audience the token carries, so that
    value must not come from an unverified parse — otherwise the text
    explaining why an attacker was rejected is written by the attacker."""
    key = _rsa_key()
    authenticator = _authenticator(key)
    seen: list[dict[str, Any]] = []
    original = jwt.decode

    def _decode(*args: Any, **kwargs: Any) -> Any:
        seen.append(dict(kwargs.get("options") or {}))
        assert len(args) > 1 and args[1], "decoded with no key"
        return original(*args, **kwargs)

    monkeypatch.setattr(jwt, "decode", _decode)

    with pytest.raises(PermissionError):
        _verify(authenticator, f"Bearer {_bot_token(key, aud='someone-else')}")

    assert seen
    assert not any(o.get("verify_signature") is False for o in seen)


def test_an_expired_token_is_refused() -> None:
    key = _rsa_key()
    with pytest.raises(PermissionError, match="expired"):
        _verify(_authenticator(key), f"Bearer {_bot_token(key, expired=True)}")


def test_a_token_from_another_issuer_is_refused() -> None:
    key = _rsa_key()
    with pytest.raises(PermissionError):
        _verify(_authenticator(key), f"Bearer {_bot_token(key, iss='https://evil')}")


def test_a_bad_signature_is_refused() -> None:
    key = _rsa_key()
    with pytest.raises(PermissionError):
        _verify(_authenticator(key), f"Bearer {_bot_token(_rsa_key())}")


def test_a_token_for_another_service_url_is_refused() -> None:
    """A token minted for one region replayed with an activity pointing
    elsewhere is the attack the claim exists to stop."""
    key = _rsa_key()
    token = _bot_token(key, service_url="https://smba.trafficmanager.net/emea/")
    with pytest.raises(PermissionError, match="serviceUrl"):
        _verify(_authenticator(key), f"Bearer {token}")


def test_a_token_with_no_service_url_claim_is_refused() -> None:
    key = _rsa_key()
    with pytest.raises(PermissionError, match="serviceUrl"):
        _verify(_authenticator(key), f"Bearer {_bot_token(key, service_url=None)}")


def test_a_key_not_endorsed_for_the_channel_is_refused() -> None:
    key = _rsa_key()
    with pytest.raises(PermissionError, match="endorsed"):
        _verify(
            _authenticator(key, endorsements=["skype"]), f"Bearer {_bot_token(key)}"
        )


def test_an_unknown_key_id_is_refused_without_hammering_the_provider() -> None:
    """A stream of tokens naming made-up key ids must not become a stream of
    requests to Microsoft."""
    key = _rsa_key()
    server = _KeyServer([_jwk(key, "k1", ["msteams"])])
    authenticator = BotFrameworkAuthenticator(
        app_id="app-1", keys=_signing_keys(server)
    )
    _verify(authenticator, f"Bearer {_bot_token(key)}")

    for _ in range(5):
        with pytest.raises(PermissionError, match="unknown key"):
            _verify(authenticator, f"Bearer {_bot_token(key, kid='made-up')}")

    assert server.fetches == 1


def test_keys_already_held_survive_a_provider_outage() -> None:
    key = _rsa_key()
    server = _KeyServer([_jwk(key, "k1", ["msteams"])])
    keys = _signing_keys(server)
    authenticator = BotFrameworkAuthenticator(app_id="app-1", keys=keys)
    _verify(authenticator, f"Bearer {_bot_token(key)}")

    server.fail = True
    keys._fetched_at = 0.0  # stale, so the next request tries to refresh
    keys._attempted_at = 0.0
    _verify(authenticator, f"Bearer {_bot_token(key)}")


# ── Graph validation tokens ──────────────────────────────────────────────────


def _validation_token(
    key: rsa.RSAPrivateKey,
    *,
    tenant: str = "org-1",
    aud: str = "app-1",
    caller: str = GRAPH_CHANGE_TRACKING_APP_ID,
    version: str = "v2",
    iss: str | None = None,
) -> str:
    issuer = iss or (
        f"https://login.microsoftonline.com/{tenant}/v2.0"
        if version == "v2"
        else f"https://sts.windows.net/{tenant}/"
    )
    claims = {
        "aud": aud,
        "iss": issuer,
        "tid": tenant,
        "exp": datetime.now(UTC) + timedelta(hours=1),
        ("azp" if version == "v2" else "appid"): caller,
    }
    return jwt.encode(claims, key, algorithm="RS256", headers={"kid": "g1"})


def _notification_authenticator(
    key: rsa.RSAPrivateKey,
) -> GraphNotificationAuthenticator:
    server = _KeyServer([_jwk(key, "g1", [])])
    return GraphNotificationAuthenticator(app_id="app-1", keys=_signing_keys(server))


@pytest.mark.parametrize("version", ["v1", "v2"])
def test_validation_tokens_vouch_for_their_directories(version: str) -> None:
    key = _rsa_key()
    tokens = [
        _validation_token(key, tenant="org-1", version=version),
        _validation_token(key, tenant="org-2", version=version),
    ]

    vouched = _run(_notification_authenticator(key).vouched_tenants(tokens))

    assert vouched == frozenset({"org-1", "org-2"})


def test_a_validation_token_for_another_app_is_refused() -> None:
    key = _rsa_key()
    with pytest.raises(PermissionError):
        _run(
            _notification_authenticator(key).vouched_tenants(
                [_validation_token(key, aud="someone-else")]
            )
        )


def test_a_validation_token_not_issued_to_graph_is_refused() -> None:
    key = _rsa_key()
    with pytest.raises(PermissionError, match="change-tracking"):
        _run(
            _notification_authenticator(key).vouched_tenants(
                [_validation_token(key, caller="some-other-app")]
            )
        )


def test_a_validation_token_whose_directory_its_issuer_does_not_name_is_refused() -> (
    None
):
    key = _rsa_key()
    token = _validation_token(
        key, tenant="org-1", iss="https://login.microsoftonline.com/org-2/v2.0"
    )
    with pytest.raises(PermissionError, match="directory"):
        _run(_notification_authenticator(key).vouched_tenants([token]))


# ── Signing keys: what a key set can go wrong with ───────────────────────────


def test_no_keys_to_verify_with_is_neither_accepted_nor_called_forged() -> None:
    """Microsoft's key endpoint down at the first request leaves nothing to
    check a signature against. The activity is not accepted, and not refused
    as forged either: that would lose it, where an outage is retried."""
    key = _rsa_key()
    server = _KeyServer([_jwk(key, "k1", ["msteams"])])
    server.fail = True
    authenticator = BotFrameworkAuthenticator(
        app_id="app-1", keys=_signing_keys(server)
    )

    with pytest.raises(SigningKeysUnavailable, match="could not fetch signing keys"):
        _verify(authenticator, f"Bearer {_bot_token(key)}")
    # Too soon to fetch again, and still nothing held to check with.
    with pytest.raises(
        SigningKeysUnavailable, match="no signing keys could be fetched"
    ):
        _verify(authenticator, f"Bearer {_bot_token(key)}")


def test_entries_that_are_not_usable_keys_are_skipped() -> None:
    key = _rsa_key()
    server = _KeyServer(
        [
            {"kty": "RSA", "n": "AQAB", "e": "AQAB"},  # no kid
            {"kid": "broken", "kty": "RSA", "n": "not base64!", "e": "x"},
            _jwk(key, "k1", ["msteams"]),
        ]
    )
    authenticator = BotFrameworkAuthenticator(
        app_id="app-1", keys=_signing_keys(server)
    )

    _verify(authenticator, f"Bearer {_bot_token(key)}")


def test_a_key_set_with_nothing_usable_leaves_nothing_to_check_with() -> None:
    key = _rsa_key()
    server = _KeyServer([{"kid": "broken", "kty": "RSA", "n": "!", "e": "!"}])
    authenticator = BotFrameworkAuthenticator(
        app_id="app-1", keys=_signing_keys(server)
    )

    with pytest.raises(SigningKeysUnavailable, match="no usable signing keys"):
        _verify(authenticator, f"Bearer {_bot_token(key)}")


def test_keys_already_held_survive_a_key_set_with_nothing_usable() -> None:
    key = _rsa_key()
    server = _KeyServer([_jwk(key, "k1", ["msteams"])])
    keys = _signing_keys(server)
    authenticator = BotFrameworkAuthenticator(app_id="app-1", keys=keys)
    _verify(authenticator, f"Bearer {_bot_token(key)}")

    server.keys = [{"kid": "broken", "kty": "RSA", "n": "!", "e": "!"}]
    keys._fetched_at = 0.0
    keys._attempted_at = 0.0
    _verify(authenticator, f"Bearer {_bot_token(key)}")


def test_a_bearer_that_is_not_a_jwt_is_refused() -> None:
    with pytest.raises(PermissionError, match="not a JWT"):
        _verify(_authenticator(_rsa_key()), "Bearer not-a-jwt")


def test_a_token_naming_no_signing_key_is_refused() -> None:
    key = _rsa_key()
    unnamed = jwt.encode(
        {"aud": "app-1", "iss": BOTFRAMEWORK_ISSUER}, key, algorithm="RS256"
    )

    with pytest.raises(PermissionError, match="names no signing key"):
        _verify(_authenticator(key), f"Bearer {unnamed}")


# ── Verifying an id token an admin signed in with ─────────────────────────────


def _id_token(
    key: rsa.RSAPrivateKey,
    *,
    kid: str = "id1",
    app_id: str = "app-1",
    tenant: str = "tenant-1",
    expired: bool = False,
    claims: dict[str, Any] | None = None,
) -> str:
    now = datetime.now(UTC)
    exp = now - timedelta(minutes=5) if expired else now + timedelta(hours=1)
    body: dict[str, Any] = {
        "aud": app_id,
        "iss": f"https://login.microsoftonline.com/{tenant}/v2.0",
        "tid": tenant,
        "exp": exp,
    }
    if claims:
        body.update(claims)
    return jwt.encode(body, key, algorithm="RS256", headers={"kid": kid})


def test_a_genuine_id_token_is_accepted() -> None:
    key = _rsa_key()
    server = _KeyServer([_jwk(key, "id1", [])])

    verified = _run(
        verify_microsoft_id_token(
            _id_token(key), app_id="app-1", keys=_signing_keys(server)
        )
    )

    assert verified["tid"] == "tenant-1"


def test_an_expired_id_token_is_rejected() -> None:
    key = _rsa_key()
    server = _KeyServer([_jwk(key, "id1", [])])

    with pytest.raises(PermissionError, match="id token rejected"):
        _run(
            verify_microsoft_id_token(
                _id_token(key, expired=True),
                app_id="app-1",
                keys=_signing_keys(server),
            )
        )


def test_an_id_token_addressed_to_a_different_app_is_rejected() -> None:
    key = _rsa_key()
    server = _KeyServer([_jwk(key, "id1", [])])

    with pytest.raises(PermissionError, match="id token rejected"):
        _run(
            verify_microsoft_id_token(
                _id_token(key, app_id="some-other-app"),
                app_id="app-1",
                keys=_signing_keys(server),
            )
        )


def test_an_id_token_issued_by_a_directory_other_than_the_one_it_names_is_rejected() -> (
    None
):
    key = _rsa_key()
    server = _KeyServer([_jwk(key, "id1", [])])
    forged = _id_token(
        key, claims={"iss": "https://login.microsoftonline.com/someone-else/v2.0"}
    )

    with pytest.raises(
        PermissionError, match="not issued by the organisation it names"
    ):
        _run(
            verify_microsoft_id_token(
                forged, app_id="app-1", keys=_signing_keys(server)
            )
        )


def test_requests_arriving_during_the_first_fetch_wait_for_its_keys() -> None:
    """A burst at a cold start: every request after the first used to find no
    key and no fetch allowed, and was refused."""
    key = _rsa_key()

    class _SlowKeyServer(_KeyServer):
        async def handle(self, request: httpx.Request) -> httpx.Response:
            if str(request.url) != _METADATA:
                await asyncio.sleep(0.2)
            return self.handler(request)

    server = _SlowKeyServer([_jwk(key, "k1", ["msteams"])])
    http = httpx.AsyncClient(transport=httpx.MockTransport(server.handle))
    authenticator = BotFrameworkAuthenticator(
        app_id="app-1", keys=SigningKeys(metadata_url=_METADATA, http=http)
    )
    header = f"Bearer {_bot_token(key)}"

    async def burst() -> None:
        await asyncio.gather(
            *(
                authenticator.verify(
                    header, service_url=_SERVICE_URL, channel_id="msteams"
                )
                for _ in range(5)
            )
        )

    _run(burst())

    assert server.fetches == 1
