'use strict';

const $ = id => document.getElementById(id);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

const PREFS_KEY = 'ict.prefs';
const ALL_MOVIES = 'All movies';

// Show me levels. From DETAILS on the app names clips and shows frames.
const MOVIES = 1, NUMBERS = 2, DETAILS = 3, EVERYTHING = 4;

const state = {
  data: null,        // app/clips.json, fetched once
  clips: [],
  level: 0,          // 0 is the total alone, up to EVERYTHING
  secrets: false,
  filter: 'missing',
  movie: ALL_MOVIES,
  selected: null,
  revealed: new Set(),
  revealedDetails: new Set(),
  warned: false,     // the spoiler and content warning has been accepted
};

/* ------------------------------------------------------------------ *
 * Preferences
 * ------------------------------------------------------------------ */

function loadPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    if (Number.isInteger(saved.level)) state.level = Math.min(Math.max(saved.level, 0), EVERYTHING);
    if (typeof saved.secrets === 'boolean') state.secrets = saved.secrets;
    if (typeof saved.warned === 'boolean') state.warned = saved.warned;
    if (['missing', 'found', 'all'].includes(saved.filter)) state.filter = saved.filter;
  } catch { /* corrupt or unavailable storage is not worth reporting */ }
}

function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      level: state.level, secrets: state.secrets, filter: state.filter,
      warned: state.warned,
    }));
  } catch { /* private mode */ }
}

/* ------------------------------------------------------------------ *
 * Remembering the save between visits
 *
 * Whichever save you open is kept, so there is nothing to opt into: a
 * FileSystemFileHandle survives a reload, and later visits read the same
 * file again. Chromium only; elsewhere the file is simply re-picked.
 * ------------------------------------------------------------------ */

const canPickFile = typeof window.showOpenFilePicker === 'function';

// Where the loaded save came from, so Reload re-reads *that* rather than
// whatever auto-detection would have picked.
let source = null;

// Held in memory so the picker can be opened straight from a click.
let rememberedHandle = null;

function idb() {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('ict', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('handles');
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
    // Another tab holding an older version open would otherwise stall forever.
    open.onblocked = () => reject(new Error('Storage is busy in another tab.'));
  });
}

/** One request against the stored save handle, e.g. store => store.get('save'). */
async function handleStore(mode, request) {
  const db = await idb();
  try {
    return await new Promise((resolve, reject) => {
      const req = request(db.transaction('handles', mode).objectStore('handles'));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

const loadHandle = () => handleStore('readonly', store => store.get('save'));

/** Kept for this visit and the next; remembering is a convenience, never a failure. */
function remember(handle) {
  rememberedHandle = handle;
  handleStore('readwrite', store => store.put(handle, 'save')).catch(() => {});
}

async function readHandle(handle, { prompt }) {
  const opts = { mode: 'read' };
  let permission = await handle.queryPermission(opts);
  if (permission !== 'granted' && prompt) permission = await handle.requestPermission(opts);
  if (permission !== 'granted') {
    if (!prompt) return false;
    throw Tracker.saveError('The browser did not let the page read that file.',
      'Drag it onto the box instead.');
  }

  source = { kind: 'handle', handle };
  await applySave(await handle.getFile());
  remember(handle);
  return true;
}

/**
 * After a browser restart a stored handle needs permission again, which only a
 * click can grant, so the file is offered by name instead of opening silently.
 */
function offerAgain(handle) {
  $('again').textContent = `Open ${handle.name} again`;
  $('again-wrap').hidden = false;
  $('again').onclick = () => loading(() => readHandle(handle, { prompt: true }));
}

/* ------------------------------------------------------------------ *
 * Native shell bridge (Photino)
 * ------------------------------------------------------------------ */

const native = typeof window.external === 'object' && typeof window.external.receiveMessage === 'function';
let nativeWaiting = null;

function askNative(cmd, path) {
  return new Promise((resolve, reject) => {
    nativeWaiting = { resolve, reject };
    window.external.sendMessage(JSON.stringify({ cmd, path }));
  });
}

function wireNative() {
  window.external.receiveMessage(raw => {
    if (!nativeWaiting) return;
    const pending = nativeWaiting;
    nativeWaiting = null;
    try {
      const msg = JSON.parse(raw);
      msg.ok || msg.cancelled
        ? pending.resolve(msg)
        : pending.reject(Tracker.saveError(
          msg.error || 'The app could not read that save.',
          msg.hint || 'Use “choose a file” to point at it yourself.'));
    } catch (e) {
      pending.reject(e);
    }
  });
}

function base64ToBuffer(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/** The shell replies with the save in base64 and the path it came from. */
const applyNative = msg => applySave(base64ToBuffer(msg.data), msg.path);

function loadFromNative() {
  return loading(async () => {
    const msg = await askNative('find');
    source = { kind: 'native' };
    await applyNative(msg);
  });
}

/** Re-reads whatever the current save came from. */
function reload() {
  if (!source) return Promise.resolve();
  return loading(async () => {
    try {
      if (source.kind === 'native') {
        await applyNative(await askNative('find'));
      } else if (source.kind === 'native-file') {
        await applyNative(await askNative('read', source.path));
      } else if (source.kind === 'handle') {
        await applySave(await source.handle.getFile());
      } else {
        // Re-reading the same File re-reads it from disk, unless it was replaced.
        await applySave(source.file);
      }
    } catch (e) {
      throw e.name === 'NotReadableError' || e.name === 'NotFoundError'
        ? Tracker.saveError('That save is no longer where it was.', 'Use Open save to choose it again.')
        : e;
    }
  });
}

/**
 * A plain <input type="file"> cannot be told where to open, and the File System
 * Access API only accepts a handle or one of six well-known folders, never an
 * arbitrary path. Passing an id lets the browser reopen wherever the last pick
 * happened, and a remembered save starts it exactly there.
 */
async function chooseFile() {
  hideError();

  if (native) {
    const msg = await askNative('open').catch(e => { showError(e); return null; });
    if (!msg || msg.cancelled) return;
    return loading(async () => {
      source = { kind: 'native-file', path: msg.path };
      await applyNative(msg);
    });
  }

  if (!canPickFile) {
    $('file').click();
    return;
  }

  const options = {
    id: 'immortality-save',
    types: [{ description: 'IMMORTALITY save', accept: { 'application/octet-stream': ['.abr'] } }],
  };
  // Read from memory: awaiting anything here would spend the click's user
  // activation, and the picker refuses to open without it.
  if (rememberedHandle) options.startIn = rememberedHandle;

  let handle;
  const asked = performance.now();
  try {
    [handle] = await window.showOpenFilePicker(options);
  } catch (e) {
    // Nobody cancels a dialog this fast: the browser refused to show one at all.
    if (e.name === 'AbortError' && performance.now() - asked < 300) {
      showError(Tracker.saveError('This browser did not open a file picker.',
        'Drag your save onto the box instead, or open this page in another browser.'));
    } else if (e.name !== 'AbortError') {
      showError(e);
    }
    return;
  }
  return loading(() => readHandle(handle, { prompt: true }));
}

/* ------------------------------------------------------------------ *
 * Pictures
 *
 * One archive holds a still of every clip and a frame for every match-cut,
 * both pulled out of the game. One request instead of hundreds, and a folder
 * of this game's frames is never left lying about. It is only fetched once a
 * level that shows pictures has been chosen.
 * ------------------------------------------------------------------ */

let pictures = null;               // { box, at: { name: [offset, length] }, data: Blob }
let picturesPending = null;
const picUrls = new Map();

function ensurePictures() {
  if (picturesPending) return picturesPending;
  picturesPending = Promise.all([
    fetch('pictures.json').then(r => (r.ok ? r.json() : null)),
    fetch('pictures.bin').then(r => (r.ok ? r.blob() : null)),
  ]).then(([index, data]) => {
    if (!index || !data) return;
    pictures = { ...index, data };
    listKey = '';
    redraw();
  }).catch(() => { /* the app works without them */ });
  return picturesPending;
}

function picUrl(name) {
  const at = pictures && pictures.at[name];
  if (!at) return '';
  let url = picUrls.get(name);
  if (!url) {
    url = URL.createObjectURL(pictures.data.slice(at[0], at[0] + at[1], 'image/webp'));
    picUrls.set(name, url);
  }
  return url;
}

function picture(name, cls) {
  const url = picUrl(name);
  if (!url) return null;
  const img = el('img', cls);
  img.src = url;
  // Decorative: every picture sits beside the text that already names it.
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  // Every picture is padded to one box, so the shape is known before it loads.
  [img.width, img.height] = pictures.box;
  return img;
}

/** A picture with a ring around the place to click, given as [x, y, w, h] fractions. */
function marked(name, mark) {
  const img = picture(name);
  if (!img || !mark) return img;
  const [x, y, w, h] = mark;
  const pc = v => v * 100 + '%';
  const ring = el('span', 'mark');
  ring.style.cssText = `--x:${pc(x + w / 2)};--y:${pc(y + h / 2)};--w:${pc(w)};--h:${pc(h)}`;
  const wrap = el('span', 'pic');
  wrap.append(img, ring);
  return wrap;
}

/** Opens larger on a click: a ring on a small picture is hard to read. */
function zoomable(name, mark, caption) {
  const shot = marked(name, mark);
  if (!shot) return null;
  const button = el('button', 'zoom-in');
  button.type = 'button';
  button.title = 'Show this bigger';
  button.append(shot);
  button.onclick = () => {
    $('zoom-pic').replaceChildren(marked(name, mark));
    $('zoom-cap').textContent = caption;
    $('zoom').showModal();
  };
  return button;
}

/* ------------------------------------------------------------------ *
 * Derived data
 * ------------------------------------------------------------------ */

const inScope = () => state.secrets ? state.clips : state.clips.filter(c => !c.secret);

// Routes name the clip they start from, so they need to look one up.
let byClip = new Map();
const showNames = () => state.level >= DETAILS;
const showRoute = clip => state.level >= EVERYTHING || state.revealed.has(clip.id);
const showDetails = clip => showNames() || state.revealedDetails.has(clip.id);
const percent = (part, whole) => whole ? part / whole * 100 + '%' : '0';

// Below this width there is no room for a side pane, so the detail opens
// inside the selected row instead. Must match the stylesheet.
const inlineDetail = matchMedia('(max-width: 900px)');
inlineDetail.addEventListener('change', redraw);

function movieSummaries() {
  const scope = inScope();
  const names = [...new Set(scope.map(c => c.movie))];
  return names.map(name => {
    const group = scope.filter(c => c.movie === name);
    const watched = group.filter(c => c.watched).length;
    return {
      name,
      watched,
      total: group.length,
      missing: group.length - watched,
      hidden: state.secrets ? 0
        : state.clips.filter(c => c.movie === name && c.secret && !c.watched).length,
    };
  });
}

function visibleClips() {
  let clips = inScope();
  if (state.filter === 'missing') clips = clips.filter(c => !c.watched);
  if (state.filter === 'found') clips = clips.filter(c => c.watched);
  if (state.movie !== ALL_MOVIES) clips = clips.filter(c => c.movie === state.movie);
  return clips;
}

/* ------------------------------------------------------------------ *
 * Render
 * ------------------------------------------------------------------ */

/** For changes nobody clicked for, which must not close the Open save page. */
function redraw() {
  if (state.clips.length && $('intro').hidden) render();
}

function render() {
  const scope = inScope();
  const watched = scope.filter(c => c.watched).length;
  const total = scope.length;
  const missing = total - watched;
  const pending = !state.secrets && state.clips.some(c => c.secret && !c.watched);

  $('controls').hidden = false;
  $('intro').hidden = true;
  $('results').hidden = false;
  $('refresh').hidden = !source;
  $('back').hidden = true;

  $('totals').hidden = state.level === 0;
  $('watched').textContent = watched;
  $('of-total').textContent = `of ${total} found`;
  $('meter-fill').style.width = percent(watched, total);
  $('headline').innerHTML = (missing === 0 ? 'All found.' : `${missing} still to find`)
    + (pending ? ' <span class="tease">…or maybe not?</span>' : '');

  $('board-total').hidden = state.level !== 0;
  $('board-movies').hidden = state.level !== MOVIES;
  $('browser').hidden = state.level < NUMBERS;
  // Nothing shows a picture below this, so nothing needs fetching below it.
  if (state.level >= DETAILS) ensurePictures();

  if (state.level === 0) renderTotal(watched, total, missing, pending);
  if (state.level === MOVIES) renderMovies();
  if (state.level >= NUMBERS) renderBrowser();
}

function renderTotal(watched, total, missing, pending) {
  const number = $('big-number');
  number.className = missing === 0 ? 'hero done' : 'hero';
  number.textContent = missing === 0 ? 'All found' : missing;
  $('big-caption').innerHTML = missing === 0
    ? (pending ? '<span class="tease">…or maybe not?</span>' : '')
    : (missing === 1 ? 'clip still to find' : 'clips still to find');
  $('hero-fill').style.width = percent(watched, total);
  $('hero-watched').textContent = `${watched} watched`;
}

function renderMovies() {
  const host = $('movie-cards');
  host.replaceChildren();
  for (const m of movieSummaries()) {
    const card = el('div', 'card');
    const row = el('div', 'row');
    row.append(el('span', 'name', m.name));
    row.append(el('span', 'left', m.missing === 0 ? 'All found' : String(m.missing)));
    if (m.missing) row.append(el('span', 'unit', m.missing === 1 ? 'clip left' : 'clips left'));
    if (m.hidden) row.append(el('span', 'star', '*'));
    card.append(row);
    const meter = el('div', 'meter');
    const fill = el('i');
    fill.style.width = percent(m.watched, m.total);
    meter.append(fill);
    card.append(meter);
    host.append(card);
  }
}

// Rebuilding every row for a selection change replaced ~3000 nodes on each click.
// The list is now rebuilt only when its contents actually change; selecting a clip
// just moves a class and the detail panel.
let listKey = '';
const rowFor = new Map();

function renderBrowser() {
  const clips = visibleClips();
  const key = [
    state.filter, state.movie, state.level, state.secrets,
    state.revealed.size, state.revealedDetails.size, clips.length,
  ].join('|');

  if (key !== listKey) {
    // Rebuilding replaces a focused movie button, so focus moves to its replacement.
    const refocus = !!document.activeElement?.closest('#movie-list');
    listKey = key;
    renderMovieList();
    renderClipList(clips);
    if (refocus) $('movie-list').querySelector('[aria-pressed="true"]')?.focus();
  }
  applySelection(clips);
}

function renderMovieList() {
  const list = $('movie-list');
  list.replaceChildren();
  const entries = [{ name: ALL_MOVIES, tally: '', hidden: 0 }].concat(
    movieSummaries().map(m => ({ name: m.name, tally: `${m.watched}/${m.total}`, hidden: m.hidden })));

  for (const entry of entries) {
    const button = el('button');
    button.type = 'button';
    button.setAttribute('aria-pressed', entry.name === state.movie);
    button.append(el('span', '', entry.name));
    if (entry.tally) button.append(el('span', 'tally', entry.tally));
    if (entry.hidden) button.append(el('span', 'star', '*'));
    button.onclick = () => { state.movie = entry.name; state.selected = null; render(); };
    const li = el('li');
    li.append(button);
    list.append(li);
  }
}

function renderClipList(clips) {
  $('clip-count').textContent = `${clips.length} clips`;
  const host = $('clips');
  host.replaceChildren();
  rowFor.clear();

  // Every clip has a still, but only those showing details may show it. While
  // any row in this list does, every row keeps the column so titles line up.
  const anyPics = !!pictures && clips.some(showDetails);

  for (const clip of clips) {
    const li = el('li', clip.watched ? 'found' : '');
    const row = el('button', 'row');
    row.type = 'button';
    row.append(el('span', 'edge'));
    row.append(el('span', 'id', String(clip.id)));

    if (anyPics) {
      row.classList.add('with-thumb');
      row.append((showDetails(clip) && picture(String(clip.id), 'thumb')) || el('span', 'thumb blank'));
    }

    const text = el('span', 'text');
    text.append(el('span', 'title', showDetails(clip) ? clip.title : 'Clip ' + clip.id));
    text.append(el('span', 'meta', showDetails(clip) ? clip.subtitle : 'details hidden at this setting'));
    row.append(text);

    const tags = el('span', 'tags');
    // Marking an unwatched clip as a secret is itself a hint.
    if (clip.secret && state.secrets && (showNames() || clip.watched)) tags.append(el('span', 'tag secret', 'Secret'));
    if (clip.watched) tags.append(el('span', 'tag found', 'Found'));
    row.append(tags);
    const caret = el('span', 'caret', '\u25BE');
    caret.setAttribute('aria-hidden', 'true');
    row.append(caret);

    row.onclick = () => {
      // Inline, a second tap on the open clip closes it again.
      const open = state.selected === clip.id;
      state.selected = inlineDetail.matches && open ? null : clip.id;
      applySelection(visibleClips());
    };
    li.append(row);
    host.append(li);
    rowFor.set(clip.id, li);
  }

  const empty = $('empty');
  empty.hidden = clips.length > 0;
  empty.textContent = state.filter === 'found'
    ? 'You have not found any of these yet.'
    : 'Nothing left to find here.';
}

function applySelection(clips) {
  // Inline, nothing is selected until tapped; the side pane always shows something.
  if (!state.selected || !clips.some(c => c.id === state.selected)) {
    state.selected = !inlineDetail.matches && clips.length ? clips[0].id : null;
  }

  for (const [id, li] of rowFor) {
    const on = id === state.selected;
    li.classList.toggle('on', on);
    const row = li.firstElementChild;
    row.setAttribute('aria-current', on);
    // Inline, the row opens and closes the detail beneath it.
    if (inlineDetail.matches) row.setAttribute('aria-expanded', on);
    else row.removeAttribute('aria-expanded');
    const last = li.lastElementChild;
    if (last && last.classList.contains('detail')) last.remove();
  }

  const selected = clips.find(c => c.id === state.selected);
  const pane = $('detail');

  if (inlineDetail.matches) {
    pane.replaceChildren();
    pane.hidden = true;
    if (selected) {
      const panel = el('div', 'detail');
      fillDetail(panel, selected);
      rowFor.get(selected.id)?.append(panel);
    }
  } else {
    fillDetail(pane, selected);
    pane.hidden = !selected;
  }
  sizeDetail();
}

/**
 * The pane sticks under the header but starts further down the page, so a fixed
 * height reaches past the bottom of the window and the last of it can never be
 * scrolled into view.
 *
 * Its own rectangle is no use here: a sticky box is composited, and reading it
 * from inside a scroll handler gives the position it had a frame ago. The grid
 * it sits in is an ordinary element, and the pane starts at the top of that or
 * at its sticky offset, whichever is lower down the page.
 */
function sizeDetail() {
  const pane = $('detail');
  if (pane.hidden || inlineDetail.matches) {
    pane.style.maxHeight = '';
    return;
  }
  const sticky = parseFloat(getComputedStyle(pane).top) || 0;
  const top = Math.max(sticky, $('browser').getBoundingClientRect().top);
  const next = Math.max(260, Math.round(innerHeight - top - 16)) + 'px';
  if (pane.style.maxHeight !== next) pane.style.maxHeight = next;
}

addEventListener('scroll', sizeDetail, { passive: true });
addEventListener('resize', sizeDetail);

function fillDetail(host, clip) {
  host.replaceChildren();
  if (!clip) return;

  host.append(el('h3', '', 'CLIP ' + clip.id));
  if (showDetails(clip)) {
    const still = zoomable(String(clip.id), null, clip.title);
    if (still) {
      const frame = el('figure', 'still');
      frame.append(still);
      host.append(frame);
    }
    host.append(el('p', 'lead', clip.title));
    if (clip.line) host.append(el('p', 'muted', clip.line));
  } else {
    const reveal = el('button', 'ghost', 'Reveal details');
    reveal.onclick = () => { state.revealedDetails.add(clip.id); render(); };
    host.append(reveal);
  }

  const slate = el('dl', 'slate');
  const add = (key, value) => {
    const row = el('div');
    row.append(el('dt', '', key));
    row.append(el('dd', '', value || '-'));
    slate.append(row);
  };
  if (showDetails(clip)) {
    add('Movie', clip.movie);
    add('Take', clip.take);
    add('Date', clip.date);
  }
  // Naming an unwatched clip as a secret is the same hint the list badge withholds.
  if (showDetails(clip) || clip.watched) add('Kind', clip.kind);
  add('Status', clip.watched ? 'Found' : 'Still missing');
  if (clip.watched && clip.views > 0) add('Watched', clip.views === 1 ? 'once' : clip.views + ' times');
  host.append(slate);

  host.append(el('h4', 'eyebrow', 'How to find it'));
  if (showRoute(clip)) {
    const lines = Tracker.routeFor(clip, byClip);
    if (!lines.length) host.append(el('p', 'dim', 'No way into this one is recorded.'));

    const steps = el('ul', 'route');
    for (const step of lines) {
      const li = el('li');
      li.append(el('span', 'arrow', '\u25B8'));

      const words = el('span');
      words.append(el('span', '', step.text));
      // When and how reliable, kept quiet so neither reads as the instruction.
      if (step.note) words.append(el('span', 'note', step.note));
      li.append(words);

      const shot = step.pic && zoomable(step.pic, step.mark, step.text);
      if (shot) {
        const figure = el('figure', 'cue');
        figure.append(shot);
        li.append(figure);
      }
      steps.append(li);
    }
    host.append(steps);
  } else {
    host.append(el('p', 'dim', 'Hidden so you can keep hunting. Stuck on this one?'));
    const reveal = el('button', 'ghost', 'Reveal this clip');
    reveal.onclick = () => { state.revealed.add(clip.id); render(); };
    host.append(reveal);
  }
}

/* ------------------------------------------------------------------ *
 * Loading
 * ------------------------------------------------------------------ */

async function loadClips() {
  if (state.data) return state.data;
  const response = await fetch('clips.json');
  if (!response.ok) throw new Error('Could not load the clip list.');
  state.data = await response.json();
  return state.data;
}

let toastTimer = 0;

function showError(e) {
  const hint = e && e.hint ? e.hint : '';
  $('toast-title').textContent = (e && e.message) || String(e);
  $('toast-hint').textContent = hint;
  $('toast-hint').hidden = !hint;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideError, 14000);
}

function hideError() {
  clearTimeout(toastTimer);
  $('toast').hidden = true;
}

function setBusy(on) {
  $('busy').hidden = !on;
  $('drop').classList.toggle('is-busy', on);
}

/** Every path that loads a save goes through here, so one place owns the spinner. */
async function loading(work) {
  hideError();
  setBusy(true);
  try {
    // Let the browser paint the spinner before the parse blocks the thread.
    await new Promise(requestAnimationFrame);
    await work();
  } catch (e) {
    if (e && e.name !== 'AbortError') showError(e);
  } finally {
    setBusy(false);
  }
}

/**
 * Accepts a File or an ArrayBuffer. With a File the first bytes are checked
 * before the rest is read, so picking a video or a photo fails at once instead
 * of pulling hundreds of megabytes into memory first.
 */
async function applySave(input, name) {
  const data = await loadClips();

  let buffer;
  if (input instanceof Blob) {
    name = name || input.name;
    const head = new Uint8Array(await input.slice(0, 17).arrayBuffer());
    if (!Tracker.looksLikeSave(head)) {
      throw Tracker.saveError(
        `“${basename(name)}” is not an IMMORTALITY save.`,
        'The file you want is called SaveGame.abr. The folders it lives in are listed below.');
    }
    buffer = await input.arrayBuffer();
  } else {
    buffer = input;
  }

  state.clips = Tracker.buildClips(data, Tracker.readSave(buffer, name && basename(name)));
  byClip = new Map(state.clips.map(c => [c.id, c]));
  state.selected = null;
  state.revealed.clear();
  state.revealedDetails.clear();
  listKey = '';
  $('again-wrap').hidden = true;
  syncControls();
  render();
}

const basename = path => String(path).split(/[\\/]/).pop();

function handleFile(file, handle) {
  return loading(async () => {
    source = handle ? { kind: 'handle', handle } : { kind: 'file', file };
    await applySave(file);
    if (handle) remember(handle);
  });
}

function syncControls() {
  $('level').value = String(state.level);
  $('secrets').setAttribute('aria-checked', String(state.secrets));
  for (const button of $('filters').children) {
    button.setAttribute('aria-pressed', button.dataset.filter === state.filter);
  }
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

const drop = $('drop');
['dragenter', 'dragover'].forEach(name =>
  drop.addEventListener(name, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(name =>
  drop.addEventListener(name, () => drop.classList.remove('over')));
drop.addEventListener('drop', async e => {
  e.preventDefault();
  const item = e.dataTransfer.items && e.dataTransfer.items[0];
  const file = e.dataTransfer.files[0];
  if (!file) return;

  // A dropped handle can be remembered; a plain File cannot.
  let handle = null;
  if (item && typeof item.getAsFileSystemHandle === 'function') {
    handle = await item.getAsFileSystemHandle().catch(() => null);
    if (handle && handle.kind !== 'file') handle = null;
  }
  handleFile(file, handle);
});
$('file').addEventListener('change', e => {
  if (e.target.files[0]) handleFile(e.target.files[0]);
});

$('choose').addEventListener('click', chooseFile);

$('refresh').addEventListener('click', reload);

/**
 * Levels below DETAILS say how many clips are left and nothing more. From there
 * the app names them and shows frames, which cannot be taken back, so it is
 * asked for once.
 */
function setLevel(level) {
  if (level < DETAILS || state.warned) {
    applyLevel(level);
    return;
  }
  syncControls();
  pendingLevel = level;
  $('warn').showModal();
}

function applyLevel(level) {
  state.level = level;
  state.revealed.clear();
  state.revealedDetails.clear();
  syncControls();
  savePrefs();
  render();
}

let pendingLevel = 0;

$('level').addEventListener('change', e => setLevel(Number(e.target.value)));

$('warn-yes').addEventListener('click', () => {
  state.warned = true;
  $('warn').close();
  applyLevel(pendingLevel);
});
$('warn-no').addEventListener('click', () => $('warn').close());

$('secrets').addEventListener('click', () => {
  state.secrets = !state.secrets;
  state.selected = null;
  syncControls();
  savePrefs();
  render();
});

document.querySelectorAll('[data-more]').forEach(button =>
  button.addEventListener('click', () => setLevel(Math.min(state.level + 1, EVERYTHING))));

$('filters').addEventListener('click', e => {
  const button = e.target.closest('button');
  if (!button) return;
  state.filter = button.dataset.filter;
  state.selected = null;
  syncControls();
  savePrefs();
  render();
});

document.addEventListener('keydown', e => {
  if ($('browser').hidden || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  // Leave the caret alone when the user is typing or using the select.
  if (e.target.closest('input, select, textarea')) return;
  const clips = visibleClips();
  if (!clips.length) return;
  e.preventDefault();
  const at = clips.findIndex(c => c.id === state.selected);
  const next = e.key === 'ArrowDown'
    ? Math.min(at + 1, clips.length - 1)
    : Math.max(at - 1, 0);
  state.selected = clips[next].id;
  applySelection(clips);
  const li = rowFor.get(state.selected);
  // Once the keyboard is in the list, focus follows the selection.
  if (document.activeElement?.closest('#clips')) li?.firstElementChild.focus({ preventScroll: true });
  li?.scrollIntoView({ block: 'nearest' });
});

// Opening the picker keeps whatever is already loaded, so it can be returned to.
$('reset').addEventListener('click', () => {
  hideError();
  $('back').hidden = !state.clips.length;
  $('results').hidden = true;
  $('controls').hidden = true;
  $('intro').hidden = false;
  // Cleared so choosing the same file again still fires a change event.
  $('file').value = '';
});

$('back').addEventListener('click', () => {
  hideError();
  render();
});

$('toast-close').addEventListener('click', hideError);

const toTop = $('to-top');
const syncToTop = () => { toTop.hidden = scrollY < innerHeight; };
syncToTop();
addEventListener('scroll', syncToTop, { passive: true });
addEventListener('resize', syncToTop);
toTop.addEventListener('click', () => {
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  scrollTo({ top: 0, behavior: calm ? 'auto' : 'smooth' });
});
// The toast's height depends on its message, so the button is told how far to rise.
new ResizeObserver(() => {
  const toast = $('toast');
  document.documentElement.style.setProperty('--toast-room',
    toast.hidden ? '0px' : `calc(${toast.offsetHeight}px + .6rem)`);
}).observe($('toast'));

/** Closes on the X, on Escape, and on a click outside it. */
function wireDialog(id) {
  const dialog = $(id);
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', e => {
    const box = dialog.getBoundingClientRect();
    const inside = e.clientX >= box.left && e.clientX <= box.right
      && e.clientY >= box.top && e.clientY <= box.bottom;
    if (!inside) dialog.close();
  });
  // Embedded webviews do not always deliver the native Escape-to-cancel.
  dialog.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      e.preventDefault();
      dialog.close();
    }
  });
}

wireDialog('about');
wireDialog('get');
wireDialog('warn');
wireDialog('zoom');
$('about-open').addEventListener('click', () => $('about').showModal());
$('install').addEventListener('click', () => $('get').showModal());

/* ------------------------------------------------------------------ *
 * Start
 * ------------------------------------------------------------------ */

loadPrefs();
syncControls();

if (native) {
  // The desktop build is already installed; there is nothing to offer.
  $('install').hidden = true;
  $('desktop-offer').hidden = true;
  wireNative();
  // Whatever the outcome, the boot state has served its purpose.
  loadFromNative().finally(() => document.documentElement.classList.remove('booting'));
} else {
  if (canPickFile) {
    loadHandle()
      .then(async handle => {
        if (!handle) return;
        rememberedHandle = handle;
        // Granted: open straight away. Otherwise offer it, since only a click
        // can restore permission after the browser has been closed.
        if (!await readHandle(handle, { prompt: false })) offerAgain(handle);
      })
      .catch(() => { /* fall back to the drop zone */ });
  }
  if ('serviceWorker' in navigator) {
    addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }

  let installPrompt = null;
  const syncInstall = () => {
    $('install-now').disabled = !installPrompt;
    $('install-note').hidden = !!installPrompt;
  };
  syncInstall();

  addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    installPrompt = e;
    syncInstall();
  });
  addEventListener('appinstalled', () => { installPrompt = null; syncInstall(); });

  $('install-now').addEventListener('click', () => {
    if (!installPrompt) return;
    $('get').close();
    installPrompt.prompt();
    installPrompt = null;
    syncInstall();
  });
}
