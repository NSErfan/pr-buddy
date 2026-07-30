const prHead = document.getElementById('pr-head');
const currentTitle = document.getElementById('current-title');
const currentCrumb = document.getElementById('current-crumb');
const filterBar = document.getElementById('filter-bar');
const listMeta = document.getElementById('list-meta');
const visibleLabel = document.getElementById('visible-label');
const sortToggle = document.getElementById('sort-toggle');
const outlineEl = document.getElementById('outline');
const othersList = document.getElementById('others-list');
const statusEl = document.getElementById('status');
const resolvedSummary = document.getElementById('resolved-summary');
const newPill = document.getElementById('new-pill');

// Rebuild the pill's content wholesale each time: it can never end up as a
// bare dot with a missing label, and it hides whenever there is no label.
function setNewPill(updates) {
  const label = updates === null ? '' : updates > 0 ? `${updates} new` : 'updated';
  if (!label) {
    newPill.hidden = true;
    return;
  }
  const dot = document.createElement('span');
  dot.className = 'new-dot';
  newPill.replaceChildren(dot, document.createTextNode(label));
  newPill.title =
    updates > 0
      ? `${updates} comments/commits since you last viewed this PR — click to sync`
      : 'The PR changed since you last viewed it (edit, push, or label) — click to sync';
  newPill.hidden = false;
}
const noCurrent = document.getElementById('no-current');
const contentEl = document.getElementById('content');

const FILTERS = [
  { key: 'all', label: 'All', match: () => true },
  { key: 'open', label: 'Needs reply', match: (i) => i.type === 'thread' && !i.resolved },
  { key: 'resolved', label: 'Resolved', match: (i) => i.type === 'thread' && i.resolved },
  { key: 'outdated', label: 'Outdated', match: (i) => i.type === 'thread' && i.outdated },
  { key: 'comments', label: 'Comments', match: (i) => i.type !== 'thread' },
];

let activeFilter = localStorage.getItem('focus-pr-filter') || 'all';
let sortMode = localStorage.getItem('focus-pr-sort') || 'timeline';

// ---- per-PR view state -----------------------------------------------------
// The popup reopens exactly where it was left: expanded cards, scroll
// position, and keyboard selection survive closing the popup (e.g. after
// jumping to a comment on the page).

const VIEW_KEY = 'focus-pr-view';
let viewPrKey = null;
let viewState = { expanded: [], scroll: 0, sel: '', people: [], query: '' };

function loadViewState(prKey) {
  viewPrKey = prKey;
  try {
    const all = JSON.parse(localStorage.getItem(VIEW_KEY) || '{}');
    viewState = { expanded: [], scroll: 0, sel: '', people: [], query: '', ...(all[prKey] || {}) };
  } catch {
    viewState = { expanded: [], scroll: 0, sel: '', people: [], query: '' };
  }
}

function saveViewState(patch) {
  if (!viewPrKey) return;
  Object.assign(viewState, patch);
  try {
    const all = JSON.parse(localStorage.getItem(VIEW_KEY) || '{}');
    all[viewPrKey] = { ...viewState, t: Date.now() };
    const keys = Object.keys(all);
    if (keys.length > 30) {
      keys.sort((a, b) => (all[a].t || 0) - (all[b].t || 0));
      for (const k of keys.slice(0, keys.length - 30)) delete all[k];
    }
    localStorage.setItem(VIEW_KEY, JSON.stringify(all));
  } catch {
    // Storage unavailable: state just won't persist.
  }
}

function itemKey(item) {
  return item.anchor || item.id || item.path || '';
}

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

function lastActivity(item) {
  if (item.type === 'thread') {
    let max = 0;
    for (const c of item.comments) {
      const t = Date.parse(c.time || '') || 0;
      if (t > max) max = t;
    }
    return max;
  }
  return Date.parse(item.time || '') || 0;
}

function describeUpdates(entry) {
  if (!entry?.seen || !entry?.latest) return null;
  const delta = (a, b) => Math.max(0, (a || 0) - (b || 0));
  const d =
    delta(entry.latest.comments, entry.seen.comments) +
    delta(entry.latest.reviewComments, entry.seen.reviewComments) +
    delta(entry.latest.commits, entry.seen.commits);
  if (d > 0) return d;
  return entry.latest.updatedAt !== entry.seen.updatedAt ? 0 : null; // 0 = "updated"
}

// ---- avatars ---------------------------------------------------------------

const AVATAR_PALETTE = [
  'oklch(0.6 0.14 275)', 'oklch(0.6 0.13 200)', 'oklch(0.6 0.14 25)',
  'oklch(0.58 0.12 150)', 'oklch(0.62 0.13 90)', 'oklch(0.6 0.14 330)',
];

function initials(name) {
  const parts = (name || '?').replace(/\[bot\]$/i, '').replace(/[-_]/g, ' ').split(' ').filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function hashName(s) {
  let h = 0;
  for (let i = 0; i < (s || '').length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

// A face: real avatar image when available, deterministic initials otherwise
// (and when the image fails to load) — no broken images, ever.
function face(author, src) {
  const f = el('span', 'face', src ? undefined : initials(author));
  f.style.background = AVATAR_PALETTE[hashName(author) % AVATAR_PALETTE.length];
  if (src) {
    const img = el('img');
    img.alt = '';
    img.src = src;
    img.addEventListener('error', () => {
      img.remove();
      f.textContent = initials(author);
    }, { once: true });
    f.append(img);
  }
  return f;
}

function isBot(author) {
  return /\[bot\]$/i.test(author || '') || /^copilot$/i.test(author || '');
}

// ---- search ----------------------------------------------------------------
// Every whitespace-separated term must appear somewhere in the item (file
// name, path, comment text, or an author's name) — so "steven cancel" finds
// threads where Steven talked about cancellation.

const searchBar = document.getElementById('search-bar');
const searchBox = document.getElementById('search-box');
const searchInput = document.getElementById('search-input');
const searchClear = document.getElementById('search-clear');
const searchHint = document.getElementById('search-hint');
const resultBar = document.getElementById('result-bar');
const resultLabel = document.getElementById('result-label');
const resultDetail = document.getElementById('result-detail');

let query = '';

function queryTerms() {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

function haystacks(item) {
  if (item.type === 'thread') {
    return [
      item.path || '',
      ...item.comments.map((c) => `${c.author || ''} ${c.snippet || ''}`),
    ];
  }
  return [`${item.author || ''} ${item.snippet || ''}`];
}

// null = no query, false = no match, else details for rendering.
function matchQuery(item) {
  const terms = queryTerms();
  if (!terms.length) return null;
  const fields = haystacks(item).map((s) => s.toLowerCase());
  if (!terms.every((t) => fields.some((f) => f.includes(t)))) return false;
  const comments = item.type === 'thread' ? item.comments : [item];
  const hit = comments.find((c) =>
    terms.some((t) => `${c.author || ''} ${c.snippet || ''}`.toLowerCase().includes(t)),
  );
  return { terms, hit, count: comments.filter((c) =>
    terms.some((t) => `${c.author || ''} ${c.snippet || ''}`.toLowerCase().includes(t)),
  ).length };
}

// A window of text around the earliest matching term, with ellipses.
function snippetAround(text, terms, before = 40, after = 110) {
  const lower = (text || '').toLowerCase();
  let at = -1;
  let term = '';
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i !== -1 && (at === -1 || i < at)) {
      at = i;
      term = t;
    }
  }
  if (at === -1) return null;
  const start = Math.max(0, at - before);
  const end = Math.min(text.length, at + term.length + after);
  return {
    pre: (start ? '…' : '') + text.slice(start, at),
    mark: text.slice(at, at + term.length),
    post: text.slice(at + term.length, end) + (end < text.length ? '…' : ''),
  };
}

// Text with every term wrapped in <mark>, as a safe DOM fragment.
function highlight(text, terms) {
  const frag = document.createDocumentFragment();
  if (!terms.length) {
    frag.append(text || '');
    return frag;
  }
  const lower = (text || '').toLowerCase();
  let i = 0;
  while (i < text.length) {
    let at = -1;
    let term = '';
    for (const t of terms) {
      const j = lower.indexOf(t, i);
      if (j !== -1 && (at === -1 || j < at)) {
        at = j;
        term = t;
      }
    }
    if (at === -1) break;
    if (at > i) frag.append(text.slice(i, at));
    const m = document.createElement('mark');
    m.textContent = text.slice(at, at + term.length);
    frag.append(m);
    i = at + term.length;
  }
  if (i < text.length) frag.append(text.slice(i));
  return frag;
}

function syncSearchChrome() {
  const active = !!query.trim();
  searchBox.classList.toggle('active', active);
  searchClear.hidden = !active;
  searchHint.hidden = active;
  resultBar.hidden = !active;
}

function renderResultBar(scoped, outline) {
  if (!query.trim()) return;
  const threads = scoped.filter((i) => i.type === 'thread').length;
  const others = scoped.length - threads;
  const bits = [];
  if (threads) bits.push(`${threads} thread${threads === 1 ? '' : 's'}`);
  if (others) bits.push(`${others} comment${others === 1 ? '' : 's'}`);
  resultLabel.textContent = scoped.length ? bits.join(' · ') : 'No matches';
  resultDetail.textContent = scoped.length
    ? `matching “${query.trim()}” in this pull request`
    : 'Try a file name, a person, or a phrase from a comment';
}

// ---- people filter ---------------------------------------------------------

const whoBar = document.getElementById('who-bar');
const whoStack = document.getElementById('who-stack');
const whoSummary = document.getElementById('who-summary');
const whoClear = document.getElementById('who-clear');

let selectedPeople = new Set();

function itemAuthors(item) {
  if (item.type === 'thread') return item.comments.map((c) => c.author).filter(Boolean);
  return item.author ? [item.author] : [];
}

function matchesPeople(item) {
  if (!selectedPeople.size) return true;
  return itemAuthors(item).some((a) => selectedPeople.has(a));
}

// Everyone who spoke in this PR, most-involved first, with an avatar and the
// number of threads/comments they appear in.
function collectPeople(items) {
  const byName = new Map();
  for (const item of items) {
    for (const author of new Set(itemAuthors(item))) {
      let p = byName.get(author);
      if (!p) {
        p = { name: author, count: 0, avatar: '' };
        byName.set(author, p);
      }
      p.count++;
      if (!p.avatar) {
        const src =
          item.type === 'thread'
            ? item.comments.find((c) => c.author === author && c.avatar)?.avatar
            : item.avatar;
        if (src) p.avatar = src;
      }
    }
  }
  return [...byName.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function shortName(name) {
  return (name || '').replace(/\[bot\]$/i, '').replace(/-BandLab$/i, '');
}

function renderWho(people, onChange) {
  whoBar.hidden = people.length < 2; // nothing to filter by with a single voice
  if (whoBar.hidden) return;

  whoStack.textContent = '';
  for (const p of people) {
    const on = selectedPeople.has(p.name);
    const btn = el('button', 'who-face');
    btn.style.background = AVATAR_PALETTE[hashName(p.name) % AVATAR_PALETTE.length];
    btn.title = `${p.name} · ${p.count} thread${p.count === 1 ? '' : 's'}`;
    btn.setAttribute('aria-pressed', String(on));
    if (on) btn.classList.add('on');
    else if (selectedPeople.size) btn.classList.add('dim');
    if (p.avatar) {
      const img = el('img');
      img.alt = '';
      img.src = p.avatar;
      img.addEventListener('error', () => {
        img.remove();
        btn.textContent = initials(p.name);
      }, { once: true });
      btn.append(img);
    } else {
      btn.textContent = initials(p.name);
    }
    btn.addEventListener('click', () => {
      if (selectedPeople.has(p.name)) selectedPeople.delete(p.name);
      else selectedPeople.add(p.name);
      renderWho(people, onChange);
      onChange();
    });
    whoStack.append(btn);
  }

  const chosen = people.filter((p) => selectedPeople.has(p.name)).map((p) => shortName(p.name));
  whoSummary.textContent = chosen.length
    ? `Threads involving ${chosen.join(', ')}`
    : 'Tap a face to see only their threads';
  whoClear.hidden = !chosen.length;
  whoClear.onclick = () => {
    selectedPeople.clear();
    renderWho(people, onChange);
    onChange();
  };
}

// ---- navigation ------------------------------------------------------------

async function gotoComment(tabId, baseUrl, anchorId) {
  const url = `${baseUrl}#${anchorId}`;
  saveViewState({ scroll: contentEl.scrollTop });
  try {
    await chrome.tabs.update(tabId, { active: true });
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'goto-anchor', url });
    } catch {
      await chrome.tabs.update(tabId, { url });
    }
  } finally {
    window.close();
  }
}

// ---- outline rendering -----------------------------------------------------

let renderItems = () => {};
let scrollRestored = false;

async function cachedOutline(key) {
  try {
    const storageKey = `outlineCache:${key}`;
    const { [storageKey]: entry } = await chrome.storage.local.get(storageKey);
    // A clobbered/empty outline (pre-0.18.1 bug wrote these) counts as absent.
    if (entry?.outline?.items?.length && GFPCache.isFresh(entry)) return entry;
  } catch {
    // Storage unavailable: no cache.
  }
  return null;
}

function splitPath(path) {
  const i = (path || '').lastIndexOf('/');
  if (i === -1) return { dir: '', base: path || 'review thread' };
  return { dir: path.slice(0, i + 1), base: path.slice(i + 1) };
}

function shortDir(dir) {
  const max = 52;
  return dir.length <= max ? dir : '…' + dir.slice(dir.length - max + 1);
}

function commentBlock(tab, outline, c) {
  const row = el('div', 'cmt');
  const avcol = el('div', 'cmt-avcol');
  avcol.append(face(c.author, c.avatar), el('div', 'cmt-rail'));
  const col = el('div', 'cmt-col');
  const head = el('div', 'cmt-head');
  head.append(el('span', 'cmt-author', c.author || '—'));
  if (isBot(c.author)) head.append(el('span', 'bot-tag', 'bot'));
  head.append(el('span', 'cmt-time', relTime(c.time)));
  col.append(head);
  const body = el('div', 'cmt-body clickable');
  body.append(highlight(c.snippet || '', queryTerms()));
  body.title = 'Go to this comment on the page';
  body.addEventListener('click', () => void gotoComment(tab.id, outline.url, c.id));
  col.append(body);
  row.append(avcol, col);
  return row;
}

function threadCard(tab, outline, item) {
  const card = el('div', 'card thread');
  const head = el('button', 'card-head');
  head.title = item.path || '';

  const top = el('div', 'head-top');
  const dot = el('span', 'status-dot' + (item.resolved ? ' resolved' : ''));
  const fileCol = el('div', 'file-col');
  const { dir, base } = splitPath(item.path);
  const nameEl = el('div', 'file-name');
  nameEl.append(highlight(base, queryTerms()));
  fileCol.append(nameEl);
  if (dir) fileCol.append(el('div', 'file-path', shortDir(dir)));
  top.append(dot, fileCol);
  const activity = lastActivity(item);
  if (activity) top.append(el('span', 'head-time', relTime(new Date(activity).toISOString())));
  head.append(top);

  const pills = el('div', 'head-pills');
  if (item.outdated) pills.append(el('span', 'pill outdated', 'outdated'));
  pills.append(
    item.resolved ? el('span', 'pill resolved', 'resolved') : el('span', 'pill open', 'open'),
  );
  pills.append(el('span', 'spacer'));
  const faces = el('span', 'faces');
  const authors = [...new Map(item.comments.map((c) => [c.author, c])).values()].slice(0, 4);
  for (const a of authors) faces.append(face(a.author, a.avatar));
  pills.append(faces);
  const n = item.comments.length || item.count;
  pills.append(el('span', 'reply-count', `${n} ${n === 1 ? 'reply' : 'replies'}`));
  head.append(pills);

  const m = matchQuery(item);
  const shown = (m && m.hit) || item.comments[item.comments.length - 1];
  if (shown) {
    const preview = el('div', 'head-preview');
    const author = el('b');
    author.textContent = shown.author || '—';
    preview.append(author, ' ');
    const terms = m ? m.terms : [];
    const around = terms.length ? snippetAround(shown.snippet || '', terms) : null;
    if (around) {
      preview.append(around.pre);
      const mk = document.createElement('mark');
      mk.textContent = around.mark;
      preview.append(mk, around.post);
    } else {
      preview.append(shown.snippet || '');
    }
    head.append(preview);
  }

  const body = el('div', 'card-body');
  const inner = el('div', 'card-body-inner');
  const pad = el('div', 'card-body-pad');
  for (const c of item.comments) pad.append(commentBlock(tab, outline, c));
  const actions = el('div', 'card-actions');
  const go = el('button', 'btn-accent', 'Open thread on page');
  go.addEventListener('click', () => {
    if (item.anchor) void gotoComment(tab.id, outline.url, item.anchor);
  });
  actions.append(go);
  pad.append(actions);
  inner.append(pad);
  body.append(inner);

  head.addEventListener('click', () => {
    if (item.comments.length) {
      card.classList.toggle('expanded');
      const set = new Set(viewState.expanded);
      if (card.classList.contains('expanded')) set.add(itemKey(item));
      else set.delete(itemKey(item));
      saveViewState({ expanded: [...set] });
    } else if (item.anchor) void gotoComment(tab.id, outline.url, item.anchor);
  });

  card.append(head, body);
  card.dataset.anchor = item.anchor || '';
  card.dataset.key = itemKey(item);
  return card;
}

function plainCard(tab, outline, item) {
  const card = el('div', 'card plain');
  const head = el('button', 'card-head');
  const top = el('div', 'head-top');
  top.append(el('span', 'status-dot'));
  const col = el('div', 'file-col');
  const nameRow = el('div', 'cmt-head');
  const authorEl = el('span', 'cmt-author');
  authorEl.append(highlight(item.author || '—', queryTerms()));
  nameRow.append(authorEl);
  if (isBot(item.author)) nameRow.append(el('span', 'bot-tag', 'bot'));
  if (item.type === 'review') {
    if (item.state === 'approved') nameRow.append(el('span', 'pill approved', 'approved'));
    else if (item.state === 'changes') nameRow.append(el('span', 'pill changes', 'requested changes'));
    else nameRow.append(el('span', 'pill open', 'reviewed'));
  }
  col.append(nameRow);
  top.append(col);
  top.append(el('span', 'head-time', relTime(item.time)));
  head.append(top);
  if (item.snippet) {
    const preview = el('div', 'head-preview');
    const terms = queryTerms();
    const around = terms.length ? snippetAround(item.snippet, terms) : null;
    if (around) {
      preview.append(around.pre);
      const mk = document.createElement('mark');
      mk.textContent = around.mark;
      preview.append(mk, around.post);
    } else {
      preview.append(item.snippet);
    }
    head.append(preview);
  }
  // Reuse the faces slot for the avatar, aligned with thread cards.
  const dotEl = top.querySelector('.status-dot');
  dotEl.replaceWith(face(item.author, item.avatar));
  head.addEventListener('click', () => void gotoComment(tab.id, outline.url, item.id));
  card.append(head);
  card.dataset.anchor = item.id;
  card.dataset.key = itemKey(item);
  return card;
}

function renderFilterBar(items) {
  filterBar.hidden = false;
  filterBar.textContent = '';
  const counts = Object.fromEntries(FILTERS.map((f) => [f.key, items.filter(f.match).length]));
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
      renderItems(items);
    });
    filterBar.append(btn);
  }
}

function renderOutline(tab, pr, prState, outline, cachedAt, mode) {
  prHead.hidden = false;
  currentTitle.textContent = outline.title;
  currentCrumb.textContent = '';
  currentCrumb.append(el('span', '', `#${pr.number}`));
  currentCrumb.append(el('span', 'sep', '/'));
  currentCrumb.append(el('span', '', pr.repo));
  if (outline.branch) {
    currentCrumb.append(el('span', 'sep', '/'));
    currentCrumb.append(el('span', 'branch', outline.branch));
  }

  const entry = prState[pr.key];
  setNewPill(describeUpdates(entry));

  selectedPeople = new Set(viewState.people || []);
  const people = collectPeople(outline.items);
  // Drop selections for people who are no longer in the conversation.
  for (const name of [...selectedPeople]) {
    if (!people.some((p) => p.name === name)) selectedPeople.delete(name);
  }

  renderWho(people, () => {
    saveViewState({ people: [...selectedPeople] });
    refresh();
  });
  listMeta.hidden = false;
  searchBar.hidden = false;
  query = viewState.query || '';
  searchInput.value = query;
  syncSearchChrome();

  searchInput.oninput = () => {
    query = searchInput.value;
    saveViewState({ query });
    syncSearchChrome();
    refresh();
  };
  searchInput.onkeydown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (query) clearSearch();
      else searchInput.blur();
    }
  };
  searchClear.onclick = clearSearch;

  function clearSearch() {
    query = '';
    searchInput.value = '';
    saveViewState({ query: '' });
    syncSearchChrome();
    refresh();
    searchInput.focus();
  }

  // The people filter applies first; the status chips count what survives it.
  function refresh() {
    const scoped = outline.items
      .filter(matchesPeople)
      .filter((i) => matchQuery(i) !== false);
    renderFilterBar(scoped);
    renderItems(scoped);
    renderResultBar(scoped, outline);
  }

  renderItems = (scoped = outline.items
    .filter(matchesPeople)
    .filter((i) => matchQuery(i) !== false)) => {
    const filter = FILTERS.find((f) => f.key === activeFilter) || FILTERS[0];
    let items = scoped.filter(filter.match);
    if (sortMode === 'recent') items = [...items].sort((a, b) => lastActivity(b) - lastActivity(a));

    const threads = scoped.filter((i) => i.type === 'thread');
    const shownThreads = items.filter((i) => i.type === 'thread').length;
    const totalThreads = outline.items.filter((i) => i.type === 'thread').length;
    visibleLabel.textContent =
      activeFilter === 'comments'
        ? `${items.length} comments & reviews`
        : selectedPeople.size
          ? `${shownThreads} of ${totalThreads} threads · filtered by people`
          : `${shownThreads} of ${totalThreads} threads`;
    sortToggle.textContent = sortMode === 'recent' ? 'Recent ↓' : 'Timeline ↓';
    resolvedSummary.textContent = threads.length
      ? `${threads.filter((t) => t.resolved).length}/${threads.length} resolved`
      : '';

    outlineEl.textContent = '';
    if (mode === 'subpage') {
      outlineEl.append(
        el('div', 'notice', `Conversation index from ${relTime(new Date(cachedAt).toISOString())} ago — clicking a comment opens the Conversation tab at that spot.`),
      );
    } else if (cachedAt) {
      outlineEl.append(
        el('div', 'notice', `Cached outline from ${relTime(new Date(cachedAt).toISOString())} ago — reopen after indexing for fresh data.`),
      );
    } else if (outline.indexing) {
      outlineEl.append(el('div', 'notice', 'Still indexing this page — reopen in a moment for the full list.'));
    }
    const expanded = new Set(viewState.expanded);
    for (const item of items) {
      const card = item.type === 'thread' ? threadCard(tab, outline, item) : plainCard(tab, outline, item);
      if (item.type === 'thread' && item.comments.length && expanded.has(itemKey(item))) {
        card.classList.add('expanded', 'no-anim');
        requestAnimationFrame(() => card.classList.remove('no-anim'));
      }
      outlineEl.append(card);
    }
    if (!items.length && !outline.indexing) {
      outlineEl.append(
        el('div', 'empty', query.trim()
          ? `Nothing matches “${query.trim()}”.`
          : selectedPeople.size
            ? 'No threads here involve the selected people.'
            : 'Nothing here — every thread in this filter is handled.'),
      );
    }
    selIndex = -1;
    if (viewState.sel) {
      const i = cards().findIndex((c) => c.dataset.key === viewState.sel);
      if (i >= 0) selectCard(i);
    }
  };
  refresh();

  if (!scrollRestored) {
    scrollRestored = true;
    requestAnimationFrame(() => {
      contentEl.scrollTop = viewState.scroll || 0;
    });
  }

  sortToggle.onclick = () => {
    sortMode = sortMode === 'recent' ? 'timeline' : 'recent';
    localStorage.setItem('focus-pr-sort', sortMode);
    renderItems();
  };
}

function renderIndexPrompt(tab, pr, prState) {
  prHead.hidden = false;
  currentTitle.textContent = tab.title?.replace(/ · Pull Request.*$/, '') || 'This pull request';
  const conversationUrl = `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`;
  const notice = el('div', 'notice', 'This PR isn’t indexed yet.');

  const bg = el('button', 'btn-accent', 'Index in background');
  bg.style.marginLeft = '6px';
  bg.addEventListener('click', async () => {
    notice.textContent = 'Indexing in a background tab — this view fills in when it’s done…';
    const res = await send({ type: 'index-pr', key: pr.key, url: conversationUrl });
    const cached = await cachedOutline(pr.key);
    if (cached) {
      window.__gfpOutlineUrl = cached.outline.url;
      renderOutline(tab, pr, prState, cached.outline, cached.savedAt, 'subpage');
    } else {
      notice.textContent = res?.ok
        ? 'This PR has no conversation yet.'
        : 'Indexing didn’t finish — try opening the Conversation tab directly.';
    }
  });

  const go = el('button', '', 'Open Conversation');
  go.addEventListener('click', async () => {
    await chrome.tabs.update(tab.id, { url: conversationUrl });
    window.close();
  });

  notice.append(bg, go);
  outlineEl.textContent = '';
  outlineEl.append(notice);
}

function renderReloadNotice(tab) {
  prHead.hidden = false;
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

// ---- PR switcher dropdown --------------------------------------------------

const prMenuBtn = document.getElementById('pr-menu-btn');
const prDropdown = document.getElementById('pr-dropdown');

function setDropdownOpen(open) {
  prDropdown.hidden = !open;
  prMenuBtn.classList.toggle('open', open);
  document.body.style.minHeight = open ? '460px' : '';
}

prMenuBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  setDropdownOpen(prDropdown.hidden);
});
prHead.addEventListener('click', (e) => {
  e.stopPropagation();
  setDropdownOpen(prDropdown.hidden);
});
document.getElementById('dd-close').addEventListener('click', () => setDropdownOpen(false));
document.addEventListener('click', (e) => {
  if (!prDropdown.hidden && !e.target.closest('#pr-dropdown, #pr-menu-btn, #pr-head')) {
    setDropdownOpen(false);
  }
});

document.getElementById('pr-url-input').addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  const url = e.currentTarget.value.trim();
  if (!parsePrUrl(url)) return;
  await chrome.tabs.create({ url, active: true });
  window.close();
});

function stateBadge(entry, updates) {
  if (updates !== null && updates > 0) return { text: `${updates} new`, cls: 'b-accent' };
  if (!entry?.state) return null;
  if (entry.state === 'merged') return { text: 'merged', cls: 'b-purple' };
  if (entry.state === 'closed') return { text: 'closed', cls: 'b-red' };
  if (entry.draft) return { text: 'draft', cls: 'b-neutral' };
  return { text: 'in review', cls: 'b-accent' };
}

function renderOthers(prState, openTabs, currentKey) {
  const byKey = new Map();
  for (const t of openTabs) {
    if (t.key !== currentKey && !byKey.has(t.key)) byKey.set(t.key, t);
  }
  othersList.textContent = '';

  if (!byKey.size) {
    othersList.append(el('p', 'empty', currentKey ? 'No other PR tabs open.' : 'No pull request tabs open.'));
    return;
  }

  const rows = [...byKey.values()].sort((a, b) => {
    const ua = describeUpdates(prState[a.key]) !== null ? 0 : 1;
    const ub = describeUpdates(prState[b.key]) !== null ? 0 : 1;
    return ua - ub || a.key.localeCompare(b.key);
  });

  for (const row of rows) {
    const entry = prState[row.key];
    const updates = describeUpdates(entry);
    const btn = el('button', 'pr-row');
    const dot = el('span', 'dot' + (updates !== null ? ' hot' : ''));
    const col = el('div', 'col');
    col.append(
      el('div', 't', entry?.title || row.tabTitle?.replace(/ · Pull Request.*$/, '') || row.key),
    );
    const meta =
      row.pr.kind === 'commit'
        ? `${row.pr.owner}/${row.pr.repo} @ ${row.pr.sha.slice(0, 7)}`
        : `#${row.pr.number} · ${row.pr.owner}/${row.pr.repo}`;
    col.append(el('div', 'm', meta));
    btn.append(dot, col);
    const badge = stateBadge(entry, updates);
    if (badge) btn.append(el('span', `badge ${badge.cls}`, badge.text));

    const open = async (newTab) => {
      await send({
        type: 'focus-pr',
        key: row.key,
        url: entry?.url || row.url,
        newTab,
      });
      window.close();
    };
    btn.title = 'Click to switch to this pull request · ⌘/Ctrl-click for a new tab';
    btn.addEventListener('click', (e) => void open(e.metaKey || e.ctrlKey || e.shiftKey));
    // Middle-click, like a browser link.
    btn.addEventListener('auxclick', (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      void open(true);
    });
    othersList.append(btn);
  }
}

// ---- keyboard navigation ---------------------------------------------------

let selIndex = -1;

function cards() {
  return [...outlineEl.querySelectorAll('.card')];
}

function selectCard(i) {
  const list = cards();
  if (!list.length) return;
  selIndex = Math.max(0, Math.min(list.length - 1, i));
  list.forEach((c, j) => c.classList.toggle('sel', j === selIndex));
  list[selIndex].scrollIntoView({ block: 'nearest' });
  saveViewState({ sel: list[selIndex].dataset.key || '' });
}

document.addEventListener('keydown', (e) => {
  if (e.target instanceof Element && e.target.closest('input, textarea')) return;
  if (e.key === '/') {
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
    return;
  }
  const k = e.key.toLowerCase();
  if (k === 'j') selectCard(selIndex + 1);
  else if (k === 'k') selectCard(selIndex - 1);
  else if (e.key === 'Enter' && selIndex >= 0) {
    e.preventDefault();
    cards()[selIndex]?.querySelector('.card-head')?.click();
  } else if (k === 'g' && selIndex >= 0) {
    const card = cards()[selIndex];
    const anchor = card?.dataset.anchor;
    if (anchor && window.__gfpTab) void gotoComment(window.__gfpTab.id, window.__gfpOutlineUrl, anchor);
  }
});

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
    window.__gfpTab = activeTab;
    loadViewState(pr.key);
    try {
      const outline = await chrome.tabs.sendMessage(activeTab.id, { type: 'get-outline' });
      if (!outline?.ok) currentKey = null;
      else if (outline.subpage) {
        // Files changed / commits tab: serve the conversation index from
        // cache; clicks flip this tab to the conversation at the comment.
        const cached = await cachedOutline(pr.key);
        if (cached) {
          window.__gfpOutlineUrl = cached.outline.url;
          renderOutline(activeTab, pr, prState, cached.outline, cached.savedAt, 'subpage');
        } else renderIndexPrompt(activeTab, pr, prState);
      } else {
        window.__gfpOutlineUrl = outline.url;
        if (outline.indexing && !outline.items.length) {
          const cached = await cachedOutline(pr.key);
          if (cached) renderOutline(activeTab, pr, prState, cached.outline, cached.savedAt);
          else renderOutline(activeTab, pr, prState, outline);
        } else renderOutline(activeTab, pr, prState, outline);
      }
    } catch {
      const cached = await cachedOutline(pr.key);
      if (cached) {
        window.__gfpOutlineUrl = cached.outline.url;
        renderOutline(activeTab, pr, prState, cached.outline, cached.savedAt);
      } else renderReloadNotice(activeTab);
    }
  }

  renderOthers(prState, openTabs, currentKey);

  if (!currentKey && prHead.hidden) {
    noCurrent.hidden = false;
    noCurrent.textContent = 'This tab isn’t a pull request — pick one from the list.';
    setDropdownOpen(true);
  }

  // The header height depends on the rendered title; re-clamp the list so
  // the whole popup stays under Chrome's height cap.
  reclampSize();
}

// Sync: re-poll the API, and when the current PR has unseen activity, reload
// its tab (the thread cache makes re-indexing cheap) and live-refresh the
// outline as indexing progresses.
async function sync() {
  statusEl.textContent = 'Syncing…';
  await send({ type: 'poll-now' });
  const [{ prState }, [activeTab]] = await Promise.all([
    send({ type: 'get-state' }),
    chrome.tabs.query({ active: true, currentWindow: true }),
  ]);
  const pr = activeTab ? parsePrUrl(activeTab.url || '') : null;
  if (pr && describeUpdates(prState[pr.key]) !== null) {
    statusEl.textContent = 'Refreshing page…';
    try {
      await chrome.tabs.reload(activeTab.id);
    } catch {
      // Tab gone; the plain re-load below still refreshes the popup.
    }
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const outline = await chrome.tabs.sendMessage(activeTab.id, { type: 'get-outline' });
        if (outline?.ok) {
          const { prState: fresh } = await send({ type: 'get-state' });
          renderOutline(activeTab, pr, fresh, outline);
          statusEl.textContent = outline.indexing ? 'Indexing…' : '';
          if (!outline.indexing) break;
        }
      } catch {
        // Content script not up yet (page still loading) — keep waiting.
      }
    }
    statusEl.textContent = '';
    return;
  }
  statusEl.textContent = '';
  await load();
}

document.getElementById('refresh').addEventListener('click', () => void sync());
newPill.addEventListener('click', () => void sync());

document.getElementById('open-options').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// ---- resizable popup -------------------------------------------------------

const MIN_W = 360, MAX_W = 780, MIN_H = 200, MAX_H = 540;
// Chrome hard-caps popups at 600px tall. If the document is taller, the
// window clips and vertical resizing feels dead: the header, filters, and
// footer are fixed costs, so the list must absorb the cap.
const POPUP_MAX = 590;

function chromeOverhead() {
  return document.body.scrollHeight - contentEl.offsetHeight;
}

function applySize(w, h) {
  document.body.style.width = `${w}px`;
  const clamped = Math.min(h, Math.max(160, POPUP_MAX - chromeOverhead()));
  contentEl.style.height = `${clamped}px`;
}

function reclampSize() {
  try {
    const saved = JSON.parse(localStorage.getItem('focus-pr-size') || 'null');
    applySize(saved?.w || 460, saved?.h || MAX_H);
  } catch {
    applySize(460, MAX_H);
  }
}
reclampSize();

const handle = document.getElementById('resize-handle');
handle.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  handle.setPointerCapture(e.pointerId);
  const startX = e.clientX;
  const startY = e.clientY;
  const startW = document.body.getBoundingClientRect().width;
  const startH = contentEl.getBoundingClientRect().height;
  let w = startW, h = startH;
  const onMove = (ev) => {
    w = Math.min(MAX_W, Math.max(MIN_W, Math.round(startW + ev.clientX - startX)));
    h = Math.min(MAX_H, Math.max(MIN_H, Math.round(startH + ev.clientY - startY)));
    applySize(w, h);
  };
  const onUp = () => {
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', onUp);
    localStorage.setItem('focus-pr-size', JSON.stringify({ w, h }));
  };
  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onUp);
});

let scrollSaveTimer = null;
contentEl.addEventListener('scroll', () => {
  clearTimeout(scrollSaveTimer);
  scrollSaveTimer = setTimeout(() => saveViewState({ scroll: contentEl.scrollTop }), 150);
}, { passive: true });

void load();
