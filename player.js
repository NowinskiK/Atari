// Minimal Atari 800XL (PAL, 64 KB) player for disk images (ATR) and executables (XEX), built on the headless
// Sfotty Pie emulator core (https://github.com/cyco130/sfotty-pie, MIT) and AltirraOS.
// The page sets the OS on the canvas (data-os, 16 KB XL/XE OS ROM); the catalog comes from games/catalog.yml.
import {
	Atari, AtrImage, Joystick, buildBootDisk, KEYBOARD_LINES, paletteFor, CYCLES_PER_LINE,
	PAL_CYCLES_PER_SECOND, PAL_PIXEL_ASPECT_RATIO, FRAME_BUFFER_WIDTH as W, FRAME_BUFFER_HEIGHT as H,
} from "https://cdn.jsdelivr.net/npm/@sfotty-pie/a8@0.3.0/+esm";
import { load as parseYaml } from "https://cdn.jsdelivr.net/npm/js-yaml@4.1.0/+esm";
import { marked } from "https://cdn.jsdelivr.net/npm/marked@12.0.2/+esm";

const canvas = document.getElementById("screen");
const catalogView = document.getElementById("catalog-view"), gameView = document.getElementById("game-view");
const ctx = canvas.getContext("2d");
const image = ctx.createImageData(W, H);
const pixels = new Uint32Array(image.data.buffer);
const palette = paletteFor("pal");
canvas.width = W;
canvas.height = H;
canvas.style.aspectRatio = `${(W * PAL_PIXEL_ASPECT_RATIO).toFixed(1)} / ${H}`;

const LINES_PER_MS = PAL_CYCLES_PER_SECOND / CYCLES_PER_LINE / 1000;
const MAX_LINES = 312 * 3;           // catch up at most 3 frames after a stall (tab in background)
const OPTION_HOLD_FRAMES = 30;       // hold OPTION at power-on: BASIC off, $A000-$BFFF is RAM for the game
                                     // (AltirraOS reads it about 6 frames in; Hans Kloss reboots if BASIC is on)

let machine, stick, disk, diskName;
let optionFrames = 0, basicOff = true;

// --- keyboard: PC key (KeyboardEvent.code) -> Atari scan code ------------------------------
const SCAN = {
	KeyA: 0x3F, KeyB: 0x15, KeyC: 0x12, KeyD: 0x3A, KeyE: 0x2A, KeyF: 0x38, KeyG: 0x3D, KeyH: 0x39,
	KeyI: 0x0D, KeyJ: 0x01, KeyK: 0x05, KeyL: 0x00, KeyM: 0x25, KeyN: 0x23, KeyO: 0x08, KeyP: 0x0A,
	KeyQ: 0x2F, KeyR: 0x28, KeyS: 0x3E, KeyT: 0x2D, KeyU: 0x0B, KeyV: 0x10, KeyW: 0x2E, KeyX: 0x16,
	KeyY: 0x2B, KeyZ: 0x17,
	Digit1: 0x1F, Digit2: 0x1E, Digit3: 0x1A, Digit4: 0x18, Digit5: 0x1D,
	Digit6: 0x1B, Digit7: 0x33, Digit8: 0x35, Digit9: 0x30, Digit0: 0x32,
	Minus: 0x0E, Equal: 0x0F, Semicolon: 0x02, Comma: 0x20, Period: 0x22, Slash: 0x26,
	Space: 0x21, Enter: 0x0C, NumpadEnter: 0x0C, Backspace: 0x34, Tab: 0x2C, Escape: 0x1C,
	CapsLock: 0x3C, Backquote: 0x27,                  // ` = inverse video key
	BracketLeft: 0x36, BracketRight: 0x37,             // < and > (CLEAR / INSERT with Shift)
	Backslash: 0x06, Quote: 0x07,                      // + and *
	F1: 0x11,                                          // HELP
};
// PC arrows = Atari Ctrl + the arrow keys (- = + *); the game masks Ctrl off ($3F), the title editor needs it
const ARROWS = { ArrowUp: 0x0E, ArrowDown: 0x0F, ArrowLeft: 0x06, ArrowRight: 0x07 };
const META = { ShiftLeft: KEYBOARD_LINES.SHIFT, ShiftRight: KEYBOARD_LINES.SHIFT,
	ControlLeft: KEYBOARD_LINES.CONTROL, F7: KEYBOARD_LINES.BREAK, Pause: KEYBOARD_LINES.BREAK };
const CONSOLE = { F2: "start", F3: "select", F4: "option" };
// joystick on the numeric keypad, fire = right Ctrl or numpad 0
const PAD_DIRS = { Numpad8: 1, Numpad2: 2, Numpad4: 4, Numpad6: 8 };
const PAD_FIRE = new Set(["ControlRight", "Numpad0"]);
// per game (controls in games/<name>.yml): arrows = "keys" (the Atari cursor keys above) or "joystick",
// fire = more PC keys for the joystick button
const ARROW_DIRS = { ArrowUp: 1, ArrowDown: 2, ArrowLeft: 4, ArrowRight: 8 };
let controls = { arrows: "keys", fire: new Set() };
const isFire = (c) => PAD_FIRE.has(c) || controls.fire.has(c);
const dirOf = (c) => PAD_DIRS[c] ?? (controls.arrows === "joystick" ? ARROW_DIRS[c] : 0) ?? 0;

const held = new Set();
let ctrlArrows = 0, kbDir = 0, kbFire = false;

// A key stays down at least MIN_HOLD_FRAMES emulated frames: the emulator runs in chunks, and a quick
// tap could otherwise be pressed and released between two of them, unseen by the Atari.
const MIN_HOLD_FRAMES = 3;
const pressedAt = new Map();
let deferred = [], frameCount = 0;

const handles = (c) => c in SCAN || c in ARROWS || c in META || c in CONSOLE || c in PAD_DIRS || isFire(c);

function key(e, down) {
	const c = e.code;
	if (!machine || gameView.hidden || e.metaKey || !handles(c)) return;   // the catalog: keys are for the search
	e.preventDefault();
	if (down) {
		if (held.has(c)) { deferred = deferred.filter((d) => d.c !== c); return; }   // auto-repeat / re-press
		held.add(c);
		pressedAt.set(c, frameCount);
		apply(c, true);
	} else if (held.has(c)) {
		const at = pressedAt.get(c) + MIN_HOLD_FRAMES;
		if (frameCount >= at) release(c);
		else deferred.push({ c, at });
	}
}

function release(c) {
	held.delete(c);
	apply(c, false);
}

// Atari Ctrl = left Ctrl, or a PC arrow without Shift: the OS ignores most Ctrl + Shift keys, so Shift + arrow
// (fire in the Robbo games) has to reach the Atari as Shift + the plain arrow key
function syncCtrl(kb) {
	const shift = held.has("ShiftLeft") || held.has("ShiftRight");
	if (held.has("ControlLeft") || (ctrlArrows && !shift)) kb.pressMetaKey(KEYBOARD_LINES.CONTROL);
	else kb.releaseMetaKey(KEYBOARD_LINES.CONTROL);
}

function apply(c, down) {
	const kb = machine.keyboard;
	if (isFire(c)) kbFire = [...held].some(isFire);
	else if (dirOf(c)) kbDir = [...held].reduce((d, k) => d | dirOf(k), 0);
	else if (c in SCAN) down ? kb.pressKey(SCAN[c]) : kb.releaseKey(SCAN[c]);
	else if (c in ARROWS) {
		ctrlArrows += down ? 1 : -1;
		if (down) { syncCtrl(kb); kb.pressKey(ARROWS[c]); }
		else { kb.releaseKey(ARROWS[c]); syncCtrl(kb); }
	}
	else if (META[c] === KEYBOARD_LINES.CONTROL) syncCtrl(kb);
	else if (c in META) {
		down ? kb.pressMetaKey(META[c]) : kb.releaseMetaKey(META[c]);
		if (META[c] === KEYBOARD_LINES.SHIFT) syncCtrl(kb);
	}
	else if (c in CONSOLE) machine.console[CONSOLE[c]] = down;
}

function releaseAll() {
	held.clear(); deferred = []; ctrlArrows = 0; kbDir = 0; kbFire = false;
	if (!machine) return;
	machine.keyboard.releaseAll();
	for (const k of Object.values(CONSOLE)) machine.console[k] = false;
	if (optionFrames) machine.console.option = true;   // still holding OPTION after power-on (BASIC off)
}

// switch to a game's controls and show them in the key list
const KEY_NAMES = { ControlLeft: "left Ctrl", ControlRight: "right Ctrl", ShiftLeft: "left Shift", ShiftRight: "right Shift" };
function setControls(c = {}) {
	releaseAll();
	controls = { arrows: c.arrows === "joystick" ? "joystick" : "keys", fire: new Set(c.fire ?? []) };
	document.querySelector("#keys-arrows td:last-child").textContent =
		controls.arrows === "joystick" ? "joystick" : "move (Atari cursor keys)";
	const fire = document.getElementById("keys-fire");
	fire.hidden = !controls.fire.size;
	fire.cells[0].replaceChildren(...[...controls.fire].flatMap((k, i) => {
		const kbd = document.createElement("kbd");
		kbd.textContent = KEY_NAMES[k] ?? k.replace(/^(Key|Digit)/, "");
		return i ? [" ", kbd] : [kbd];
	}));
}

addEventListener("keydown", (e) => key(e, true));
addEventListener("keyup", (e) => key(e, false));
addEventListener("blur", releaseAll);

// --- gamepad (first one): stick / d-pad, A or B = fire, Start / Back = START / SELECT ---------
function pollInput() {
	let dir = kbDir, fire = kbFire;
	for (const p of navigator.getGamepads?.() ?? []) {
		if (!p) continue;
		const b = (i) => p.buttons[i]?.pressed;
		const [x = 0, y = 0] = p.axes;
		if (y < -0.5 || b(12)) dir |= 1;
		if (y > 0.5 || b(13)) dir |= 2;
		if (x < -0.5 || b(14)) dir |= 4;
		if (x > 0.5 || b(15)) dir |= 8;
		fire ||= b(0) || b(1);
		if (!held.has("F2")) machine.console.start = !!b(9);
		if (!held.has("F3")) machine.console.select = !!b(8);
		break;
	}
	stick.direction = dir;
	stick.trigger = fire;
}

// --- sound: per-cycle level -> box-filtered samples -> AudioWorklet ring buffer ---------------
const WORKLET = `
class Feed extends AudioWorkletProcessor {
	constructor() {
		super();
		this.buf = new Float32Array(16384); this.r = 0; this.w = 0;
		this.port.onmessage = (e) => {
			const d = e.data;
			if (((this.w - this.r) & 16383) > 6000) return;      // too far ahead: drop, keep latency low
			for (let i = 0; i < d.length; i++) { this.buf[this.w] = d[i]; this.w = (this.w + 1) & 16383; }
		};
	}
	process(_, outputs) {
		const out = outputs[0];
		for (let i = 0; i < out[0].length; i++) {
			let v = 0;
			if (this.r !== this.w) { v = this.buf[this.r]; this.r = (this.r + 1) & 16383; }
			for (const ch of out) ch[i] = v;
		}
		return true;
	}
}
registerProcessor("feed", Feed);`;

let audio = null, cyclesPerSample = 0, acc = 0, accN = 0, phase = 0, dcIn = 0, dcOut = 0;
let chunk = new Float32Array(512), chunkLen = 0;

async function startAudio() {
	try {
		const context = new AudioContext();
		await context.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" })));
		const node = new AudioWorkletNode(context, "feed", { outputChannelCount: [2] });
		node.connect(context.destination);
		audio = { context, port: node.port };
		cyclesPerSample = PAL_CYCLES_PER_SECOND / context.sampleRate;
	} catch (err) {
		console.warn("no sound:", err);
	}
}

// a game opened by a link starts without a click: the browser keeps the sound off until the first one
for (const type of ["pointerdown", "keydown"]) addEventListener(type, () => audio?.context.resume());

function sample(level) {
	acc += level; accN++;
	if (++phase < cyclesPerSample) return;
	phase -= cyclesPerSample;
	const x = acc / accN; acc = 0; accN = 0;
	dcOut = x - dcIn + 0.995 * dcOut; dcIn = x;          // remove the DC offset
	chunk[chunkLen++] = dcOut * 0.3;
	if (chunkLen === chunk.length) {
		audio.port.postMessage(chunk, [chunk.buffer]);
		chunk = new Float32Array(512); chunkLen = 0;
	}
}

// --- the machine --------------------------------------------------------------------------
const SIOV = 0xE459, DDEVIC = 0x300, DUNIT = 0x301, DCOMND = 0x302, DSTATS = 0x303, DBUFLO = 0x304, PEEK = 1;
const RTS = 0x60;

// The emulator's SIO answers read / write / status only. Konstruktor formats the disk ($22, IO_FORMAT
// $9388) before "zapisz Robbo" writes the stand-alone game, so format ($21 / $22) on D1 is served here:
// clear the image, put an empty bad-sector list ($FF,$FF) into the buffer, return status 1.
function trapFormat(m) {
	m.interceptExecute(SIOV, () => {
		const peek = (a) => m.mmu.read(a, PEEK);
		const cmd = peek(DCOMND);
		if (peek(DDEVIC) !== 0x31 || peek(DUNIT) !== 1 || (cmd !== 0x21 && cmd !== 0x22) || !disk) return undefined;
		let status = 0x90;                                 // device error: write-protected
		if (!disk.writeProtected) {
			const empty = new Uint8Array(disk.sectorSize);
			for (let s = 1; s <= disk.sectorCount; s++) disk.writeSector(s, empty);
			const buf = peek(DBUFLO) | (peek(DBUFLO + 1) << 8);
			m.mmu.write(buf, 0xFF, 0);
			m.mmu.write((buf + 1) & 0xFFFF, 0xFF, 0);
			status = 1;
		}
		m.mmu.write(DSTATS, status, 0);
		m.cpu.Y = status;
		m.cpu.nFlag = status >= 0x80;
		m.cpu.zFlag = false;
		return RTS;
	});
}

// Problem Jasia sets the VBI vector to $C0E2, the handler's address in the real XL OS. In AltirraOS that is the
// middle of the handler, past the RTCLOK update, so the game hangs at its first wait. Send it to the real start.
const VVBLKI = 0x222, XL_VBI = 0xC0E2, ALTIRRA_VBI = 0xC00C, NMI_JMP_VBI = 0xC19F;

function trapXlVbi(m) {
	m.interceptExecute(NMI_JMP_VBI, () => {
		if (m.mmu.read(VVBLKI, PEEK) !== (XL_VBI & 0xFF) || m.mmu.read(VVBLKI + 1, PEEK) !== XL_VBI >> 8) return undefined;
		m.mmu.write(VVBLKI, ALTIRRA_VBI & 0xFF, 0);
		m.mmu.write(VVBLKI + 1, ALTIRRA_VBI >> 8, 0);
		return undefined;
	});
}

// an empty single-density disk: ATR header ($0296, 720 x 128 bytes in 16-byte paragraphs) + zeros
function blankDisk() {
	const atr = new Uint8Array(16 + 720 * 128);
	atr.set([0x96, 0x02, 0x80, 0x16, 0x80, 0x00]);
	return atr;
}

function powerOn() {
	releaseAll();                                      // first: it releases the console keys, OPTION too
	machine.console.powerCycle();
	machine.console.option = basicOff;
	optionFrames = basicOff ? OPTION_HOLD_FRAMES : 0;
}

function runLine() {
	const m = machine;
	if (audio?.context.state === "running") for (let i = 0; i < CYCLES_PER_LINE; i++) { m.cycle(); sample(m.audio); }
	else for (let i = 0; i < CYCLES_PER_LINE; i++) m.cycle();
	if (m.anticGtia.vcount !== 0) return false;
	// a frame is complete: convert it and handle the timed OPTION release
	const f = m.frame;
	for (let i = 0; i < f.length; i++) pixels[i] = palette[f[i]];
	if (optionFrames && !--optionFrames) m.console.option = false;
	frameCount++;
	if (deferred.length) {
		const due = deferred.filter((d) => d.at <= frameCount);
		deferred = deferred.filter((d) => d.at > frameCount);
		for (const d of due) release(d.c);
	}
	return true;
}

// Emulation runs on a timer against the wall clock; animation frames only present the picture
// (browsers throttle requestAnimationFrame in windows that are not in front).
let last = 0, debt = 0, dirty = false;
function step() {
	setTimeout(step, 4);
	const now = performance.now();
	if (document.hidden || gameView.hidden) { last = now; return; }   // paused while the catalog is shown
	pollInput();
	debt = Math.min(debt + (now - last) * LINES_PER_MS, MAX_LINES);
	last = now;
	for (; debt >= 1; debt--) if (runLine()) dirty = true;
}

function present() {
	requestAnimationFrame(present);
	if (dirty) { ctx.putImageData(image, 0, 0); dirty = false; }
}

// the catalog's text files change often: ask the server every time (unchanged = a short 304), so a
// browser or GitHub Pages cache never shows yesterday's catalog
async function fetchText(url) {
	const r = await fetch(url, { cache: "no-cache" });
	if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
	return r.text();
}

async function fetchBytes(url) {
	const r = await fetch(url);
	if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
	return new Uint8Array(await r.arrayBuffer());
}

// the machine is made by the first game loaded (audio may only start after a click)
let ready = null;
function machineReady() {
	ready ??= (async () => {
		await startAudio();
		const os = await fetchBytes(canvas.dataset.os);
		machine = new Atari({ xl: true, xeBankCount: 4, tvSystem: "pal", os });   // 130XE: Problem Jasia needs its 128 KB
		stick = new Joystick(machine.joysticks[0]);
		trapFormat(machine);
		trapXlVbi(machine);
		last = performance.now();
		step();
		requestAnimationFrame(present);
	})().catch((err) => { ready = null; throw err; });
	return ready;
}

// load a game from the catalog with its settings and boot it
async function play(game) {
	showGame(game);
	const status = document.getElementById("status");
	status.textContent = "Loading…";
	const [bytes] = await Promise.all([fetchBytes(`games/files/${game.file}`), machineReady()]);
	setControls(game.controls);
	basicOff = !game.basic;
	insert(bytes, game.file.split("/").pop());
	powerOn();
	document.body.classList.add("running");
	status.textContent = "";
	canvas.focus();
}

// put a disk into D1: while running, like swapping a floppy (Restart boots it);
// an executable (XEX) goes onto a write-protected boot disk
function insert(bytes, name) {
	disk = bytes[0] === 0xFF && bytes[1] === 0xFF ? buildBootDisk(bytes) : new AtrImage(bytes);
	diskName = name.replace(/\.[^.]*$/, "") + ".atr";
	machine.insertDisk(disk);
	document.getElementById("disk").textContent = `D1: ${name}`;
	for (const b of document.querySelectorAll(".bar button")) b.disabled = false;
	document.getElementById("save").disabled = disk.writeProtected;   // a boot disk has nothing saved on it
}

// --- the catalog: games/catalog.yml lists the names, games/<name>.yml holds each game's settings ------
const games = [];
const showError = (err) => {
	document.getElementById(gameView.hidden ? "catalog-status" : "status").textContent = `Error: ${err.message}`;
};

function row(game) {
	const el = (tag, className, text) => Object.assign(document.createElement(tag), { className, textContent: text ?? "" });
	const info = el("div");
	info.append(el("span", "title", game.title));
	if (game.info) info.append(el("span", "meta", game.info));
	const button = el("button", "", "▶ Run");
	button.type = "button";
	button.addEventListener("click", () => openGame(game));
	game.row = el("li", "game");
	game.row.append(info, button);
	return game.row;
}

async function loadCatalog() {
	const names = parseYaml(await fetchText("games/catalog.yml"));
	const list = await Promise.all(names.map(async (name) => ({ name, ...parseYaml(await fetchText(`games/${name}.yml`)) })));
	games.push(...list);
	document.querySelector(".catalog").replaceChildren(...games.map(row), document.getElementById("own-disk"));
	filter();
	const game = games.find((g) => g.name === linked);
	if (game) openGame(game);
}

// search by name or info: case and Polish letters do not matter ("zolna" finds "Żołna")
const fold = (t) => (t ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ł/g, "l");
const search = document.getElementById("search");
function filter() {
	const words = fold(search.value).split(/\s+/).filter(Boolean);
	let shown = 0;
	for (const g of games) {
		const text = fold(`${g.title} ${g.info}`);
		g.row.hidden = !words.every((w) => text.includes(w));
		if (!g.row.hidden) shown++;
	}
	document.getElementById("catalog-status").textContent = shown ? "" : `No game matches “${search.value}”.`;
}
search.addEventListener("input", filter);
search.addEventListener("keydown", (e) => {                    // Enter loads the game when only one is left
	const shown = games.filter((g) => !g.row.hidden);
	if (e.key === "Enter" && shown.length === 1) openGame(shown[0]);
});

// --- the two views: the catalog, and a game's screen; the browser's Back returns to the catalog ------
function openGame(game) {
	history.pushState({ game: game.name }, "", `#${game.name}`);
	play(game).catch(showError);
}

function showGame(game) {
	document.getElementById("game-title").textContent = game.title;
	document.getElementById("game-info").textContent = game.info ?? "";
	document.getElementById("game-description").textContent = game.description ?? "";
	showAbout(game);
	catalogView.hidden = true;
	gameView.hidden = false;
	scrollTo(0, 0);
}

// games/<name>.md, when there is one, is the game's About section (Markdown from this repository)
let shownGame = null;
async function showAbout(game) {
	const about = document.getElementById("game-about");
	about.hidden = true;
	shownGame = game;
	if (!game.name) return;                                   // a disk of your own
	game.about ??= fetch(`games/${game.name}.md`, { cache: "no-cache" }).then((r) => (r.ok ? r.text() : "")).catch(() => "");
	const text = await game.about;
	if (shownGame !== game || !text.trim()) return;           // another game opened meanwhile, or no text
	about.querySelector(".about").innerHTML = marked.parse(text);
	about.hidden = false;
}

function showCatalog() {
	releaseAll();
	gameView.hidden = true;
	catalogView.hidden = false;
	search.focus();
}

addEventListener("popstate", () => {
	const name = history.state?.game ?? location.hash.slice(1);   // a #name typed into the address bar has no state
	const game = games.find((g) => g.name === name);
	if (game) play(game).catch(showError);
	else showCatalog();
});
document.getElementById("back").addEventListener("click", () => {
	if (history.state?.game) history.back();
	else showCatalog();
});

// a link to #name opens that game; the catalog stays as the page before it, for Back and ← Catalog
const linked = location.hash.slice(1);
history.replaceState(null, "", location.pathname + location.search);
loadCatalog().catch(showError);
search.focus();

// --- page controls --------------------------------------------------------------------------
document.getElementById("restart").addEventListener("click", () => { powerOn(); canvas.focus(); });
document.getElementById("save").addEventListener("click", () => {
	const a = document.createElement("a");
	a.href = URL.createObjectURL(new Blob([disk.toBytes()], { type: "application/octet-stream" }));
	a.download = diskName;
	a.click();
	setTimeout(() => URL.revokeObjectURL(a.href), 1000);
	canvas.focus();
});
async function loadDisk(e) {
	const file = e.target.files[0];
	if (!file) return;
	const bytes = new Uint8Array(await file.arrayBuffer());
	const fromCatalog = gameView.hidden;                      // nothing is running there: the disk has to boot
	if (fromCatalog) history.pushState({ game: file.name }, "", "#disk");
	showGame({ title: file.name });
	await machineReady();
	setControls();                                            // a disk of your own: the default controls
	basicOff = true;
	insert(bytes, file.name);
	if (fromCatalog || (bytes[0] === 0xFF && bytes[1] === 0xFF)) powerOn();   // an executable only runs when booted
	document.body.classList.add("running");
	e.target.value = "";
	canvas.focus();
}
for (const id of ["load", "load-catalog"]) document.getElementById(id).addEventListener("change", (e) => loadDisk(e).catch(showError));
document.getElementById("blank").addEventListener("click", () => {
	insert(blankDisk(), "blank.atr");
	canvas.focus();
});
document.getElementById("fullscreen").addEventListener("click", () => canvas.requestFullscreen?.());
