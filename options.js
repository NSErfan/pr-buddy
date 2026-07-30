const DEFAULTS = { dedupe: true, autoExpand: true, pollMinutes: 5, token: '' };

const dedupeEl = document.getElementById('dedupe');
const autoExpandEl = document.getElementById('autoExpand');
const pollEl = document.getElementById('pollMinutes');
const tokenEl = document.getElementById('token');
const statusEl = document.getElementById('status');

async function load() {
  const { settings } = await chrome.storage.local.get('settings');
  const s = { ...DEFAULTS, ...settings };
  dedupeEl.checked = s.dedupe;
  autoExpandEl.checked = s.autoExpand;
  pollEl.value = s.pollMinutes;
  tokenEl.value = s.token;
}

document.getElementById('save').addEventListener('click', async () => {
  const settings = {
    dedupe: dedupeEl.checked,
    autoExpand: autoExpandEl.checked,
    pollMinutes: Math.min(60, Math.max(1, Number(pollEl.value) || DEFAULTS.pollMinutes)),
    token: tokenEl.value.trim(),
  };
  await chrome.storage.local.set({ settings });
  await chrome.runtime.sendMessage({ type: 'settings-changed' });
  statusEl.textContent = 'Saved';
  setTimeout(() => (statusEl.textContent = ''), 2000);
});

void load();
