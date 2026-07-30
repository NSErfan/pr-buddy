const currentSection = document.getElementById('current');
const currentTitle = document.getElementById('current-title');
const currentMeta = document.getElementById('current-meta');
const filterBar = document.getElementById('filter-bar');
const outlineEl = document.getElementById('outline');
const othersHeading = document.getElementById('others-heading');
const othersList = document.getElementById('others-list');
const statusEl = document.getElementById('status');

const CHEVRON =
  '<svg class="chevron" viewBox="0 0 16 16" width="12" height="12"><path fill="currentColor" d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z"/></svg>';
const JUMP =
  '<svg viewBox="0 0 16 16" width="12" height="12"><path fill="currentColor" d="M3.75 2h3.5a.75.75 0 0 1 0 1.5h-3.5a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-3.5a.75.75 0 0 1 1.5 0v3.5A1.75 1.75 0 0 1 12.25 14h-8.5A1.75 1.75 0 0 1 2 12.25v-8.5C2 2.784 2.784 2 3.75 2Zm6.854-1h4.146a.25.25 0 0 1 .25.25v4.146a.25.25 0 0 1-.427.177L13.03 4.03 9.28 7.78a.751.751 0 0 1-1.06-1.06l3.75-3.75-1.543-1.543A.25.25 0 0 1 10.604 1Z"/></svg>';

const FILTERS = [
  { key: 'all', label: 'All', match: () => true },
  { key: 'open', label: 'Open', match: (i) => i.type === 'thread' && !i.resolved },
  { key: 'resolved', label: 'Resolved', match: (i) => i.type === 'thread' && i.resolved },
  { key: 'outdated', label: 'Outdated', match: (i) => i.type === 'thread' && i.outdated },
  { key: 'comments', label: 'Comments', match: (i) => i.type !== 'thread' },
];

let activeFilter = localStorage.getItem('focus-pr-filter') || 'all';

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

// Deterministic letter-on-circle fallback so a missing or unloadable avatar
// (Copilot and other bots) never renders as a broken image.
function initialAvatar(name) {
  const n = (name || '?').replace(/\[bot\]$/i, '').trim() || '?';
  const letter = n[0].toUpperCase();
  let h = 0;
  for (const ch of n) h = (h * 31 + ch.charCodeAt(0)) % 360;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48">` +
    `<circle cx="24" cy="24" r="24" fill="hsl(${h},42%,52%)"/>` +
    `<text x="24" y="31" font-family="-apple-system,sans-serif" font-size="22" font-weight="600" fill="#fff" text-anchor="middle">${letter}</text></svg>`;
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}

function avatarImg(cls, author, src) {
  const img = el('img', cls);
  img.alt = '';
  img.src = src || initialAvatar(author);
  if (src) img.addEventListener('error', () => { img.src = initialAvatar(author); }, { once: true });
  return img;
}

function commentRow(tab, outline, c) {
  const row = el('button', 'row');
  const avatar = avatarImg('avatar', c.author, c.avatar);
  const col = el('div', 'col');
  const who = el('div', 'who');
  who.append(el('span', 'author', c.author || '—'));
  who.append(el('span', 'when', relTime(c.time)));
  col.append(who);
  if (c.snippet) col.append(el('div', 'snippet', c.snippet));
  row.append(avatar, col);
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

function splitPath(path) {
  const i = path.lastIndexOf('/');
  if (i === -1) return { dir: '', base: path };
  return { dir: path.slice(0, i), base: path.slice(i + 1) };
}

function threadGroup(tab, outline, item) {
  const wrap = el('div', 'thread');
  const head = el('button', 'thread-head');
  head.title = item.path || '';

  const line1 = el('div', 'line1');
  line1.innerHTML = CHEVRON;
  const file = el('span', 'file');
  const { base } = splitPath(item.path || 'review thread');
  file.append(el('span', 'basename', base));
  line1.append(file);
  line1.append(chip('count', String(item.count)));
  if (item.outdated) line1.append(chip('outdated', 'outdated'));
  line1.append(item.resolved ? chip('resolved', 'resolved') : chip('open-thread', 'open'));
  const jump = el('span', 'jump');
  jump.innerHTML = JUMP;
  jump.title = 'Go to thread on the page';
  line1.append(jump);
  head.append(line1);

  const first = item.comments[0];
  if (first) {
    const line2 = el('div', 'line2');
    const mini = avatarImg('mini-avatar', first.author, first.avatar);
    const preview = el('span', 'preview');
    const author = el('b');
    author.textContent = first.author || '—';
    preview.append(author, ` ${first.snippet || ''}`);
    line2.append(mini, preview);
    head.append(line2);
  }

  const body = el('div', 'thread-body');
  const inner = el('div', 'thread-body-inner');
  for (const c of item.comments) inner.append(commentRow(tab, outline, c));
  body.append(inner);

  head.addEventListener('click', (e) => {
    if (e.target.closest('.jump') && item.anchor) {
      void gotoComment(tab.id, outline.url, item.anchor);
      return;
    }
    if (item.comments.length) {
      wrap.classList.toggle('expanded');
    } else if (item.anchor) {
      // Content not indexed yet: jump straight to the thread on the page.
      void gotoComment(tab.id, outline.url, item.anchor);
    }
  });

  wrap.append(head, body);
  return wrap;
}

function renderFilterBar(items) {
  filterBar.hidden = false;
  filterBar.textContent = '';
  const counts = Object.fromEntries(
    FILTERS.map((f) => [f.key, items.filter(f.match).length]),
  );
  if (!counts[activeFilter]) activeFilter = 'all';
  for (const f of FILTERS) {
    if (f.key !== 'all' && !counts[f.key]) continue;
    const btn = el('button', 'filter-chip');
    if (f.key === activeFilter) btn.classList.add('active');
    btn.append(el('span', '', f.label), el('span', 'n', String(counts[f.key])));
    btn.addEventListener('click', () => {
      activeFilter = f.key;
      localStorage.setItem('focus-pr-filter', f.key);
      renderFilterBar(items);
      renderItems();
    });
    filterBar.append(btn);
  }
}

let renderItems = () => {};

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

  renderFilterBar(outline.items);

  renderItems = () => {
    const filter = FILTERS.find((f) => f.key === activeFilter) || FILTERS[0];
    const items = outline.items.filter(filter.match);
    outlineEl.textContent = '';
    if (outline.indexing) {
      outlineEl.append(
        el('div', 'notice', 'Still indexing this page — reopen in a moment for the full list.'),
      );
    }
    for (const item of items) {
      if (item.type === 'thread') outlineEl.append(threadGroup(tab, outline, item));
      else if (item.type === 'review') outlineEl.append(reviewRow(tab, outline, item));
      else outlineEl.append(commentRow(tab, outline, item));
    }
    if (!items.length && !outline.indexing) {
      outlineEl.append(
        el('div', 'empty', activeFilter === 'all'
          ? 'No conversation on this pull request yet.'
          : `Nothing matches “${filter.label}”.`),
      );
    }
  };
  renderItems();
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

// ---- PR-list dropdown ------------------------------------------------------

const prMenuBtn = document.getElementById('pr-menu-btn');
const prDropdown = document.getElementById('pr-dropdown');
const prCount = document.getElementById('pr-count');
const noCurrent = document.getElementById('no-current');

function setDropdownOpen(open) {
  prDropdown.hidden = !open;
  prMenuBtn.classList.toggle('open', open);
  // The popup window sizes to the document; an absolutely-positioned
  // dropdown doesn't contribute height, so reserve room while it's open.
  document.body.style.minHeight = open ? '440px' : '';
}

prMenuBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  setDropdownOpen(prDropdown.hidden);
});

document.addEventListener('click', (e) => {
  if (!prDropdown.hidden && !e.target.closest('#pr-dropdown, #pr-menu-btn')) {
    setDropdownOpen(false);
  }
});

function renderOthers(prState, openTabs, currentKey) {
  const byKey = new Map();
  for (const t of openTabs) {
    if (t.key !== currentKey && !byKey.has(t.key)) byKey.set(t.key, t);
  }
  othersHeading.textContent = currentKey ? 'Other open pull requests' : 'Open pull requests';
  othersList.textContent = '';
  prCount.hidden = !byKey.size;
  prCount.textContent = String(byKey.size);

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
    meta.textContent =
      row.pr.kind === 'commit'
        ? `${row.pr.owner}/${row.pr.repo} @ ${row.pr.sha.slice(0, 7)}`
        : `${row.pr.owner}/${row.pr.repo} #${row.pr.number}`;
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

  if (!currentKey && currentSection.hidden) {
    noCurrent.hidden = false;
    noCurrent.textContent = 'This tab isn’t a pull request — pick one from the list.';
    setDropdownOpen(true);
  }
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
