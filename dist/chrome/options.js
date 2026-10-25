import { DEFAULT_SETTINGS } from './lib/settings.js';

const fields = {
  realTimeDedupEnabled: document.getElementById('realTimeDedupEnabled'),
  debounceMs: document.getElementById('debounceMs'),
  autoGroupByDomain: document.getElementById('autoGroupByDomain'),
  minTabsPerGroup: document.getElementById('minTabsPerGroup'),
  sortInsideGroups: document.getElementById('sortInsideGroups'),
  staleThresholdDays: document.getElementById('staleThresholdDays'),
  autoCheckStale: document.getElementById('autoCheckStale'),
  intervalMinutes: document.getElementById('intervalMinutes'),
  runOnStartup: document.getElementById('runOnStartup'),
};

const INT_FIELDS = {
  debounceMs: { min: 100 },
  minTabsPerGroup: { min: 2 },
  staleThresholdDays: { min: 0 },
  intervalMinutes: { min: 1 },
};

const saveBtn = document.getElementById('save');
const savedEl = document.getElementById('saved');
const logsEl = document.getElementById('logs');

function readInt(key) {
  const field = fields[key];
  const fallback = DEFAULT_SETTINGS[key];
  const parsed = Number.parseInt(field.value, 10);
  if (!Number.isFinite(parsed)) return fallback;

  const min = INT_FIELDS[key]?.min;
  if (min !== undefined && parsed < min) return min;
  return parsed;
}

function loadSettings() {
  chrome.storage.sync.get(DEFAULT_SETTINGS, (data) => {
    for (const [key, field] of Object.entries(fields)) {
      if (field.type === 'checkbox') {
        field.checked = data[key];
      } else {
        field.value = data[key];
      }
    }
  });
}

function appendText(parent, className, text) {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  parent.appendChild(span);
}

function loadLogs() {
  chrome.storage.local.get('actionLogs', (data) => {
    const logs = data.actionLogs || [];
    logsEl.innerHTML = '';
    if (logs.length === 0) {
      const li = document.createElement('li');
      li.textContent = 'No actions logged yet.';
      logsEl.appendChild(li);
      return;
    }
    for (const entry of logs) {
      const li = document.createElement('li');
      const time = new Date(entry.timestamp).toLocaleString();
      appendText(li, 'log-time', time);
      appendText(li, 'log-type', `[${entry.type}]`);
      li.append(entry.message);
      logsEl.appendChild(li);
    }
  });
}

saveBtn.addEventListener('click', () => {
  const settings = {
    realTimeDedupEnabled: fields.realTimeDedupEnabled.checked,
    debounceMs: readInt('debounceMs'),
    autoGroupByDomain: fields.autoGroupByDomain.checked,
    minTabsPerGroup: readInt('minTabsPerGroup'),
    sortInsideGroups: fields.sortInsideGroups.checked,
    staleThresholdDays: readInt('staleThresholdDays'),
    autoCheckStale: fields.autoCheckStale.checked,
    intervalMinutes: readInt('intervalMinutes'),
    runOnStartup: fields.runOnStartup.checked,
  };

  chrome.storage.sync.set(settings, () => {
    chrome.runtime.sendMessage({ action: 'settingsUpdated' });
    savedEl.style.visibility = 'visible';
    setTimeout(() => {
      savedEl.style.visibility = 'hidden';
    }, 2000);
  });
});

loadSettings();
loadLogs();
