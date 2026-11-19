"""Writes tests/fixtures/pilot-authorization.json: shared vectors for pilot key authorizations (Option B).

  python3 tests/fixtures/make_pilot_authorization.py

Deterministic: fixed seeds, a fixed clock, and Ed25519 signing is deterministic. The Python checker is
registry/registry/pilot_authorization.py; a later browser checker loads the same JSON. Each failing case has exactly
one fault. registry/tests/test_pilot_authorization.py checks every case and that this file is up to date.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "registry"))

from registry import ed25519  # noqa: E402
from registry import pilot_authorization as pa  # noqa: E402

OUT = Path(__file__).with_name("pilot-authorization.json")
NOW = 1_800_000_000
COMPANY, PILOT, OTHER = bytes(range(32)), bytes(range(1, 33)), bytes(range(2, 34))
C, P, O = (ed25519.public_key(s) for s in (COMPANY, PILOT, OTHER))
WEAK = bytes([1]) + bytes(31)  # the identity point: small order
OFF_CURVE = (2**255 - 21).to_bytes(32, "little")  # canonical y = p - 2, but no x: the not_weak control of ed25519-weak-keys.json
DEFAULT = NOW + pa.DEFAULT_DAYS * pa.DAY

HOW = ("For each case: find the lines of `line` that start with `line_prefix` without its trailing space, at the very "
       "first character of the line (no trimming: a line with any character before it, even a space, is not an "
       "authorization line). None: no authorization, so `found` is false, reason is no_line and nothing is authorized "
       "(signer not confirmed; never treat it as valid); `found` is true otherwise. More than one, or one not exactly `line_prefix` + base64url + '.' + sig: reason malformed. "
       "Otherwise check the base64url and sig against `pilot_key` (the key being authorized), `company_key` (the "
       "expected company key) and `now` (the checker's own clock, epoch seconds), testing `reasons` in order: "
       "malformed unless the authorization is base64url without padding that decodes to exactly the four canonical "
       "lines (prefix, pilot_key=<64 lowercase hex>, company_key=<64 lowercase hex>, not_after=<YYYY-MM-DDTHH:MM:SSZ>, "
       "a real UTC time, joined by \\n, no trailing newline) and re-encodes to the same characters, and sig is 128 "
       "lowercase hex; weak_pilot_key = the statement's pilot_key is small-order, non-canonical or not a curve point; same_key = pilot_key equals company_key in the "
       "statement; not_pilot_key = the statement's pilot_key differs from `pilot_key`; bad_signature = sig does not "
       "verify under the statement's company_key over the decoded bytes; ended = not_after <= now; too_long = "
       "not_after > now + max_days * 86400; not_company_key = the statement's company_key differs from `company_key`. "
       "`signed_text` is what was signed; `registry_error` is what POST /v1/pilot-keys answers (with 422).")


def case(name, reason, *, signer=COMPANY, pilot=P, company=C, not_after=DEFAULT, text=None, auth=None, sig=None,
         line=None, expect_pilot=P, expect_company=C, found=True):
    text = text if text is not None else pa.statement(pilot, company, not_after)
    auth = auth if auth is not None else pa.encode(text)
    sig = sig if sig is not None else ed25519.sign(signer, text).hex()
    return {"name": name, "authorization": auth, "authorization_sig": sig,
            "line": line if line is not None else pa.to_line(auth, sig), "signed_text": text.decode("ascii"),
            "pilot_key": expect_pilot.hex(), "company_key": expect_company.hex(), "now": NOW,
            "found": found, "reason": reason, "registry_error": pa.REGISTRY_ERROR.get(reason)}


def cases():
    good = pa.statement(P, C, DEFAULT)
    good_sig = ed25519.sign(COMPANY, good).hex()
    good_auth = pa.encode(good)
    tampered = bytearray(good)
    tampered[-2] = ord("1") if tampered[-2] != ord("1") else ord("2")  # last seconds digit: still canonical
    flipped = ("0" if good_sig[0] != "0" else "1") + good_sig[1:]
    padded = good_auth + ("=" * (-len(good_auth) % 4) or "==")

    def prefixed(prefix):
        return good.replace(pa.PREFIX.encode(), prefix.encode(), 1)

    two = pa.to_line(good_auth, good_sig)
    return [
        case("valid", None),
        case("valid at exactly max_days", None, not_after=NOW + pa.MAX_DAYS * pa.DAY),
        case("valid inside a longer message", None, line="Flight 12 ferry\n" + two + "\nSealed on the company iPad"),
        case("ended: not_after equals now", "ended", not_after=NOW),
        case("ended: not_after before now", "ended", not_after=NOW - 1),
        case("too long: one second past max_days", "too_long", not_after=NOW + pa.MAX_DAYS * pa.DAY + 1),
        case("wrong org: another company key expected", "not_company_key", expect_company=O),
        case("tampered: one byte of the statement changed", "bad_signature", text=good,
             auth=pa.encode(bytes(tampered)), sig=good_sig),
        case("tampered: signature changed", "bad_signature", sig=flipped),
        case("wrong prefix: receipt", "malformed", text=prefixed("fseal-receipt v1")),
        case("wrong prefix: company key challenge", "malformed", text=prefixed("hashwing-key-enroll v1")),
        case("wrong prefix: pilot key challenge", "malformed", text=prefixed("hashwing-pilot-key-enroll v1")),
        case("wrong prefix: v2", "malformed", text=prefixed("hashwing-pilot-authorization v2")),
        case("trailing newline", "malformed", text=good + b"\n"),
        case("base64 padding", "malformed", text=good, auth=padded),
        # A canonical statement is printable ASCII without '>', '?' or '~', so its base64url never holds '-' or '_' and
        # a like-for-like alphabet swap can't be built. These keep the length and put the standard-alphabet characters
        # where base64url has none: a decoder that maps '+'/'/' to '-'/'_' still gets non-canonical bytes.
        case("standard base64 '+' (same length)", "malformed", text=good, auth="+" + good_auth[1:]),
        case("standard base64 '/' (same length)", "malformed", text=good, auth=good_auth[:-1] + "/"),
        case("uppercase hex in the statement", "malformed",
             text=good.replace(b"pilot_key=" + P.hex().encode(), b"pilot_key=" + P.hex().upper().encode())),
        case("uppercase hex signature", "malformed", sig=good_sig.upper()),
        case("second 60", "malformed", text=good[:-3] + b"60Z"),
        case("pilot_key mismatch", "not_pilot_key", pilot=O),
        case("signed by another key", "bad_signature", signer=OTHER),
        case("weak pilot key", "weak_pilot_key", pilot=WEAK, expect_pilot=WEAK),
        case("pilot key not a curve point", "weak_pilot_key", pilot=OFF_CURVE, expect_pilot=OFF_CURVE),
        case("pilot key equals company key", "same_key", pilot=C, expect_pilot=C),
        case("two authorization lines in one message", "malformed", text=good, sig=good_sig, line=two + "\n" + two),
        case("leading space before the line", "no_line", line=" " + two, found=False),
    ]


def build():
    doc = {
        "source": "Generated by tests/fixtures/make_pilot_authorization.py; checked by "
                  "registry/tests/test_pilot_authorization.py.",
        "prefix": pa.PREFIX,
        "line_prefix": pa.LINE_PREFIX,
        "default_days": pa.DEFAULT_DAYS,
        "max_days": pa.MAX_DAYS,
        "pilot_key_cap": 50,
        "recipient_compromised_cap": 500,
        "how_to_evaluate": HOW,
        "reasons": [{"reason": r, "registry_error": e} for r, e in pa.REGISTRY_ERROR.items()],
        "cases": cases(),
    }
    return json.dumps(doc, indent=2) + "\n"


if __name__ == "__main__":
    OUT.write_text(build())
    print(f"{OUT}: {len(cases())} cases")
