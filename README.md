# Atari games in the browser

[![Play in the browser](.github/play-button.svg)](https://nowinskik.github.io/Atari/)
[![Site](https://github.com/NowinskiK/Atari/actions/workflows/site.yml/badge.svg)](https://github.com/NowinskiK/Atari/actions/workflows/site.yml)

A static web page with a catalog of 8-bit Atari games, played in an Atari 800XL emulator: the fixed version of
[Robbo Konstruktor](https://github.com/NowinskiK/lkavalon-atari/tree/main/robbo-konstruktor), Fred, Hans Kloss, Misja and Jaskiniowiec.
The start page is the catalog: search by name or info, and **Load** on a row hides the list, shows the game's
screen and boots it (the first Load starts the emulator). **← Catalog** or the browser's Back returns to the list
and pauses the game. It is published to GitHub Pages by [.github/workflows/site.yml](.github/workflows/site.yml) on every
push to `main`: <https://nowinskik.github.io/Atari/>.

| File | Purpose |
| --- | --- |
| [index.html](index.html) | the page: two views – the catalog (search and a list filled from `games/`) and a game (screen, buttons, keys) |
| [style.css](style.css) | the page's styles |
| [player.js](player.js) | the player: machine, keyboard, gamepad, sound, timing, disk handling, catalog and search, views, per-game controls |
| [firmware/altirraos-xl.rom](firmware/altirraos-xl.rom) | AltirraOS XL/XE – the free replacement OS ([licence](firmware/README.md)) |
| [games/files/robbo-konstruktor.atr](games/files/robbo-konstruktor.atr) | the disk: the fixed version (copy protection off) built in [lkavalon-atari](https://github.com/NowinskiK/lkavalon-atari), `Robbo Konstruktor (1990)(L.K. Avalon)(PL)[cr CAMOsoft 2026].atr` |
| [games/files/](games/files/) `fred.xex`, `hans-kloss.xex`, `misja.xex`, `jaskiniowiec.xex` | Fred, Hans Kloss, Misja and Jaskiniowiec, executables: booted from a write-protected boot disk (`buildBootDisk`) |
| [games/](games/) | the catalog: [catalog.yml](games/catalog.yml) lists the games in order, `<name>.yml` holds each game's settings, an optional `<name>.md` its About text |

## How it works

- Emulator: the headless core [`@sfotty-pie/a8`](https://github.com/cyco130/sfotty-pie) 0.3.0 (MIT), loaded as an
  ES module from jsDelivr (pinned version). Machine: 800XL, PAL, 64 KB, no BASIC (OPTION is held for the first
  30 frames after power-on, like on a real XL; Hans Kloss reboots itself when BASIC is on).
- Disk: the emulator's built-in SIO serves read / write / status on D1:. It has no **format** command, which
  "zapisz Robbo" needs (`IO_FORMAT` $9388 sends `$22`), so `player.js` traps `SIOV` for `$21` / `$22`: it clears
  the image and returns status 1. Saving changes only the image in the browser; **Download disk** saves it as a file.
- Timing: the emulator runs on a 4 ms timer against the wall clock (at most 3 frames of catch-up),
  `requestAnimationFrame` only draws – browsers throttle animation frames in windows that are not in front.
- Keys: PC arrows send Atari Ctrl + the arrow keys (the game masks Ctrl off with `AND #$3F` in `GET_KEY` $3130,
  the title editor needs Ctrl+arrows). Every key stays down for at least 3 frames, so a quick tap is not lost
  between two emulation steps. Key list on the page.
- Sound: POKEY level per machine cycle → averaged per sample, DC removed → an `AudioWorklet` ring buffer
  (starts after the Start click, as browsers require).

## Running locally

The page needs a web server (modules and `fetch` do not work from `file://`). From the repository root:

```bash
py -3 -m http.server 8765 --bind 127.0.0.1     # then open http://127.0.0.1:8765/
```

To add a game, put its `.atr` or `.xex` into [games/files/](games/files/), add its name to [games/catalog.yml](games/catalog.yml) and write
`games/<name>.yml`:

```yaml
title: Hans Kloss
file: hans-kloss.xex                 # disk image (.atr) or executable (.xex) in games/files/
info: LK Avalon, 1992 · by Dariusz Żołna · executable (XEX)   # the grey line on the card
description: "…"                     # optional; quote text that has a colon
basic: false                         # false = OPTION is held at power-on, BASIC off
controls:
  arrows: joystick                   # keys = Atari cursor keys (Ctrl + arrows), joystick = joystick directions
  fire: [Space, ControlLeft]         # more PC keys (KeyboardEvent.code) for the joystick button
```

A game hosted on another site (for example [Saper](games/saper.yml) from atarionline.pl) is not kept in the repository:
add `url:` with the download link next to `file:`. The workflow downloads it into `games/files/<file>` before publishing
(the page cannot fetch it from the other site itself: that site sends no CORS header). Such files are listed in
[.gitignore](.gitignore); to run locally, download the file once yourself, e.g.
`curl -fsSL -o games/files/saper.atr "<url>"`.

For a longer text, add `games/<name>.md`: when it exists, the game's page shows it as **About** (Markdown,
rendered with [marked](https://marked.js.org/) 12.0.2 from jsDelivr), e.g.
[games/robbo-konstruktor.md](games/robbo-konstruktor.md).

Right Ctrl, numpad 0 and the numpad 8 / 2 / 4 / 6 joystick work in every game. A disk loaded with **Load disk…**
gets the default controls (`arrows: keys`, BASIC off).

To update the Robbo disk, copy a new build of the fixed version from lkavalon-atari over
`games/files/robbo-konstruktor.atr` (keep this name: the catalog loads it, and **Download disk** uses it as the file name).

## Publishing

GitHub Pages must be switched on once: repository **Settings → Pages → Build and deployment → Source: GitHub
Actions**. After that every push to `main` that touches the page, the player, a game, the firmware or the
workflow redeploys it.
