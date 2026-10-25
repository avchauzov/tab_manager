import { cpSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

export const FIREFOX_EXTENSION_ID = 'tab-manager@tab-manager.invalid';
export const FIREFOX_MIN_VERSION = '140.0';
// Desktop Firefox 140 understands this manifest. Firefox for Android gained the
// data-collection field in 142, so the Android minimum is set separately.
export const FIREFOX_ANDROID_MIN_VERSION = '142.0';

const ROOT_FILES = ['background.js', 'options.html', 'options.js'];
const RESOURCE_DIRS = ['lib', 'icons'];

export function readSourceManifest() {
  return JSON.parse(readFileSync(join(projectRoot, 'manifest.json'), 'utf8'));
}

export function firefoxManifest(source = readSourceManifest()) {
  if (source.background?.service_worker !== 'background.js' || source.background?.type !== 'module') {
    throw new Error('Firefox build expects background.js as a module service worker in manifest.json');
  }

  const { background: _background, ...rest } = source;
  return {
    ...rest,
    browser_specific_settings: {
      gecko: {
        id: FIREFOX_EXTENSION_ID,
        strict_min_version: FIREFOX_MIN_VERSION,
        data_collection_permissions: {
          required: ['none'],
        },
      },
      gecko_android: {
        strict_min_version: FIREFOX_ANDROID_MIN_VERSION,
      },
    },
    background: {
      scripts: ['background.js'],
      type: 'module',
    },
  };
}

function copyExtensionFiles(dest) {
  mkdirSync(dest, { recursive: true });
  for (const file of ROOT_FILES) {
    cpSync(join(projectRoot, file), join(dest, file));
  }
  for (const dir of RESOURCE_DIRS) {
    cpSync(join(projectRoot, dir), join(dest, dir), {
      recursive: true,
      filter: (path) => !path.endsWith('.DS_Store'),
    });
  }
}

export function buildExtension(target, outRoot = join(projectRoot, 'dist')) {
  if (target !== 'chrome' && target !== 'firefox') {
    throw new Error(`Unknown build target: ${target}`);
  }

  const dest = join(outRoot, target);
  rmSync(dest, { recursive: true, force: true });
  copyExtensionFiles(dest);

  if (target === 'chrome') {
    cpSync(join(projectRoot, 'manifest.json'), join(dest, 'manifest.json'));
  } else {
    const manifest = firefoxManifest();
    writeFileSync(join(dest, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  }

  return dest;
}

function isDirectRun() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

function main() {
  const arg = process.argv[2] ?? 'all';
  if (arg === 'all') {
    buildExtension('chrome');
    buildExtension('firefox');
    console.log('Built chrome and firefox extensions.');
    return;
  }
  if (arg === 'chrome' || arg === 'firefox') {
    buildExtension(arg);
    console.log(`Built ${arg} extension.`);
    return;
  }
  console.error('Usage: node scripts/build.mjs [chrome|firefox|all]');
  process.exit(1);
}

if (isDirectRun()) main();
