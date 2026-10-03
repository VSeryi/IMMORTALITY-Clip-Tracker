'use strict';

const MAX_CLIP_ID = 288;
const GUIDE_URL = 'Immortality_Guide.csv';
const ALL_MOVIES = 'All movies';

/* ------------------------------------------------------------------ *
 * MS-NRBF reader
 * SaveGame.abr is a .NET BinaryFormatter stream. Only the records the
 * save actually uses are implemented, but the walk is a full one so the
 * stream stays in sync.
 * ------------------------------------------------------------------ */

class Ref {
  constructor(target) { this.target = target; }
}

class Nrbf {
  constructor(buffer) {
    this.view = new DataView(buffer);
    this.bytes = new Uint8Array(buffer);
    this.pos = 0;
    this.classes = new Map();
    this.objects = new Map();
    this.rootId = 0;
    this.utf8 = new TextDecoder('utf-8');
  }

  parse() {
    while (this.pos < this.bytes.length) {
      if (this.record().kind === 'end') break;
    }
    return this.objects.get(this.rootId);
  }

  deref(value) {
    let hops = 0;
    while (value instanceof Ref && hops++ < 64) value = this.objects.get(value.target);
    return value;
  }

  byte() { return this.bytes[this.pos++]; }

  int32() {
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }

  string() {
    let length = 0, shift = 0, b;
    do {
      b = this.byte();
      length |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80);
    const s = this.utf8.decode(this.bytes.subarray(this.pos, this.pos + length));
    this.pos += length;
    return s;
  }

  primitive(type) {
    const p = this.pos;
    switch (type) {
      case 1: this.pos += 1; return this.bytes[p] !== 0;
      case 2: this.pos += 1; return this.bytes[p];
      case 3: {
        const b0 = this.bytes[p];
        const n = b0 < 0x80 ? 1 : b0 < 0xe0 ? 2 : b0 < 0xf0 ? 3 : 4;
        this.pos += n;
        return this.utf8.decode(this.bytes.subarray(p, p + n));
      }
      case 5: case 18: return this.string();
      case 6: this.pos += 8; return this.view.getFloat64(p, true);
      case 7: this.pos += 2; return this.view.getInt16(p, true);
      case 8: this.pos += 4; return this.view.getInt32(p, true);
      case 9: case 12: case 13: this.pos += 8; return this.view.getBigInt64(p, true);
      case 10: this.pos += 1; return this.view.getInt8(p);
      case 11: this.pos += 4; return this.view.getFloat32(p, true);
      case 14: this.pos += 2; return this.view.getUint16(p, true);
      case 15: this.pos += 4; return this.view.getUint32(p, true);
      case 16: this.pos += 8; return this.view.getBigUint64(p, true);
      default: throw new Error('unknown primitive type ' + type);
    }
  }

  members(objectId, cls) {
    const obj = {};
    this.objects.set(objectId, obj);            // register first so cycles resolve
    cls.names.forEach((name, i) => {
      obj[name] = cls.types && cls.types[i] === 0
        ? this.primitive(cls.extra[i])
        : this.value();
    });
    return obj;
  }

  classRecord(withTypes, withLibrary) {
    const objectId = this.int32();
    this.string();                              // class name
    const count = this.int32();
    const names = [];
    for (let i = 0; i < count; i++) names.push(this.string());

    let types = null, extra = null;
    if (withTypes) {
      types = [];
      extra = new Array(count).fill(null);
      for (let i = 0; i < count; i++) types.push(this.byte());
      for (let i = 0; i < count; i++) {
        if (types[i] === 0 || types[i] === 7) extra[i] = this.byte();
        else if (types[i] === 3) this.string();
        else if (types[i] === 4) { this.string(); this.int32(); }
      }
    }
    if (withLibrary) this.int32();

    const cls = { names, types, extra };
    this.classes.set(objectId, cls);
    return this.members(objectId, cls);
  }

  elements(objectId, length) {
    const arr = new Array(length).fill(null);
    this.objects.set(objectId, arr);
    let i = 0;
    while (i < length) {
      const r = this.record();
      if (r.kind === 'none') continue;
      if (r.kind === 'end') break;
      if (r.kind === 'null') { i += r.count; continue; }
      arr[i++] = r.value;
    }
    return arr;
  }

  binaryArray() {
    const objectId = this.int32();
    const arrayType = this.byte();
    const rank = this.int32();
    let length = 1;
    for (let i = 0; i < rank; i++) length *= this.int32();
    if (arrayType >= 3 && arrayType <= 5) for (let i = 0; i < rank; i++) this.int32();

    const binType = this.byte();
    let primType = 0;
    if (binType === 0 || binType === 7) primType = this.byte();
    else if (binType === 3) this.string();
    else if (binType === 4) { this.string(); this.int32(); }

    if (binType === 0) {
      const arr = [];
      for (let i = 0; i < length; i++) arr.push(this.primitive(primType));
      this.objects.set(objectId, arr);
      return arr;
    }
    return this.elements(objectId, length);
  }

  value() {
    while (this.pos < this.bytes.length) {
      const r = this.record();
      if (r.kind === 'val') return r.value;
      if (r.kind !== 'none') return null;
    }
    return null;
  }

  record() {
    const type = this.byte();
    switch (type) {
      case 0:                                   // SerializedStreamHeader
        this.rootId = this.int32();
        this.pos += 12;
        return { kind: 'none' };
      case 1: {                                 // ClassWithId
        const objectId = this.int32();
        const metadataId = this.int32();
        return { kind: 'val', value: this.members(objectId, this.classes.get(metadataId)) };
      }
      case 2: return { kind: 'val', value: this.classRecord(false, false) };
      case 3: return { kind: 'val', value: this.classRecord(false, true) };
      case 4: return { kind: 'val', value: this.classRecord(true, false) };
      case 5: return { kind: 'val', value: this.classRecord(true, true) };
      case 6: {                                 // BinaryObjectString
        const objectId = this.int32();
        const value = this.string();
        this.objects.set(objectId, value);
        return { kind: 'val', value };
      }
      case 7: return { kind: 'val', value: this.binaryArray() };
      case 8: return { kind: 'val', value: this.primitive(this.byte()) };
      case 9: return { kind: 'val', value: new Ref(this.int32()) };
      case 10: return { kind: 'null', count: 1 };
      case 11: return { kind: 'end' };
      case 12: this.int32(); this.string(); return { kind: 'none' };
      case 13: return { kind: 'null', count: this.byte() };
      case 14: return { kind: 'null', count: this.int32() };
      case 15: {                                // ArraySinglePrimitive
        const objectId = this.int32();
        const length = this.int32();
        const prim = this.byte();
        const arr = [];
        for (let i = 0; i < length; i++) arr.push(this.primitive(prim));
        this.objects.set(objectId, arr);
        return { kind: 'val', value: arr };
      }
      case 16: case 17: {
        const objectId = this.int32();
        return { kind: 'val', value: this.elements(objectId, this.int32()) };
      }
      default:
        throw new Error('unsupported record type ' + type + ' at ' + (this.pos - 1));
    }
  }
}

/** Returns { watched: Map<id,{views,secret}>, hosts: Map<id,hostId> }. */
function readSave(buffer) {
  const reader = new Nrbf(buffer);
  let root;
  try {
    root = reader.parse();
  } catch {
    throw new Error('That file could not be read. Pick SaveGame.abr from your Immortality folder.');
  }
  if (!root || !root.Game) throw new Error('This does not look like an IMMORTALITY save.');

  const game = reader.deref(root.Game);
  const history = reader.deref(game.ViewHistory);
  const items = reader.deref(history._items) || [];
  const size = Math.min(Number(history._size) || 0, items.length);

  const watched = new Map();
  for (let i = 0; i < size; i++) {
    const viewed = reader.deref(items[i]);
    if (!viewed) continue;
    watched.set(Number(viewed.ClipID), {
      views: Number(viewed.Views),
      secret: !!viewed.IsSupernatural,
    });
  }

  // Randomised per playthrough: which clip each monologue secret hides in.
  const hosts = new Map();
  const assigned = reader.deref(game.AssignedSecrets);
  const pairs = assigned ? reader.deref(assigned.KeyValuePairs) : null;
  for (const entry of pairs || []) {
    const pair = reader.deref(entry);
    if (pair) hosts.set(Number(pair.key), Number(pair.value));
  }

  if (!watched.size) throw new Error('No view history found in that save.');
  return { watched, hosts };
}

/* ------------------------------------------------------------------ *
 * Clip guide
 * ------------------------------------------------------------------ */

function splitCsvLine(line) {
  const cells = [];
  let cell = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c !== '"') { cell += c; continue; }
      if (line[i + 1] === '"') { cell += '"'; i++; continue; }
      quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ';') { cells.push(cell); cell = ''; }
    else cell += c;
  }
  cells.push(cell);
  return cells;
}

const field = (cells, i) => {
  const v = (cells[i] || '').trim();
  return v === '-' ? '' : v;
};

const place = (movie, take, date) => {
  const text = [movie, take].filter(Boolean).join(' ');
  return date ? `${text} (${date})`.trim() : text;
};

function parseGuide(text) {
  const rows = [];
  // Two header rows: the first only groups the "Where To Find" columns.
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/).slice(2)) {
    const cells = splitCsvLine(line);
    const id = parseInt(field(cells, 0), 10);
    if (!Number.isInteger(id) || id < 1 || id > MAX_CLIP_ID) continue;

    const hints = [];
    for (let block = 0; block < 4; block++) {
      const start = 8 + block * 4;
      const keyword = field(cells, start);
      if (!keyword) continue;
      const where = place(field(cells, start + 1), field(cells, start + 2), field(cells, start + 3));
      hints.push(where ? `${keyword} in ${where}` : keyword);
    }

    rows.push({
      kind: field(cells, 1),
      movie: field(cells, 2),
      take: field(cells, 3),
      date: field(cells, 4),
      description: field(cells, 7),
      hints,
      get secret() { return this.kind.startsWith('Secret'); },
    });
  }
  return rows;
}

/**
 * The guide lists a secret right after the clip it hides in, but the game hands
 * out ClipIDs in a different local order, so about one row in twenty ends up
 * describing its neighbour. IsSupernatural in the save is authoritative, so the
 * rows get re-dealt to match that clip/secret pattern.
 */
function alignGuide(rows, watched) {
  const wanted = rows.map((_, i) => {
    const seen = watched.get(i + 1);
    return seen ? seen.secret : null;
  });

  const blanks = wanted.filter(w => w === null).length;
  if (blanks) {
    // When every unwatched clip must be a secret (or must be a regular clip),
    // the arithmetic settles it and the whole list can be aligned.
    const outstanding = rows.filter(r => r.secret).length - wanted.filter(w => w === true).length;
    if (outstanding === 0 || outstanding === blanks) {
      const value = outstanding !== 0;
      for (let i = 0; i < wanted.length; i++) if (wanted[i] === null) wanted[i] = value;
    }
  }

  const used = new Array(rows.length).fill(false);
  const result = new Array(rows.length).fill(null);
  wanted.forEach((want, position) => {
    if (want === null) return;
    for (let i = 0; i < rows.length; i++) {
      if (used[i] || rows[i].secret !== want) continue;
      result[position] = rows[i];
      used[i] = true;
      break;
    }
  });

  const spare = rows.filter((_, i) => !used[i]);
  let next = 0;
  return result.map((row, i) => row || spare[next++] || rows[i]);
}

function buildClips(rows, save) {
  const clips = alignGuide(rows, save.watched).map((row, index) => {
    const id = index + 1;
    const seen = save.watched.get(id);
    return {
      id,
      watched: !!seen,
      secret: seen ? seen.secret : row.secret,
      views: seen ? seen.views : 0,
      kind: row.kind,
      movie: row.movie || 'Other',
      take: row.take,
      date: row.date,
      description: row.description,
      hints: row.hints,
      hostId: save.hosts.get(id) || 0,
      hostLabel: '',
      get title() { return this.take ? `${this.movie} ${this.take}` : this.movie; },
      get subtitle() { return [this.date, this.description].filter(Boolean).join('  ·  '); },
    };
  });

  const labels = new Map(clips.map(c => [c.id, place(c.movie, c.take, c.date)]));
  clips.forEach(c => { if (c.hostId) c.hostLabel = labels.get(c.hostId) || ''; });
  return clips;
}

function routeFor(clip) {
  if (!clip.secret) {
    return clip.hints.length
      ? clip.hints.map(h => 'Match-cut on ' + h)
      : ['No route recorded in the guide.'];
  }
  if (clip.hostId) {
    return ['Rewind clip #' + clip.hostId + (clip.hostLabel ? ' – ' + clip.hostLabel : '')];
  }
  if (!clip.take && !clip.date) return [`Hidden inside the ${clip.movie} clips`];

  const digits = clip.kind.replace(/\D/g, '');
  const depth = digits ? parseInt(digits, 10) : 1;
  const steps = ['Rewind ' + place(clip.movie, clip.take, clip.date)];
  if (depth > 1) steps.push(`Keep rewinding – it is ${depth} levels deep`);
  return steps;
}

/* ------------------------------------------------------------------ *
 * UI
 * ------------------------------------------------------------------ */

const $ = id => document.getElementById(id);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

const state = {
  guide: null,
  clips: [],
  level: 0,          // 0 total, 1 movies, 2 numbers, 3 details, 4 everything
  secrets: false,
  filter: 'missing',
  movie: ALL_MOVIES,
  selected: null,
  revealed: new Set(),
  revealedDetails: new Set(),
};

const inScope = () => state.secrets ? state.clips : state.clips.filter(c => !c.secret);
const showNames = () => state.level >= 3;
const showRoute = clip => state.level >= 4 || state.revealed.has(clip.id);
const showDetails = clip => showNames() || state.revealedDetails.has(clip.id);

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

function render() {
  const scope = inScope();
  const watched = scope.filter(c => c.watched).length;
  const total = scope.length;
  const missing = total - watched;
  const pending = !state.secrets && state.clips.some(c => c.secret && !c.watched);

  $('controls').hidden = false;
  $('intro').hidden = true;
  $('results').hidden = false;

  // header strip — hidden when the big number is the whole screen
  $('totals').hidden = state.level === 0;
  $('watched').textContent = watched;
  $('of-total').textContent = `of ${total} found`;
  $('meter-fill').style.width = total ? (watched / total * 100) + '%' : '0';
  $('headline').innerHTML = (missing === 0 ? 'All found.' : `${missing} still to find`)
    + (pending ? ' <span class="tease">…or maybe not?</span>' : '');

  $('board-total').hidden = state.level !== 0;
  $('board-movies').hidden = state.level !== 1;
  $('browser').hidden = state.level < 2;

  if (state.level === 0) renderTotal(watched, total, missing, pending);
  if (state.level === 1) renderMovies();
  if (state.level >= 2) renderBrowser();
}

function renderTotal(watched, total, missing, pending) {
  const number = $('big-number');
  number.className = missing === 0 ? 'hero done' : 'hero';
  number.textContent = missing === 0 ? 'All found' : missing;
  $('big-caption').innerHTML = missing === 0
    ? (pending ? '<span class="tease" style="color:var(--secret)">…or maybe not?</span>' : '')
    : (missing === 1 ? 'clip still to find' : 'clips still to find');
  $('hero-fill').style.width = total ? (watched / total * 100) + '%' : '0';
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
    meter.style.marginTop = '.7rem';
    const fill = el('i');
    fill.style.width = m.total ? (m.watched / m.total * 100) + '%' : '0';
    meter.append(fill);
    card.append(meter);
    host.append(card);
  }
}

function renderBrowser() {
  // movie sidebar
  const list = $('movie-list');
  list.replaceChildren();
  const entries = [{ name: ALL_MOVIES, tally: '', hidden: 0 }].concat(
    movieSummaries().map(m => ({ name: m.name, tally: `${m.watched}/${m.total}`, hidden: m.hidden })));

  for (const entry of entries) {
    const li = el('li', entry.name === state.movie ? 'on' : '');
    li.append(el('span', '', entry.name));
    if (entry.tally) li.append(el('span', 'tally', entry.tally));
    if (entry.hidden) li.append(el('span', 'star', '*'));
    li.onclick = () => { state.movie = entry.name; state.selected = null; render(); };
    list.append(li);
  }

  // clip list
  let clips = inScope();
  if (state.filter === 'missing') clips = clips.filter(c => !c.watched);
  if (state.filter === 'found') clips = clips.filter(c => c.watched);
  if (state.movie !== ALL_MOVIES) clips = clips.filter(c => c.movie === state.movie);

  $('clip-count').textContent = `${clips.length} clips`;
  const host = $('clips');
  host.replaceChildren();

  if (!state.selected || !clips.some(c => c.id === state.selected)) {
    state.selected = clips.length ? clips[0].id : null;
  }

  for (const clip of clips) {
    const li = el('li', [clip.watched ? 'found' : '', clip.id === state.selected ? 'on' : ''].join(' ').trim());
    li.append(el('span', 'edge'));
    li.append(el('span', 'id', String(clip.id)));

    const text = el('div', 'text');
    text.append(el('div', 'title', showDetails(clip) ? clip.title : 'Clip ' + clip.id));
    text.append(el('div', 'meta', showDetails(clip) ? clip.subtitle : 'details hidden at this setting'));
    li.append(text);

    const tags = el('div', 'tags');
    // Marking an unwatched clip as a secret is itself a hint.
    if (clip.secret && state.secrets && (showNames() || clip.watched)) tags.append(el('span', 'tag secret', 'Secret'));
    if (clip.watched) tags.append(el('span', 'tag found', 'Found'));
    li.append(tags);

    li.onclick = () => { state.selected = clip.id; render(); };
    host.append(li);
  }

  const empty = $('empty');
  empty.hidden = clips.length > 0;
  empty.textContent = state.filter === 'found'
    ? 'You have not found any of these yet.'
    : 'Nothing left to find here.';

  renderDetail(clips.find(c => c.id === state.selected));
}

function renderDetail(clip) {
  const host = $('detail');
  host.replaceChildren();
  host.hidden = !clip;
  if (!clip) return;

  host.append(el('h3', '', 'CLIP ' + clip.id));
  if (showDetails(clip)) host.append(el('p', '', clip.title));
  if (showDetails(clip) && clip.description) host.append(el('p', 'muted', clip.description));

  if (!showDetails(clip)) {
    const reveal = el('button', 'ghost', 'Reveal details');
    reveal.onclick = () => { state.revealedDetails.add(clip.id); render(); };
    host.append(reveal);
  }

  const slate = el('dl', 'slate');
  const add = (key, value) => {
    const row = el('div');
    row.append(el('dt', '', key));
    row.append(el('dd', '', value || '—'));
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
    const steps = el('ul', 'route');
    for (const step of routeFor(clip)) {
      const li = el('li');
      li.append(el('span', 'arrow', '▸'));
      li.append(el('span', '', step));
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
 * Wiring
 * ------------------------------------------------------------------ */

async function loadGuide() {
  if (state.guide) return state.guide;
  const response = await fetch(GUIDE_URL);
  if (!response.ok) throw new Error('Could not load the clip guide.');
  state.guide = parseGuide(await response.text());
  return state.guide;
}

async function handleFile(file) {
  const error = $('error');
  error.hidden = true;
  try {
    const [guide, buffer] = await Promise.all([loadGuide(), file.arrayBuffer()]);
    state.clips = buildClips(guide, readSave(buffer));
    state.selected = null;
    state.revealed.clear();
    state.revealedDetails.clear();
    render();
  } catch (e) {
    error.textContent = e.message || String(e);
    error.hidden = false;
  }
}

const drop = $('drop');
['dragenter', 'dragover'].forEach(name =>
  drop.addEventListener(name, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(name =>
  drop.addEventListener(name, () => drop.classList.remove('over')));
drop.addEventListener('drop', e => {
  e.preventDefault();
  if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});
$('file').addEventListener('change', e => {
  if (e.target.files[0]) handleFile(e.target.files[0]);
});

$('level').addEventListener('change', e => {
  state.level = Number(e.target.value);
  state.revealed.clear();
  state.revealedDetails.clear();
  render();
});

$('secrets').addEventListener('click', e => {
  state.secrets = !state.secrets;
  e.currentTarget.setAttribute('aria-checked', String(state.secrets));
  state.selected = null;
  render();
});

document.querySelectorAll('[data-more]').forEach(button =>
  button.addEventListener('click', () => {
    state.level = Math.min(state.level + 1, 4);
    $('level').value = String(state.level);
    render();
  }));

$('filters').addEventListener('click', e => {
  const button = e.target.closest('button');
  if (!button) return;
  state.filter = button.dataset.filter;
  state.selected = null;
  [...e.currentTarget.children].forEach(b => b.classList.toggle('on', b === button));
  render();
});

$('reset').addEventListener('click', () => {
  state.clips = [];
  $('results').hidden = true;
  $('controls').hidden = true;
  $('intro').hidden = false;
  $('file').value = '';
});

$('about-open').addEventListener('click', () => $('about').showModal());
