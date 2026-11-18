import pytest
from registry_helpers import SECRET, SEED_A, line, make_app, call, token

from registry import receipt
from registry.identity import identify, make_dev_token

GOOD = line(SEED_A, 7, head=b"\xab" * 32)
H, K, S = (GOOD.split()[i].split("=")[1] for i in (3, 4, 5))


@pytest.mark.parametrize("text", [
    GOOD.replace("fseal-receipt", "fseal-receipT"),
    GOOD.replace(" v1 ", " v2 "),
    GOOD.replace(H, H.upper()),
    GOOD.replace(S, S[:-2]),
    GOOD.replace(K, K + "00"),
    GOOD + " extra",
    GOOD.replace("count=7", "count=0"),
    GOOD.replace("count=7", f"count={2**64}"),
    GOOD.replace("count=7", "count=-7"),
    GOOD.replace("count=7", "count=7x"),
    GOOD.replace("count=7", "count=７"),
    GOOD.replace("head=", "hed="),
    " ".join(GOOD.split()[:5]),
    "",
])
def test_malformed_receipts_are_rejected(text):
    assert receipt.parse(text) is None


def test_well_formed_receipt_parses_with_max_count():
    assert receipt.parse(GOOD).count == 7
    assert receipt.parse(GOOD.replace("count=7", f"count={2**64 - 1}")).count == 2**64 - 1


def _headers(tok):
    return {"authorization": f"Bearer {tok}"}


def test_dev_token_checks_hmac_expiry_claims_and_secret_length():
    env, now = {"IDENTITY_ADAPTER": "dev-hs256", "DEV_TOKEN_SECRET": SECRET}, 1000
    good = make_dev_token(SECRET, "u", "orgA", "pilot", now + 10)
    assert identify({}, _headers(good), env, now).org_id == "orgA"
    assert identify({}, _headers(good), env, now + 10) is None  # expired
    assert identify({}, _headers(make_dev_token(SECRET + "x", "u", "orgA", "pilot", now + 10)), env, now) is None
    assert identify({}, _headers(make_dev_token(SECRET, "u", "org#A", "pilot", now + 10)), env, now) is None
    assert identify({}, _headers(make_dev_token(SECRET, "u", "orgA", "root", now + 10)), env, now) is None
    assert identify({}, _headers(good[:-2]), env, now) is None
    assert identify({}, {}, env, now) is None
    assert identify({}, _headers(good), {**env, "DEV_TOKEN_SECRET": "short"}, now) is None
    assert identify({}, _headers(good), {}, now) is None  # adapter unset
    assert identify({}, _headers(good), {"IDENTITY_ADAPTER": "nope"}, now) is None


def test_deeply_nested_token_header_is_401_not_an_error():
    import base64
    head = base64.urlsafe_b64encode(b"[" * 5000).rstrip(b"=").decode()
    tok = f"{head}.e30.c2ln"
    env = {"IDENTITY_ADAPTER": "dev-hs256", "DEV_TOKEN_SECRET": SECRET}
    assert identify({}, _headers(tok), env, 0) is None
    app, _, _ = make_app()
    assert call(app, "GET", "/v1/keys", tok)[:2] == (401, {"error": "unauthorized"})


def test_cognito_adapter_reads_authorizer_claims_only():
    claims = {"sub": "s", "custom:org_id": "orgA", "custom:role": "admin", "token_use": "id", "iss": "i", "aud": "c",
              "exp": "99"}
    event = {"requestContext": {"authorizer": {"jwt": {"claims": claims}}}}
    env = {"IDENTITY_ADAPTER": "cognito", "COGNITO_ISSUER": "i", "COGNITO_CLIENT_ID": "c"}
    assert identify(event, {}, env, 0).role == "admin"
    assert identify({}, _headers(make_dev_token(SECRET, "u", "orgA", "admin", 99)), env, 0) is None
    assert identify({"requestContext": {"authorizer": {"jwt": {"claims": {**claims, "custom:role": "x"}}}}}, {}, env, 0) is None


def test_every_401_is_identical():
    app, _, clock = make_app()
    bad = [None, token(clock, secret=SECRET + "!"), token(clock, ttl=-1), "garbage"]
    results = [call(app, "GET", "/v1/registrations", t) for t in bad]
    unset, _, c2 = make_app(IDENTITY_ADAPTER="")
    results.append(call(unset, "GET", "/v1/registrations", token(c2)))
    assert all(r == (401, {"error": "unauthorized"}, results[0][2]) for r in results)
