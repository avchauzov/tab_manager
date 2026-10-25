import { normalizeUrl, isSupportedUrl, formatLogUrl } from './normalize.js';
import { validTimestamp } from './access.js';
import { addActionLog } from './log.js';
import {
  safeTabsQuery,
  safeTabsRemove,
  safeWindowsGetAll,
  safeWindowsGetCurrent,
} from './safe.js';

function pickByWindowAndId(tabs, focusedWindowId) {
  const inFocused =
    focusedWindowId == null ? [] : tabs.filter((tab) => tab.windowId === focusedWindowId);
  const pool = inFocused.length > 0 ? inFocused : tabs;
  return pool.reduce((a, b) => (a.id > b.id ? a : b));
}

export function pickWinner(tabs, { focusedWindowId, activeTabId } = {}) {
  if (activeTabId) {
    const active = tabs.find((tab) => tab.id === activeTabId);
    if (active) return active;
  }

  let bestAccess = -1;
  let contenders = [];
  for (const tab of tabs) {
    if (!validTimestamp(tab.lastAccessed)) continue;
    if (tab.lastAccessed > bestAccess) {
      bestAccess = tab.lastAccessed;
      contenders = [tab];
    } else if (tab.lastAccessed === bestAccess) {
      contenders.push(tab);
    }
  }
  if (contenders.length === 1) return contenders[0];
  if (contenders.length > 1) return pickByWindowAndId(contenders, focusedWindowId);
  return pickByWindowAndId(tabs, focusedWindowId);
}

export function pickRealtimeWinner(tabs, { lastFocusedWindowId, activeTabId, focusedWindowId }) {
  const inLastFocused =
    lastFocusedWindowId != null ? tabs.filter((t) => t.windowId === lastFocusedWindowId) : [];
  const pool = inLastFocused.length > 0 ? inLastFocused : tabs;
  return pickWinner(pool, {
    activeTabId,
    focusedWindowId: inLastFocused.length > 0 ? lastFocusedWindowId : focusedWindowId,
  });
}

function buildDedupBuckets(tabs) {
  const byNormalized = new Map();

  for (const tab of tabs) {
    if (tab.pinned) continue;
    if (!isSupportedUrl(tab.url)) continue;
    const key = normalizeUrl(tab.url);
    if (!key) continue;
    if (!byNormalized.has(key)) byNormalized.set(key, []);
    byNormalized.get(key).push(tab);
  }

  return byNormalized;
}

async function closeDuplicateLosers(tabs, winner, windows, windowFilter) {
  let closedCount = 0;

  for (const tab of tabs) {
    if (tab.id === winner.id) continue;
    if (windowFilter && tab.windowId !== windowFilter) continue;

    const win = windows.find((w) => w.id === tab.windowId);
    const winLabel = win ? `Window ${win.id}` : 'unknown window';
    const removed = await safeTabsRemove(tab.id);
    if (removed) {
      closedCount++;
      await addActionLog('dedup', `closed duplicate: ${formatLogUrl(tab.url)} from ${winLabel}`);
    }
  }

  return closedCount;
}

export async function closeDuplicatesInWindow(windowId) {
  const windowTabs = await safeTabsQuery({ windowId });
  const activeTabId = windowTabs.find((t) => t.active)?.id ?? null;

  const byNormalized = buildDedupBuckets(windowTabs);
  const windows = await safeWindowsGetAll();
  let closedCount = 0;

  for (const [, tabs] of byNormalized) {
    if (tabs.length < 2) continue;

    const winner = pickWinner(tabs, {
      focusedWindowId: windowId,
      activeTabId,
    });

    closedCount += await closeDuplicateLosers(tabs, winner, windows, windowId);
  }

  return { closedCount };
}

export async function closeDuplicatesAcrossAllWindows({
  mode = 'manual',
  winnerPicker = pickWinner,
  lastFocusedWindowId = null,
} = {}) {
  const allTabs = await safeTabsQuery({});
  const focusedWindow = await safeWindowsGetCurrent();
  const focusedWindowId = focusedWindow?.id ?? null;
  const activeTabId = focusedWindow?.focused
    ? allTabs.find((t) => t.active && t.windowId === focusedWindowId)?.id ?? null
    : allTabs.find((t) => t.active)?.id ?? null;

  const byNormalized = buildDedupBuckets(allTabs);
  const windows = await safeWindowsGetAll();
  let closedCount = 0;

  for (const [, tabs] of byNormalized) {
    if (tabs.length < 2) continue;

    const winner = winnerPicker(tabs, {
      mode,
      focusedWindowId,
      activeTabId,
      lastFocusedWindowId,
    });

    closedCount += await closeDuplicateLosers(tabs, winner, windows);
  }

  return { closedCount };
}
