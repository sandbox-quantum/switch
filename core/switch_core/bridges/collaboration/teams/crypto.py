from __future__ import annotations

import base64
import hashlib
import hmac
import json
from typing import Any

from cryptography import x509
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import padding as asym_padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.hashes import SHA1
from cryptography.hazmat.primitives.padding import PKCS7
from cryptography.hazmat.primitives.serialization import load_pem_private_key


class ResourceDataError(RuntimeError):
    """A Graph change-notification resource payload failed to decrypt/verify."""


def _load_private_key(pem: str) -> Any:
    key = load_pem_private_key(pem.encode("utf-8"), password=None)
    return key


def decrypt_resource_data(
    encrypted_content: dict[str, Any], private_key_pem: str
) -> dict[str, Any]:
    """Decrypt and verify the ``encryptedContent`` of a Graph change notification.

    Microsoft Graph encrypts included resource data with a one-time symmetric
    key, itself RSA-OAEP-encrypted to the subscription's public certificate. The
    steps (per the Graph "change notifications with resource data" spec):

    1. RSA-OAEP-decrypt ``dataKey`` with our private key to recover the
       symmetric key.
    2. HMAC-SHA256 the encrypted ``data`` with that key and constant-time
       compare against ``dataSignature`` — a mismatch means tampering.
    3. AES-256-CBC-decrypt ``data`` (IV = first 16 bytes of the symmetric key)
       and strip PKCS7 padding.

    Returns the decoded resource (a ``chatMessage`` JSON object).
    """
    try:
        data = base64.b64decode(encrypted_content["data"])
        data_signature = encrypted_content["dataSignature"]
        data_key = base64.b64decode(encrypted_content["dataKey"])
    except (KeyError, ValueError, TypeError) as e:
        raise ResourceDataError(f"malformed encryptedContent: {e}") from e

    private_key = _load_private_key(private_key_pem)
    symmetric_key = private_key.decrypt(
        data_key,
        asym_padding.OAEP(
            mgf=asym_padding.MGF1(algorithm=SHA1()),
            algorithm=SHA1(),
            label=None,
        ),
    )

    expected_sig = base64.b64encode(
        hmac.new(symmetric_key, data, hashlib.sha256).digest()
    ).decode("utf-8")
    if not hmac.compare_digest(expected_sig, data_signature):
        raise ResourceDataError("resource data signature mismatch")

    # AES-CBC is Microsoft Graph's fixed resource-data encryption format, so it
    # cannot be swapped for an AEAD mode. Integrity is provided by the
    # encrypt-then-MAC HMAC-SHA256 verification above (constant-time), which is
    # checked before any decryption happens — so CBC is safe here.
    iv = symmetric_key[:16]
    cipher = Cipher(algorithms.AES(symmetric_key), modes.CBC(iv))  # nosemgrep
    decryptor = cipher.decryptor()
    padded = decryptor.update(data) + decryptor.finalize()
    unpadder = PKCS7(algorithms.AES.block_size).unpadder()
    plaintext = unpadder.update(padded) + unpadder.finalize()

    try:
        result: dict[str, Any] = json.loads(plaintext)
    except json.JSONDecodeError as e:
        raise ResourceDataError(f"decrypted resource is not valid JSON: {e}") from e
    return result


def load_certificate_der_b64(cert_pem: str) -> str:
    """Validate the PEM certificate and return its base64 DER body.

    Graph expects ``encryptionCertificate`` to be the base64-encoded DER of the
    X.509 certificate. We re-encode from the parsed cert rather than trusting
    hand-stripped PEM, so a malformed certificate fails loudly here."""
    cert = x509.load_pem_x509_certificate(cert_pem.encode("utf-8"))
    der = cert.public_bytes(serialization.Encoding.DER)
    return base64.b64encode(der).decode("utf-8")
