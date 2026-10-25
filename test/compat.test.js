import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test from 'node:test';

import {
  FIREFOX_ANDROID_MIN_VERSION,
  FIREFOX_EXTENSION_ID,
  FIREFOX_MIN_VERSION,
  buildExtension,
  firefoxManifest,
  projectRoot,
  readSourceManifest,
} from '../scripts/build.mjs';

const REQUIRED_FILES = [
  'manifest.json',
  'background.js',
  'options.html',
  'options.js',
  'icons/icon128.png',
  'lib/access.js',
  'lib/dedup.js',
  'lib/grouping.js',
  'lib/log.js',
  'lib/normalize.js',
  'lib/safe.js',
  'lib/settings.js',
  'lib/sort.js',
  'lib/stale.js',
];

const LISTENER_APIS = [
  'chrome.windows.onFocusChanged.addListener',
  'chrome.runtime.onInstalled.addListener',
  'chrome.runtime.onStartup.addListener',
  'chrome.alarms.onAlarm.addListener',
  'chrome.action.onClicked.addListener',
  'chrome.tabs.onActivated.addListener',
  'chrome.tabs.onUpdated.addListener',
  'chrome.runtime.onMessage.addListener',
];

function relativeFiles(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) relativeFiles(path, base, out);
    else out.push(relative(base, path));
  }
  return out.sort();
}

function walkSourceJs(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git' || entry === 'test' || entry === 'scripts') {
      continue;
    }
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walkSourceJs(path, out);
    else if (path.endsWith('.js')) out.push(path);
  }
  return out;
}

const sourceManifest = readSourceManifest();
const firefox = firefoxManifest(sourceManifest);

test('chrome manifest stays a module service worker', () => {
  assert.equal(sourceManifest.manifest_version, 3);
  assert.equal(sourceManifest.background.service_worker, 'background.js');
  assert.equal(sourceManifest.background.type, 'module');
  assert.equal(sourceManifest.background.scripts, undefined);
  assert.equal(sourceManifest.browser_specific_settings, undefined);
  assert.equal(sourceManifest.action.default_popup, undefined);
  assert.deepEqual(sourceManifest.permissions, ['tabs', 'tabGroups', 'storage', 'alarms']);
});

test('firefox manifest uses an event page and declares no remote data collection', () => {
  assert.equal(firefox.manifest_version, 3);
  assert.equal(firefox.background.service_worker, undefined);
  assert.deepEqual(firefox.background.scripts, ['background.js']);
  assert.equal(firefox.background.type, 'module');
  assert.equal(firefox.browser_specific_settings.gecko.id, FIREFOX_EXTENSION_ID);
  assert.equal(firefox.browser_specific_settings.gecko.id, 'tab-manager@tab-manager.invalid');
  assert.equal(firefox.browser_specific_settings.gecko.strict_min_version, FIREFOX_MIN_VERSION);
  assert.equal(firefox.browser_specific_settings.gecko.strict_min_version, '140.0');
  assert.equal(
    firefox.browser_specific_settings.gecko_android.strict_min_version,
    FIREFOX_ANDROID_MIN_VERSION
  );
  assert.equal(firefox.browser_specific_settings.gecko_android.strict_min_version, '142.0');
  assert.deepEqual(firefox.browser_specific_settings.gecko.data_collection_permissions, {
    required: ['none'],
  });
  assert.deepEqual(firefox.permissions, sourceManifest.permissions);
  assert.equal(firefox.name, sourceManifest.name);
  assert.equal(firefox.version, sourceManifest.version);
  assert.equal(firefox.action.default_popup, undefined);
  assert.equal(firefox.options_ui.page, sourceManifest.options_ui.page);
  assert.deepEqual(firefox.icons, sourceManifest.icons);
});

test('both bundles contain the shared extension and differ only in the manifest', () => {
  const out = mkdtempSync(join(tmpdir(), 'tab-manager-build-'));
  try {
    const chromeDir = buildExtension('chrome', out);
    const firefoxDir = buildExtension('firefox', out);

    for (const file of REQUIRED_FILES) {
      assert.equal(existsSync(join(chromeDir, file)), true, `chrome bundle missing ${file}`);
      assert.equal(existsSync(join(firefoxDir, file)), true, `firefox bundle missing ${file}`);
    }

    for (const banned of ['package.json', 'README.md', 'scripts/build.mjs', 'test/compat.test.js']) {
      assert.equal(existsSync(join(chromeDir, banned)), false, `chrome bundle includes ${banned}`);
      assert.equal(existsSync(join(firefoxDir, banned)), false, `firefox bundle includes ${banned}`);
    }

    assert.equal(
      readFileSync(join(chromeDir, 'manifest.json'), 'utf8'),
      readFileSync(join(projectRoot, 'manifest.json'), 'utf8')
    );

    const builtFirefox = JSON.parse(readFileSync(join(firefoxDir, 'manifest.json'), 'utf8'));
    assert.deepEqual(builtFirefox, firefox);

    const chromeFiles = relativeFiles(chromeDir).filter((file) => file !== 'manifest.json');
    const firefoxFiles = relativeFiles(firefoxDir).filter((file) => file !== 'manifest.json');
    assert.deepEqual(chromeFiles, firefoxFiles);
    for (const file of chromeFiles) {
      const chromeBytes = readFileSync(join(chromeDir, file));
      const firefoxBytes = readFileSync(join(firefoxDir, file));
      assert.equal(chromeBytes.equals(firefoxBytes), true, `${file} differs between bundles`);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('shared source does not rewrite tab URLs', () => {
  const offenders = [];
  for (const file of walkSourceJs(projectRoot)) {
    const text = readFileSync(file, 'utf8');
    if (/\.tabs\.update\b/.test(text) || /\bwebNavigation\b/.test(text) || /location\.href\s*=/.test(text)) {
      offenders.push(relative(projectRoot, file));
    }
  }
  assert.deepEqual(offenders, []);
});

test('background listeners are registered synchronously for service workers and event pages', () => {
  const source = readFileSync(join(projectRoot, 'background.js'), 'utf8');
  const prelude = source.split(/\n(?:async )?function /)[0];
  assert.equal(/\bawait\b/.test(prelude), false);
  const registration = source.slice(source.indexOf('chrome.windows.onFocusChanged.addListener'));
  assert.notEqual(registration, '');
  assert.equal(/\bawait\b/.test(registration), false);
  assert.equal(registration.includes('setTimeout'), false);
  assert.equal(registration.includes('DOMContentLoaded'), false);
  for (const api of LISTENER_APIS) {
    assert.equal(registration.includes(api), true, api);
  }
});

test('background init, settings, and URL observation survive a fresh background load', async () => {
  const calls = [];
  const syncStore = { intervalMinutes: 17 };
  const localStore = {};
  const alarmStore = new Map();

  function track(name, fn) {
    return async (...args) => {
      calls.push({ name, args });
      return fn(...args);
    };
  }

  function storageArea(store, prefix) {
    return {
      get: track(`${prefix}.get`, async (keys) => {
        if (typeof keys === 'string') return { [keys]: store[keys] };
        if (Array.isArray(keys)) {
          const out = {};
          for (const key of keys) out[key] = store[key];
          return out;
        }
        if (keys && typeof keys === 'object') {
          const out = { ...keys };
          for (const key of Object.keys(out)) {
            if (Object.prototype.hasOwnProperty.call(store, key)) out[key] = store[key];
          }
          return out;
        }
        return { ...store };
      }),
      set: track(`${prefix}.set`, async (items) => {
        Object.assign(store, structuredClone(items));
      }),
    };
  }

  function eventApi() {
    const listeners = [];
    return {
      addListener(fn) {
        listeners.push(fn);
      },
      listeners,
    };
  }

  const events = {
    onFocusChanged: eventApi(),
    onInstalled: eventApi(),
    onStartup: eventApi(),
    onAlarm: eventApi(),
    onClicked: eventApi(),
    onActivated: eventApi(),
    onUpdated: eventApi(),
    onMessage: eventApi(),
  };

  globalThis.chrome = {
    windows: {
      WINDOW_ID_NONE: -1,
      onFocusChanged: events.onFocusChanged,
      getLastFocused: track('windows.getLastFocused', async () => ({ id: 1 })),
      getAll: track('windows.getAll', async () => [{ id: 1 }]),
      getCurrent: track('windows.getCurrent', async () => ({ id: 1, focused: true })),
    },
    runtime: {
      onInstalled: events.onInstalled,
      onStartup: events.onStartup,
      onMessage: events.onMessage,
    },
    alarms: {
      onAlarm: events.onAlarm,
      get: track('alarms.get', async (name) => alarmStore.get(name) ?? null),
      clear: track('alarms.clear', async (name) => {
        alarmStore.delete(name);
        return true;
      }),
      create: track('alarms.create', async (name, info) => {
        alarmStore.set(name, { name, ...info });
      }),
    },
    action: { onClicked: events.onClicked },
    tabs: {
      onActivated: events.onActivated,
      onUpdated: events.onUpdated,
      get: track('tabs.get', async () => null),
      query: track('tabs.query', async () => []),
      remove: track('tabs.remove', async () => undefined),
      discard: track('tabs.discard', async () => null),
      move: track('tabs.move', async () => null),
      group: track('tabs.group', async () => null),
      ungroup: track('tabs.ungroup', async () => undefined),
      update: track('tabs.update', async () => null),
    },
    tabGroups: {
      TAB_GROUP_ID_NONE: -1,
      get: track('tabGroups.get', async () => null),
      query: track('tabGroups.query', async () => []),
      update: track('tabGroups.update', async () => null),
      move: track('tabGroups.move', async () => null),
    },
    storage: {
      sync: storageArea(syncStore, 'storage.sync'),
      local: storageArea(localStore, 'storage.local'),
    },
  };

  await import('../background.js');

  for (const event of Object.values(events)) {
    assert.equal(event.listeners.length, 1);
  }

  async function drain() {
    for (let i = 0; i < 80; i += 1) await Promise.resolve();
  }

  events.onInstalled.listeners[0]();
  await drain();
  assert.equal(alarmStore.get('tabManagerTick')?.periodInMinutes, 17);
  assert.equal(calls.some((call) => call.name === 'tabs.query'), true);
  assert.equal(calls.some((call) => call.name === 'windows.getAll'), true);

  const createsAfterInstall = calls.filter((call) => call.name === 'alarms.create').length;
  assert.equal(createsAfterInstall, 1);
  calls.length = 0;
  events.onStartup.listeners[0]();
  await drain();
  assert.equal(calls.filter((call) => call.name === 'alarms.create').length, 0);
  assert.equal(calls.some((call) => call.name === 'alarms.get'), true);

  syncStore.intervalMinutes = 21;
  let response;
  const pending = events.onMessage.listeners[0]({ action: 'settingsUpdated' }, {}, (value) => {
    response = value;
  });
  assert.equal(pending, true);
  await drain();
  assert.deepEqual(response, { ok: true });
  assert.equal(alarmStore.get('tabManagerTick').periodInMinutes, 21);

  const { getSettings } = await import('../lib/settings.js');
  const settings = await getSettings();
  assert.equal(settings.intervalMinutes, 21);
  assert.equal(settings.realTimeDedupEnabled, true);

  calls.length = 0;
  events.onUpdated.listeners[0](
    5,
    { url: 'https://example.com/a?utm_source=x&id=4' },
    { id: 5, url: 'https://example.com/a?utm_source=x&id=4' }
  );
  await drain();
  assert.equal(calls.some((call) => call.name === 'tabs.update'), false);
  assert.equal(localStore.urlLastAccess?.['https://example.com/a?id=4']?.lastObservedAt > 0, true);

  calls.length = 0;
  events.onAlarm.listeners[0]({ name: 'other' });
  await drain();
  assert.equal(calls.some((call) => call.name === 'tabs.query'), false);
  events.onAlarm.listeners[0]({ name: 'tabManagerTick' });
  await drain();
  assert.equal(calls.some((call) => call.name === 'windows.getAll'), true);

  events.onFocusChanged.listeners[0](chrome.windows.WINDOW_ID_NONE);
  events.onClicked.listeners[0]({ id: 1, windowId: 1 });
  await drain();
});
