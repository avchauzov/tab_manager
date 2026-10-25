import assert from 'node:assert/strict';
import test from 'node:test';

import {
    accessKey,
    effectiveLastAccess,
    getLastAccess,
    readAccessEntry,
    withLastObservedAt,
} from '../lib/access.js';
import { pickRealtimeWinner, pickWinner } from '../lib/dedup.js';
import { colorForHostname, isStaleGroup } from '../lib/grouping.js';
import { formatSummary } from '../lib/log.js';
import { formatLogUrl, getHostname, isSupportedUrl, normalizeUrl } from '../lib/normalize.js';
import { isStaleCandidate, shouldDiscardTab } from '../lib/stale.js';

const baseUrl = 'https://shop.com/item/42';

test('accessKey maps utm variants to the same storage key', () => {
  const withEmail = `${baseUrl}?utm_source=email`;
  const withAds = `${baseUrl}?utm_source=ads`;
  assert.equal(accessKey(withEmail), accessKey(withAds));
  assert.equal(accessKey(withEmail), 'https://shop.com/item/42');
});

test('getLastAccess reads by normalized key regardless of tab url variant', () => {
  const urlLastAccess = { [accessKey(baseUrl)]: 1000 };
  assert.equal(getLastAccess(urlLastAccess, `${baseUrl}?utm_source=email`), 1000);
  assert.equal(getLastAccess(urlLastAccess, `${baseUrl}?fbclid=xyz`), 1000);
  assert.equal(getLastAccess({}, `${baseUrl}?utm_source=email`), undefined);
});

test('normalizeUrl strips tracking noise and preserves meaningful query params', () => {
  assert.equal(
    normalizeUrl('HTTPS://Example.com/path/?utm_source=x&b=2&a=1#section'),
    'https://example.com/path?a=1&b=2'
  );
  assert.equal(
    normalizeUrl('https://example.com/page?utm_source=chatgpt.com'),
    'https://example.com/page'
  );
  assert.equal(
    normalizeUrl('https://example.com/page?id=9&utm_source=chatgpt.com'),
    'https://example.com/page?id=9'
  );
  assert.equal(
    normalizeUrl('https://example.com/page?utm_medium=email&fbclid=1&gclid=2&dclid=3&msclkid=4&yclid=5&mc_cid=6&mc_eid=7&ref_src=twsrc'),
    'https://example.com/page'
  );
  assert.equal(
    normalizeUrl('https://example.com/page?ref=keep&source=keep&from=keep'),
    'https://example.com/page?from=keep&ref=keep&source=keep'
  );
  assert.equal(
    normalizeUrl('https://example.com/page?b=2&a=1'),
    normalizeUrl('https://example.com/page?a=1&b=2')
  );
});

test('normalizeUrl rejects unsupported or malformed urls', () => {
  assert.equal(isSupportedUrl('chrome://extensions'), false);
  assert.equal(normalizeUrl('chrome://extensions'), null);
  assert.equal(isSupportedUrl('moz-extension://ext-id/options.html'), false);
  assert.equal(normalizeUrl('moz-extension://ext-id/options.html'), null);
  assert.equal(normalizeUrl('not a url'), null);
});

test('getHostname lowercases supported hostnames', () => {
  assert.equal(getHostname('https://EXAMPLE.com/Page'), 'example.com');
});

test('formatLogUrl omits query and hash from action log messages', () => {
  assert.equal(formatLogUrl('https://x.com/p?utm_token=secret#hash'), 'x.com/p');
  assert.equal(formatLogUrl('chrome://extensions'), '(unsupported)');
  assert.equal(formatLogUrl('moz-extension://ext-id/options.html'), '(unsupported)');
});

test('formatSummary reports empty and pluralized changes', () => {
  assert.equal(
    formatSummary({ closed: 0, grouped: 0, stale: 0, discarded: 0, ungrouped: 0 }),
    'No changes'
  );
  assert.equal(
    formatSummary({ closed: 1, grouped: 2, stale: 1, discarded: 0, ungrouped: 2 }),
    'Closed 1 duplicate, grouped 2 tabs, moved 1 tab to Stale, ungrouped 2 single-tab groups'
  );
  assert.equal(
    formatSummary({ closed: 0, grouped: 0, stale: 2, discarded: 2, ungrouped: 0 }),
    'moved 2 tabs to Stale, discarded 2'
  );
  assert.equal(
    formatSummary({ closed: 0, grouped: 0, stale: 0, discarded: 3, ungrouped: 0 }),
    'discarded 3'
  );
});

test('pickWinner priority: active > lastAccessed > focused > max id', () => {
  const url = 'https://example.com/page';
  const tabs = [
    { id: 1, url, windowId: 10, lastAccessed: 100 },
    { id: 2, url, windowId: 10, lastAccessed: 300 },
    { id: 3, url, windowId: 20, lastAccessed: 900 },
  ];

  assert.equal(pickWinner(tabs, { activeTabId: 1, focusedWindowId: 10 }).id, 1);
  assert.equal(pickWinner(tabs, { focusedWindowId: 10 }).id, 3);
  assert.equal(
    pickWinner(
      [
        { id: 11, url, windowId: 10, lastAccessed: 500 },
        { id: 12, url, windowId: 20, lastAccessed: 500 },
      ],
      { focusedWindowId: 10 }
    ).id,
    11
  );
  assert.equal(
    pickWinner(
      [
        { id: 4, url, windowId: 10, lastAccessed: 0 },
        { id: 5, url, windowId: 20, lastAccessed: Number.NaN },
      ],
      { focusedWindowId: 10 }
    ).id,
    4
  );
  assert.equal(
    pickWinner(
      [
        { id: 6, url, windowId: 99 },
        { id: 7, url, windowId: 99 },
      ],
      { focusedWindowId: 1 }
    ).id,
    7
  );
});

test('pickRealtimeWinner prefers duplicate in last focused window', () => {
  const url = 'https://example.com/page';
  const urlLastAccess = { [accessKey(url)]: 100 };
  const tabs = [
    { id: 1, url, windowId: 10, active: false },
    { id: 2, url, windowId: 20, active: false },
  ];

  assert.equal(
    pickRealtimeWinner(tabs, {
      lastFocusedWindowId: 10,
      activeTabId: 2,
      urlLastAccess,
      focusedWindowId: 20,
    }).id,
    1
  );
});

test('pickRealtimeWinner falls back when no duplicate is in last focused window', () => {
  const url = 'https://example.com/page';
  const urlLastAccess = { [accessKey(url)]: 100 };
  const tabs = [
    { id: 1, url, windowId: 30, active: false },
    { id: 2, url, windowId: 40, active: true },
  ];

  assert.equal(
    pickRealtimeWinner(tabs, {
      lastFocusedWindowId: 10,
      activeTabId: 2,
      urlLastAccess,
      focusedWindowId: 40,
    }).id,
    2
  );
});

test('shouldDiscardTab skips active, audible, discarded, and pinned tabs', () => {
  assert.equal(shouldDiscardTab({ active: true, audible: false, discarded: false, pinned: false }), false);
  assert.equal(shouldDiscardTab({ active: false, audible: true, discarded: false, pinned: false }), false);
  assert.equal(shouldDiscardTab({ active: false, audible: false, discarded: true, pinned: false }), false);
  assert.equal(shouldDiscardTab({ active: false, audible: false, discarded: false, pinned: true }), false);
  assert.equal(shouldDiscardTab({ active: false, audible: false, discarded: false, pinned: false }), true);
});

test('colorForHostname is deterministic and uses domain palette', () => {
  const palette = ['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
  const first = colorForHostname('example.com');
  const second = colorForHostname('example.com');
  assert.equal(first, second);
  assert.equal(palette.includes(first), true);
  assert.equal(palette.includes(colorForHostname('other.example.com')), true);
});

test('isStaleGroup matches only the Stale title', () => {
  assert.equal(isStaleGroup({ title: 'Stale' }), true);
  assert.equal(isStaleGroup({ title: 'example.com' }), false);
  assert.equal(isStaleGroup(null), false);
});

test('effectiveLastAccess is the newest valid timestamp', () => {
  const now = 1_700_000_000_000;
  const monthAgo = now - 30 * 24 * 60 * 60 * 1000;
  const entry = { lastSeenAt: now - 50, lastObservedAt: now - 10 };
  assert.equal(effectiveLastAccess(entry, { lastAccessed: now - 20 }), now - 10);
  assert.equal(effectiveLastAccess({ lastObservedAt: monthAgo }, { lastAccessed: monthAgo - 5 }), monthAgo);
  assert.equal(effectiveLastAccess({}, { lastAccessed: 0 }), undefined);
  assert.equal(effectiveLastAccess({}, { lastAccessed: Number.NaN }), undefined);
});

test('lastObservedAt is overwritten when the same URL is seen again', () => {
  const now = 1_700_000_000_000;
  const monthAgo = now - 30 * 24 * 60 * 60 * 1000;
  const key = accessKey(baseUrl);
  const again = withLastObservedAt({ [key]: { lastObservedAt: monthAgo, lastSeenAt: monthAgo } }, baseUrl, now);
  assert.equal(again[key].lastObservedAt, now);
  assert.equal(again[key].lastSeenAt, monthAgo);
  assert.equal(
    isStaleCandidate({ url: baseUrl, lastAccessed: 0 }, again, now, 3 * 24 * 60 * 60 * 1000),
    false
  );
});

test('isStaleCandidate uses lastObservedAt as a URL-age bound', () => {
  const now = 1_700_000_000_000;
  const day = 24 * 60 * 60 * 1000;
  const thresholdMs = 3 * day;
  const tab = { url: `${baseUrl}?utm_source=email`, lastAccessed: now - 5 * day };
  const key = accessKey(baseUrl);

  assert.equal(isStaleCandidate(tab, {}, now, thresholdMs), false);
  assert.equal(isStaleCandidate(tab, { [key]: now - 10 * day }, now, thresholdMs), false);
  assert.equal(readAccessEntry({ [key]: now - 10 * day }, baseUrl).lastSeenAt, now - 10 * day);

  const fresh = { [key]: { lastObservedAt: now } };
  assert.equal(isStaleCandidate(tab, fresh, now, thresholdMs), false);
  assert.equal(effectiveLastAccess(readAccessEntry(fresh, baseUrl), tab), now);

  const aged = { [key]: { lastObservedAt: now - 5 * day } };
  assert.equal(effectiveLastAccess(readAccessEntry(aged, baseUrl), { lastAccessed: now - 10 * day }), now - 5 * day);
  assert.equal(isStaleCandidate({ url: baseUrl, lastAccessed: now - 10 * day }, aged, now, thresholdMs), true);

  const seenRecently = { [key]: { lastObservedAt: now - day, lastSeenAt: now - day } };
  assert.equal(isStaleCandidate({ url: baseUrl, lastAccessed: 0 }, seenRecently, now, thresholdMs), false);
});
