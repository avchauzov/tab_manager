import { isSupportedUrl, normalizeUrl } from './normalize.js';
import { safeStorageLocalGet, safeStorageLocalSet } from './safe.js';

export function validTimestamp(value) {
  return Number.isFinite(value) && value > 0;
}

export function accessKey(url) {
  return normalizeUrl(url) ?? url;
}

export function readAccessEntry(urlLastAccess, url) {
  const raw = urlLastAccess?.[accessKey(url)];
  if (typeof raw === 'number') return { lastSeenAt: raw };
  if (raw && typeof raw === 'object') {
    return {
      lastSeenAt: raw.lastSeenAt,
      lastObservedAt: raw.lastObservedAt,
    };
  }
  return {};
}

function compactEntry(entry) {
  const stored = {};
  if (validTimestamp(entry.lastSeenAt)) stored.lastSeenAt = entry.lastSeenAt;
  if (validTimestamp(entry.lastObservedAt)) stored.lastObservedAt = entry.lastObservedAt;
  return stored;
}

export function effectiveLastAccess(entry, tab) {
  const values = [entry?.lastSeenAt, tab?.lastAccessed, entry?.lastObservedAt].filter(validTimestamp);
  if (values.length === 0) return undefined;
  return Math.max(...values);
}

export function withLastObservedAt(urlLastAccess, url, now) {
  const next = { ...urlLastAccess };
  const entry = readAccessEntry(next, url);
  entry.lastObservedAt = now;
  next[accessKey(url)] = compactEntry(entry);
  return next;
}

export function withLastSeenAt(urlLastAccess, url, now) {
  const next = { ...urlLastAccess };
  const entry = readAccessEntry(next, url);
  entry.lastSeenAt = now;
  next[accessKey(url)] = compactEntry(entry);
  return next;
}

export function withSeededLastObservedAt(urlLastAccess, url, now) {
  const entry = readAccessEntry(urlLastAccess, url);
  if (validTimestamp(entry.lastObservedAt)) return urlLastAccess;
  const next = { ...urlLastAccess };
  entry.lastObservedAt = now;
  next[accessKey(url)] = compactEntry(entry);
  return next;
}

export async function getUrlLastAccess() {
  const data = await safeStorageLocalGet('urlLastAccess');
  return data.urlLastAccess || {};
}

export function getLastAccess(urlLastAccess, url) {
  const raw = urlLastAccess?.[accessKey(url)];
  if (typeof raw === 'number') return raw;
  if (raw && typeof raw === 'object') return raw.lastSeenAt;
  return undefined;
}

let accessWriteChain = Promise.resolve();

function enqueueAccessWrite(fn) {
  const run = accessWriteChain.then(fn, fn);
  accessWriteChain = run.then(() => {}, () => {});
  return run;
}

async function writeUrlLastAccess(url, mutate, { supportedOnly = false } = {}) {
  if (!url) return;
  if (supportedOnly && !isSupportedUrl(url)) return;
  const map = await getUrlLastAccess();
  const next = mutate(map, url, Date.now());
  if (next === map) return;
  await safeStorageLocalSet({ urlLastAccess: next });
}

export function touchLastSeenAt(url) {
  return enqueueAccessWrite(() => writeUrlLastAccess(url, withLastSeenAt));
}

export function recordLastObservedAt(url) {
  return enqueueAccessWrite(() => writeUrlLastAccess(url, withLastObservedAt, { supportedOnly: true }));
}

export function seedLastObservedAt(urls, now = Date.now()) {
  return enqueueAccessWrite(async () => {
    if (!urls?.length) return;
    let map = await getUrlLastAccess();
    let changed = false;
    for (const url of urls) {
      if (!url || !isSupportedUrl(url)) continue;
      const next = withSeededLastObservedAt(map, url, now);
      if (next !== map) {
        map = next;
        changed = true;
      }
    }
    if (changed) await safeStorageLocalSet({ urlLastAccess: map });
  });
}
