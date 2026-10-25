import { recordLastObservedAt, touchLastSeenAt } from './lib/access.js';
import {
    closeDuplicatesAcrossAllWindows,
    closeDuplicatesInWindow,
    pickRealtimeWinner,
} from './lib/dedup.js';
import {
    cleanupSingleTabHostnameGroups,
    groupTabsByHostname,
    isInStaleGroup,
} from './lib/grouping.js';
import { isSupportedUrl } from './lib/normalize.js';
import {
    safeAlarmsClear,
    safeAlarmsCreate,
    safeAlarmsGet,
    safeTabsGet,
    safeTabsUngroup,
    safeWindowsGetAll,
} from './lib/safe.js';
import { getSettings } from './lib/settings.js';
import { layoutWindow } from './lib/sort.js';
import { checkStaleTabs } from './lib/stale.js';

const ALARM_NAME = 'tabManagerTick';
const debounceTimers = new Map();
let lastFocusedWindowId = null;
let opChain = Promise.resolve();

function enqueueOp(fn) {
  const run = opChain.then(fn, fn);
  opChain = run.then(() => {}, () => {});
  return run;
}

async function getLastFocusedWindowId() {
  if (lastFocusedWindowId == null) {
    try {
      const win = await chrome.windows.getLastFocused();
      lastFocusedWindowId = win?.id ?? null;
    } catch {
      lastFocusedWindowId = null;
    }
  }
  return lastFocusedWindowId;
}

async function setupAlarm(forceRecreate = false) {
  if (!forceRecreate) {
    const existing = await safeAlarmsGet(ALARM_NAME);
    if (existing) return;
  }

  const { intervalMinutes } = await getSettings();
  await safeAlarmsClear(ALARM_NAME);
  await safeAlarmsCreate(ALARM_NAME, { periodInMinutes: intervalMinutes });
}

async function organizeWindow(windowId) {
  const settings = await getSettings();
  if (settings.autoGroupByDomain) {
    await groupTabsByHostname(windowId, settings);
  }
  if (settings.autoCheckStale) {
    await checkStaleTabs(windowId);
  }
  await cleanupSingleTabHostnameGroups(windowId, settings);
  await layoutWindow(windowId, settings);
}

async function runWindowPipeline(windowId) {
  await closeDuplicatesInWindow(windowId);
  await organizeWindow(windowId);
}

async function runAlarmPipeline() {
  const focusedId = await getLastFocusedWindowId();
  const windows = await safeWindowsGetAll();

  for (const win of windows) {
    if (focusedId != null && win.id === focusedId) continue;
    await runWindowPipeline(win.id);
  }
}

async function handleMessage(msg) {
  switch (msg.action) {
    case 'settingsUpdated':
      await setupAlarm(true);
      return { ok: true };
    default:
      return { ok: false };
  }
}

async function runStartupPipeline() {
  const settings = await getSettings();
  if (!settings.runOnStartup) return;

  await closeDuplicatesAcrossAllWindows({ mode: 'alarm' });

  const windows = await safeWindowsGetAll();
  for (const win of windows) {
    await organizeWindow(win.id);
  }
}

async function initExtension() {
  await getLastFocusedWindowId();
  await setupAlarm();
  await runStartupPipeline();
}

async function handleRealTimeDedup(tabId) {
  const settings = await getSettings();
  if (!settings.realTimeDedupEnabled) return;

  const tab = await safeTabsGet(tabId);
  if (!tab || !isSupportedUrl(tab.url)) return;

  const lastFocusedId = await getLastFocusedWindowId();
  await closeDuplicatesAcrossAllWindows({
    mode: 'realtime',
    winnerPicker: pickRealtimeWinner,
    lastFocusedWindowId: lastFocusedId,
  });

  await cleanupSingleTabHostnameGroups(undefined, settings);
}

function scheduleRealTimeDedup(tabId) {
  getSettings()
    .then((settings) => {
      if (!settings.realTimeDedupEnabled) return;

      clearTimeout(debounceTimers.get(tabId));
      debounceTimers.set(
        tabId,
        setTimeout(() => {
          debounceTimers.delete(tabId);
          enqueueOp(() => handleRealTimeDedup(tabId)).catch(() => {});
        }, settings.debounceMs)
      );
    })
    .catch(() => {});
}

async function handleActivated({ tabId }) {
  const tab = await safeTabsGet(tabId);
  if (!tab) return;

  const wasStale = await isInStaleGroup(tab);
  if (tab.url) await touchLastSeenAt(tab.url);
  if (!wasStale) return;

  await safeTabsUngroup([tabId]);
  await layoutWindow(tab.windowId, await getSettings());
}

async function handleUpdated(tabId, changeInfo, tab) {
  const nextUrl = tab?.url || changeInfo.url;
  if (changeInfo.url && nextUrl) {
    await recordLastObservedAt(nextUrl);
  }
  if (changeInfo.url || changeInfo.status === 'complete') {
    scheduleRealTimeDedup(tabId);
  }
}

// Listeners are registered synchronously while the background entry evaluates.
// Chrome service workers and Firefox event pages only wake for those listeners
// after suspension, and in-memory state is rebuilt from storage or the browser.
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) {
    lastFocusedWindowId = windowId;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  enqueueOp(() => initExtension()).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  enqueueOp(() => initExtension()).catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  enqueueOp(() => runAlarmPipeline()).catch(() => {});
});

chrome.action.onClicked.addListener((tab) => {
  enqueueOp(() => runWindowPipeline(tab.windowId)).catch(() => {});
});

chrome.tabs.onActivated.addListener((info) => {
  enqueueOp(() => handleActivated(info)).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  enqueueOp(() => handleUpdated(tabId, changeInfo, tab)).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  enqueueOp(() => handleMessage(msg))
    .then((result) => sendResponse(result))
    .catch(() => sendResponse({ ok: false, summary: 'Error' }));
  return true;
});
