import json
import secrets
from pathlib import Path

from tools.persistence import Persistence


def test_review_queue_survives_restart_and_is_owner_scoped(tmp_path):
    env = {
        'APP_DATA_DIR': str(tmp_path.resolve()),
        'APP_PUBLIC_ORIGIN': 'http://127.0.0.1:4190',
        'APP_LOCAL_HTTP': '1',
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

    owner, other = guest(), guest()
    digest = {'digest': 'a' * 64}
    status, _, created = request('POST', 'review-queue', digest, owner)
    assert status == 201
    job = {'id': created['id']}
    service = start()
    assert request('POST', 'review-queue', digest, owner)[2] == job
    assert request('GET', 'review-queue', auth=other)[2]['items'] == []
    assert request('POST', 'review-queue/complete', job, other)[0] == 404
    assert request('POST', 'review-queue/complete', job, owner)[0] == 200
    service = start()
    assert request('GET', 'review-queue', auth=owner)[2]['items'][0]['processed_at']
