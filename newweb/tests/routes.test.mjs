import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRouteHash, routeHash, safeReturnRoute, screenFromHash } from '../src/routes.mjs';

test('new routes, old tool paths, query parameters, and unknown paths share one interpretation', () => {
  for (const [hash, screen] of [
    ['', 'landing'], ['#/', 'landing'], ['#/signup', 'signup'], ['#/login', 'login'],
    ['#/app', 'sandbox'], ['#/app/verify', 'verify'], ['#/sandbox', 'sandbox'], ['#/verify', 'verify'],
    ['#/records/742?sample=intact', 'records'], ['#/findings', 'sandbox'],
    ['#/examples', 'sandbox'], ['#/telemetry', 'sandbox'], ['#/404-test', 'not-found'],
    ['#/404-test/details', 'not-found'],
  ]) assert.equal(screenFromHash(hash), screen, hash);
  assert.deepEqual({ kind: parseRouteHash('#/records/742?sample=px4&record=42').kind, screen: parseRouteHash('#/records/742?sample=px4&record=42').screen, detail: parseRouteHash('#/records/742?sample=px4&record=42').detail }, { kind: 'workspace', screen: 'records', detail: '742' });
  assert.equal(parseRouteHash('#/records/742?sample=px4&record=42').params.get('record'), '42');
  assert.equal(routeHash('verify'), '#/app/verify');
  assert.equal(routeHash('landing'), '#/');
  assert.equal(routeHash('404-test'), '#/not-found');
  assert.equal(safeReturnRoute('#/app/receipts?sample=px4&record=9'), '#/app/receipts?sample=px4&record=9');
  assert.equal(safeReturnRoute('https://attacker.example/'), '#/app/sandbox');
  assert.equal(safeReturnRoute('#/login'), '#/app/sandbox');
});

test('direct product routes preserve tab-local queries and legacy hashes', async () => {
  const { parseLocation, productHref } = await import('../src/routes.mjs');
  for (const [pathname, screen] of [['/', 'overview'], ['/verify', 'verify'], ['/benchmarks', 'benchmarks'], ['/system', 'system']]) {
    const route = parseLocation({ pathname, search: '?sample=tampered&record=7', hash: '' });
    assert.equal(route.screen, screen);
    assert.equal(route.kind, 'workspace');
    assert.equal(route.direct, true);
    assert.equal(route.sample, 'tampered');
    assert.equal(route.record, '7');
  }
  assert.equal(parseLocation({ pathname: '/flightseal/console/', hash: '', search: '' }).screen, 'landing');
  assert.equal(parseLocation({ pathname: '/', hash: '#/app/receipts', search: '' }).screen, 'receipts');
  assert.equal(parseLocation({ pathname: '/api/missing', hash: '', search: '' }).screen, 'not-found');
  assert.equal(productHref('sandbox', { sample: 'intact', record: 4 }), '/workbench?sample=intact&record=4');
  assert.equal(productHref('system'), '/settings');
  assert.equal(productHref('records', { record: 3 }), '#/app/records?record=3');
});

test('canonical workspaces are distinct and verification remains a real workbench tool', async () => {
  const { parseLocation, productHref } = await import('../src/routes.mjs');
  for (const page of ['overview','workbench','reports','settings']) {
    const route=parseLocation({pathname:'/'+page,search:'',hash:''});
    assert.equal(route.kind,'workspace');assert.equal(route.canonical,page);
  }
  assert.equal(parseLocation({pathname:'/workbench',search:'?tool=verify&sample=intact',hash:''}).screen,'verify');
  assert.equal(productHref('verify',{sample:'intact'}),'/workbench?sample=intact&tool=verify');
});

test('Jobs keeps its search and page in the URL, and only those', () => {
  assert.equal(parseRouteHash('#/app/jobs?q=J-10&page=2').screen, 'jobs');
  assert.equal(parseRouteHash('#/jobs').screen, 'jobs');
  assert.equal(routeHash('jobs', { q: 'roof north', page: 2 }), '#/app/jobs?q=roof+north&page=2');
  assert.equal(routeHash('jobs', { q: '', page: 1 }), '#/app/jobs');
  assert.equal(routeHash('verify', { q: 'x', page: 3 }), '#/app/verify', 'other routes ignore q and page');
  assert.equal(routeHash('jobs', { q: 'x', status: 'registered', page: 2 }), '#/app/jobs?q=x&page=2&status=registered');
  assert.equal(routeHash('jobs', { status: 'bogus' }), '#/app/jobs', 'an unknown status is dropped');
  assert.equal(routeHash('verify', { status: 'waiting' }), '#/app/verify', 'only Jobs keeps a status');
});

test('receipt deep links retain their selected public receipt position',()=>{
 assert.equal(routeHash('receipts',{sample:'rewritten',receipt:2}),'#/app/receipts?sample=rewritten&receipt=2');
 assert.equal(safeReturnRoute('#/app/receipts?sample=intact&receipt=2'),'#/app/receipts?sample=intact&receipt=2');
 assert.equal(routeHash('receipts',{receipt:-1}),'#/app/receipts');
});
