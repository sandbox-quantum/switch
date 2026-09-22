import json

PROVIDER_KINDS = {
    "claude": {"api-key", "setup-token"},
    "codex": {"api-key", "auth-json"},
    "cursor": {"api-key"},
    "opencode": {"auth-json"},
    "antigravity": {"auth-json"},
}


def validate_provider_credential(provider: str, kind: str, credential: str) -> str:
    if kind not in PROVIDER_KINDS.get(provider, set()):
        raise ValueError("Choose a supported credential type for this provider.")
    credential = credential.strip()
    if not credential or len(credential.encode()) > 16384:
        raise ValueError("The credential must be nonempty and smaller than 16 KiB.")
    if kind == "auth-json":
        try:
            value = json.loads(credential)
        except ValueError:
            raise ValueError(
                "Choose the provider's JSON authentication file."
            ) from None
        if not isinstance(value, dict) or not value:
            raise ValueError("The authentication file must contain a JSON object.")
        return json.dumps(value, separators=(",", ":"))
    if any(not 33 <= ord(character) <= 126 for character in credential):
        raise ValueError(
            "The API key must not contain whitespace or control characters."
        )
    return credential
