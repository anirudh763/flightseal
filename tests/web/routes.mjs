// Responsive, route, keyboard and no-script checks for the canonical workbench.
//   node tests/web/routes.mjs
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { serve } from './serve.mjs';
import { acquireBrowserLock, releaseBrowserLock } from './browser-lock.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const COUNCIL = '/Users/anirudhyadav/Downloads/active/user-council-2026-11-14/flightseal';
const EVIDENCE = process.env.FSEAL_WEB_EVIDENCE || (existsSync(COUNCIL) ? join(COUNCIL, 'workbench/compatibility-tests') : join(ROOT, 'build/test-artifacts/compatibility-tests'));
const require = createRequire(join(ROOT, 'newweb/package.json'));
const { chromium } = require('playwright');
const AXE = require('fs').readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const SYSTEM_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const checks = [];
const ONLY = process.env.ROUTES_ONLY ? new RegExp(process.env.ROUTES_ONLY) : null;
let lock;
let browser;
let server;
let rootUrl;

async function check(name, fn) {
  if (ONLY && !ONLY.test(name)) return;
  try { await fn(); checks.push({ name, passed: true }); console.log(`ok ${name}`); }
  catch (error) { checks.push({ name, passed: false, error: String(error?.stack || error) }); console.error(`FAIL ${name}: ${error?.message || error}`); }
}

async function waitHeading(page, route, title) {
  await page.waitForFunction((path) => [ `#/${path}`, `#/app/${path}` ].includes(location.hash.split('?')[0]), route);
  await page.waitForFunction((text) => document.querySelector('.commandbar h1')?.textContent === text, title, { timeout: 15000 });
}

async function axe(page, label) {
  await page.evaluate(AXE);
  const result = await page.evaluate(() => window.axe.run(document, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
  }));
  assert.equal(result.violations.length, 0, `${label}: ${result.violations.map((item) => `${item.id}: ${item.nodes.map((node) => node.target.join(' ')).join(', ')}`).join(' | ')}`);
}

try {
  lock = await acquireBrowserLock();
  mkdirSync(EVIDENCE, { recursive: true });
  ({ server, url: rootUrl } = await serve(0, '/flightseal'));
  const chromePath = process.env.CHROME_PATH || (existsSync(SYSTEM_CHROME) ? SYSTEM_CHROME : undefined);
  browser = await chromium.launch({ headless: true, ...(chromePath ? { executablePath: chromePath } : {}) });

  await check('320, 768, and 1440 layouts stay in the light theme without page overflow; key targets remain 44px', async () => {
    for (const width of [320, 768, 1440]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await context.newPage();
      await page.goto(`${rootUrl}console/#/sandbox`);
      await page.waitForFunction(() => document.querySelector('#result-heading')?.textContent.includes('Intact'), null, { timeout: 30000 });
      assert.equal((await page.locator('.brand span:not(.brand-mark)').textContent()).trim(), 'HashWing');
      assert.equal(await page.title(), 'Samples · HashWing');
      const state = await page.evaluate(() => {
        const color = getComputedStyle(document.body).backgroundColor.match(/[\d.]+/g)?.map(Number) || [];
        const brightness = color.length >= 3 ? (Math.max(...color.slice(0, 3)) + Math.min(...color.slice(0, 3))) / 510 : 0;
        const targets = ['.skip-link', '#primary-nav a', '.command-actions button', '.sample-toolbar .button'].map((selector) => {
          const el = document.querySelector(selector);
          if (!el || el.getClientRects().length === 0) return null;
          const rect = el.getBoundingClientRect();
          return { selector, width: rect.width, height: rect.height };
        }).filter(Boolean);
        return { width: innerWidth, viewport: document.documentElement.clientWidth, page: document.documentElement.scrollWidth, brightness, targets };
      });
      assert.ok(state.brightness > 0.78, `${width}px: canvas is not light: ${JSON.stringify(state)}`);
      assert.ok(state.page <= state.viewport + 1, `${width}px: horizontal page overflow: ${JSON.stringify(state)}`);
      assert.ok(state.targets.length >= 2, `${width}px: expected visible skip and navigation/action targets: ${JSON.stringify(state.targets)}`);
      for (const target of state.targets) assert.ok(target.width >= 44 && target.height >= 44, `${width}px: undersized target ${JSON.stringify(target)}`);
      await axe(page, `${width}px light workbench`);
      await page.screenshot({ path: join(EVIDENCE, `canonical-routes-${width}.png`), fullPage: true });
      await context.close();
    }
  });

  await check('200% text zoom preserves readable workbench content without horizontal page overflow', async () => {
    const context = await browser.newContext({ viewport: { width: 320, height: 900 } });
    try {
      const page = await context.newPage();
      // CDP bypasses the application's CSP only in this isolated visual-zoom context.
      const cdp = await context.newCDPSession(page);
      await cdp.send('Page.setBypassCSP', { enabled: true });
      await page.goto(`${rootUrl}console/#/sandbox`);
      await page.waitForFunction(() => document.querySelector('#result-heading')?.textContent.includes('Intact'), null, { timeout: 30000 });
      // Model text-only zoom by doubling the computed size of every text-bearing element.
      await page.evaluate(() => {
        const rules = [];
        let index = 0;
        for (const element of document.querySelectorAll('body *')) {
          if (![...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim())) continue;
          const size = Number.parseFloat(getComputedStyle(element).fontSize);
          if (!Number.isFinite(size)) continue;
          const key = `text-zoom-${index++}`;
          element.dataset.textZoomCase = key;
          rules.push(`[data-text-zoom-case="${key}"] { font-size: ${size * 2}px !important; }`);
        }
        const style = document.createElement('style');
        style.textContent = rules.join('\n');
        document.head.append(style);
      });
      const result = await page.evaluate(() => {
        const viewport = document.documentElement.clientWidth;
        const nodes = [...document.querySelectorAll('body *')].map((element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          const chain = [];
          for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
            const overflowX = getComputedStyle(parent).overflowX;
            if (['auto', 'scroll', 'hidden', 'clip'].includes(overflowX)) chain.push(`${parent.tagName.toLowerCase()}${parent.id ? `#${parent.id}` : ''}.${overflowX}`);
          }
          return {
            node: `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${typeof element.className === 'string' && element.className ? `.${element.className.trim().replaceAll(/\s+/g, '.')}` : ''}`,
            right: Math.round(rect.right), width: Math.round(rect.width), scrollWidth: element.scrollWidth,
            minWidth: style.minWidth, fontSize: style.fontSize, overflowAncestors: chain,
            text: (element.textContent || '').trim().slice(0, 64),
            parents: [...function* () { for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) yield `${parent.tagName.toLowerCase()}${parent.id ? `#${parent.id}` : ''}${typeof parent.className === 'string' && parent.className ? `.${parent.className.trim().replaceAll(/\s+/g, '.')}` : ''}`; }()].slice(0, 4),
          };
        });
        const overflow = nodes.filter((element) => element.right > viewport + 1 && element.overflowAncestors.length === 0)
          .sort((a, b) => b.right - a.right).slice(0, 8);
        const textOverflow = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (!node.textContent.trim()) continue;
          const range = document.createRange(); range.selectNodeContents(node);
          const rect = range.getBoundingClientRect();
          if (rect.right > viewport + 1) textOverflow.push({ text: node.textContent.trim().slice(0, 48), parent: node.parentElement.className, right: Math.round(rect.right) });
        }
        return { viewport, page: document.documentElement.scrollWidth, heading: getComputedStyle(document.querySelector('h1')).fontSize, overflow, textOverflow: textOverflow.slice(0, 10) };
      });
      assert.ok(result.page <= result.viewport + 1, `200% text sizing overflowed at 320px: ${JSON.stringify(result)}`);
      assert.ok(parseFloat(result.heading) >= 27, `200% text sizing did not enlarge the heading: ${JSON.stringify(result)}`);
    } finally { await context.close(); }
  });

  await check('legacy root links route into the canonical workbench and preserve allowlisted sample, record, and receipt values', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    try {
      const page = await context.newPage();
      const assertRoute = (screen, params) => {
        const actual = new URL(page.url());
        const route = new URL(actual.hash.slice(1), actual.origin);
        assert.equal(actual.pathname, new URL(`${rootUrl}console/`).pathname);
        assert.equal(actual.search, '');
        assert.equal(route.pathname, `/app/${screen}`);
        assert.deepEqual([...route.searchParams].sort(), Object.entries(params).sort());
      };
      await page.goto(`${rootUrl}?sample=rewritten`);
      await waitHeading(page, 'sandbox', 'Samples');
      await page.waitForFunction(() => document.querySelector('#result-heading')?.textContent.includes('Tampered'), null, { timeout: 30000 });
      assertRoute('sandbox', { sample: 'rewritten', record: '0' });

      await page.goto(`${rootUrl}#/findings?sample=rewritten`);
      await waitHeading(page, 'sandbox', 'Samples');
      await page.waitForFunction(() => document.querySelector('#result-heading')?.textContent.includes('Tampered'), null, { timeout: 30000 });
      assertRoute('sandbox', { sample: 'rewritten', record: '0' });

      await page.goto(`${rootUrl}?sample=intact&record=742`);
      await waitHeading(page, 'records', 'Records');
      await page.waitForFunction(() => document.querySelector('#record-detail-title')?.textContent === 'Record 742', null, { timeout: 30000 });
      assertRoute('records', { sample: 'intact', record: '742' });

      await page.goto(`${rootUrl}?sample=not-allowlisted&record=742`);
      await waitHeading(page, 'records', 'Records');
      await page.waitForFunction(() => document.querySelector('#record-detail-title')?.textContent === 'Record 742', null, { timeout: 30000 });
      assertRoute('records', { sample: 'intact', record: '742' });
      assert.doesNotMatch(page.url(), /not-allowlisted/);

      await page.goto(`${rootUrl}#/receipts/2?sample=rewritten`);
      await waitHeading(page, 'receipts', 'Receipts');
      assertRoute('receipts', { sample: 'rewritten', record: '0', receipt: '2' });
      await page.goto(`${rootUrl}#/records/742?sample=intact`);
      await waitHeading(page, 'records', 'Records');
      await page.waitForFunction(() => document.querySelector('#record-detail-title')?.textContent === 'Record 742', null, { timeout: 30000 });
      assertRoute('records', { sample: 'intact', record: '742' });
    } finally { await context.close(); }
  });

  await check('canonical history Back and Forward restore the route while preserving the loaded evidence and selected record', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    try {
      const page = await context.newPage();
      await page.goto(`${rootUrl}console/#/records?sample=intact&record=742`);
      await page.waitForFunction(() => document.querySelector('#record-detail-title')?.textContent === 'Record 742', null, { timeout: 30000 });
      await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Receipts' }).click();
      await waitHeading(page, 'receipts', 'Receipts');
      await page.goBack();
      await waitHeading(page, 'records', 'Records');
      assert.equal(await page.locator('#record-detail-title').textContent(), 'Record 742');
      assert.match(await page.locator('.record-list').textContent(), /742/);
      await page.goForward();
      await waitHeading(page, 'receipts', 'Receipts');
      assert.equal(await page.locator('tbody tr').count(), 8);
    } finally { await context.close(); }
  });

  await check('keyboard navigation activates a route, moves focus to its heading, and the skip link reaches main content', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    try {
      const page = await context.newPage();
      await page.goto(`${rootUrl}console/#/sandbox`);
      await page.waitForFunction(() => document.querySelector('#result-heading')?.textContent.includes('Intact'), null, { timeout: 30000 });
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.className), 'skip-link');
      const skip = await page.locator('.skip-link').boundingBox();
      assert.ok(skip && skip.width >= 44 && skip.height >= 44, `skip target is undersized: ${JSON.stringify(skip)}`);
      await page.keyboard.press('Enter');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'main');
      await page.locator('.skip-link').focus();
      await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Records' }).focus();
      await page.keyboard.press('Enter');
      await waitHeading(page, 'records', 'Records');
      await page.waitForFunction(() => document.activeElement.id === 'page-records', null, { timeout: 3000 });
      assert.equal(await page.evaluate(() => document.activeElement.id), 'page-records');
    } finally { await context.close(); }
  });

  await check('the root no-script fallback explains the JavaScript requirement and links to the native CLI', async () => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    try {
      const page = await context.newPage();
      await page.goto(rootUrl);
      const message = page.locator('noscript');
      assert.ok(await message.isVisible());
      assert.match(await message.innerText(), /needs JavaScript/i);
      assert.match(await message.innerText(), /native CLI/i);
      assert.match(await message.locator('a').getAttribute('href'), /github\.com\/.*#quick-start/);
      assert.equal(await page.locator('#root').count(), 0, 'disabled-script fallback unexpectedly rendered the workbench shell');
    } finally { await context.close(); }
  });
} catch (error) {
  checks.push({ name: 'browser route setup', passed: false, error: String(error?.stack || error) });
  console.error(`FAIL browser route setup: ${error?.message || error}`);
} finally {
  await browser?.close();
  server?.close();
  mkdirSync(EVIDENCE, { recursive: true });
  writeFileSync(join(EVIDENCE, 'canonical-routes.json'), JSON.stringify({ suite: 'tests/web/routes.mjs', checks, total: checks.length, passed: checks.filter((item) => item.passed).length, failed: checks.filter((item) => !item.passed).length }, null, 2));
  await releaseBrowserLock(lock);
}

if (checks.some((item) => !item.passed)) process.exitCode = 1;
