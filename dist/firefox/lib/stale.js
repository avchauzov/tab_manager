import { isSupportedUrl, formatLogUrl } from './normalize.js';
import {
  getUrlLastAccess,
  readAccessEntry,
  seedLastObservedAt,
  validTimestamp,
  effectiveLastAccess,
} from './access.js';
import { getSettings } from './settings.js';
import { STALE_GROUP_TITLE, STALE_GROUP_COLOR, isInStaleGroup } from './grouping.js';
import { addActionLog } from './log.js';
import {
  safeTabsQuery,
  safeTabsGroup,
  safeTabsDiscard,
  safeTabGroupsQuery,
  safeTabGroupsUpdate,
  safeWindowsGetAll,
} from './safe.js';

const EMPTY_STALE_RESULT = { moved: 0, discarded: 0 };

export function shouldDiscardTab(tab) {
  return !tab.active && !tab.audible && !tab.discarded && !tab.pinned;
}

async function findStaleGroupId(windowId) {
  const groups = await safeTabGroupsQuery({ windowId, title: STALE_GROUP_TITLE });
  return groups.length > 0 ? groups[0].id : null;
}

async function logStaleTabs(tabIds, tabsById) {
  for (const tabId of tabIds) {
    const tab = tabsById.get(tabId);
    if (tab) await addActionLog('stale', `moved tab to Stale: ${formatLogUrl(tab.url)}`);
  }
}

async function discardStaleTabs(staleTabIds, tabsById) {
  let discarded = 0;
  for (const tabId of staleTabIds) {
    const tab = tabsById.get(tabId);
    if (!tab || !shouldDiscardTab(tab)) continue;
    const result = await safeTabsDiscard(tabId);
    if (result) discarded++;
  }
  return discarded;
}

async function groupTabIdsIntoStale(windowId, staleGroupId, tabIds) {
  if (tabIds.length === 0) return { groupId: staleGroupId, moved: 0 };

  if (staleGroupId === null) {
    const firstTab = tabIds[0];
    staleGroupId = await safeTabsGroup({
      tabIds: [firstTab],
      createProperties: { windowId },
    });
    if (staleGroupId === null) return { groupId: null, moved: 0 };

    await safeTabGroupsUpdate(staleGroupId, {
      title: STALE_GROUP_TITLE,
      color: STALE_GROUP_COLOR,
    });

    const rest = tabIds.slice(1);
    if (rest.length === 0) return { groupId: staleGroupId, moved: 1 };

    const result = await safeTabsGroup({ groupId: staleGroupId, tabIds: rest });
    if (result === null) return { groupId: staleGroupId, moved: 1 };
    return { groupId: staleGroupId, moved: tabIds.length };
  }

  const result = await safeTabsGroup({ groupId: staleGroupId, tabIds });
  if (result === null) return { groupId: staleGroupId, moved: 0 };
  return { groupId: staleGroupId, moved: tabIds.length };
}

export async function moveTabsToStale(windowId, staleGroupId, staleTabIds, tabs) {
  const tabsById = new Map(tabs.map((tab) => [tab.id, tab]));
  const { moved } = await groupTabIdsIntoStale(windowId, staleGroupId, staleTabIds);
  if (moved === 0) return EMPTY_STALE_RESULT;

  const movedTabIds = staleTabIds.slice(0, moved);
  await logStaleTabs(movedTabIds, tabsById);

  const discarded = await discardStaleTabs(movedTabIds, tabsById);
  return { moved, discarded };
}

export function isStaleCandidate(tab, urlLastAccess, now, thresholdMs) {
  const entry = readAccessEntry(urlLastAccess, tab.url);
  if (!validTimestamp(entry.lastObservedAt)) return false;
  const effective = effectiveLastAccess(entry, tab);
  if (effective === undefined) return false;
  return now - effective > thresholdMs;
}

export async function checkStaleTabs(windowId) {
  const urlLastAccess = await getUrlLastAccess();
  const settings = await getSettings();
  const thresholdMs = settings.staleThresholdDays * 24 * 60 * 60 * 1000;
  const now = Date.now();

  const staleGroupId = await findStaleGroupId(windowId);
  const tabs = await safeTabsQuery({ windowId });
  const staleTabIds = [];
  const urlsToSeed = [];

  for (const tab of tabs) {
    if (tab.pinned) continue;
    if (tab.active) continue;
    if (await isInStaleGroup(tab)) continue;
    if (!isSupportedUrl(tab.url)) continue;

    const entry = readAccessEntry(urlLastAccess, tab.url);
    if (!validTimestamp(entry.lastObservedAt)) {
      urlsToSeed.push(tab.url);
      continue;
    }

    if (isStaleCandidate(tab, urlLastAccess, now, thresholdMs)) {
      staleTabIds.push(tab.id);
    }
  }

  if (urlsToSeed.length > 0) await seedLastObservedAt(urlsToSeed, now);

  if (staleTabIds.length === 0) return EMPTY_STALE_RESULT;

  return moveTabsToStale(windowId, staleGroupId, staleTabIds, tabs);
}

export async function checkStaleTabsForAllWindows() {
  const windows = await safeWindowsGetAll();
  const total = { moved: 0, discarded: 0 };
  for (const win of windows) {
    const result = await checkStaleTabs(win.id);
    total.moved += result.moved;
    total.discarded += result.discarded;
  }
  return total;
}
