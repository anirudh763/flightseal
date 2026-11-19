"""Client side of key enrollment: the bytes a signer signs for `GET /v1/keys/challenge`.

Rule B1 (design PR #57): a client never signs text the server sends. It builds
`hashwing-key-enroll v1\n<org>\n<nonce>` itself from its own org and the 32-lowercase-hex nonce, and signs only if
the server's `message` is byte-equal to that. Anything else (a receipt message, another org, a trailing newline) is
refused before signing. This is a deliberate second copy of the format, not a call to `App.challenge_message`: if
the client reused the server's builder, a server change would silently change what clients sign.
"""
import re

_NONCE = re.compile(r"[0-9a-f]{32}")


def bytes_to_sign(org_id, challenge):
    """Return the challenge bytes to sign, or raise ValueError when the server's challenge doesn't match them."""
    nonce, message = challenge.get("nonce"), challenge.get("message")
    if not isinstance(org_id, str) or not org_id or not isinstance(nonce, str) or not isinstance(message, str):
        raise ValueError("malformed challenge")
    if not _NONCE.fullmatch(nonce):
        raise ValueError("challenge nonce is not 32 lowercase hex")
    built = b"hashwing-key-enroll v1\n" + org_id.encode() + b"\n" + nonce.encode()
    if message.encode() != built:
        raise ValueError("server challenge message differs from the locally built bytes; not signing")
    return built
