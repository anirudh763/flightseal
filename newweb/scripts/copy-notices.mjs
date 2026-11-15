import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const [name, license, filename = 'LICENSE'] of [
  ['lucide-react', 'ISC'], ['react', 'MIT'], ['react-dom', 'MIT'], ['tailwindcss', 'MIT'],
  ['pdf-lib', 'MIT', 'LICENSE.md'], ['@pdf-lib/standard-fonts', 'MIT', 'LICENSE.md'],
  ['@pdf-lib/upng', 'MIT'], ['pako', 'MIT-Zlib'], ['pdf-lib/node_modules/tslib', '0BSD', 'LICENSE.txt'],
]) {
  const source = resolve(root, `node_modules/${name}/${filename}`);
  const target = resolve(root, `../docs/console/licenses/${name}-${license}.txt`);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}
