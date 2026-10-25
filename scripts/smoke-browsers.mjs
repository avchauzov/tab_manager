import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import http from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import webExt from 'web-ext';

import { FIREFOX_EXTENSION_ID, buildExtension, projectRoot } from './build.mjs';

const CHROME_CANDIDATES = [
  process.env.CHROME_BINARY,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
].filter(Boolean);

function localFirefoxBuilds() {
  const root = join(projectRoot, 'firefox');
  if (!existsSync(root)) return [];
  const builds = [];
  for (const entry of readdirSync(root)) {
    const binary = join(root, entry, 'Firefox.app', 'Contents', 'MacOS', 'firefox');
    if (existsSync(binary)) builds.push(binary);
  }
  return builds;
}

const FIREFOX_CANDIDATES = [
  process.env.FIREFOX_BINARY,
  '/Applications/Firefox.app/Contents/MacOS/firefox',
  '/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox',
  '/Applications/Firefox Nightly.app/Contents/MacOS/firefox',
  ...localFirefoxBuilds(),
].filter(Boolean);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function firstExisting(paths) {
  return paths.find((path) => existsSync(path)) ?? null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function expect(condition, message, details) {
  if (!condition) {
    const extra = details === undefined ? '' : `\n${JSON.stringify(details, null, 2)}`;
    throw new Error(`${message}${extra}`);
  }
}

function startServer() {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>tab-manager-smoke</title>');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.opened = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', (event) => reject(event.error || new Error('CDP socket error')));
    });
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) return;
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    });
  }

  async send(method, params = {}) {
    await this.opened;
    const id = this.nextId;
    this.nextId += 1;
    const result = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.ws.send(JSON.stringify({ id, method, params }));
    return result;
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      throw new Error(details.exception?.description || details.text || 'CDP evaluation failed');
    }
    return result.result?.value;
  }

  close() {
    this.ws.close();
  }
}

async function fetchTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) throw new Error(`DevTools list returned ${response.status}`);
  return response.json();
}

async function waitForTarget(port, predicate, timeoutMs = 20000) {
  const started = Date.now();
  let last = [];
  while (Date.now() - started < timeoutMs) {
    try {
      last = await fetchTargets(port);
      const found = last.find(predicate);
      if (found?.webSocketDebuggerUrl) return found;
    } catch {
      // The browser is still starting.
    }
    await delay(200);
  }
  const summary = last.map((target) => ({ type: target.type, url: target.url }));
  throw new Error(`Timed out waiting for a browser target\n${JSON.stringify(summary, null, 2)}`);
}

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function createPipeClient(writeStream, readStream) {
  let buffer = '';
  const waiters = new Map();
  let nextId = 1;
  readStream.setEncoding('utf8');
  readStream.on('data', (chunk) => {
    buffer += chunk;
    let splitAt = buffer.indexOf('\0');
    while (splitAt !== -1) {
      const raw = buffer.slice(0, splitAt);
      buffer = buffer.slice(splitAt + 1);
      splitAt = buffer.indexOf('\0');
      if (!raw.trim()) continue;
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!message.id || !waiters.has(message.id)) continue;
      const waiter = waiters.get(message.id);
      waiters.delete(message.id);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result);
    }
  });
  return {
    send(method, params = {}) {
      const id = nextId;
      nextId += 1;
      const result = new Promise((resolve, reject) => {
        waiters.set(id, { resolve, reject });
      });
      writeStream.write(`${JSON.stringify({ id, method, params })}\0`);
      return result;
    },
  };
}

function launchChrome({ binary, userDataDir, port }) {
  // Branded Chrome ignores --load-extension. Extensions.loadUnpacked is accepted
  // only on the debugging pipe, and only with unsafe extension debugging enabled.
  const child = spawn(binary, [
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${port}`,
    '--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-component-update',
    '--hide-crash-restore-bubble',
    '--disable-session-crashed-bubble',
    '--window-size=1000,800',
    'about:blank',
  ], {
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stdio[2].setEncoding('utf8');
  child.stdio[2].on('data', (chunk) => {
    stderr += chunk;
    if (stderr.length > 12000) stderr = stderr.slice(-12000);
  });
  return {
    child,
    pipe: createPipeClient(child.stdio[3], child.stdio[4]),
    stderr: () => stderr,
  };
}

async function openChrome({ binary, userDataDir, port, extensionDir }) {
  const session = launchChrome({ binary, userDataDir, port });
  try {
    await withTimeout(session.pipe.send('Browser.getVersion'), 15000, 'Chrome debugging pipe did not respond');
    await withTimeout(
      session.pipe.send('Extensions.loadUnpacked', { path: extensionDir }),
      15000,
      'Extensions.loadUnpacked failed'
    );
    return session;
  } catch (error) {
    stopProcessGroup(session.child);
    throw new Error(`${error.message}\n${session.stderr()}`);
  }
}

function stopProcessGroup(child) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      // The process has already exited.
    }
  }
}

async function waitForExit(child, timeoutMs = 8000) {
  if (!child || child.exitCode != null || child.signalCode) return;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  stopProcessGroup(child);
}

async function waitForAlarm(evalBackground) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < 15000) {
    last = await evalBackground(`(async () => {
      const api = globalThis.chrome || globalThis.browser;
      return api.alarms.get('tabManagerTick');
    })()`);
    if (last?.name === 'tabManagerTick') return last;
    await delay(200);
  }
  throw new Error(`Background alarm was not created\n${JSON.stringify(last)}`);
}

async function runScenario(evalBackground, evalPage, { backgroundKey, origin }) {
  const probe = await evalBackground(`(async () => {
    const api = globalThis.chrome || globalThis.browser;
    const manifest = api.runtime.getManifest();
    return {
      hasChrome: typeof globalThis.chrome !== 'undefined',
      hasBrowser: typeof globalThis.browser !== 'undefined',
      backgroundKeys: Object.keys(manifest.background || {}),
      popup: manifest.action ? manifest.action.default_popup || null : null,
      none: api.tabGroups.TAB_GROUP_ID_NONE,
      hasGroup: typeof api.tabs.group === 'function',
      hasMove: typeof api.tabGroups.move === 'function',
    };
  })()`);
  expect(probe.backgroundKeys.includes(backgroundKey), `background.${backgroundKey} missing`, probe);
  expect(probe.popup == null, 'action.default_popup is set', probe);
  expect(probe.none === -1, 'TAB_GROUP_ID_NONE is not -1', probe);
  expect(probe.hasGroup && probe.hasMove, 'tab group APIs are missing', probe);
  expect(probe.hasChrome, 'chrome namespace is missing in the background', probe);

  const alarm = await waitForAlarm(evalBackground);
  expect(alarm.periodInMinutes === 60, 'initial alarm does not use the default interval', alarm);
  await delay(1000);

  const originJson = JSON.stringify(origin);
  const dedup = await evalBackground(`(async () => {
    const api = globalThis.chrome || globalThis.browser;
    const url = ${originJson} + '/dup-check';
    await api.tabs.create({ url, active: false });
    await api.tabs.create({ url, active: false });
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const tabs = await api.tabs.query({});
    return tabs
      .filter((tab) => tab.url === url)
      .map((tab) => ({ id: tab.id, url: tab.url, windowId: tab.windowId }));
  })()`);
  expect(dedup.length === 1, 'same-window dedup did not leave one tab', dedup);
  expect(dedup[0].url === `${origin}/dup-check`, 'dedup rewrote the tab URL', dedup);

  const cross = await evalBackground(`(async () => {
    const api = globalThis.chrome || globalThis.browser;
    const url = ${originJson} + '/cross-dup';
    const first = await api.windows.getCurrent();
    await api.windows.create({ url, focused: false });
    await api.tabs.create({ windowId: first.id, url, active: false });
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const tabs = await api.tabs.query({});
    return tabs
      .filter((tab) => tab.url === url)
      .map((tab) => ({ id: tab.id, url: tab.url, windowId: tab.windowId }));
  })()`);
  expect(cross.length === 1, 'cross-window dedup did not leave one tab', cross);
  expect(cross[0].url === `${origin}/cross-dup`, 'cross-window dedup rewrote the tab URL', cross);

  await evalBackground(`(async () => {
    const api = globalThis.chrome || globalThis.browser;
    await api.storage.sync.set({
      intervalMinutes: 17,
      realTimeDedupEnabled: false,
      runOnStartup: false,
    });
    await api.storage.local.set({ smokeMarker: 'persist-1' });
  })()`);
  await delay(500);

  const optionsUrl = await evalBackground(`(async () => {
    const api = globalThis.chrome || globalThis.browser;
    const url = api.runtime.getURL('options.html');
    await api.windows.create({ url, focused: false });
    return url;
  })()`);

  const layout = await evalPage(optionsUrl, `(async () => {
    const api = globalThis.chrome || globalThis.browser;
    const origin = ${originJson};
    const win = await api.windows.create({ url: origin + '/a', focused: true });
    const windowId = win.id;
    const pinned = await api.tabs.create({ windowId, url: origin + '/pinned', pinned: true, index: 0 });
    const tracked = await api.tabs.create({
      windowId,
      url: origin + '/b?utm_source=cursor&id=7',
      active: false,
    });
    await api.tabs.create({ windowId, url: origin + '/host/1', active: false });
    await api.tabs.create({ windowId, url: origin + '/host/2', active: false });
    const readyDeadline = Date.now() + 3000;
    while (Date.now() < readyDeadline) {
      const ready = await api.tabs.query({ windowId });
      const loaded = ready.filter((tab) => String(tab.url || '').startsWith(origin));
      if (loaded.length >= 5) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const settingsMod = await import(api.runtime.getURL('lib/settings.js'));
    const grouping = await import(api.runtime.getURL('lib/grouping.js'));
    const sort = await import(api.runtime.getURL('lib/sort.js'));
    const settings = await settingsMod.getSettings();
    await grouping.groupTabsByHostname(windowId, {
      ...settings,
      autoGroupByDomain: true,
      minTabsPerGroup: 2,
    });
    await sort.layoutWindow(windowId, { ...settings, sortInsideGroups: true });
    const tabs = await api.tabs.query({ windowId });
    tabs.sort((a, b) => a.index - b.index);
    const groups = await api.tabGroups.query({ windowId });
    const kept = await api.tabs.get(tracked.id);
    const pinnedTab = await api.tabs.get(pinned.id);
    return {
      tabs: tabs.map((tab) => ({
        url: tab.url,
        pinned: tab.pinned,
        index: tab.index,
        groupId: tab.groupId,
      })),
      groups: groups.map((group) => ({ id: group.id, title: group.title })),
      keptUrl: kept.url,
      pinned: { pinned: pinnedTab.pinned, url: pinnedTab.url, groupId: pinnedTab.groupId, index: pinnedTab.index },
    };
  })()`);

  const unpinned = layout.tabs.filter((tab) => !tab.pinned);
  expect(layout.pinned.pinned === true, 'pinned tab was unpinned', layout);
  expect(layout.pinned.index === 0, 'pinned tab is not first', layout);
  expect(layout.pinned.groupId === -1, 'pinned tab was grouped', layout);
  expect(layout.pinned.url === `${origin}/pinned`, 'pinned tab URL changed', layout);
  expect(layout.keptUrl.includes('utm_source=cursor') && layout.keptUrl.includes('id=7'), 'tracking parameter was removed from the tab URL', layout);
  expect(layout.groups.length === 1, 'expected one hostname group', layout);
  expect(layout.groups[0].title === '127.0.0.1', 'hostname group title', layout);
  const expectedUrls = [
    `${origin}/a`,
    `${origin}/b?utm_source=cursor&id=7`,
    `${origin}/host/1`,
    `${origin}/host/2`,
  ];
  expect(
    unpinned.map((tab) => tab.url).join('\n') === expectedUrls.join('\n'),
    'tabs are not sorted by normalized URL',
    { expectedUrls, layout }
  );
  expect(unpinned.every((tab) => tab.groupId === layout.groups[0].id), 'a sorted tab is outside the hostname group', layout);

  const optionsStarted = Date.now();
  let options = null;
  while (Date.now() - optionsStarted < 8000) {
    options = await evalPage(optionsUrl, `(() => ({
      title: document.title,
      interval: document.querySelector('#intervalMinutes')?.value ?? null,
      dedup: document.querySelector('#realTimeDedupEnabled')?.checked ?? null,
      startup: document.querySelector('#runOnStartup')?.checked ?? null,
      save: Boolean(document.querySelector('#save')),
    }))()`);
    if (options?.interval === '17' && options.save && options.dedup === false && options.startup === false) break;
    await delay(200);
  }
  expect(options.title === 'Tab Manager Settings', 'options title', options);
  expect(options.save === true, 'options save button', options);
  expect(options.interval === '17', 'options did not load the stored interval', options);
  expect(options.dedup === false, 'options did not load the stored dedup setting', options);
  expect(options.startup === false, 'options did not load the stored startup setting', options);

  const stored = await evalBackground(`(async () => {
    const api = globalThis.chrome || globalThis.browser;
    const sync = await api.storage.sync.get(['intervalMinutes', 'realTimeDedupEnabled', 'runOnStartup']);
    const local = await api.storage.local.get('smokeMarker');
    return { sync, local };
  })()`);
  expect(stored.sync.intervalMinutes === 17, 'sync storage did not keep the interval', stored);
  expect(stored.local.smokeMarker === 'persist-1', 'local storage did not keep the marker', stored);
}

async function smokeChrome(extensionDir, origin) {
  const binary = firstExisting(CHROME_CANDIDATES);
  if (!binary) {
    console.log('SKIPPED: Google Chrome is not installed. Set CHROME_BINARY to run the Chrome smoke test.');
    return 'skipped';
  }

  const userDataDir = mkdtempSync(join(tmpdir(), 'tab-manager-chrome-'));
  const port = await freePort();
  let session = await openChrome({ binary, userDataDir, port, extensionDir });
  let sw = null;
  const pageSessions = [];
  try {
    const worker = await waitForTarget(
      port,
      (target) => target.type === 'service_worker' && target.url.includes('/background.js')
    );
    sw = new Cdp(worker.webSocketDebuggerUrl);
    const evalBackground = (expression) => sw.evaluate(expression);
    async function evalPage(url, expression) {
      let existing = pageSessions.find((item) => item.url === url);
      if (!existing) {
        const page = await waitForTarget(port, (target) => target.type === 'page' && target.url === url);
        existing = { url, cdp: new Cdp(page.webSocketDebuggerUrl) };
        pageSessions.push(existing);
      }
      return existing.cdp.evaluate(expression);
    }

    await runScenario(evalBackground, evalPage, { backgroundKey: 'service_worker', origin });
    sw.close();
    sw = null;

    stopProcessGroup(session.child);
    await waitForExit(session.child);
    const closedAt = Date.now();
    while (Date.now() - closedAt < 10000) {
      try {
        await fetch(`http://127.0.0.1:${port}/json/version`);
        await delay(200);
      } catch {
        break;
      }
    }

    session = await openChrome({ binary, userDataDir, port, extensionDir });
    const readPersisted = async () => {
      const restarted = await waitForTarget(
        port,
        (target) => target.type === 'service_worker' && target.url.includes('/background.js'),
        8000
      );
      const client = new Cdp(restarted.webSocketDebuggerUrl);
      try {
        return await client.evaluate(`(async () => {
          const api = globalThis.chrome || globalThis.browser;
          if (!api) return { missingApi: true, href: self.location.href };
          const sync = await api.storage.sync.get(['intervalMinutes', 'realTimeDedupEnabled', 'runOnStartup']);
          const local = await api.storage.local.get('smokeMarker');
          const alarm = await api.alarms.get('tabManagerTick');
          return { sync, local, alarm: alarm || null, href: self.location.href };
        })()`);
      } finally {
        client.close();
      }
    };
    let persisted = null;
    const restartStarted = Date.now();
    while (Date.now() - restartStarted < 8000) {
      try {
        persisted = await readPersisted();
      } catch (error) {
        persisted = { error: String(error) };
      }
      if (persisted?.alarm?.name === 'tabManagerTick' && persisted.sync) break;
      await delay(200);
    }
    expect(persisted.sync.intervalMinutes === 17, 'settings did not survive a Chrome restart', persisted);
    expect(persisted.local.smokeMarker === 'persist-1', 'local storage did not survive a Chrome restart', persisted);
    expect(persisted.sync.realTimeDedupEnabled === false, 'dedup setting did not survive a Chrome restart', persisted);
    expect(persisted.alarm?.name === 'tabManagerTick', 'alarm was not restored after a Chrome restart', persisted);
    console.log('Chrome smoke: passed');
    return 'passed';
  } finally {
    sw?.close();
    for (const page of pageSessions) page.cdp.close();
    if (session?.child) {
      stopProcessGroup(session.child);
      await waitForExit(session.child);
    }
  }
}

function findConsoleActor(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);
  if (typeof value.consoleActor === 'string') return value.consoleActor;
  for (const child of Object.values(value)) {
    const found = findConsoleActor(child, seen);
    if (found) return found;
  }
  return null;
}

function rdpString(result) {
  if (typeof result === 'string') return result;
  if (result && typeof result.result?.value === 'string') return result.result.value;
  if (typeof result?.value === 'string') return result.value;
  throw new Error(`Firefox evaluation did not return a string\n${JSON.stringify(result)}`);
}

async function evaluateInFirefox(remote, consoleActor, expression) {
  async function evaluate(text) {
    const packets = [];
    const onError = (error) => {
      const message = String(error?.message || '');
      const start = message.indexOf('{');
      if (start === -1) return;
      try {
        packets.push(JSON.parse(message.slice(start)));
      } catch {
        // The client also reports unrelated protocol noise.
      }
    };
    remote.client.on('error', onError);
    try {
      const response = await remote.client.request({
        to: consoleActor,
        type: 'evaluateJSAsync',
        text,
      });
      const started = Date.now();
      while (Date.now() - started < 10000) {
        const packet = packets.find((item) => item.resultID === response.resultID);
        if (packet) {
          if (packet.hasException) throw new Error(JSON.stringify(packet));
          const value = typeof packet.result === 'string' ? packet.result : packet.result?.value;
          if (typeof value === 'string') return JSON.parse(value);
          throw new Error(`Unexpected Firefox result packet\n${JSON.stringify(packet)}`);
        }
        await delay(50);
      }
      throw new Error(`Firefox evaluation result was not delivered\n${JSON.stringify({ response, packets })}`);
    } finally {
      remote.client.off('error', onError);
    }
  }

  await evaluate(`(function () {
    globalThis.__tabManagerSmoke = { done: false, error: null, value: null };
    Promise.resolve().then(() => (${expression})).then(
      (value) => {
        globalThis.__tabManagerSmoke.value = value ?? null;
        globalThis.__tabManagerSmoke.done = true;
      },
      (error) => {
        globalThis.__tabManagerSmoke.error = String(error && error.stack || error);
        globalThis.__tabManagerSmoke.done = true;
      }
    );
    return JSON.stringify({ started: true });
  })()`);
  const started = Date.now();
  while (Date.now() - started < 20000) {
    const state = await evaluate('JSON.stringify(globalThis.__tabManagerSmoke)');
    if (state.done) {
      if (state.error) throw new Error(state.error);
      return state.value;
    }
    await delay(100);
  }
  throw new Error('Firefox evaluation timed out');
}

async function firefoxRequest(remote, request) {
  try {
    return { ok: true, response: await remote.client.request(request) };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

async function firefoxExtensionEvaluator(remote) {
  const addon = await remote.getInstalledAddon(FIREFOX_EXTENSION_ID);
  if (addon.backgroundScriptStatus !== 'RUNNING' || addon.persistentBackgroundScript !== false) {
    throw new Error(`Firefox background is not a running event page\n${JSON.stringify(addon)}`);
  }
  const watcher = await remote.client.request({ to: addon.actor, type: 'getWatcher' });
  const packets = [];
  const onError = (error) => {
    const message = String(error?.message || '');
    const start = message.indexOf('{');
    if (start === -1) return;
    try {
      packets.push(JSON.parse(message.slice(start)));
    } catch {
      // Ignore protocol noise.
    }
  };
  remote.client.on('error', onError);
  let frames;
  try {
    frames = await remote.client.request({
      to: watcher.actor,
      type: 'watchTargets',
      targetType: 'frame',
    });
    await delay(1000);
  } finally {
    remote.client.off('error', onError);
  }
  const targets = [frames?.target, ...packets.map((packet) => packet.target)].filter(Boolean);
  const extensionTarget = targets.find((target) => String(target.url || '').startsWith('moz-extension://'));
  const consoleActor = extensionTarget?.consoleActor;
  if (!consoleActor) {
    throw new Error(`Firefox did not expose the extension background\n${JSON.stringify({
      urls: targets.map((target) => target.url),
      packetTypes: packets.map((packet) => packet.type),
    })}`);
  }
  return (expression) => evaluateInFirefox(remote, consoleActor, expression);
}

async function launchFirefox(extensionDir, profileDir) {
  const runner = await webExt.cmd.run({
    sourceDir: extensionDir,
    noReload: true,
    noInput: true,
    firefox: firstExisting(FIREFOX_CANDIDATES),
    firefoxProfile: profileDir,
    profileCreateIfMissing: true,
    keepProfileChanges: true,
    pref: {},
    verbose: false,
  });
  const desktop = runner.extensionRunners.find((item) => item.getName() === 'Firefox Desktop');
  if (!desktop?.remoteFirefox) throw new Error('Firefox remote debugger did not connect');
  return { runner, remote: desktop.remoteFirefox };
}

async function smokeFirefox(extensionDir, origin) {
  const binary = firstExisting(FIREFOX_CANDIDATES);
  if (!binary) {
    console.log('SKIPPED: Firefox is not installed. Set FIREFOX_BINARY to run the Firefox smoke test.');
    return 'skipped';
  }

  const profileDir = mkdtempSync(join(tmpdir(), 'tab-manager-firefox-'));
  let session = null;
  try {
    session = await launchFirefox(extensionDir, profileDir);
    const evalBackground = await firefoxExtensionEvaluator(session.remote);

    async function evalPage(url, expression) {
      const started = Date.now();
      let lastTargets = null;
      while (Date.now() - started < 8000) {
        const listed = await session.remote.client.request('listTabs');
        lastTargets = listed;
        const tab = (listed.tabs || []).find((item) => item.url === url);
        if (!tab) {
          await delay(200);
          continue;
        }
        let consoleActor = tab.consoleActor || null;
        if (!consoleActor) {
          const target = await firefoxRequest(session.remote, { to: tab.actor, type: 'getTarget' });
          consoleActor = target.ok ? findConsoleActor(target.response) : null;
          if (!consoleActor) {
            const watcher = await firefoxRequest(session.remote, { to: tab.actor, type: 'getWatcher' });
            if (watcher.ok) {
              const frames = await firefoxRequest(session.remote, {
                to: watcher.response.actor,
                type: 'watchTargets',
                targetType: 'frame',
              });
              consoleActor = frames.ok ? frames.response?.target?.consoleActor || null : null;
            }
          }
        }
        if (consoleActor) return evaluateInFirefox(session.remote, consoleActor, expression);
        await delay(200);
      }
      throw new Error(`Extension page did not appear\n${JSON.stringify(lastTargets)}`);
    }

    await runScenario(evalBackground, evalPage, { backgroundKey: 'scripts', origin });
    await session.runner.exit();
    session = null;
    await delay(1000);

    session = await launchFirefox(extensionDir, profileDir);
    const restarted = await firefoxExtensionEvaluator(session.remote);
    const persisted = await restarted(`(async () => {
      const api = globalThis.chrome || globalThis.browser;
      const sync = await api.storage.sync.get(['intervalMinutes', 'realTimeDedupEnabled', 'runOnStartup']);
      const local = await api.storage.local.get('smokeMarker');
      const alarm = await api.alarms.get('tabManagerTick');
      return { sync, local, alarm };
    })()`);
    expect(persisted.sync.intervalMinutes === 17, 'settings did not survive a Firefox restart', persisted);
    expect(persisted.local.smokeMarker === 'persist-1', 'local storage did not survive a Firefox restart', persisted);
    expect(persisted.sync.realTimeDedupEnabled === false, 'dedup setting did not survive a Firefox restart', persisted);
    expect(persisted.alarm?.name === 'tabManagerTick', 'alarm was not restored after a Firefox restart', persisted);
    console.log('Firefox smoke: passed');
    return 'passed';
  } finally {
    if (session) {
      try {
        await session.runner.exit();
      } catch {
        // Firefox may already be closed.
      }
    }
  }
}

const chromeDir = buildExtension('chrome');
const firefoxDir = buildExtension('firefox');
const { server, origin } = await startServer();
let failed = false;
try {
  const only = process.env.SMOKE_BROWSER;
  const chromeResult = !only || only === 'chrome' ? await smokeChrome(chromeDir, origin) : 'skipped';
  const firefoxResult = !only || only === 'firefox' ? await smokeFirefox(firefoxDir, origin) : 'skipped';
  if (chromeResult === 'skipped' && firefoxResult === 'skipped') {
    console.error('Neither Chrome nor Firefox is available for a runtime smoke test.');
    failed = true;
  }
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  server.close();
}
if (failed) process.exit(1);
