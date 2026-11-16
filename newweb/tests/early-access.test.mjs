import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { deliverEarlyAccessRequest } from '../src/early-access.mjs';

async function ownedReceiver(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/request`;
  return { endpoint, close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

test('owned local receiver acknowledges only the explicit three-field request', async () => {
  let received;
  const receiver = await ownedReceiver(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    received = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ received: true }));
  });
  try {
    const result = await deliverEarlyAccessRequest(receiver.endpoint, { email: 'test@example.invalid', teamSize: '1–5', useCase: 'test only' });
    assert.equal(result.received, true);
    assert.deepEqual(Object.keys(received).sort(), ['email', 'teamSize', 'useCase'].sort());
  } finally { await receiver.close(); }
});

test('HTTP success without acknowledgement and non-success are not reported as received', async () => {
  for (const [status, body] of [[200, { ok: true }], [503, { received: true }]]) {
    const receiver = await ownedReceiver((_request, response) => { response.statusCode = status; response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(body)); });
    try { await assert.rejects(deliverEarlyAccessRequest(receiver.endpoint, { email: 't@example.invalid', teamSize: '1–5', useCase: 'test' }), /did not acknowledge receipt/); }
    finally { await receiver.close(); }
  }
});

test('remote request refuses insecure non-local endpoints and unexpected fields', async () => {
  await assert.rejects(deliverEarlyAccessRequest('http://example.invalid/submit', { email: 'a', teamSize: '1', useCase: 'x' }), /must use HTTPS/);
  await assert.rejects(deliverEarlyAccessRequest('https://example.invalid/submit', { email: 'a', teamSize: '1', useCase: 'x', file: 'private' }), /Only email/);
});
