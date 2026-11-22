import json
import secrets
from pathlib import Path

from tools.persistence import Persistence


def queue_client(tmp_path):
    env = {
        'APP_DATA_DIR': str(tmp_path.resolve()),
        'APP_PUBLIC_ORIGIN': 'http://127.0.0.1:4190',
        'APP_LOCAL_HTTP': '1',
        'APP_PASSWORD_AUTH': '1',
        'APP_SESSION_SECRET': secrets.token_hex(32),
    }

    def start():
        return Persistence('hashwing', Path('docs').resolve(), env)

    service = start()

    def request(method, path, body=None, auth=None):
        headers = {'Origin': env['APP_PUBLIC_ORIGIN'], 'Content-Type': 'application/json', **(auth or {})}
        raw = json.dumps(body).encode() if body is not None else b''
        status, headers, response = service.handle(method, '/api/' + path, headers, raw)
        return status, headers, json.loads(response)

    def guest():
        status, headers, data = request('POST', 'session/guest', {})
        assert status == 200
        return {'Cookie': headers['Set-Cookie'].split(';')[0], 'X-CSRF-Token': data['csrf_token']}

    def restart():
        nonlocal service
        service = start()

    return request, guest, restart


def test_review_queue_survives_restart_and_is_owner_scoped(tmp_path):
    request, guest, restart = queue_client(tmp_path)
    owner, other = guest(), guest()
    digest = {'digest': 'a' * 64}
    status, _, created = request('POST', 'review-queue', digest, owner)
    assert status == 201
    job = {'id': created['id']}
    restart()
    assert request('POST', 'review-queue', digest, owner)[2] == job
    assert request('GET', 'review-queue', auth=other)[2]['items'] == []
    assert request('POST', 'review-queue/complete', job, other)[0] == 404
    assert request('POST', 'review-queue/complete', job, owner)[0] == 200
    restart()
    assert request('GET', 'review-queue', auth=owner)[2]['items'][0]['processed_at']


def test_completed_reviews_release_slots_and_history_is_bounded(tmp_path):
    request, guest, restart = queue_client(tmp_path)
    owner = guest()
    for index in range(100):
        assert request('POST', 'review-queue', {'digest': f'{index:064x}'}, owner)[0] == 201
    digest = {'digest': f'{100:064x}'}
    assert request('POST', 'review-queue', digest, owner)[0] == 409
    restart()
    rows = request('GET', 'review-queue', auth=owner)[2]['items']
    for row in rows:
        assert request('POST', 'review-queue/complete', {'id': row['id']}, owner)[0] == 200
    status, _, job = request('POST', 'review-queue', digest, owner)
    assert status == 201
    rows = request('GET', 'review-queue', auth=owner)[2]['items']
    assert rows[0]['id'] == job['id']
    assert len(rows) == 101
    assert request('POST', 'review-queue/complete', job, owner)[0] == 200
    rows = request('GET', 'review-queue', auth=owner)[2]['items']
    assert len(rows) == 100
    assert any(row['id'] == job['id'] for row in rows)


def test_guest_reviews_follow_account_and_duplicate_history_is_preserved(tmp_path):
    request, guest, restart = queue_client(tmp_path)
    credentials = {'username': 'reviewer', 'password': 'local test password'}

    def authenticate(route, guest_auth):
        status, headers, data = request('POST', 'session/' + route, credentials, guest_auth)
        assert status in {200, 201}
        return {'Cookie': headers['Set-Cookie'].split(';')[0], 'X-CSRF-Token': data['csrf_token']}

    first_guest = guest()
    original = {'digest': 'b' * 64}
    account = authenticate('signup', first_guest)
    _, _, account_job = request('POST', 'review-queue', original, account)
    second_guest = guest()
    _, _, duplicate = request('POST', 'review-queue', original, second_guest)
    request('POST', 'review-queue/complete', duplicate, second_guest)
    _, _, guest_job = request('POST', 'review-queue', {'digest': 'c' * 64}, second_guest)

    migrated = authenticate('login', second_guest)
    restart()
    rows = request('GET', 'review-queue', auth=migrated)[2]['items']
    assert [row['id'] for row in rows] == [guest_job['id'], account_job['id']]
    assert rows[1]['processed_at']
    assert request('GET', 'review-queue', auth=second_guest)[0] == 401


def test_guest_migration_over_quota_keeps_guest_queue_accessible(tmp_path, monkeypatch):
    monkeypatch.setattr('tools.persistence.REVIEW_QUEUE_LIMIT', 1)
    request, guest, _ = queue_client(tmp_path)
    credentials = {'username': 'reviewer', 'password': 'local test password'}
    status, headers, data = request('POST', 'session/signup', credentials, guest())
    assert status in {200, 201}
    account = {'Cookie': headers['Set-Cookie'].split(';')[0], 'X-CSRF-Token': data['csrf_token']}
    guest_auth = guest()
    digest = {'digest': 'd' * 64}
    account_digest = {'digest': 'e' * 64}
    assert request('POST', 'review-queue', account_digest, account)[0] == 201
    assert request('POST', 'review-queue', digest, guest_auth)[0] == 201

    assert request('POST', 'session/login', credentials, guest_auth)[0] == 409
    assert request('GET', 'review-queue', auth=guest_auth)[2]['items'][0]['digest'] == digest['digest']
    assert request('GET', 'review-queue', auth=account)[2]['items'][0]['digest'] == account_digest['digest']
