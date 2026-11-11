// Minimal Atari 800XL (PAL, 64 KB) player for disk images (ATR) and executables (XEX), built on the headless
// Sfotty Pie emulator core (https://github.com/cyco130/sfotty-pie, MIT) and AltirraOS.
// The page sets the firmware on the canvas (data-os, 16 KB XL/XE OS ROM; data-basic, 8 KB BASIC ROM);
// the catalog comes from games/catalog.yml.
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
// The core's frame is colour clocks $24-$DF. The last 4 ($DC-$DF) are cut off: a TV hides them, and
// a scrolled wide playfield puts junk there (Joust's striped column). What is left, $24-$DB, is
// centred on the playfield ($80).
const VISIBLE_W = W - 8;
canvas.width = VISIBLE_W;
canvas.height = H;
canvas.style.aspectRatio = `${(VISIBLE_W * PAL_PIXEL_ASPECT_RATIO).toFixed(1)} / ${H}`;

const LINES_PER_MS = PAL_CYCLES_PER_SECOND / CYCLES_PER_LINE / 1000;
const MAX_LINES = 312 * 3;           // catch up at most 3 frames after a stall (tab in background)
const OPTION_HOLD_FRAMES = 30;       // hold OPTION at power-on: BASIC off, $A000-$BFFF is RAM for the game
                                     // (AltirraOS reads it about 6 frames in; Hans Kloss reboots if BASIC is on)

let machine, stick, stick2, disk, diskName;
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
// player2 = joystick 2 on the keyboard, for two-player games (Joust): move = the PC keys for up, down, left, right,
// fire = the PC keys for its button. Its keys win over the ones above: in Joust the numeric keypad and right Ctrl
// are joystick 2. A second gamepad is joystick 2 in every game.
const ARROW_DIRS = { ArrowUp: 1, ArrowDown: 2, ArrowLeft: 4, ArrowRight: 8 };
const DIR_BITS = [1, 2, 4, 8];   // up, down, left, right
let controls = { arrows: "keys", fire: new Set(), dirs2: {}, fire2: new Set() };
const isFire2 = (c) => controls.fire2.has(c);
const dir2Of = (c) => controls.dirs2[c] ?? 0;
const isPlayer2 = (c) => isFire2(c) || !!dir2Of(c);
const isFire = (c) => !isPlayer2(c) && (PAD_FIRE.has(c) || controls.fire.has(c));
const dirOf = (c) => (isPlayer2(c) ? 0 : PAD_DIRS[c] ?? (controls.arrows === "joystick" ? ARROW_DIRS[c] : 0) ?? 0);

const held = new Set();
let ctrlArrows = 0, kbDir = 0, kbFire = false, kbDir2 = 0, kbFire2 = false;

// A key stays down at least MIN_HOLD_FRAMES emulated frames: the emulator runs in chunks, and a quick
// tap could otherwise be pressed and released between two of them, unseen by the Atari.
const MIN_HOLD_FRAMES = 3;
const pressedAt = new Map();
let deferred = [], frameCount = 0;

const handles = (c) => c in SCAN || c in ARROWS || c in META || c in CONSOLE || c in PAD_DIRS || isFire(c) ||
	isPlayer2(c);

function key(e, down) {
	const c = e.code;
	if (!machine || gameView.hidden || e.metaKey || !handles(c)) return;   // the catalog: keys are for the search
	e.preventDefault();
	if (down) {
		if (held.has(c)) { deferred = deferred.filter((d) => d.c !== c); return; }   // auto-repeat / re-press
		held.add(c);
		pressedAt.set(c, frameCount);
		apply(c, true);
		noteKey(c);
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
	else if (isFire2(c)) kbFire2 = [...held].some(isFire2);
	else if (dir2Of(c)) kbDir2 = [...held].reduce((d, k) => d | dir2Of(k), 0);
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
	held.clear(); deferred = []; ctrlArrows = 0; kbDir = 0; kbFire = false; kbDir2 = 0; kbFire2 = false;
	if (!machine) return;
	machine.keyboard.releaseAll();
	for (const k of Object.values(CONSOLE)) machine.console[k] = false;
	if (optionFrames) machine.console.option = true;   // still holding OPTION after power-on (BASIC off)
}

// switch to a game's controls and show them in the key list
const KEY_NAMES = { ControlLeft: "left Ctrl", ControlRight: "right Ctrl", ShiftLeft: "left Shift", ShiftRight: "right Shift" };
// <kbd> elements for PC key codes, separated by spaces (Numpad8 = "num 8")
const kbds = (codes) => codes.flatMap((k, i) => {
	const kbd = document.createElement("kbd");
	kbd.textContent = KEY_NAMES[k] ?? k.replace(/^(Key|Digit)/, "").replace(/^Numpad/, "num ");
	return i ? [" ", kbd] : [kbd];
});
function setControls(c = {}) {
	releaseAll();
	const p2 = c.player2 ?? {};
	controls = {
		arrows: c.arrows === "joystick" ? "joystick" : "keys", fire: new Set(c.fire ?? []),
		dirs2: Object.fromEntries((p2.move ?? []).map((k, i) => [k, DIR_BITS[i]])), fire2: new Set(p2.fire ?? []),
	};
	document.querySelector("#keys-arrows td:last-child").textContent =
		controls.arrows === "joystick" ? "joystick" : "move (Atari cursor keys)";
	const fire = document.getElementById("keys-fire");
	fire.hidden = !controls.fire.size;
	fire.cells[0].replaceChildren(...kbds([...controls.fire]));
	const player2 = document.getElementById("keys-player2");
	player2.hidden = !(p2.move?.length || p2.fire?.length);
	player2.cells[0].replaceChildren(...kbds(p2.move ?? []), ...(p2.fire?.length ? [", fire ", ...kbds(p2.fire)] : []));
	// the numeric keypad row: hidden when the keypad is player 2's joystick
	document.getElementById("keys-pad").hidden = Object.keys(PAD_DIRS).some(isPlayer2);
}

// --- hint: the game ignores the keys pressed (Joust waits for START, not fire) -------------------------
// The game's own code (PC below the OS ROM) is watched for reads of the joystick, the keyboard and the console keys.
// A key pressed is "ignored" when the game reads nothing of its kind within HINT_CHECK_FRAMES; after HINT_PRESSES
// ignored keys within HINT_WINDOW_FRAMES a hint shows on the screen - once per boot, and not after a console key.
const OS_ROM = 0xC000, CONSOL = 0xD01F, CH = 0x2FC;
const STICK_REGS = [0xD010, 0xD011, 0xD300, 0x278, 0x279, 0x284, 0x285];   // TRIG0/1, PORTA, STICK0/1, STRIG0/1
const KEY_REGS = [CH, 0xD209, 0xD20F];                                     // CH, KBCODE, SKSTAT (Shift)
const HINT_CHECK_FRAMES = 25, HINT_PRESSES = 4, HINT_WINDOW_FRAMES = 250, CONSOLE_POLL_FRAMES = 50;
const HINT_SHOW_MS = 15000;
const lastRead = { stick: -1, keys: -1, console: -1 };
let hintChecks = [], ignoredAt = [], hintDone = false, hintTimer = 0;
const hint = document.getElementById("hint");
function watchInputReads(m) {
	const seen = (kind) => () => { if (m.cpu.PC < OS_ROM) lastRead[kind] = frameCount; };
	for (const a of STICK_REGS) m.observeRead(a, seen("stick"));
	for (const a of KEY_REGS) m.observeRead(a, seen("keys"));
	m.observeRead(CONSOL, seen("console"));
	m.observeWrite(CH, (_, v) => { if (v === 0xFF) lastRead.keys = frameCount; });   // the key was taken (also by the OS)
}

function noteKey(c) {
	if (c in CONSOLE) { hintDone = true; hideHint(); return; }
	if (hintDone) return;
	const kind = isFire(c) || dirOf(c) || isPlayer2(c) ? "stick" : "keys", at = frameCount;
	hintChecks.push({ due: at + HINT_CHECK_FRAMES, kind, at });
}

function checkHint() {
	const due = hintChecks.filter((h) => h.due <= frameCount);
	if (!due.length) return;
	hintChecks = hintChecks.filter((h) => h.due > frameCount);
	for (const h of due) if (lastRead[h.kind] < h.at) ignoredAt.push(h.at);
	ignoredAt = ignoredAt.filter((at) => at > frameCount - HINT_WINDOW_FRAMES);
	if (!hintDone && ignoredAt.length >= HINT_PRESSES) showHint(lastRead.console > frameCount - CONSOLE_POLL_FRAMES);
}

function showHint(waitsForConsole) {
	hintDone = true;
	hint.querySelector(".hint-text").innerHTML = waitsForConsole
		? "The game seems to wait for <b>START</b>: press <kbd>F2</kbd>. <kbd>F3</kbd> is SELECT, <kbd>F4</kbd> OPTION."
		: "The game does not seem to react to these keys. Many games start with <b>START</b>: press <kbd>F2</kbd>.";
	hint.hidden = false;
	clearTimeout(hintTimer);
	hintTimer = setTimeout(hideHint, HINT_SHOW_MS);
}

function hideHint() {
	clearTimeout(hintTimer);
	hint.hidden = true;
}

// a new boot: forget the keys pressed before
function resetHint() {
	hintChecks = []; ignoredAt = []; hintDone = false;
	lastRead.stick = lastRead.keys = lastRead.console = -1;
	hideHint();
}

hint.querySelector(".hint-close").addEventListener("click", () => { hideHint(); canvas.focus(); });
hint.querySelector(".hint-keys").addEventListener("click", async () => {
	hideHint();
	if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});   // the key list is on the page
	document.getElementById("keys").scrollIntoView({ behavior: "smooth" });
});

addEventListener("keydown", (e) => key(e, true));
addEventListener("keyup", (e) => key(e, false));
addEventListener("blur", releaseAll);

// --- gamepads: the first is joystick 1, the second joystick 2: stick / d-pad, A or B = fire; ---------
// Start / Back on the first = START / SELECT
function pollInput() {
	const sticks = [{ dir: kbDir, fire: kbFire }, { dir: kbDir2, fire: kbFire2 }];
	const pads = [...(navigator.getGamepads?.() ?? [])].filter(Boolean);
	pads.slice(0, 2).forEach((p, n) => {
		const b = (i) => p.buttons[i]?.pressed, s = sticks[n];
		const [x = 0, y = 0] = p.axes;
		if (y < -0.5 || b(12)) s.dir |= 1;
		if (y > 0.5 || b(13)) s.dir |= 2;
		if (x < -0.5 || b(14)) s.dir |= 4;
		if (x > 0.5 || b(15)) s.dir |= 8;
		s.fire ||= b(0) || b(1);
		if (n) return;
		if (!held.has("F2")) machine.console.start = !!b(9);
		if (!held.has("F3")) machine.console.select = !!b(8);
	});
	stick.direction = sticks[0].dir;
	stick.trigger = sticks[0].fire;
	stick2.direction = sticks[1].dir;
	stick2.trigger = sticks[1].fire;
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

// Problem Jasia 2 reads and writes its disk through JMP $C6C4, the middle of DSKINV in the real XL OS, with the
// command, buffer and sector already set. In AltirraOS that address is empty ROM, so nothing is read and the CPU
// slides on until it meets a stray RTS, which breaks the stack. The sector is served here instead.
const XL_DSKINV_IO = 0xC6C4, EMPTY_ROM = 0xFF, DAUX1 = 0x30A, CMD_READ = 0x52, CMD_WRITE = 0x57, CMD_PUT = 0x50;

function trapXlDskinv(m) {
	m.interceptExecute(XL_DSKINV_IO, () => {
		const peek = (a) => m.mmu.read(a, PEEK);
		if (peek(XL_DSKINV_IO) !== EMPTY_ROM || !disk) return undefined;
		const cmd = peek(DCOMND);
		const buf = peek(DBUFLO) | (peek(DBUFLO + 1) << 8);
		const sector = peek(DAUX1) | (peek(DAUX1 + 1) << 8);
		let status = 0x90;                                 // device error
		if (cmd === CMD_READ) {
			const data = disk.readSector(sector);
			if (data) {
				data.forEach((b, i) => m.mmu.write((buf + i) & 0xFFFF, b, 0));
				status = 1;
			}
		} else if ((cmd === CMD_WRITE || cmd === CMD_PUT) && !disk.writeProtected) {
			const data = Array.from({ length: disk.sectorSize }, (_, i) => peek((buf + i) & 0xFFFF));
			if (disk.writeSector(sector, data)) status = 1;
		}
		m.mmu.write(DSTATS, status, 0);
		m.cpu.Y = status;
		m.cpu.nFlag = status >= 0x80;
		m.cpu.zFlag = false;
		return RTS;
	});
}

// Robbo NK calls $E4C1 while it sets up its first screen. In AltirraOS that is a table of bit masks, not code: run
// as code, it jumps into the boot disk's loader and crashes. Return at once, as the RTS just before it would.
const XL_E4C1 = 0xE4C1, BIT_MASK_TABLE = 0x80;

function trapE4C1(m) {
	m.interceptExecute(XL_E4C1, () => (m.mmu.read(XL_E4C1, PEEK) === BIT_MASK_TABLE ? RTS : undefined));
}

// Problem Jasia and Robbo NK fill the OS vectors ($200-$225) with a table saved from the real XL OS, and Problem
// Jasia's keyboard IRQ handler ends with JMP $C030 at $014C. Those are ROM addresses of the real OS: in AltirraOS they are the middle of other
// code, so RTCLOK stops (the game hangs at its first wait) and any key crashes the CPU (see issue #5). Each is
// changed to AltirraOS's handler: the vectors at every VBI, the jump just before it is used.
const XL_VECTORS = [                                  // vector, address in the XL OS, address in AltirraOS
	[0x222, 0xC0E2, 0xC00C],                           // VVBLKI
	[0x224, 0xC28A, 0xC050],                           // VVBLKD
	[0x216, 0xC030, 0xC1DE],                           // VIMIRQ
	[0x208, 0xFC19, 0xFED5],                           // VKEYBD
	[0x20A, 0xEB2C, 0xEA49],                           // VSERIN
	[0x20C, 0xEAAD, 0xEA92],                           // VSEROR
	[0x20E, 0xEAEC, 0xEACB],                           // VSEROC
	...[0x202, 0x204, 0x206, 0x210, 0x212, 0x214].map((v) => [v, 0xC0CD, 0xC054]),   // handlers that only return
];
const NMI_JMP_VBI = 0xC19F, GAME_IRQ_JMP = 0x14C, JMP = 0x4C, XL_IRQ = 0xC030, ALTIRRA_IRQ = 0xC1DE;

function trapXlOs(m) {
	const word = (a) => m.mmu.read(a, PEEK) | (m.mmu.read(a + 1, PEEK) << 8);
	const redirect = (a, from, to) => {
		if (word(a) !== from) return;
		m.mmu.write(a, to & 0xFF, 0);
		m.mmu.write(a + 1, to >> 8, 0);
	};
	m.interceptExecute(NMI_JMP_VBI, () => {
		for (const [vector, xl, altirra] of XL_VECTORS) redirect(vector, xl, altirra);
		return undefined;
	});
	m.interceptExecute(GAME_IRQ_JMP, () => {
		if (m.mmu.read(GAME_IRQ_JMP, PEEK) === JMP) redirect(GAME_IRQ_JMP + 1, XL_IRQ, ALTIRRA_IRQ);
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
	resetHint();
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
	if (hintChecks.length) checkHint();
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
		// the built-in BASIC: OPTION at power-on switches it out (basic: false), but a game may switch it back on
		// through PORTB - Raszyn 1809 is an Atari BASIC program in an executable and runs on the ROM
		const [os, basic] = await Promise.all([fetchBytes(canvas.dataset.os), fetchBytes(canvas.dataset.basic)]);
		machine = new Atari({ xl: true, xeBankCount: 4, tvSystem: "pal", os, basic });   // 130XE: Problem Jasia needs its 128 KB
		stick = new Joystick(machine.joysticks[0]);
		stick2 = new Joystick(machine.joysticks[1]);
		trapFormat(machine);
		trapXlOs(machine);
		trapXlDskinv(machine);
		trapE4C1(machine);
		watchInputReads(machine);
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
	watchWrites(disk);
	machine.insertDisk(disk);
	document.getElementById("disk-name").textContent = `D1: ${name}`;
	setModified(false);
	for (const b of document.querySelectorAll(".bar button")) b.disabled = false;
	document.getElementById("save").disabled = disk.writeProtected;   // a boot disk has nothing saved on it
}

// The disk is "modified" once a write changes a sector (the emulator's SIO, format and the DSKINV trap all call
// disk.writeSector), until it is downloaded. Writing the same bytes again (a game saving unchanged data) does not count.
let modified = false;
function watchWrites(d) {
	const write = d.writeSector.bind(d);
	d.writeSector = (sector, data) => {
		const old = d.readSector(sector);                 // a view of the image: compare before writing
		const changed = !old || old.some((b, i) => i < data.length && b !== (data[i] & 0xFF));
		const ok = write(sector, data);
		if (ok && changed && d === disk) setModified(true);
		return ok;
	};
}

const pageTitle = document.title;
function setModified(on) {
	if (modified === on) return;
	modified = on;
	document.body.classList.toggle("modified", on);
	document.getElementById("disk-modified").hidden = !on;
	document.title = on ? `● ${pageTitle}` : pageTitle;   // seen on the tab too
}

// closing or reloading the page loses the changes: the browser asks first
addEventListener("beforeunload", (e) => {
	if (modified) e.preventDefault();
});

// another disk in D1: replaces the changed one: ask first (true = go ahead)
function mayReplaceDisk() {
	return !modified || confirm("The disk in D1: has changes that you have not downloaded. Replace it and lose them?");
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
	if (!mayReplaceDisk()) return;
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
	hideHint();
	gameView.hidden = true;
	catalogView.hidden = false;
	search.focus();
}

addEventListener("popstate", () => {
	if (history.state?.disk) return void playLink(history.state.disk).catch(showError);
	const name = history.state?.game ?? location.hash.slice(1);   // a #name typed into the address bar has no state
	const game = games.find((g) => g.name === name);
	if (game) play(game).catch(showError);
	else showCatalog();
});
document.getElementById("back").addEventListener("click", () => {
	if (history.state?.game) history.back();
	else showCatalog();
});

// a link to #name opens that game, a link with ?disk=<url> boots that file; the catalog stays as the page
// before it, for Back and ← Catalog
const linkedDisk = new URLSearchParams(location.search).get("disk");
const linked = linkedDisk ? "" : location.hash.slice(1);
const search0 = location.search;
history.replaceState(null, "", location.pathname + (linkedDisk ? "" : location.search));
if (linkedDisk) {
	history.pushState({ disk: linkedDisk }, "", location.pathname + search0);
	playLink(linkedDisk).catch(showError);
}
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
	setModified(false);
	canvas.focus();
});
const isXex = (bytes) => bytes[0] === 0xFF && bytes[1] === 0xFF;
const isAtr = (bytes) => bytes[0] === 0x96 && bytes[1] === 0x02;

// a disk of your own (from the computer or from a link): the default controls, BASIC off
async function runOwnDisk(bytes, name, boot) {
	await machineReady();
	setControls();
	basicOff = true;
	insert(bytes, name);
	if (boot || isXex(bytes)) powerOn();                      // an executable only runs when booted
	document.body.classList.add("running");
	canvas.focus();
}

async function loadDisk(e) {
	const file = e.target.files[0];
	e.target.value = "";
	if (!file || !mayReplaceDisk()) return;
	const bytes = new Uint8Array(await file.arrayBuffer());
	const fromCatalog = gameView.hidden;                      // nothing is running there: the disk has to boot
	if (fromCatalog) history.pushState({ game: file.name }, "", "#disk");
	showGame({ title: file.name });
	await runOwnDisk(bytes, file.name, fromCatalog);
}

// ?disk=<url>: download an .atr or .xex from anywhere that allows it (CORS) and boot it. A GitHub page link
// (github.com/<owner>/<repo>/blob/<branch>/<path>) is turned into its raw file, which GitHub serves with CORS.
const MAX_DISK = 16 << 20;
function diskUrl(text) {
	const url = new URL(text, location.href);                 // a relative path is a file on this site
	if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`${text}: not a web link`);
	if (url.hostname !== "github.com" && url.hostname !== "www.github.com") return url;
	const m = url.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/);
	if (!m) throw new Error(`${text}: link to a file on GitHub (its …/blob/… page), not to a repository or a folder`);
	return new URL(`https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`);
}

async function fetchDisk(url) {
	let r;
	try {
		r = await fetch(url);
	} catch {
		throw new Error(`cannot download ${url.href}: the site does not let other pages read its files (no CORS header), or it cannot be reached`);
	}
	if (!r.ok) throw new Error(`${url.href}: HTTP ${r.status}`);
	if (Number(r.headers.get("content-length")) > MAX_DISK) throw new Error(`${url.href}: the file is too large for a disk`);
	const bytes = new Uint8Array(await r.arrayBuffer());
	if (bytes.length > MAX_DISK) throw new Error(`${url.href}: the file is too large for a disk`);
	if (!isXex(bytes) && !isAtr(bytes)) throw new Error(`${url.href} is not an .atr or .xex file (a link to a folder or a web page?)`);
	return bytes;
}

async function playLink(link) {
	showGame({ title: link.split("/").pop() || link, info: link });
	const status = document.getElementById("status");
	status.textContent = "Loading…";
	const url = diskUrl(link);
	let name = url.pathname.split("/").pop() || url.hostname;
	try { name = decodeURIComponent(name); } catch { /* keep it as it is */ }
	document.getElementById("game-title").textContent = name;
	const bytes = await fetchDisk(url);
	status.textContent = "";
	await runOwnDisk(bytes, name, true);
}
for (const id of ["load", "load-catalog"]) document.getElementById(id).addEventListener("change", (e) => loadDisk(e).catch(showError));
document.getElementById("blank").addEventListener("click", () => {
	if (!mayReplaceDisk()) return;
	insert(blankDisk(), "blank.atr");
	canvas.focus();
});
// the screen's box goes full screen, not just the canvas: the hint and the status show there too
document.getElementById("fullscreen").addEventListener("click", () => {
	canvas.parentElement.requestFullscreen?.().then(() => canvas.focus(), () => {});
});
