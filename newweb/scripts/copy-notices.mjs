import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const [name, license] of [['lucide-react', 'ISC'], ['react', 'MIT'], ['react-dom', 'MIT'], ['tailwindcss', 'MIT']]) {
  const source = resolve(root, `node_modules/${name}/LICENSE`);
  const target = resolve(root, `../docs/console/licenses/${name}-${license}.txt`);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}
