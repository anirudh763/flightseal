// Compatibility entrypoint for the canonical console's read-recovery, stale-read,
// export, and file-hardening browser suite.
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireBrowserLock, releaseBrowserLock } from './browser-lock.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const EVIDENCE = process.env.REACT_CONSOLE_EVIDENCE || join(ROOT, 'build/test-artifacts/compatibility-tests');
const lock = await acquireBrowserLock();
try {
  process.env.REACT_CONSOLE_EVIDENCE = EVIDENCE;
  await import('../../newweb/tests/console.mjs');
} finally {
  await releaseBrowserLock(lock);
}
