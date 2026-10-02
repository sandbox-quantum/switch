"""The keyring: parsing `SECRET_KEYS`, per-purpose keys, encryption with key ids."""

from __future__ import annotations

import base64
import hashlib

import pytest
from cryptography.fernet import Fernet

from switch_core.keys import Keyring, KeyringError, Purpose, UndecryptableError

_A = "a" * 40
_B = "b" * 40


def _keyring(value: str, legacy: str | None = None) -> Keyring:
    return Keyring.parse(value, legacy_secret=legacy)


class TestParsing:
    def test_the_first_key_is_current(self) -> None:
        keyring = _keyring(f"new:{_B}, old:{_A}")
        assert [k.id for k in keyring.keys] == ["new", "old"]
        assert keyring.current.id == "new"

    def test_a_secret_may_contain_colons(self) -> None:
        assert _keyring(f"k1:{_A}:tail").current.secret == f"{_A}:tail".encode()

    @pytest.mark.parametrize(
        ("value", "message"),
        [
            ("", "at least one key"),
            (_A, "no ':'"),
            (f"bad id:{_A}", "key id"),
            ("k1:short", "shorter than 32"),
            (f"k1:{_A},k1:{_B}", "twice"),
        ],
    )
    def test_malformed_values_are_refused(self, value: str, message: str) -> None:
        with pytest.raises(KeyringError, match=message):
            _keyring(value)

    def test_an_empty_legacy_secret_is_none(self) -> None:
        assert _keyring(f"k1:{_A}", legacy="").legacy_secret is None


class TestDerivedKeys:
    def test_each_purpose_gets_its_own_key(self) -> None:
        keyring = _keyring(f"k1:{_A}")
        derived = {keyring.derive(purpose) for purpose in Purpose}
        assert len(derived) == len(Purpose)

    def test_no_derived_key_is_the_master_key(self) -> None:
        keyring = _keyring(f"k1:{_A}")
        assert all(keyring.derive(p) != _A.encode() for p in Purpose)

    def test_derivation_is_stable(self) -> None:
        assert _keyring(f"k1:{_A}").derive(Purpose.SESSION) == _keyring(
            f"other:{_B},k1:{_A}"
        ).derive(Purpose.SESSION, "k1")

    def test_verification_keys_are_every_master_keys_current_first(self) -> None:
        keyring = _keyring(f"new:{_B},old:{_A}")
        assert keyring.verification_keys(Purpose.INSTALL_STATE) == [
            keyring.derive(Purpose.INSTALL_STATE, "new"),
            keyring.derive(Purpose.INSTALL_STATE, "old"),
        ]

    def test_an_unknown_key_id_is_refused(self) -> None:
        with pytest.raises(KeyringError, match="No key 'gone'"):
            _keyring(f"k1:{_A}").derive(Purpose.SESSION, "gone")


class TestEncryption:
    def test_a_value_round_trips_and_names_its_key(self) -> None:
        keyring = _keyring(f"k1:{_A}")
        encrypted = keyring.encrypt("xoxb-secret")
        assert encrypted.startswith("k1$k1$")
        assert "xoxb-secret" not in encrypted
        assert keyring.decrypt(encrypted) == "xoxb-secret"
        assert keyring.is_current(encrypted)

    def test_a_value_under_an_older_key_still_opens(self) -> None:
        old = _keyring(f"k1:{_A}").encrypt("xoxb-secret")
        rotated = _keyring(f"k2:{_B},k1:{_A}")
        assert rotated.decrypt(old) == "xoxb-secret"
        assert not rotated.is_current(old)

    def test_a_value_under_a_removed_key_is_an_error(self) -> None:
        old = _keyring(f"k1:{_A}").encrypt("xoxb-secret")
        with pytest.raises(UndecryptableError, match="no longer in SECRET_KEYS"):
            _keyring(f"k2:{_B}").decrypt(old)

    def test_a_key_whose_secret_changed_is_an_error(self) -> None:
        old = _keyring(f"k1:{_A}").encrypt("xoxb-secret")
        with pytest.raises(UndecryptableError, match="secret has changed"):
            _keyring(f"k1:{_B}").decrypt(old)

    def test_the_at_rest_key_is_not_the_old_scheme(self) -> None:
        """A value encrypted the old way with the master secret is not one the
        new key opens: the legacy path is only for `JWT_SECRET_KEY`."""
        naive = Fernet(base64.urlsafe_b64encode(hashlib.sha256(_A.encode()).digest()))
        with pytest.raises(UndecryptableError):
            _keyring(f"k1:{_A}").decrypt(naive.encrypt(b"x").decode())


def _legacy_encrypt(secret: str, plaintext: str) -> str:
    """How a value was encrypted with `JWT_SECRET_KEY` before `SECRET_KEYS`."""
    key = base64.urlsafe_b64encode(hashlib.sha256(secret.encode()).digest())
    return Fernet(key).encrypt(plaintext.encode()).decode()


class TestLegacyValues:
    def test_open_while_the_legacy_secret_is_set(self) -> None:
        keyring = _keyring(f"k1:{_A}", legacy="old-jwt-secret")
        value = _legacy_encrypt("old-jwt-secret", "xoxb-secret")
        assert keyring.decrypt(value) == "xoxb-secret"
        assert not keyring.is_current(value)

    def test_are_an_error_once_it_is_removed(self) -> None:
        value = _legacy_encrypt("old-jwt-secret", "xoxb-secret")
        with pytest.raises(UndecryptableError, match="JWT_SECRET_KEY is not set"):
            _keyring(f"k1:{_A}").decrypt(value)

    def test_are_an_error_under_a_different_legacy_secret(self) -> None:
        value = _legacy_encrypt("old-jwt-secret", "xoxb-secret")
        with pytest.raises(UndecryptableError, match="does not open"):
            _keyring(f"k1:{_A}", legacy="another").decrypt(value)
