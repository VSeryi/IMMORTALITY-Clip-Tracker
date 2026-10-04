'use strict';

/**
 * Save parsing and clip logic. No DOM, no globals beyond `Tracker`, and
 * no ES modules so the same file works over http:// and inside the native shell.
 */
const Tracker = (() => {

const CORRUPT = 'not a readable save';

/**
 * Cheap check before committing to a full parse: an MS-NRBF stream opens with a
 * SerializedStreamHeader, which is record type 0 followed by two ids and the
 * version pair 1.0. Anything else is some other kind of file.
 */
function looksLikeSave(bytes) {
  if (!bytes || bytes.length < 17 || bytes[0] !== 0) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getInt32(9, true) === 1 && view.getInt32(13, true) === 0;
}

/* ------------------------------------------------------------------ *
 * MS-NRBF reader
 * SaveGame.abr is a .NET BinaryFormatter stream. Only the records the
 * save actually uses are implemented, but the walk is a full one so the
 * stream stays in sync.
 * ------------------------------------------------------------------ */

class Ref {
  constructor(target) { this.target = target; }
}

// Fixed-size primitives by MS-NRBF type code: [bytes, DataView getter].
const FIXED = {
  1: [1, 'getUint8'], 2: [1, 'getUint8'], 6: [8, 'getFloat64'], 7: [2, 'getInt16'],
  8: [4, 'getInt32'], 9: [8, 'getBigInt64'], 10: [1, 'getInt8'], 11: [4, 'getFloat32'],
  12: [8, 'getBigInt64'], 13: [8, 'getBigInt64'], 14: [2, 'getUint16'], 15: [4, 'getUint32'],
  16: [8, 'getBigUint64'],
};

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
    // A damaged stream can otherwise keep producing plausible-looking records.
    let budget = 4_000_000;
    while (this.pos < this.bytes.length) {
      if (budget-- <= 0) throw new Error(CORRUPT);
      if (this.record().kind === 'end') break;
    }
    return this.objects.get(this.rootId);
  }

  deref(value) {
    let hops = 0;
    while (value instanceof Ref && hops++ < 64) value = this.objects.get(value.target);
    return value;
  }

  /** Every item costs at least one byte, so no count can exceed what is left. */
  bounded(count) {
    if (!Number.isInteger(count) || count < 0 || count > this.bytes.length - this.pos) {
      throw new Error(CORRUPT);
    }
    return count;
  }

  need(size) {
    if (this.pos + size > this.bytes.length) throw new Error(CORRUPT);
  }

  byte() {
    if (this.pos >= this.bytes.length) throw new Error(CORRUPT);
    return this.bytes[this.pos++];
  }

  int32() {
    this.need(4);
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
      if (shift > 35) throw new Error(CORRUPT);
    } while (b & 0x80);
    this.bounded(length);
    const s = this.utf8.decode(this.bytes.subarray(this.pos, this.pos + length));
    this.pos += length;
    return s;
  }

  primitive(type) {
    if (type === 5 || type === 18) return this.string();     // Decimal travels as text, like String
    const p = this.pos;
    if (type === 3) {                                         // Char: one UTF-8 sequence
      this.need(1);
      const b0 = this.bytes[p];
      const n = b0 < 0x80 ? 1 : b0 < 0xe0 ? 2 : b0 < 0xf0 ? 3 : 4;
      this.need(n);
      this.pos += n;
      return this.utf8.decode(this.bytes.subarray(p, p + n));
    }
    const [size, getter] = FIXED[type] || [];
    if (!size) throw new Error(CORRUPT);
    this.need(size);
    this.pos += size;
    const value = this.view[getter](p, true);
    return type === 1 ? value !== 0 : value;
  }

  primitives(objectId, length, type) {
    const arr = [];
    for (let i = 0; i < length; i++) arr.push(this.primitive(type));
    this.objects.set(objectId, arr);
    return arr;
  }

  /** What follows a member's binary type: a primitive type code, or a class name to skip. */
  typeInfo(binaryType) {
    if (binaryType === 0 || binaryType === 7) return this.byte();
    if (binaryType === 3) this.string();
    if (binaryType === 4) { this.string(); this.int32(); }
    return null;
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
    const count = this.bounded(this.int32());
    const names = [];
    for (let i = 0; i < count; i++) names.push(this.string());

    let types = null, extra = null;
    if (withTypes) {
      types = [];
      extra = [];
      for (let i = 0; i < count; i++) types.push(this.byte());
      for (let i = 0; i < count; i++) extra.push(this.typeInfo(types[i]));
    }
    if (withLibrary) this.int32();

    const cls = { names, types, extra };
    this.classes.set(objectId, cls);
    return this.members(objectId, cls);
  }

  elements(objectId, length) {
    this.bounded(length);
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
    const rank = this.bounded(this.int32());
    let length = 1;
    for (let i = 0; i < rank; i++) length *= this.int32();
    this.bounded(length);
    if (arrayType >= 3 && arrayType <= 5) for (let i = 0; i < rank; i++) this.int32();

    const binType = this.byte();
    const primType = this.typeInfo(binType);
    return binType === 0
      ? this.primitives(objectId, length, primType)
      : this.elements(objectId, length);
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
        const length = this.bounded(this.int32());
        return { kind: 'val', value: this.primitives(objectId, length, this.byte()) };
      }
      case 16: case 17: {
        const objectId = this.int32();
        return { kind: 'val', value: this.elements(objectId, this.bounded(this.int32())) };
      }
      default:
        throw new Error(CORRUPT);
    }
  }
}

/** An error carrying a second line of advice for the UI to show. */
function saveError(message, hint) {
  const error = new Error(message);
  error.hint = hint;
  return error;
}

/** Returns { watched: Map<id,{views,secret}>, hosts: Map<id,hostId>, themes: [a,b,c] }. */
function readSave(buffer, name) {
  const file = name ? `“${name}”` : 'That file';
  const bytes = new Uint8Array(buffer);

  if (!looksLikeSave(bytes)) {
    throw saveError(
      `${file} is not an IMMORTALITY save.`,
      'The file you want is called SaveGame.abr. The folders it lives in are listed below.');
  }

  const reader = new Nrbf(buffer);
  let root;
  try {
    root = reader.parse();
  } catch {
    throw saveError(
      `${file} could not be read.`,
      'It looks like a save but the contents are damaged. Try the copy in Steam Cloud.');
  }
  if (!root || !root.Game) {
    throw saveError(
      `${file} is a save, but not from IMMORTALITY.`,
      'Look for SaveGame.abr in the Immortality folder rather than another game\u2019s.');
  }

  const game = reader.deref(root.Game);
  const history = reader.deref(game.ViewHistory);
  const items = reader.deref(history?._items) || [];
  const size = Math.min(Number(history?._size) || 0, items.length);

  const watched = new Map();
  for (let i = 0; i < size; i++) {
    const viewed = reader.deref(items[i]);
    if (!viewed) continue;
    watched.set(Number(viewed.ClipID), {
      views: Number(viewed.Views),
      secret: !!viewed.IsSupernatural,
    });
  }

  // Randomised per playthrough: which clip each free-floating secret landed in.
  const hosts = new Map();
  const assigned = reader.deref(game.AssignedSecrets);
  const pairs = assigned ? reader.deref(assigned.KeyValuePairs) : null;
  for (const entry of pairs || []) {
    const pair = reader.deref(entry);
    if (pair) hosts.set(Number(pair.key), Number(pair.value));
  }

  if (!watched.size) {
    throw saveError(
      `${file} has no clips watched yet.`,
      'Play a little, let the game save, then come back.');
  }
  // Three hidden scores every newly watched clip adds to; the ending needs some of each.
  const themes = ['TotalThemeA', 'TotalThemeB', 'TotalThemeC'].map(key => Number(game[key]));
  return { watched, hosts, themes };
}

/* ------------------------------------------------------------------ *
 * Clips
 *
 * Everything here comes from app/clips.json, which tools/make-data.py reads
 * out of the game itself, so the app only joins it to the save.
 * ------------------------------------------------------------------ */

const label = clip => clip.date ? `${clip.title} (${clip.date})` : clip.title;

function buildClips(data, save) {
  // Clips already holding a free-floating secret, which keep it for good.
  const taken = new Set(save.hosts.values());
  const progress = gameProgress(data, save);
  return data.clips.map(row => {
    const seen = save.watched.get(row.id);
    const clip = {
      ...row,
      watched: !!seen,
      secret: row.kind === 'Secret',
      views: seen ? seen.views : 0,
      // Plain fields, not getters: these are read once per row on every redraw.
      title: row.take ? `${row.movie} ${row.take}` : row.movie,
      subtitle: [row.date, row.line].filter(Boolean).join('  \u00b7  '),
    };
    // A free-floating secret can be in any clip of its pool. The save knows
    // which one it landed in, or else which of them are still free.
    if (row.pool) {
      const host = save.hosts.get(row.id);
      const open = row.enter.filter(way => host ? way.from === host : !taken.has(way.from));
      clip.enter = open.length ? open : row.enter;
      clip.placed = !!host && open.length > 0;
    }
    if (row.ending) clip.ending = endingProgress(row.ending, save);
    if (row.gate) {
      clip.progress = progress;
      clip.heldBack = progress === null || progress < row.gate;
    }
    return clip;
  });
}

/**
 * How much of the game the save has seen, in percent, measured as the game
 * measures it for every gate: the theme scores so far over their maximum.
 * Each ending threshold is a quarter of one of those maximums.
 */
function gameProgress(data, save) {
  const quarters = data.clips.find(row => row.ending)?.ending.themes;
  if (!quarters || save.themes.some(Number.isNaN)) return null;
  const sum = values => values.reduce((a, b) => a + b, 0);
  return 100 * sum(save.themes) / (4 * sum(quarters));
}

function endingProgress(need, save) {
  const seen = [...save.watched.values()];
  return {
    ...need,
    watched: save.watched.size,
    secretsSeen: seen.filter(clip => clip.secret).length,
    missing: need.clips.filter(id => !save.watched.has(id)),
    themesMet: save.themes.some(Number.isNaN) ? null
      : need.themes.every((amount, i) => save.themes[i] >= amount - 0.001),
  };
}

/** Seconds into a clip, written the way a player reads a scrubber. */
const clock = seconds => {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
};

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const either = (items, word) => items.length < 2 ? String(items[0])
  : `${items.slice(0, -1).join(', ')} ${word} ${items[items.length - 1]}`;

const step = (text, note = '', pic = '', mark = null) => ({ text, note, pic, mark });

function cutStep(route, byId) {
  const from = byId.get(route.shot);
  const note = [
    route.at !== undefined ? 'at ' + clock(route.at) : '',
    // Only when no ordinary clip holds the object; the generator avoids it otherwise.
    from.secret ? 'starts in a secret' : '',
    route.lands === 1 ? 'always cuts here'
      : `cuts here or to ${plural(route.lands - 1, 'other clip')}${route.mutual ? ' that have it too' : ''}`,
    // Already said above when they are the very clips it can cut to.
    route.also && !route.mutual ? `also in ${plural(route.also, 'other clip')}` : '',
  ].filter(Boolean).join('  \u00b7  ');
  return step(`Match-cut on ${route.object} in ${label(from)}`,
    note, route.pic || String(route.shot), route.box || null);
}

// What to press: a secret opens only in its own speed range, and the arrow keys
// swap direction inside a clip that plays reversed.
const SPEED = {
  slow: 'at half speed: hold , (comma)',
  fast: 'at 1x to 8x: press \u2190 or A',
  reversed: 'at 1x to 8x: press \u2192 or D, as this clip plays reversed',
};

function rewindStep(way, byId) {
  const host = byId.get(way.from);
  const [from, to] = way.at;
  const when = to - from < 1 ? `past ${clock(from)}` : `from ${clock(to)} back to ${clock(from)}`;
  // A secret's own picture is not shown until the player has found it.
  return step(`Rewind clip ${host.id}, ${label(host)}, ${when}`, SPEED[way.speed], host.secret ? '' : String(host.id));
}

function secretSteps(clip, byId) {
  const ways = clip.enter || [];
  if (clip.pool && !clip.placed) {
    const more = ways.length - 3;
    return [
      step(`It can turn up in ${ways.length > 1 ? `any of ${ways.length} clips` : 'this clip'}`,
        `opening ${ways.length > 1 ? 'one' : 'it'} can place a secret there for good, by chance. Rewind at the moment shown; if nothing appears, go back to the grid and open it again`),
      ...ways.slice(0, 3).map(way => rewindStep(way, byId)),
      ...(more > 0 ? [step(`or ${plural(more, 'more clip')} like these`)] : []),
    ];
  }
  // A secret inside a secret: walk back to the ordinary clip the chain starts in.
  const chain = [];
  for (let at = clip; at && at.secret && at.enter && chain.length < 8; at = byId.get(at.enter[0].from)) {
    chain.unshift(at.enter[0]);
  }
  return chain.map(way => rewindStep(way, byId));
}

function endingSteps(e) {
  const tally = (have, need) => have >= need ? 'done' : `you have ${have}`;
  return [
    step(`Watch ${e.watch} different clips`, tally(e.watched, e.watch)),
    step(`Find ${e.secrets} secrets`, tally(e.secretsSeen, e.secrets)),
    step(`Watch clips ${either(e.clips, 'and')}`, e.missing.length ? `still to find: ${e.missing.join(', ')}` : 'done'),
    step('Reach a quarter of each of three hidden scores',
      e.themesMet === null ? 'every new clip you watch adds to them'
        : e.themesMet ? 'done' : 'not yet: every new clip you watch adds to them'),
    step(`Then open one of ${e.key.length} key clips, such as ${either(e.clips, 'or')}, and go back to the grid`,
      'the ending starts there once all of the above is true'),
    step('This clip then takes over the grid tile by tile, fills the screen and plays into the credits'),
  ];
}

/**
 * How to reach a clip, as steps of { text, note, pic, mark }: `pic` names a
 * picture in pictures.json and `mark` is the box to ring on it.
 */
function routeFor(clip, byId) {
  if (clip.ending) return endingSteps(clip.ending);
  const steps = clip.secret ? secretSteps(clip, byId) : clip.routes.map(route => cutStep(route, byId));
  if (clip.heldBack) {
    steps.push(step(`Only once about ${Math.round(clip.gate)}% of the game is watched`,
      clip.progress === null ? 'the game holds it back until then'
        : `you are at about ${Math.floor(clip.progress)}%, and every new clip you watch adds to it`));
  }
  return steps;
}

return { looksLikeSave, saveError, readSave, buildClips, routeFor };
})();
