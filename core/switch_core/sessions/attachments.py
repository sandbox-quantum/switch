def normalise_mime_type(value: str) -> str:
    """The bare media type: no parameters, lowercased, whitespace trimmed.

    Platforms report a type with parameters attached — Discord
    hands back ``text/plain; charset=utf-8`` for a plain text file — and the
    allowlist holds bare types, so the parameter has to come off before either
    end compares them.
    """
    return value.split(";", 1)[0].strip().lower()
