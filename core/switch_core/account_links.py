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

A prompt is the same proof without the typing (CHOO-4121). Switch's bot sends
the account a direct message offering a few numbers, the Switch app that asked
shows the Switch user which one is right, and tapping it confirms the link: the account
acted, and only the Switch user knew which number to tap. A wrong number
cancels the request rather than inviting a second guess, and `Not me` does the
same, so the odds of confirming a request one did not start are one in
`PROMPT_CHOICES`, once.
"""

import hashlib
import secrets
import string
from datetime import timedelta

LINK_CODE_TTL = timedelta(minutes=30)

# How many numbers a prompt offers, and the range they come from: two digits,
# so each reads at a glance and none is a prefix of another.
PROMPT_CHOICES = 3
_PROMPT_LOWEST = 10
_PROMPT_HIGHEST = 99

# How many prompts one account may be sent in `PROMPT_WINDOW`. Starting a link
# needs only a Switch login, so without a limit anyone signed in could make the
# bot message a colleague over and over.
PROMPT_LIMIT = 3
PROMPT_WINDOW = timedelta(hours=1)

# Marks a button's value as a prompt's rather than an approval card's. A card's
# token is `secrets.token_urlsafe`, whose alphabet has no ".", so the two can
# never be mistaken for each other.
PROMPT_TOKEN_PREFIX = "lnk."

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


def new_prompt_token() -> str:
    """What a prompt's buttons carry. Short enough to fit beside a position in
    Telegram's 64-byte button payload."""
    return f"{PROMPT_TOKEN_PREFIX}{secrets.token_urlsafe(12)}"


def is_prompt_token(value: str) -> bool:
    return value.startswith(PROMPT_TOKEN_PREFIX)


def new_prompt_choices() -> tuple[int, list[int]]:
    """The number the Switch app shows, and the numbers the message offers in
    the order it offers them, the right one among them."""
    rng = secrets.SystemRandom()
    choices = rng.sample(range(_PROMPT_LOWEST, _PROMPT_HIGHEST + 1), PROMPT_CHOICES)
    return rng.choice(choices), choices
