const listEl = document.getElementById('list');
const statusEl = document.getElementById('status');

function send(message) {
  return chrome.runtime.sendMessage(message);
}

function describeUpdates(entry) {
  if (!entry?.seen || !entry?.latest) return null;
  const parts = [];
  const d = {
    comments: entry.latest.comments - entry.seen.comments,
    reviewComments: entry.latest.reviewComments - entry.seen.reviewComments,
    commits: entry.latest.commits - entry.seen.commits,
  };
  if (d.comments > 0) parts.push(`+${d.comments} comment${d.comments > 1 ? 's' : ''}`);
  if (d.reviewComments > 0) parts.push(`+${d.reviewComments} review comment${d.reviewComments > 1 ? 's' : ''}`);
  if (d.commits > 0) parts.push(`+${d.commits} commit${d.commits > 1 ? 's' : ''}`);
  if (!parts.length && entry.latest.updatedAt !== entry.seen.updatedAt) parts.push('updated');
  return parts.length ? parts.join(', ') : null;
}

function stateChip(entry) {
  if (!entry?.state) return null;
  if (entry.state === 'merged') return { label: 'merged', cls: 'state-merged' };
  if (entry.state === 'closed') return { label: 'closed', cls: 'state-closed' };
  if (entry.draft) return { label: 'draft', cls: 'state-draft' };
  return null;
}

function render({ prState, openTabs }) {
  listEl.textContent = '';

  // One row per PR; tabs give us presence, prState gives us API data.
  const byKey = new Map();
  for (const t of openTabs) {
    if (!byKey.has(t.key)) byKey.set(t.key, t);
  }

  if (!byKey.size) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'No pull request tabs open.';
    listEl.append(p);
    return;
  }

  const rows = [...byKey.values()].sort((a, b) => {
    const ua = describeUpdates(prState[a.key]) ? 0 : 1;
    const ub = describeUpdates(prState[b.key]) ? 0 : 1;
    return ua - ub || a.key.localeCompare(b.key);
  });

  for (const row of rows) {
    const entry = prState[row.key];
    const btn = document.createElement('button');
    btn.className = 'pr';

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent =
      entry?.title || row.tabTitle?.replace(/ · Pull Request.*$/, '') || row.key;

    const meta = document.createElement('span');
    meta.className = 'meta';

    const ref = document.createElement('span');
    ref.textContent =
      row.pr.kind === 'commit'
        ? `${row.pr.owner}/${row.pr.repo} @ ${row.pr.sha.slice(0, 7)}`
        : `${row.pr.owner}/${row.pr.repo} #${row.pr.number}`;
    meta.append(ref);

    const state = stateChip(entry);
    if (state) {
      const chip = document.createElement('span');
      chip.className = `chip ${state.cls}`;
      chip.textContent = state.label;
      meta.append(chip);
    }

    const updates = describeUpdates(entry);
    if (updates) {
      const chip = document.createElement('span');
      chip.className = 'chip updates';
      chip.textContent = updates;
      meta.append(chip);
    }

    btn.append(title, meta);
    btn.addEventListener('click', async () => {
      await send({ type: 'focus-pr', key: row.key });
      window.close();
    });
    listEl.append(btn);
  }
}

async function load() {
  const state = await send({ type: 'get-state' });
  render(state);
}

document.getElementById('refresh').addEventListener('click', async () => {
  statusEl.textContent = 'Checking…';
  await send({ type: 'poll-now' });
  statusEl.textContent = '';
  await load();
});

document.getElementById('open-options').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

void load();
