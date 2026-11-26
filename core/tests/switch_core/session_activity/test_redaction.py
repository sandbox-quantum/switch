import pytest

from switch_core.session_activity.redaction import redact_secrets

_FILL = {
    "an OpenAI or Anthropic key": "sk-" + "a" * 24,
    "a Slack token": "xoxb-" + "1" * 12 + "-" + "b" * 12,
    "an AWS access key id": "AKIA" + "A" * 16,
    "a Google API key": "AIza" + "b" * 35,
    "a GitLab token": "glpat-" + "c" * 22,
    "a Hugging Face token": "hf_" + "d" * 24,
    "a Stripe key": "sk_test_" + "e" * 20,
    "an npm token": "npm_" + "f" * 32,
    "a GitHub token": "ghp_" + "g" * 36,
    "a JWT": "eyJ" + "a" * 12 + ".eyJ" + "b" * 12 + "." + "c" * 12,
}


@pytest.mark.parametrize("secret", _FILL.values(), ids=_FILL.keys())
def test_a_known_token_shape_is_masked(secret: str) -> None:
    assert redact_secrets(f"before {secret} after") == "before [REDACTED] after"


def test_a_private_key_is_masked_whole_or_cut_short() -> None:
    body = "A" * 64
    whole = f"-----BEGIN RSA PRIVATE KEY-----\n{body}\n-----END RSA PRIVATE KEY-----"
    assert redact_secrets(f"k:\n{whole}\nnext") == "k:\n[REDACTED]\nnext"
    assert redact_secrets("-----BEGIN PRIVATE KEY-----\n" + "A" * 20) == "[REDACTED]"


def test_a_password_in_a_url_is_masked_and_the_rest_kept() -> None:
    assert (
        redact_secrets("postgres://app:hunter2@db.example.test:5432/app")
        == "postgres://app:[REDACTED]@db.example.test:5432/app"
    )
    assert redact_secrets("https://example.test/p") == "https://example.test/p"


def test_authorization_and_bearer_credentials_are_masked() -> None:
    assert (
        redact_secrets("Authorization: Bearer " + "x" * 20)
        == "Authorization: [REDACTED]"
    )
    assert redact_secrets("Authorization: Basic dXNlcjpwYXNz") == (
        "Authorization: [REDACTED]"
    )
    assert redact_secrets('curl -H "bearer ' + "y" * 20 + '"') == (
        'curl -H "bearer [REDACTED]"'
    )


def test_a_value_assigned_to_a_secret_name_is_masked() -> None:
    assert (
        redact_secrets('API_KEY=abc123 PASSWORD: hunter2; client_secret = "s3cret"')
        == 'API_KEY=[REDACTED] PASSWORD: [REDACTED]; client_secret = "[REDACTED]"'
    )
    assert (
        redact_secrets('{"access_token":"abc","name":"x"}')
        == '{"access_token":"[REDACTED]","name":"x"}'
    )


def test_a_quoted_secret_is_masked_whole_inside_its_quotes() -> None:
    assert redact_secrets('PASSWORD="alpha beta"') == 'PASSWORD="[REDACTED]"'
    assert redact_secrets("password='alpha beta' next") == "password='[REDACTED]' next"
    assert (
        redact_secrets('{"secret": "a \\" b c", "name": "x"}')
        == '{"secret": "[REDACTED]", "name": "x"}'
    )
    assert (
        redact_secrets('Authorization: "Bearer alpha beta"')
        == 'Authorization: "[REDACTED]"'
    )


def test_an_unquoted_secret_stops_at_the_delimiter_that_closes_what_holds_it() -> None:
    assert redact_secrets('{"token":abc}') == '{"token":[REDACTED]}'
    assert redact_secrets("[password=abc]") == "[password=[REDACTED]]"
    assert redact_secrets("(secret=abc)") == "(secret=[REDACTED])"


@pytest.mark.parametrize(
    "text",
    ["max_tokens: 100", "laughs_total (sk-short)", "tokenizer=bpe", "42 passed"],
)
def test_ordinary_text_is_left_alone(text: str) -> None:
    assert redact_secrets(text) == text
