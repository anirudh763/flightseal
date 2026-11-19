"""Cognito adapter (R29, AD-3): only an ID token for this pool and app client, org and role from admin-set claims."""
import json

from registry_helpers import SEED_A, T0, call, line, make_app, token

from registry import ed25519
from registry.enroll_challenge import bytes_to_sign
from registry.identity import identify

ISS = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TestPool"
AUD = "testclientid0123456789"
ENV = {"IDENTITY_ADAPTER": "cognito", "COGNITO_ISSUER": ISS, "COGNITO_CLIENT_ID": AUD}


def claims(**over):
    # The HTTP API JWT authorizer hands claims to the Lambda as strings, exp included.
    base = {"sub": "s-1", "token_use": "id", "iss": ISS, "aud": AUD, "exp": str(T0 + 900),
            "custom:org_id": "orgA", "custom:role": "pilot"}
    base.update(over)
    return {k: v for k, v in base.items() if v is not None}


def event(c):
    return {"requestContext": {"authorizer": {"jwt": {"claims": c}}}}


def ident(c, env=ENV, now=T0):
    return identify(event(c), {}, env, now)


def test_id_token_for_this_pool_and_client_is_accepted():
    got = ident(claims())
    assert (got.sub, got.org_id, got.role) == ("s-1", "orgA", "pilot")
    assert ident(claims(exp=T0 + 900)).role == "pilot"  # an int exp is fine too


def test_access_token_is_rejected_even_with_org_claims():
    # An access token has token_use "access" and client_id instead of aud; it must not pass even if custom claims appear.
    assert ident(claims(token_use="access")) is None
    assert ident(claims(token_use="access", aud=None, client_id=AUD)) is None


def test_missing_token_use_is_rejected():
    assert ident(claims(token_use=None)) is None


def test_wrong_issuer_is_rejected():
    assert ident(claims(iss=ISS.replace("TestPool", "OtherPool"))) is None
    assert ident(claims(iss=None)) is None


def test_wrong_audience_is_rejected():
    assert ident(claims(aud="someoneelsesclient")) is None
    assert ident(claims(aud=None)) is None


def test_expired_or_malformed_exp_is_rejected():
    assert ident(claims(exp=str(T0))) is None
    assert ident(claims(exp=str(T0 - 1))) is None
    assert ident(claims(exp="soon")) is None
    assert ident(claims(exp=True)) is None
    assert ident(claims(exp="\u00b2")) is None  # str.isdigit() is true for this; int() is not
    assert ident(claims(exp=None)) is None  # the authorizer checks exp too; a token without one is refused anyway


def test_manipulated_role_or_org_is_rejected():
    for role in ("Admin", "superadmin", "admin ", "", None):
        assert ident(claims(**{"custom:role": role})) is None
    assert ident(claims(**{"custom:org_id": "orgA#x"})) is None
    # Only the admin-controlled custom attributes count: a plain "role"/"org_id" claim is ignored.
    assert ident(claims(**{"custom:role": None, "role": "admin"})) is None


def test_missing_issuer_or_client_config_is_503_identity_unavailable(capsys):
    # A misconfigured service is not the caller's fault: 503, so the console can say sign-in is unavailable.
    for drop in ("COGNITO_ISSUER", "COGNITO_CLIENT_ID"):
        env = {k: v for k, v in ENV.items() if k != drop}
        app, table, _ = make_app(**env)
        assert cognito_call(app, "GET", "/v1/registrations", claims()) == (503, {"error": "identity_unavailable"})
        assert cognito_call(app, "POST", "/v1/envelopes", claims(), {}) == (503, {"error": "identity_unavailable"})
        assert table.items == {}
        assert drop in capsys.readouterr().err
    # A bad token with a correct configuration stays 401.
    app, _, _ = make_app(**ENV)
    assert cognito_call(app, "GET", "/v1/registrations", claims(aud="x")) == (401, {"error": "unauthorized"})


def test_malformed_authorizer_context_is_401_not_an_error():
    app, _, _ = make_app(**ENV)
    for ctx in ("x", {"authorizer": []}, {"authorizer": {"jwt": "s"}}, {"authorizer": {"jwt": {"claims": ["a"]}}}):
        assert identify({"requestContext": ctx}, {}, ENV, T0) is None
        ev = {"version": "2.0", "rawPath": "/v1/registrations", "headers": {}, "body": "",
              "requestContext": {**(ctx if isinstance(ctx, dict) else {}), "http": {"method": "GET"}}}
        r = app.handle(ev)
        assert (r["statusCode"], json.loads(r["body"])) == (401, {"error": "unauthorized"})


def cognito_call(app, method, path, c, body=None):
    ev = {"version": "2.0", "rawPath": path, "headers": {}, "body": json.dumps(body) if body is not None else "",
          "requestContext": {"http": {"method": method}, **event(c)["requestContext"]}}
    r = app.handle(ev)
    return r["statusCode"], json.loads(r["body"])


def test_wrong_org_claim_cannot_read_another_orgs_data():
    app, _, _ = make_app(**ENV)
    admin_a = claims(sub="admin-a", **{"custom:role": "admin"})
    s, ch = cognito_call(app, "GET", "/v1/keys/challenge", admin_a)
    assert s == 200, ch
    s, _ = cognito_call(app, "POST", "/v1/keys", admin_a,
                        {"public_key": ed25519.public_key(SEED_A).hex(), "nonce": ch["nonce"],
                         "signature": ed25519.sign(SEED_A, bytes_to_sign("orgA", ch)).hex()})
    assert s == 201
    pilot_a = claims(sub="pilot-a")
    s, env_out = cognito_call(app, "POST", "/v1/envelopes", pilot_a, {})
    assert s == 201
    s, ack = cognito_call(app, "POST", "/v1/registrations", pilot_a,
                          {"receipt": line(SEED_A, 5), "idempotency_key": "idem-key-0000000001",
                           "envelope_id": env_out["envelope_id"]})
    assert s == 201, ack
    rid = ack["registration_id"]
    s, mine = cognito_call(app, "GET", "/v1/registrations", pilot_a)
    assert s == 200 and rid in json.dumps(mine)

    for other in (claims(sub="admin-b", **{"custom:org_id": "orgB", "custom:role": "admin"}),
                  claims(sub="pilot-a", **{"custom:org_id": "orgB"})):  # same sub, other org: still nothing
        s, out = cognito_call(app, "GET", "/v1/registrations", other)
        assert s == 200 and rid not in json.dumps(out)
        s, out = cognito_call(app, "GET", "/v1/keys", other)
        assert s == 200 and ed25519.public_key(SEED_A).hex() not in json.dumps(out)
    other_admin = claims(sub="admin-b", **{"custom:org_id": "orgB", "custom:role": "admin"})
    s, out = cognito_call(app, "DELETE", f"/v1/registrations/{rid}", other_admin)
    assert s == 404, out
    assert rid in json.dumps(cognito_call(app, "GET", "/v1/registrations", pilot_a)[1])


def test_dev_tokens_are_not_accepted_in_cognito_mode():
    app, _, clock = make_app(**ENV)
    assert call(app, "GET", "/v1/registrations", token(clock))[:2] == (401, {"error": "unauthorized"})
