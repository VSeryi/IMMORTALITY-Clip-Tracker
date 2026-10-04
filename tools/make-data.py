"""
Builds everything the tracker knows about the game from a local IMMORTALITY
install, so the app itself only ever reads the results.

    app/clips.json     every clip as the game describes it: film, take, date,
                       its first line, and every way to reach it
    app/pictures.bin   a still for every clip and a frame for every match-cut
    app/pictures.json  where each picture sits inside pictures.bin
    app/pictures.txt   the licence notice for those pictures

Windows only, because frames are decoded by the game's own Bink runtime.
Run by hand:

    python -m venv tools/.venv
    tools/.venv/Scripts/python -m pip install Pillow UnityPy
    tools/.venv/Scripts/python tools/make-data.py "<game>/Immortality_Data"

Pictures already made are kept in tools/.work, so running it again only makes
what is new. The pictures are NOT covered by this project's licence; see NOTICE.
"""
import ctypes
import datetime
import html
import json
import math
import os
import re
import struct
import sys

import UnityPy
from PIL import Image, ImageOps, ImageStat

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(os.path.dirname(HERE), "app")
WORK = os.path.join(HERE, ".work")

MAX_CLIP = 288     # 289 is the ending's last shot and 290 the menu's backdrop
ENDING_CLIP = 288  # nothing leads here; the game starts it once enough is seen
BOX = (480, 270)   # every picture is padded to this, so the app never reasons about shape
QUALITY = 74
ROUTES = 4         # match-cuts offered per clip
CROWDED = 12       # a click that can land on more clips than this is a poor way in

FILMS = {1: "Ambrosio", 2: "Minsky", 3: "2OE"}
NORMAL, SUPERNATURAL, FREE_FLOATING = 0, 1, 3   # VideoType; the game never uses 2


# ---------------------------------------------------------------------------
# The game's data
#
# One 32 MB MonoBehaviour in sharedassets4.assets, the game's MetaData, holds
# every clip and every match-cut. It has no type tree, so it is read field by
# field in the order the game's own classes declare them (MetaData, VideoData,
# MaskData and the rest, in Managed/Assembly-CSharp.dll). Nothing is searched
# for or skipped, and the read must end on the table's last byte, so a change
# in the layout fails loudly instead of drifting into plausible nonsense.
# ---------------------------------------------------------------------------

class Reader:
    """Unity's layout: little-endian, lists led by their length, strings and
    bools padded to 4 bytes."""

    def __init__(self, data, at):
        self.data, self.at = data, at

    def take(self, fmt):
        values = struct.unpack_from(fmt, self.data, self.at)
        self.at += struct.calcsize(fmt)
        return values

    def i32(self):
        return self.take("<i")[0]

    def flag(self):
        value = self.i32()
        if value not in (0, 1):
            raise ValueError(f"no bool at byte {self.at - 4}")
        return value == 1

    def text(self):
        n = self.i32()
        if not 0 <= n <= len(self.data) - self.at:
            raise ValueError(f"no string at byte {self.at - 4}")
        value = self.data[self.at:self.at + n].decode("utf-8")
        self.at += (n + 3) & ~3
        return value

    def many(self, item):
        n = self.i32()
        if not 0 <= n <= len(self.data) - self.at:
            raise ValueError(f"no list at byte {self.at - 4}")
        return [item(self) for _ in range(n)]

    def outline(self):
        return self.take(f"<{2 * self.i32()}f")


def keyframe(r):
    """KeyData: an outline from 0 to 1 across the video, y from the bottom, and
    the 1-based frame it is drawn on. Off-screen parking spots are not valid."""
    outline = r.outline()
    time, frame = r.take("<dq")
    valid = r.flag()
    if not valid or len(outline) < 6:
        return None
    xs, ys = outline[0::2], outline[1::2]
    return frame - 1, time, min(xs), min(ys), max(xs), max(ys)


def mask(r):
    """MaskData: one clickable thing. A click searches its name up to any "-",
    plus every name in its valid links."""
    r.i32()                                    # mask type
    keys = [k for k in r.many(keyframe) if k]
    links = r.many(Reader.text)
    r.take("<4f")                              # outline colour
    name = r.text()
    r.text()                                   # achievement
    return {"name": name, "keys": keys, "links": links, "word": r.text()}


def subtitle(r):
    """SubtitleData: key, speaker, text, start, end."""
    r.text()
    r.text()
    text = r.text()
    r.take("<2f")
    return text


def segment(r):
    """SegmentData: start, end, slowest and fastest speed, and the clip it is in."""
    return r.take("<4fi")


def secret(r):
    """SecretData: a stretch of the clip that opens another one when played
    through it at a speed in range. A free-floating one opens one of a pool."""
    start, end, low, high, _ = segment(r)
    r.take("<6f")                              # fades, hint speeds, offset, speed on arrival
    to = r.i32()
    pool = r.many(Reader.i32)
    r.flag()                                   # sets the speed on arrival
    r.flag()                                   # always active
    r.take("<3i")                              # blend mode, direction, type
    return {"at": (start, end), "speed": (low, high), "to": to, "pool": pool}


def video(r):
    """VideoData."""
    v = {"masks": r.many(mask), "lines": r.many(subtitle), "secrets": r.many(secret)}
    r.many(segment)                            # stretches that switch outlines off
    r.take("<iq")                              # the thumbnail sprite
    width, height = r.take("<2f")
    (ticks,) = r.take("<q")
    r.text()                                   # file name
    (seconds, fps, _, *themes, _, importance, gate,
     _, _, _) = r.take("<12f")                 # last three: start time, music in and out
    v.update(shape=(round(width), round(height)), seconds=seconds, fps=fps, themes=themes,
             importance=importance, gate=gate, ticks=ticks)
    v["id"], v["movie"], v["scene"] = r.take("<3i")
    v["camera"] = r.text()
    _, _, v["type"], _ = r.take("<4i")         # audio either way, VideoType, film filter
    r.flag()                                   # hidden from the grid
    v["reversed"] = r.flag()
    r.flag()                                   # shown in the menu
    return v


def link(r):
    """VideoLinkData: a name, and every clip a cut on it can land in."""
    def entry(r):
        clip = r.i32()
        return clip, len(r.many(point))

    def point(r):
        r.outline()
        r.text()
        r.take("<fdd")

    return r.text(), r.many(entry)


def read_game(assets):
    """Every clip and every match-cut name, from sharedassets4.assets."""
    table = max((o for o in assets.objects if o.type.name == "MonoBehaviour"), key=lambda o: o.byte_size)
    r = Reader(bytes(table.get_raw_data()), 28)    # past the MonoBehaviour header
    if r.text() != "Videos":
        sys.exit("sharedassets4.assets has no clip table; is this IMMORTALITY?")
    videos = {v["id"]: v for v in r.many(video)}
    links = dict(r.many(link))
    if r.at != len(r.data) or sorted(videos)[:MAX_CLIP] != list(range(1, MAX_CLIP + 1)):
        sys.exit(f"the clip table ends at byte {r.at} of {len(r.data)}; its layout has changed")

    # A keyframe placed past either end of a clip keeps its time but has its
    # frame number clamped, so it describes a moment the video does not have.
    kept = dropped = 0
    for v in videos.values():
        for m in v["masks"]:
            fine = [k for k in m["keys"] if abs(k[0] - k[1] * v["fps"]) <= 1]
            kept, dropped = kept + len(fine), dropped + len(m["keys"]) - len(fine)
            m["keys"] = fine
    if dropped > kept / 1000:
        sys.exit(f"{dropped} keyframes disagree with their own frame number; the frame rate is misread")
    print(f"  {len(videos)} clips, {len(links)} match-cut names, {kept} clickable keyframes"
          f" ({dropped} past a clip's end)")
    return videos, links


def read_words(data_dir):
    """The game's English text, from its string table in resources.assets."""
    for obj in UnityPy.load(os.path.join(data_dir, "resources.assets")).objects:
        if obj.type.name != "MonoBehaviour":
            continue
        data = bytes(obj.get_raw_data())
        if data[28:40] == b"\x07\0\0\0English\0":
            r = Reader(data, 40)
            words = dict(r.many(lambda r: (r.text(), r.text())))
            if r.at == len(data) and "S_MovieName_1" in words:
                return words
    sys.exit("resources.assets has no English string table; is this IMMORTALITY?")


# ---------------------------------------------------------------------------
# Words
# ---------------------------------------------------------------------------

def labelled(v):
    """Film, take and date as the game writes them under a clip: the take is its
    scene number and camera letter. Clips outside the three films get neither."""
    if v["movie"] not in FILMS:
        return {"movie": "Other", "take": "", "date": ""}
    day = datetime.datetime(1, 1, 1) + datetime.timedelta(microseconds=v["ticks"] // 10)
    return {"movie": FILMS[v["movie"]], "take": f"{v['scene'] or ''}{v['camera']}", "date": f"{day:%d/%m/%Y}"}


def spaced(name):
    """A name the game gives no words for, made readable: "kiss_hand" is "Kiss hand"."""
    return name.split("-")[0].replace("_", " ").capitalize()


def spoken(text):
    """Subtitles carry markup for the renderer; a one-line reminder wants none of it."""
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]*>", "", text))).strip()


# ---------------------------------------------------------------------------
# Routes
#
# A click searches as the game's Database.DoSearch does: the outline's name up
# to any "-", then each name in its valid links, each looked up in the game's
# own table of the clips a cut on that name can land in. It never lands on a
# secret or on the clip it starts from.
# ---------------------------------------------------------------------------

def cuts(videos, links, words):
    """Every clickable outline, as {(clip, outline): (its name, the clips it can cut to)}."""
    found = {}
    for clip in range(1, MAX_CLIP + 1):
        for i, m in enumerate(videos[clip]["masks"]):
            if not m["keys"]:
                continue
            base = m["name"].split("-")[0]
            lands = set()
            for name in [base] + [n for n in m["links"] if n != base]:
                for to, ways in links.get(name, ()):
                    if ways and to != clip and to <= MAX_CLIP and videos[to]["type"] != SUPERNATURAL:
                        lands.add(to)
            if lands:
                found[(clip, i)] = (words.get(m["word"]) or spaced(m["name"]), lands)
    return found


def routes_into(target, clickable, videos):
    """The ways into a clip, best first, one per object, as (object, outlines to
    click, how many clips the click can land on, how many other clips it can be
    clicked in, and whether those are the very clips it can land on). A secret
    is a starting point only when nothing ordinary will do, since the player
    has to find it first; after that the surest cut wins."""
    by_name = {}
    for (source, i), (name, lands) in clickable.items():
        if target in lands:
            rank = (videos[source]["type"] != NORMAL, len(lands))
            by_name.setdefault(name, []).append((rank, source, i))
    options = []
    for name, found in by_name.items():
        found.sort()
        best = found[0][0]
        sources = {source for rank, source, _ in found if rank[0] == best[0]}
        outlines = [(s, i) for rank, s, i in found if rank == best]
        mutual = all(clickable[(s, i)][1] - {target} == sources - {s} for s, i in outlines)
        options.append((best, name, outlines, len(sources) - 1, mutual))
    options.sort(key=lambda option: option[:2])
    good = [option for option in options if not option[0][0] and option[0][1] <= CROWDED]
    return [(name, outlines, best[1], also, mutual)
            for best, name, outlines, also, mutual in (good if len(good) >= 2 else options)[:ROUTES]]


def ranked_frames(videos, source, i, memo):
    """The frames at which an outline is clickable and mostly in shot, best first:
    bigger is clearer and earlier is quicker, though the first half second is
    often a fade or the tail of the slate."""
    if (source, i) not in memo:
        found = []
        for frame, time, x0, y0, x1, y1 in videos[source]["masks"][i]["keys"]:
            area = (x1 - x0) * (y1 - y0)
            seen = max(0, min(x1, 1) - max(x0, 0)) * max(0, min(y1, 1) - max(y0, 0))
            if area <= 0 or seen < 0.75 * area:
                continue
            value = min(seen, 0.06) / 0.06 - time / 120 - 0.4 * (time < 0.5)
            if x1 - x0 > 0.9 and y1 - y0 > 0.9:
                value -= 0.5               # television static: true, but says little
            found.append((value, frame, time, (x0, y0, x1, y1)))
        found.sort(key=lambda option: -option[0])
        memo[(source, i)] = found
    return memo[(source, i)]


def choose(routes, videos, failed, made, memo):
    """One frame per route. Routes with the fewest options choose first, and
    the rest lean towards frames already chosen or already made, so routes to
    one object share one picture."""
    jobs = sorted(((clip, name, outlines) for clip, offered in routes.items() for name, outlines, *_ in offered),
                  key=lambda job: len(job[2]))
    picks, used = {}, set()
    for clip, name, outlines in jobs:
        best, top = None, None
        for source, i in outlines:
            looked = 0
            for value, frame, time, box in ranked_frames(videos, source, i, memo):
                if (source, frame) in failed:
                    continue
                value += 0.3 * ((source, frame) in used) + 0.2 * ((source, frame) in made)
                if top is None or value > top:
                    best, top = (source, frame, time, box), value
                looked += 1
                if looked == 6:
                    break
        picks[(clip, name)] = best
        if best:
            used.add(best[:2])
    return picks


# ---------------------------------------------------------------------------
# Secrets and the ending
# ---------------------------------------------------------------------------

def entrances(videos):
    """How each secret opens, from the clips that hide it: which clip, which
    stretch of it, and how fast to play through it. A secret opens only while
    that stretch plays backwards. A slow one needs half speed, which holding
    the comma key gives in any clip; a fast one needs 1x to 8x, which the arrow
    keys give, though inside a clip that plays reversed they swap direction.
    A free-floating secret is in the pool of many clips; opening one that holds
    none yet may place one of its pool there, by chance, and it stays for good."""
    ways = {}
    for host in range(1, MAX_CLIP + 1):
        v = videos[host]
        for s in v["secrets"]:
            low, high = s["speed"]
            speed = "slow" if high - low < 1 else "reversed" if v["reversed"] else "fast"
            for to in [s["to"]] if s["to"] > 0 else s["pool"]:
                if videos[to]["type"] == NORMAL:
                    continue                        # a way back out
                # Speeds are as the player sets them, which a reversed clip plays backwards.
                if (low > 0) != v["reversed"] or low * high <= 0:
                    sys.exit(f"clip {host} opens {to} played forwards; the app only says rewind")
                ways.setdefault(to, []).append({"from": host, "at": [round(t, 1) for t in s["at"]], "speed": speed})
    return ways


def ending(videos):
    """What starts the ending, from Game.CheckEndgame. Each time you leave a clip
    for the grid, it starts if 40% of every clip has been watched, a quarter of
    each of the three hidden theme scores is reached, 5 secrets and clips 188,
    267 and 269 have been seen, and the clip just left matters enough (0.75)."""
    most = [0.0, 0.0, 0.0]                       # MetaData.MaxThemeScoreV
    for v in videos.values():
        size = math.sqrt(sum(t * t for t in v["themes"]))
        if size > 1e-5:
            most = [m + t / size for m, t in zip(most, v["themes"])]
    return {"watch": -(-len(videos) * 2 // 5), "secrets": 5, "clips": [188, 267, 269],
            "themes": [round(m / 4, 3) for m in most],
            "key": [c for c in range(1, MAX_CLIP + 1) if videos[c]["importance"] >= 0.75]}


# ---------------------------------------------------------------------------
# Pictures
# ---------------------------------------------------------------------------

def picture_box(box, shape):
    """The game measures across the video from the bottom left; the picture is that
    video letterboxed into BOX and measured from the top left."""
    x0, y0, x1, y1 = (min(max(v, 0.0), 1.0) for v in box)
    scale = min(BOX[0] / shape[0], BOX[1] / shape[1])
    cw, ch = shape[0] * scale / BOX[0], shape[1] * scale / BOX[1]
    ox, oy = (1 - cw) / 2, (1 - ch) / 2
    return [round(v, 3) for v in (ox + x0 * cw, oy + (1 - y1) * ch, (x1 - x0) * cw, (y1 - y0) * ch)]


def fit(img):
    """Same box for every picture: bars, never cropping."""
    return ImageOps.pad(img.convert("RGB"), BOX, method=Image.LANCZOS, color=(0, 0, 0))


def blank(img):
    """Black, or one flat colour: two secrets' posters were never painted."""
    stat = ImageStat.Stat(img.convert("L"))
    return stat.mean[0] < 10 or stat.stddev[0] < 6


def usable(path):
    if not os.path.exists(path):
        return False
    with Image.open(path) as img:
        return not blank(img)


class Bink:
    """The game's own Bink 2 runtime, from its Plugins folder. It decodes every
    clip exactly as the game plays it and goes straight to any frame. The
    reverse-engineered decoder in ffmpeg crashed on, or smeared, four clips in
    ten, and could only reach a frame by decoding everything before it."""

    BGRX, COPY_ALL = 3, 0x80000000

    def __init__(self, data_dir):
        plugins = os.path.join(data_dir, "Plugins", "x86_64")
        os.add_dll_directory(plugins)
        dll = ctypes.CDLL(os.path.join(plugins, "bink2w64.dll"))
        handle, u32 = ctypes.c_void_p, ctypes.c_uint32
        dll.BinkOpen.argtypes, dll.BinkOpen.restype = [ctypes.c_char_p, u32], handle
        dll.BinkGoto.argtypes = [handle, u32, ctypes.c_int32]
        dll.BinkDoFrame.argtypes = [handle]
        dll.BinkCopyToBuffer.argtypes = [handle, ctypes.c_void_p, ctypes.c_int32, u32, u32, u32, u32]
        dll.BinkClose.argtypes = [handle]
        dll.BinkGetError.restype = ctypes.c_char_p
        self.dll = dll
        self.folder = os.path.join(data_dir, "StreamingAssets")

    def frames(self, clip, wanted):
        """{frame: picture} for every wanted frame the clip has."""
        dll = self.dll
        # BinkOpen takes an ANSI path.
        bink = dll.BinkOpen(os.path.join(self.folder, f"IMM_{clip:03d}.bk2").encode("mbcs"), 0)
        if not bink:
            print(f"  clip {clip}: {dll.BinkGetError().decode(errors='replace')}")
            return {}
        try:
            width, height, total = (ctypes.c_uint32 * 3).from_address(bink)   # HBINK opens with these
            buffer = ctypes.create_string_buffer(width * height * 4)
            out = {}
            for frame in sorted(f for f in wanted if 0 <= f < total):
                dll.BinkGoto(bink, frame + 1, 0)            # Bink counts frames from 1
                dll.BinkDoFrame(bink)
                dll.BinkCopyToBuffer(bink, buffer, width * 4, height, 0, 0, self.BGRX | self.COPY_ALL)
                out[frame] = fit(Image.frombuffer("RGB", (width, height), buffer.raw, "raw", "BGRX", width * 4, 1))
            return out
        finally:
            dll.BinkClose(bink)


def make_stills(assets, videos, bink):
    """The game's own poster for each clip, or a frame from the clip when the
    poster is missing or blank."""
    folder = os.path.join(WORK, "stills")
    os.makedirs(folder, exist_ok=True)
    path = lambda clip: os.path.join(folder, f"{clip:03d}.webp")
    wanted = [c for c in range(1, MAX_CLIP + 1) if not usable(path(c))]
    if wanted:
        print(f"stills: {len(wanted)} to make")
        posters = {}
        for obj in assets.objects:
            if obj.type.name == "Texture2D":
                tex = obj.read()
                if re.fullmatch(r"IMM_\d{3}", tex.m_Name or ""):
                    posters[int(tex.m_Name[4:])] = tex
        for clip in wanted:
            img = posters[clip].image if clip in posters else None
            if img is None or blank(img):
                span = videos[clip]["seconds"] * videos[clip]["fps"]
                got = bink.frames(clip, [round(span * f) for f in (0.1, 0.25, 0.45, 0.7)])
                img = next((got[f] for f in sorted(got) if not blank(got[f])), None)
                print(f"  clip {clip}: poster unusable, {'took a frame instead' if img else 'NO PICTURE'}")
            if img is not None:
                fit(img).save(path(clip), "WEBP", quality=QUALITY, method=6)
    return {clip: path(clip) for clip in range(1, MAX_CLIP + 1) if os.path.exists(path(clip))}


def make_frames(routes, videos, bink):
    """A frame for every route, decoding only what is not made yet. A frame the
    clip turns out not to have, or that is blank, is ruled out and that route
    chooses again."""
    folder = os.path.join(WORK, "frames")
    os.makedirs(folder, exist_ok=True)
    path = lambda clip, frame: os.path.join(folder, f"{clip}_{frame}.webp")
    made, failed, memo = set(), set(), {}
    for name in os.listdir(folder):
        if name.endswith(".webp"):
            shot = tuple(map(int, name[:-5].split("_")))
            (made if usable(os.path.join(folder, name)) else failed).add(shot)
    while True:
        picks = choose(routes, videos, failed, made, memo)
        missing = {}
        for pick in picks.values():
            if pick and pick[:2] not in made:
                missing.setdefault(pick[0], set()).add(pick[1])
        if not missing:
            return picks, path
        print(f"frames: decoding {sum(map(len, missing.values()))} from {len(missing)} clips")
        for clip, frames in sorted(missing.items()):
            got = bink.frames(clip, frames)
            for frame in frames:
                if frame in got and not blank(got[frame]):
                    got[frame].save(path(clip, frame), "WEBP", quality=QUALITY, method=6)
                    made.add((clip, frame))
                else:
                    failed.add((clip, frame))


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

NOTICE = """\
app/pictures.bin holds frames from IMMORTALITY.

    Copyright (c) Half Mermaid Productions. All rights reserved.

They are NOT part of this project's source code and are NOT covered by its
GNU AGPL v3 licence. They are included only as small pictures so the tracker
can show you which clip is which and where a match-cut starts, and must not be
redistributed separately or treated as freely licensed material.

They are packed into a single archive rather than left loose because the game
contains nudity and heavy spoilers, and a folder of its frames is neither a
reasonable thing to browse by accident nor to have rendered in a repository.
That is packaging, not protection.

This project is not affiliated with, endorsed by, or connected to Half Mermaid
Productions or Sam Barlow.

If you are the rights holder and would like these removed, open an issue at
https://github.com/VSeryi/IMMORTALITY-Clip-Tracker and they will be taken out
immediately, no questions asked.

IMMORTALITY: https://store.steampowered.com/app/1350200/IMMORTALITY/
"""


def write(clips, entries):
    with open(os.path.join(APP, "clips.json"), "w", encoding="utf-8") as fh:
        json.dump({"clips": clips}, fh, ensure_ascii=False, separators=(",", ":"))

    blob, index = bytearray(), {}
    for key, path in entries:
        with open(path, "rb") as fh:
            data = fh.read()
        index[key] = [len(blob), len(data)]
        blob += data
    with open(os.path.join(APP, "pictures.bin"), "wb") as fh:
        fh.write(blob)
    with open(os.path.join(APP, "pictures.json"), "w", encoding="utf-8") as fh:
        json.dump({"box": list(BOX), "at": index}, fh, separators=(",", ":"))
    with open(os.path.join(APP, "pictures.txt"), "w", encoding="utf-8", newline="\n") as fh:
        fh.write(NOTICE)
    return len(blob)


def main(data_dir):
    print("reading the game...")
    assets = UnityPy.load(os.path.join(data_dir, "sharedassets4.assets"))
    videos, links = read_game(assets)
    words = read_words(data_dir)
    clickable = cuts(videos, links, words)
    # A secret is reached by rewinding, never by a match-cut, so it has no routes.
    routes = {clip: routes_into(clip, clickable, videos)
              for clip in range(1, MAX_CLIP + 1) if videos[clip]["type"] == NORMAL}
    ways = entrances(videos)
    lost = [c for c, offered in routes.items() if not offered]
    lost += [c for c in range(1, MAX_CLIP + 1) if c not in routes and c not in ways and c != ENDING_CLIP]
    if lost:
        sys.exit(f"no way into clips {lost}")
    bink = Bink(data_dir)
    stills = make_stills(assets, videos, bink)
    picks, frame_path = make_frames(routes, videos, bink)

    clips, entries, packed, blind = [], [(str(c), p) for c, p in stills.items()], set(), []
    for clip in range(1, MAX_CLIP + 1):
        v = videos[clip]
        row = {"id": clip, **labelled(v), "kind": "Clip" if v["type"] == NORMAL else "Secret",
               "line": spoken(v["lines"][0]) if v["lines"] else ""}
        # Neither a match-cut nor a rewind reaches it before this much of the game is seen.
        if v["gate"] > 0:
            row["gate"] = round(v["gate"] * 100, 1)
        if clip in routes:
            row["routes"] = []
            for name, outlines, lands, also, mutual in routes[clip]:
                route = {"object": name, "shot": outlines[0][0], "lands": lands, "also": also}
                if mutual and lands > 1:
                    route["mutual"] = True
                pick = picks[(clip, name)]
                if pick:
                    source, frame, time, box = pick
                    key = f"{source}@{frame}"
                    route.update(shot=source, at=round(time, 1), pic=key,
                                 box=picture_box(box, videos[source]["shape"]))
                    if key not in packed:
                        packed.add(key)
                        entries.append((key, frame_path(source, frame)))
                else:
                    blind.append(f"clip {clip}: {name}")
                row["routes"].append(route)
        if clip in ways:
            row["enter"] = ways[clip]
        if v["type"] == FREE_FLOATING:
            row["pool"] = True
        if clip == ENDING_CLIP:
            row["ending"] = ending(videos)
            row["line"] = row["line"] or "The ending"     # nothing is said in it, and the game names it nowhere
        clips.append(row)

    size = write(clips, entries)
    shown = [r for c in clips for r in c.get("routes", ())]
    print(f"wrote app/clips.json: {MAX_CLIP} clips, {len(shown)} match-cuts, {len(shown) - len(blind)} with a ring,"
          f" {sum(r['lands'] == 1 for r in shown)} that always land, {sum(len(w) for w in ways.values())}"
          f" ways into {len(ways)} secrets")
    print(f"wrote app/pictures.bin: {len(stills)} stills, {len(packed)} frames, {size / 1024 / 1024:.1f} MB")
    for line in blind:
        print(f"  no frame shows the object: {line}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    main(sys.argv[1])
