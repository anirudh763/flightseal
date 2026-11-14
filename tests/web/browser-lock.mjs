import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LOCK_PATH = process.env.FLIGHTSEAL_BROWSER_LOCK || join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'five-app-user-council-browser.lock');

export function acquireBrowserLock() {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [
      '-c',
      'import fcntl, os, sys; fd=os.open(sys.argv[1], os.O_CREAT|os.O_RDWR, 0o600); fcntl.flock(fd, fcntl.LOCK_EX); print("locked", flush=True); sys.stdin.read()',
      LOCK_PATH,
    ], { stdio: ['pipe', 'pipe', 'inherit'] });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('locked\n')) resolve(child);
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (!output.includes('locked\n')) reject(new Error(`Could not acquire browser lock (python exited ${code}).`));
    });
  });
}

export async function releaseBrowserLock(child) {
  if (!child) return;
  child.stdin.end();
  await new Promise((resolve) => child.once('exit', resolve));
}
