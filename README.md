# IMMORTALITY Clip Tracker

[![build](https://github.com/VSeryi/IMMORTALITY-Clip-Tracker/actions/workflows/build.yml/badge.svg)](https://github.com/VSeryi/IMMORTALITY-Clip-Tracker/actions/workflows/build.yml)

Desktop app that reads your [IMMORTALITY](https://store.steampowered.com/app/1350200/IMMORTALITY/)
save and tells you exactly which clips you are still missing — and how to reach
each one.

Windows, macOS and Linux. One self-contained file, nothing to install.

> Heavy spoilers: the clip guide describes every scene in the game. The app
> starts fully guarded and only reveals as much as you ask it to.

## Use it

1. Grab the build for your platform from [Releases](../../releases).
2. Quit the game, so the save on disk is up to date.
3. Run it.

The save is found automatically:

1. `SaveGame.abr` sitting next to the app — drop a
   [Steam Cloud](https://store.steampowered.com/account/remotestorageapp/?appid=1350200)
   download here and it just works
2. the game's own save folder
   - Windows `%USERPROFILE%\AppData\LocalLow\Half Mermaid Productions\Immortality\<steam-id>\`
   - macOS `~/Library/Application Support/Half Mermaid Productions/Immortality/`
   - Linux `~/.config/unity3d/…` or the Proton prefix for app 1350200
3. your `Downloads` folder

Otherwise use **Open save**, or **About**, which lists every folder searched on
your machine plus the Steam Cloud link.

## Spoiler control

Use **Show me** in the header. It starts at the most guarded setting.

| Setting | Shows |
| --- | --- |
| **Total only** *(default)* | how many clips you still have to find, and nothing else |
| Per movie | how many are left in each movie |
| Clip numbers | which numbers are missing; secrets are flagged only once you have found them |
| Clip details | names, dates and what happens in each clip |
| Everything | adds the route: which clip to match-cut or rewind from |

Stuck on one clip? **Reveal details** and **Reveal this clip** open up that one
entry without changing the setting for everything else.

### Secrets

Not every clip is reached the same way. The **Secrets** switch sits next to
*Show me* and applies at every level. It is off by default, which keeps those
clips out of the list and out of every count — including the totals, so the
numbers never hint at what is being left out.

Turn it on whenever you want them included.

## How it works

`SaveGame.abr` is a .NET `BinaryFormatter` (MS-NRBF) stream and is *not*
encrypted, so the app reads it directly with Microsoft's own
[`System.Formats.Nrbf`](https://learn.microsoft.com/dotnet/standard/serialization/binaryformatter-migration-guide/read-nrbf-payloads).
No online save editor, no `jq`, no JSON export. Nothing leaves your machine.

Three things come straight out of the save:

| Field | Used for |
| --- | --- |
| `Game.ViewHistory[].ClipID` | which clips you have watched |
| `ViewedSave.IsSupernatural` | whether a clip is a secret — **authoritative** |
| `Game.AssignedSecrets` | which clip each monologue secret hides in *this* playthrough |

`AssignedSecrets` is randomised per save, so no static guide can know it. That is
why the app can point at the exact clip to revisit instead of offering a vague
hint.

### The clip numbering fix

`Immortality_Guide.csv` lists a secret immediately after the clip it hides in,
but the game hands out `ClipID`s in a different local order — so roughly one row
in twenty ends up describing its neighbour. Taken literally, the guide will claim
you are missing regular clips when you are only missing secrets.

The app re-deals the guide rows onto the real numbering using `IsSupernatural`,
which the save reports for every clip you have watched. Where a clip is unwatched
the count settles it: if the number of unwatched clips equals the number of
secrets still outstanding, every one of them must be a secret.

On a 278/288 save this turns 16 mislabelled entries into 0.

## Build

Needs the [.NET 10 SDK](https://dotnet.microsoft.com/download).

```bash
dotnet run --project src/ImmortalityClipTracker
```

Release builds are single-file, self-contained, trimmed and compressed — one
~21 MB executable that starts in well under a second and needs no runtime:

```bash
dotnet publish src/ImmortalityClipTracker -c Release -r win-x64 -o dist
```

Passing any `-r` runtime identifier switches on the single-file settings, so
there is nothing else to remember. CI uses `win-x64`, `osx-arm64`, `osx-x64` and
`linux-x64`.

Windows and Linux ship the bare executable. macOS ships a `.dmg` because a GUI
program there has to be an `.app` *bundle* — a folder containing
`Contents/MacOS/` and an `Info.plist` — and a folder cannot be a release asset.
The disk image is built with `hdiutil` and includes an `/Applications` shortcut
to drag onto.

### Releasing

Push a tag and the workflow builds all four platforms and publishes a GitHub
release with the binaries attached:

```bash
git tag v1.0.0
git push origin v1.0.0
```

The tag also sets the assembly version — `v1.2.3` becomes `1.2.3`.

### Layout

```
src/ImmortalityClipTracker/
  Models/      Clip, spoiler levels, credits
  Services/    SaveData (NRBF), ClipGuide (CSV + realignment), SaveLocator
  ViewModels/  MainViewModel
  Views/       MainWindow
  Assets/      icon, clip guide
tools/make-icon.ps1   regenerates icon.ico and icon.png
```

Drop an updated `Immortality_Guide.csv` next to the executable to override the
bundled copy.

## Credits

This app is mostly glue. The work it is built on:

| | |
| --- | --- |
| [The clip list](https://steamcommunity.com/sharedfiles/filedetails/?id=3342793414) | every clip with its take, date and match-cut objects — the guide shipped with the app. Derived in turn from the [completionist guide](https://steamcommunity.com/sharedfiles/filedetails/?id=2860754029) |
| [Reading the save](https://steamcommunity.com/sharedfiles/filedetails/?id=3731545899) | worked out that `SaveGame.abr` holds your view history |
| [The idea](https://steamcommunity.com/sharedfiles/filedetails/?id=3204009205) | the original "which videos have I missed" counter |

The same list is in the app under **About**.

Made by [XxSeRyIxX](https://steamcommunity.com/id/xxseryixx/).

## Licence

[GNU AGPL v3](LICENSE) or later. You are free to use, study, modify and share
it. If you distribute a modified version — or run one as a network service — you
must make your source available under the same licence.

The licence covers the application code. `Immortality_Guide.csv` is
community-authored clip data from the guides above. Not affiliated with Half
Mermaid or Sam Barlow. See [NOTICE](NOTICE).
