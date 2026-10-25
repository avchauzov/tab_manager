import { safeStorageLocalGet, safeStorageLocalSet } from './safe.js';

const MAX_LOGS = 50;

export async function addActionLog(type, message) {
  const data = await safeStorageLocalGet('actionLogs');
  const logs = data.actionLogs || [];
  logs.unshift({ timestamp: Date.now(), type, message });
  if (logs.length > MAX_LOGS) {
    logs.length = MAX_LOGS;
  }
  await safeStorageLocalSet({ actionLogs: logs });
}

export function formatSummary(summary) {
  const parts = [];
  if (summary.closed > 0) parts.push(`Closed ${summary.closed} duplicate${summary.closed === 1 ? '' : 's'}`);
  if (summary.grouped > 0) parts.push(`grouped ${summary.grouped} tab${summary.grouped === 1 ? '' : 's'}`);
  if (summary.stale > 0 || summary.discarded > 0) {
    const staleParts = [];
    if (summary.stale > 0) {
      staleParts.push(`moved ${summary.stale} tab${summary.stale === 1 ? '' : 's'} to Stale`);
    }
    if (summary.discarded > 0) {
      staleParts.push(`discarded ${summary.discarded}`);
    }
    parts.push(staleParts.join(', '));
  }
  if (summary.ungrouped > 0) parts.push(`ungrouped ${summary.ungrouped} single-tab group${summary.ungrouped === 1 ? '' : 's'}`);
  if (parts.length === 0) return 'No changes';
  return parts.join(', ');
}
