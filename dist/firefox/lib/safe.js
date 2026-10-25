import { addActionLog } from './log.js';

async function chromeOr(fallback, callback) {
  try {
    return await callback();
  } catch {
    return fallback;
  }
}

export const safeTabsGet = (tabId) => chromeOr(null, () => chrome.tabs.get(tabId));

export async function safeTabsQuery(queryInfo) {
  return chromeOr([], () => chrome.tabs.query(queryInfo));
}

export async function safeTabsRemove(tabIds) {
  try {
    await chrome.tabs.remove(tabIds);
    return true;
  } catch {
    return false;
  }
}

export async function safeTabsDiscard(tabId) {
  try {
    return await chrome.tabs.discard(tabId);
  } catch (err) {
    await addActionLog('discard', `failed to discard tab ${tabId}: ${err?.message ?? 'unknown'}`);
    return null;
  }
}

export const safeTabsMove = (tabId, moveProperties) =>
  chromeOr(null, () => chrome.tabs.move(tabId, moveProperties));

export const safeTabsGroup = (options) =>
  chromeOr(null, () => chrome.tabs.group(options));

export const safeTabsUngroup = (tabIds) =>
  chromeOr(null, () => chrome.tabs.ungroup(tabIds));

export const safeTabGroupsGet = (groupId) =>
  chromeOr(null, () => chrome.tabGroups.get(groupId));

export const safeTabGroupsQuery = (queryInfo) =>
  chromeOr([], () => chrome.tabGroups.query(queryInfo));

export const safeTabGroupsUpdate = (groupId, updateProperties) =>
  chromeOr(null, () => chrome.tabGroups.update(groupId, updateProperties));

export const safeTabGroupsMove = (groupId, moveProperties) =>
  chromeOr(null, () => chrome.tabGroups.move(groupId, moveProperties));

export const safeStorageLocalGet = (keys) =>
  chromeOr({}, () => chrome.storage.local.get(keys));

export async function safeStorageLocalSet(items) {
  try {
    await chrome.storage.local.set(items);
    return true;
  } catch {
    return false;
  }
}

export async function safeAlarmsCreate(name, alarmInfo) {
  try {
    await chrome.alarms.create(name, alarmInfo);
    return true;
  } catch {
    return false;
  }
}

export async function safeAlarmsClear(name) {
  try {
    await chrome.alarms.clear(name);
    return true;
  } catch {
    return false;
  }
}

export const safeAlarmsGet = (name) => chromeOr(null, () => chrome.alarms.get(name));

export const safeWindowsGetAll = () => chromeOr([], () => chrome.windows.getAll());

export const safeWindowsGetCurrent = () =>
  chromeOr(null, () => chrome.windows.getCurrent());
