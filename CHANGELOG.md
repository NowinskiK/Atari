# Changelog

Notable changes to the site, the player and the game catalog.

<!-- Shown on the site by changelog/index.html. The format follows https://keepachangelog.com/en/1.1.0/. Add new
entries under an "## Unreleased" heading. To release, change that heading to "## <version> - <date>": the newest
version heading is what the Site workflow shows in the page footer. -->

## 1.0 - 2026-10-30

### Added

- First version: the catalog with search, the browser player, per-game controls and About texts.
- Problem Jasia and Problem Jasia 2 in the catalog.
- This changelog, as a page on the site.
- Changelog link and version in the page footer; the version is stamped when the site is published.
- Links to a game: `#<name>` opens that game and runs it at once (the sound starts with the first click or key press).
- **Game not found?** row at the end of the catalog, to load a local `.atr` or `.xex` file.
- Robbo, Robbo (demo) and Robbo NK in the catalog.
- River Raid and Boulder Dash in the catalog.
- About texts for Robbo NK and both Dangerous City editions.
- Link to this repository in the page footer.
- **Play in the browser** button in the README.

### Changed

- Dangerous City is now version 2, in separate Polish and English editions.
- The catalog button is now **▶ Run**.

### Fixed

- Problem Jasia stopped on a blue screen: it needs 128 KB of memory, so the player now emulates the 130XE's extended RAM.
- Problem Jasia froze after pressing START, and any key crashed it during play: it uses addresses from the real XL OS, which point to other code in AltirraOS.
- Problem Jasia 2 crashed after its intro: it reads its disk through an address in the real XL OS that is empty in AltirraOS.
- Shift + PC arrow keys did nothing in games that use the Atari cursor keys, such as firing in the Robbo games.
- GitHub Pages workflow: the game download step and the Node 24 actions.
- The `stop site` VS Code task hung after debugging.
- Robbo NK stopped on its first screen and again after START: it calls an OS table as code and uses addresses from the real XL OS.
