"""Application-layer encryption for secrets at rest (Plaid API secrets and
item access tokens). Fernet (AES-128-CBC + HMAC-SHA256) keyed by the
CREDENTIALS_ENC_KEY env var — generate one with:

    python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"

The key lives only in the environment (Render env var / gitignored .env),
never in the database — a DB dump or SQL injection alone yields ciphertext.

decrypt() passes legacy plaintext values through unchanged (every Fernet token
starts with 'gAAAA'; real Plaid access tokens start with 'access-'), so the
upgrade needs no big-bang migration — encrypt_existing_tokens.py converts old
rows whenever it's convenient.
"""
import os

from cryptography.fernet import Fernet
from dotenv import load_dotenv

load_dotenv()

FERNET_PREFIX = 'gAAAA'

_fernet = None


def _get_fernet() -> Fernet:
    global _fernet
    if _fernet is None:
        key = os.environ.get('CREDENTIALS_ENC_KEY')
        if not key:
            raise RuntimeError(
                'CREDENTIALS_ENC_KEY is not set — required to read/write stored secrets. '
                'Generate: python -c "from cryptography.fernet import Fernet; '
                'print(Fernet.generate_key().decode())"'
            )
        _fernet = Fernet(key)
    return _fernet


def encrypt(plaintext: str) -> str:
    return _get_fernet().encrypt(plaintext.encode()).decode()


def decrypt(value):
    """Decrypt a Fernet token; pass legacy plaintext through unchanged."""
    if value is None or not value.startswith(FERNET_PREFIX):
        return value
    return _get_fernet().decrypt(value.encode()).decode()
