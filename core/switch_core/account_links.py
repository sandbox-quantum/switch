"""One-time codes that confirm a chat account belongs to a Switch user (CHOO-3881).

A Switch user asks to link a chat account, Switch shows them a code, and they
post it from that account. The code proves both halves at once: only the
Switch user is shown it, and the platform says which account posted it.

Eight characters of Crockford base32 is 40 bits. A code is single use, lives
for `LINK_CODE_TTL`, and only redeems from the one account it was issued for,
so guessing one means posting something like a trillion messages from that
account inside half an hour. That is why there is no attempt counter.

Only a hash is stored. The code is worthless without the chat account, so the
hash is there to keep codes out of anything that reads the table, not to
withstand a brute force.
"""

import hashlib
import secrets
import string
from datetime import timedelta

LINK_CODE_TTL = timedelta(minutes=30)

# Crockford's base32: no I, L, O or U, so nothing reads as another character.
_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
_LENGTH = 8
# What people type for the letters the alphabet leaves out.
_LOOKALIKES = str.maketrans({"O": "0", "I": "1", "L": "1"})
_ASCII_ALNUM = frozenset(string.ascii_letters + string.digits)


def new_link_code() -> str:
    """A fresh code, grouped `XXXX-XXXX` for reading aloud or retyping."""
    raw = "".join(secrets.choice(_ALPHABET) for _ in range(_LENGTH))
    return f"{raw[:4]}-{raw[4:]}"


def normalise_link_code(text: str) -> str | None:
    """The code as stored, or None when `text` cannot be one.

    Forgiving about what a person or a chat client does to it on the way:
    case, the hyphen, spaces, the backticks the instructions show it in,
    quotes, invisible characters a paste carries, and the letters that look
    like digits. Any other letter or digit in `text` makes it the wrong
    length.
    """
    kept = "".join(c for c in text if c in _ASCII_ALNUM)
    cleaned = kept.upper().translate(_LOOKALIKES)
    if len(cleaned) != _LENGTH or any(c not in _ALPHABET for c in cleaned):
        return None
    return cleaned


def hash_link_code(code: str) -> str:
    """The stored form of a code `normalise_link_code` accepted."""
    return hashlib.sha256(code.encode()).hexdigest()
