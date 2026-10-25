import { readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

function walkJsFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      files.push(...walkJsFiles(path));
    } else if (path.endsWith('.js')) {
      files.push(path);
    }
  }
  return files;
}

const root = new URL('..', import.meta.url).pathname;
let failed = false;

for (const file of walkJsFiles(root)) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) failed = true;
}

process.exit(failed ? 1 : 0);
