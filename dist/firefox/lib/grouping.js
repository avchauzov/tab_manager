import { getHostname, isSupportedUrl } from './normalize.js';
import { addActionLog } from './log.js';
import {
  safeTabsQuery,
  safeTabsGroup,
  safeTabsUngroup,
  safeTabGroupsQuery,
  safeTabGroupsGet,
  safeTabGroupsUpdate,
  safeWindowsGetAll,
} from './safe.js';

export const STALE_GROUP_TITLE = 'Stale';
export const STALE_GROUP_COLOR = 'grey';

const DOMAIN_COLORS = ['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

export function colorForHostname(hostname) {
  let hash = 0;
  for (let i = 0; i < hostname.length; i++) {
    hash = (hash * 31 + hostname.charCodeAt(i)) >>> 0;
  }
  return DOMAIN_COLORS[hash % DOMAIN_COLORS.length];
}

export function isStaleGroup(group) {
  return group?.title === STALE_GROUP_TITLE;
}

export async function isInStaleGroup(tab) {
  if (tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) return false;
  const group = await safeTabGroupsGet(tab.groupId);
  return isStaleGroup(group);
}

async function findHostnameGroupId(windowId, hostname) {
  const groups = await safeTabGroupsQuery({ windowId });
  for (const group of groups) {
    if (group.title === hostname && !isStaleGroup(group)) {
      return group.id;
    }
  }
  return null;
}

async function createHostnameGroup(windowId, tabIds, hostname) {
  const groupId = await safeTabsGroup({
    tabIds,
    createProperties: { windowId },
  });
  if (groupId !== null) {
    await safeTabGroupsUpdate(groupId, { title: hostname, color: colorForHostname(hostname) });
  }
  return groupId;
}

async function hostnameBuckets(windowId) {
  const buckets = new Map();
  const tabs = await safeTabsQuery({ windowId });

  for (const tab of tabs) {
    if (tab.pinned) continue;
    if (!isSupportedUrl(tab.url)) continue;
    if (await isInStaleGroup(tab)) continue;

    const hostname = getHostname(tab.url);
    if (!hostname) continue;

    if (!buckets.has(hostname)) buckets.set(hostname, []);
    buckets.get(hostname).push(tab);
  }

  return buckets;
}

async function addTabsToHostnameGroup(groupId, hostnameTabs) {
  const toAdd = hostnameTabs
    .filter((tab) => tab.groupId !== groupId)
    .map((tab) => tab.id);

  if (toAdd.length === 0) return 0;
  const result = await safeTabsGroup({ groupId, tabIds: toAdd });
  return result === null ? 0 : toAdd.length;
}

async function groupHostnameTabs(windowId, hostname, hostnameTabs) {
  const groupId = await findHostnameGroupId(windowId, hostname);
  if (groupId !== null) return addTabsToHostnameGroup(groupId, hostnameTabs);

  const createdGroupId = await createHostnameGroup(windowId, [hostnameTabs[0].id], hostname);
  if (createdGroupId === null) return 0;

  let groupedCount = 1;
  const remaining = hostnameTabs.slice(1).map((t) => t.id);
  if (remaining.length > 0) {
    const result = await safeTabsGroup({ groupId: createdGroupId, tabIds: remaining });
    if (result === null) return groupedCount;
    groupedCount += remaining.length;
  }
  await addActionLog('group', `created group: ${hostname}, ${groupedCount} tabs`);
  return groupedCount;
}

export async function groupTabsByHostname(windowId, settings) {
  const minTabs = settings.minTabsPerGroup ?? 2;
  let groupedCount = 0;

  for (const [hostname, hostnameTabs] of await hostnameBuckets(windowId)) {
    if (hostnameTabs.length < minTabs) continue;
    groupedCount += await groupHostnameTabs(windowId, hostname, hostnameTabs);
  }

  return groupedCount;
}

export async function groupTabsByHostnameForAllWindows(settings) {
  const windows = await safeWindowsGetAll();
  let total = 0;
  for (const win of windows) {
    total += await groupTabsByHostname(win.id, settings);
  }
  return total;
}

export async function cleanupSingleTabHostnameGroups(windowId, settings) {
  const minTabs = settings?.minTabsPerGroup ?? 2;
  let ungroupedCount = 0;

  const processWindow = async (winId) => {
    const groups = await safeTabGroupsQuery({ windowId: winId });
    for (const group of groups) {
      if (isStaleGroup(group)) continue;

      const tabs = await safeTabsQuery({ groupId: group.id });
      if (tabs.length >= minTabs) continue;

      const tabIds = tabs.map((t) => t.id);
      if (tabIds.length > 0) {
        await safeTabsUngroup(tabIds);
        ungroupedCount++;
        await addActionLog('ungroup', `ungrouped single-tab hostname group: ${group.title}`);
      }
    }
  };

  if (windowId !== undefined) {
    await processWindow(windowId);
  } else {
    const windows = await safeWindowsGetAll();
    for (const win of windows) {
      await processWindow(win.id);
    }
  }

  return ungroupedCount;
}
