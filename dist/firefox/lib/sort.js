import { normalizeUrl } from './normalize.js';
import { isStaleGroup } from './grouping.js';
import {
  safeTabsQuery,
  safeTabsMove,
  safeTabsGet,
  safeTabGroupsQuery,
  safeTabGroupsMove,
} from './safe.js';

function compareTabs(a, b) {
  const normA = normalizeUrl(a.url) || a.url || '';
  const normB = normalizeUrl(b.url) || b.url || '';
  const cmp = normA.localeCompare(normB);
  if (cmp !== 0) return cmp;
  const rawCmp = (a.url || '').localeCompare(b.url || '');
  if (rawCmp !== 0) return rawCmp;
  return a.id - b.id;
}

export async function sortTabsInsideHostnameGroups(windowId, settings) {
  if (!settings.sortInsideGroups) return;

  const groups = await safeTabGroupsQuery({ windowId });
  for (const group of groups) {
    if (isStaleGroup(group)) continue;

    const tabs = await safeTabsQuery({ groupId: group.id });
    if (tabs.length < 2) continue;

    const sorted = [...tabs].sort(compareTabs);
    const baseIndex = Math.min(...tabs.map((t) => t.index));

    for (let i = 0; i < sorted.length; i++) {
      const targetIndex = baseIndex + i;
      const tab = await safeTabsGet(sorted[i].id);
      if (tab && tab.index !== targetIndex) {
        await safeTabsMove(tab.id, { index: targetIndex });
      }
    }
  }
}

function ungroupedId() {
  return chrome.tabGroups.TAB_GROUP_ID_NONE;
}

function groupSpan(tabs, groupId) {
  const members = tabs.filter((tab) => tab.groupId === groupId);
  if (members.length === 0) return null;
  const start = Math.min(...members.map((tab) => tab.index));
  const end = Math.max(...members.map((tab) => tab.index)) + 1;
  return { start, end };
}

function hostnameTailIsStable(tabs, groups) {
  const stale = groups.find((group) => isStaleGroup(group));
  const hostname = groups.filter((group) => !isStaleGroup(group));
  if (hostname.length === 0) return true;

  const spans = [];
  for (const group of hostname) {
    const span = groupSpan(tabs, group.id);
    if (!span) return false;
    spans.push({ group, span });
  }
  spans.sort((a, b) => a.span.start - b.span.start);

  const alpha = [...spans].sort(
    (a, b) => (a.group.title || '').localeCompare(b.group.title || '') || a.group.id - b.group.id
  );
  if (spans.some((entry, index) => entry.group.id !== alpha[index].group.id)) return false;

  for (let i = 0; i < spans.length - 1; i++) {
    if (spans[i].span.end !== spans[i + 1].span.start) return false;
  }

  const blockStart = spans[0].span.start;
  const blockEnd = spans[spans.length - 1].span.end;
  const staleSpan = stale ? groupSpan(tabs, stale.id) : null;
  const after = staleSpan ? staleSpan.start : tabs.length;
  if (blockEnd !== after) return false;

  for (const tab of tabs) {
    if (tab.index < blockStart || tab.index >= blockEnd) continue;
    if (tab.groupId === ungroupedId()) return false;
    if (stale && tab.groupId === stale.id) return false;
  }
  return true;
}

async function parkStaleAtEnd(windowId) {
  const tabs = await safeTabsQuery({ windowId });
  const groups = await safeTabGroupsQuery({ windowId });
  const stale = groups.find((group) => isStaleGroup(group));
  if (!stale) return;
  const span = groupSpan(tabs, stale.id);
  if (!span || span.end === tabs.length) return;
  await safeTabGroupsMove(stale.id, { index: -1 });
}

async function moveHostnameGroupsBeforeStale(windowId) {
  const tabs = await safeTabsQuery({ windowId });
  const groups = await safeTabGroupsQuery({ windowId });
  if (hostnameTailIsStable(tabs, groups)) return;

  const stale = groups.find((group) => isStaleGroup(group)) ?? null;
  const hostname = groups
    .filter((group) => !isStaleGroup(group))
    .sort((a, b) => (a.title || '').localeCompare(b.title || '') || a.id - b.id);

  for (const group of hostname) {
    const members = await safeTabsQuery({ groupId: group.id });
    if (members.length === 0) continue;

    if (!stale) {
      const all = await safeTabsQuery({ windowId });
      const end = Math.max(...members.map((tab) => tab.index));
      if (end !== all.length - 1) await safeTabGroupsMove(group.id, { index: -1 });
      continue;
    }

    const staleMembers = await safeTabsQuery({ groupId: stale.id });
    if (staleMembers.length === 0) {
      await safeTabGroupsMove(group.id, { index: -1 });
      continue;
    }

    const staleStart = Math.min(...staleMembers.map((tab) => tab.index));
    const groupEnd = Math.max(...members.map((tab) => tab.index)) + 1;
    // Stale's first tab is a legal group boundary. Passing that index places
    // this group immediately before Stale; an index inside another group errors.
    if (groupEnd !== staleStart) await safeTabGroupsMove(group.id, { index: staleStart });
  }
}

async function sortUngroupedPrefix(windowId) {
  const tabs = await safeTabsQuery({ windowId });
  const pinnedCount = tabs.filter((tab) => tab.pinned).length;
  const ungrouped = tabs.filter((tab) => !tab.pinned && tab.groupId === ungroupedId());
  const sorted = [...ungrouped].sort(compareTabs);

  for (let i = 0; i < sorted.length; i++) {
    const targetIndex = pinnedCount + i;
    const tab = await safeTabsGet(sorted[i].id);
    if (tab && tab.index !== targetIndex) {
      await safeTabsMove(tab.id, { index: targetIndex });
    }
  }
}

export async function layoutWindow(windowId, settings = {}) {
  if (settings.sortInsideGroups) {
    await sortTabsInsideHostnameGroups(windowId, settings);
  }
  await parkStaleAtEnd(windowId);
  await moveHostnameGroupsBeforeStale(windowId);
  await sortUngroupedPrefix(windowId);
}
