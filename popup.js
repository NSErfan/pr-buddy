const currentSection = document.getElementById('current');
const currentTitle = document.getElementById('current-title');
const currentMeta = document.getElementById('current-meta');
const outlineEl = document.getElementById('outline');
const othersHeading = document.getElementById('others-heading');
const othersList = document.getElementById('others-list');
const statusEl = document.getElementById('status');

const CHEVRON =
  '<svg class="chevron" viewBox="0 0 16 16" width="12" height="12"><path fill="currentColor" d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z"/></svg>';
const JUMP =
  '<svg class="jump" viewBox="0 0 16 16" width="12" height="12"><path fill="currentColor" d="M3.75 2h3.5a.75.75 0 0 1 0 1.5h-3.5a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-3.5a.75.75 0 0 1 1.5 0v3.5A1.75 1.75 0 0 1 12.25 14h-8.5A1.75 1.75 0 0 1 2 12.25v-8.5C2 2.784 2.784 2 3.75 2Zm6.854-1h4.146a.25.25 0 0 1 .25.25v4.146a.25.25 0 0 1-.427.177L13.03 4.03 9.28 7.78a.751.751 0 0 1-1.06-1.06l3.75-3.75-1.543-1.543A.25.25 0 0 1 10.604 1Z"/></svg>';

function send(message) {
  return chrome.runtime.sendMessage(message);
}

function parsePrUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname !== 'github.com') return null;
    const m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/);
    if (!m) return null;
    return {
      owner: m[1],
      repo: m[2],
      number: Number(m[3]),
      key: `${m[1]}/${m[2]}#${m[3]}`.toLowerCase(),
    };
  } catch {
    return null;
  }
}

function relTime(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function chip(cls, text) {
  return el('span', `chip ${cls}`, text);
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
  if (d.reviewComments > 0) parts.push(`+${d.reviewComments} review`);
  if (d.commits > 0) parts.push(`+${d.commits} commit${d.commits > 1 ? 's' : ''}`);
  if (!parts.length && entry.latest.updatedAt !== entry.seen.updatedAt) parts.push('updated');
  return parts.length ? parts.join(', ') : null;
}

function stateChip(entry) {
  if (!entry?.state) return null;
  if (entry.state === 'merged') return chip('merged', 'merged');
  if (entry.state === 'closed') return chip('closed', 'closed');
  if (entry.draft) return chip('draft', 'draft');
  return null;
}

// ---- current PR outline ----------------------------------------------------

async function gotoComment(tabId, baseUrl, anchorId) {
  try {
    await chrome.tabs.update(tabId, { active: true });
    await chrome.tabs.sendMessage(tabId, {
      type: 'goto-anchor',
      url: `${baseUrl}#${anchorId}`,
    });
  } finally {
    window.close();
  }
}

function commentRow(tab, outline, c, small) {
  const row = el('button', 'row');
  const avatar = el('img', 'avatar');
  avatar.src = c.avatar || '';
  avatar.alt = '';
  const col = el('div', 'col');
  const who = el('div', 'who');
  who.append(el('span', 'author', c.author || '—'));
  who.append(el('span', 'when', relTime(c.time)));
  col.append(who);
  if (c.snippet) col.append(el('div', 'snippet', c.snippet));
  row.append(avatar, col);
  if (small) row.classList.add('small');
  row.addEventListener('click', () => void gotoComment(tab.id, outline.url, c.id));
  return row;
}

function reviewRow(tab, outline, item) {
  const row = commentRow(tab, outline, item);
  const who = row.querySelector('.who');
  const label =
    item.state === 'approved' ? chip('approved', 'approved')
    : item.state === 'changes' ? chip('changes', 'requested changes')
    : chip('count', 'reviewed');
  who.insertBefore(label, who.querySelector('.when'));
  return row;
}

function threadGroup(tab, outline, item) {
  const wrap = el('div', 'thread');
  const head = el('button', 'thread-head');
  head.innerHTML = CHEVRON;
  const path = el('span', 'path', item.path || 'review thread');
  // bdi keeps rtl ellipsis from reordering the path characters
  const bdi = document.createElement('bdi');
  bdi.textContent = item.path || 'review thread';
  path.textContent = '';
  path.append(bdi);
  head.append(path);
  head.append(chip('count', String(item.count)));
  if (item.outdated) head.append(chip('outdated', 'outdated'));
  if (item.resolved) head.append(chip('resolved', 'resolved'));
  head.insertAdjacentHTML('beforeend', JUMP);

  const body = el('div', 'thread-body');
  for (const c of item.comments) body.append(commentRow(tab, outline, c, true));

  head.addEventListener('click', (e) => {
    const anchor = item.comments[0]?.id;
    if (e.target.closest('.jump') && anchor) {
      void gotoComment(tab.id, outline.url, anchor);
      return;
    }
    if (!item.comments.length && anchor === undefined) return;
    wrap.classList.toggle('expanded');
  });

  wrap.append(head, body);
  return wrap;
}

function renderOutline(tab, pr, prState, outline) {
  currentSection.hidden = false;
  currentTitle.textContent = outline.title;
  currentMeta.textContent = '';
  currentMeta.append(el('span', '', `${pr.owner}/${pr.repo} #${pr.number}`));
  const entry = prState[pr.key];
  const state = stateChip(entry);
  if (state) currentMeta.append(state);
  const updates = describeUpdates(entry);
  if (updates) currentMeta.append(chip('updates', updates));

  const threads = outline.items.filter((i) => i.type === 'thread');
  const comments = outline.items.filter((i) => i.type !== 'thread');
  currentMeta.append(
    el('span', '', `${comments.length} comments · ${threads.length} threads`),
  );

  outlineEl.textContent = '';
  if (outline.indexing) {
    outlineEl.append(el('div', 'notice', 'Still indexing this page — reopen in a moment for the full list.'));
  }
  for (const item of outline.items) {
    if (item.type === 'thread') outlineEl.append(threadGroup(tab, outline, item));
    else if (item.type === 'review') outlineEl.append(reviewRow(tab, outline, item));
    else outlineEl.append(commentRow(tab, outline, item));
  }
  if (!outline.items.length && !outline.indexing) {
    outlineEl.append(el('div', 'empty', 'No conversation on this pull request yet.'));
  }
}

function renderReloadNotice(tab) {
  currentSection.hidden = false;
  currentTitle.textContent = tab.title?.replace(/ · Pull Request.*$/, '') || 'This pull request';
  const notice = el('div', 'notice', 'This tab was loaded before the extension — reload it to index the conversation.');
  const btn = el('button', '', 'Reload tab');
  btn.addEventListener('click', async () => {
    await chrome.tabs.reload(tab.id);
    window.close();
  });
  notice.append(btn);
  outlineEl.textContent = '';
  outlineEl.append(notice);
}

// ---- other PR tabs ---------------------------------------------------------

function renderOthers(prState, openTabs, currentKey) {
  const byKey = new Map();
  for (const t of openTabs) {
    if (t.key !== currentKey && !byKey.has(t.key)) byKey.set(t.key, t);
  }
  othersHeading.textContent = currentKey ? 'Other open pull requests' : 'Open pull requests';
  othersList.textContent = '';

  if (!byKey.size) {
    othersList.append(el('p', 'empty', currentKey ? 'No other PR tabs open.' : 'No pull request tabs open.'));
    return;
  }

  const rows = [...byKey.values()].sort((a, b) => {
    const ua = describeUpdates(prState[a.key]) ? 0 : 1;
    const ub = describeUpdates(prState[b.key]) ? 0 : 1;
    return ua - ub || a.key.localeCompare(b.key);
  });

  for (const row of rows) {
    const entry = prState[row.key];
    const btn = el('button', 'row');
    const col = el('div', 'col');
    const who = el('div', 'who');
    const title = el('span', 'author');
    title.textContent =
      entry?.title || row.tabTitle?.replace(/ · Pull Request.*$/, '') || row.key;
    who.append(title);
    col.append(who);

    const meta = el('div', 'snippet');
    const bits = [
      row.pr.kind === 'commit'
        ? `${row.pr.owner}/${row.pr.repo} @ ${row.pr.sha.slice(0, 7)}`
        : `${row.pr.owner}/${row.pr.repo} #${row.pr.number}`,
    ];
    meta.textContent = bits.join(' ');
    const state = stateChip(entry);
    if (state) meta.append(' ', state);
    const updates = describeUpdates(entry);
    if (updates) meta.append(' ', chip('updates', updates));
    col.append(meta);

    btn.append(col);
    btn.addEventListener('click', async () => {
      await send({ type: 'focus-pr', key: row.key, url: entry?.url || row.url });
      window.close();
    });
    othersList.append(btn);
  }
}

// ---- load ------------------------------------------------------------------

async function load() {
  const [state, [activeTab]] = await Promise.all([
    send({ type: 'get-state' }),
    chrome.tabs.query({ active: true, currentWindow: true }),
  ]);
  const { prState, openTabs } = state;

  let currentKey = null;
  const pr = activeTab ? parsePrUrl(activeTab.url || '') : null;
  if (pr) {
    currentKey = pr.key;
    try {
      const outline = await chrome.tabs.sendMessage(activeTab.id, { type: 'get-outline' });
      if (outline?.ok) renderOutline(activeTab, pr, prState, outline);
      else currentKey = null;
    } catch {
      renderReloadNotice(activeTab);
    }
  }

  renderOthers(prState, openTabs, currentKey);
}

document.getElementById('refresh').addEventListener('click', async (e) => {
  e.currentTarget.querySelector('svg').classList.add('spin');
  statusEl.textContent = 'Checking GitHub…';
  await send({ type: 'poll-now' });
  statusEl.textContent = '';
  document.querySelector('#refresh svg')?.classList.remove('spin');
  await load();
});

document.getElementById('open-options').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

void load();
