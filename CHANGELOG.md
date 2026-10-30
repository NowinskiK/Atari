# Changelog

Notable changes to the site, the player and the game catalog.

<!-- Shown on the site by changelog/index.html. The format follows https://keepachangelog.com/en/1.1.0/. The site is
published on every push to main, so entries are grouped by date instead of version numbers: add new entries under
Unreleased, and give that section the date when it reaches main. -->

## Unreleased

### Added

- Problem Jasia and Problem Jasia 2 in the catalog.
- This changelog, as a page on the site.
- Changelog link and version in the page footer; the version is stamped when the site is published.

### Fixed

- Problem Jasia stopped on a blue screen: it needs 128 KB of memory, so the player now emulates the 130XE's extended RAM.

## 2026-10-30

### Added

- First version: the catalog with search, the browser player, per-game controls and About texts.
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

- Shift + PC arrow keys did nothing in games that use the Atari cursor keys, such as firing in the Robbo games.
- GitHub Pages workflow: the game download step and the Node 24 actions.
- The `stop site` VS Code task hung after debugging.

### Known issues

- Robbo NK stops on its first screen.
