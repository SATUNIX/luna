// qr.ts — a dependency-free QR Code encoder (ISO/IEC 18004, byte mode, versions 1-40).
//
// Used for exactly one thing: the pairing link (`pirc://pair?...`) the operator scans with the
// phone. The host returns the module matrix with a pairing, so the terminal extension and the
// command-line pairing tool both draw the same code without carrying their own encoder.
// The structure follows the reference algorithm (data codewords, Reed-Solomon blocks,
// interleaving, function patterns, the eight masks and the penalty rules).

const ECL = { L: 0, M: 1, Q: 2, H: 3 } as const;
const ECL_NAMES = ["L", "M", "Q", "H"] as const;
const ECL_FORMAT_BITS = [1, 0, 3, 2] as const;

export type ErrorCorrectionLevel = keyof typeof ECL;

/** A QR module matrix: `modules[y][x]` is true for a dark module. */
export interface QrMatrix {
	readonly size: number;
	readonly modules: readonly (readonly boolean[])[];
}

export interface QrCode extends QrMatrix {
	readonly version: number;
	readonly ecl: ErrorCorrectionLevel;
	readonly mask: number;
	readonly modules: boolean[][];
}

export interface EncodeOptions {
	readonly ecl?: ErrorCorrectionLevel;
	/** Raise the error-correction level while the data still fits the same version. */
	readonly boostEcl?: boolean;
}

export interface RenderOptions {
	/** Light modules around the code, in modules. */
	readonly quiet?: number;
	/** Wrap each line in ANSI colours (black on white). */
	readonly ansi?: boolean;
}

/** `list[index]`, for indexes the algorithm guarantees are in range. */
function at<T>(list: readonly T[], index: number): T {
	const value = list[index];
	if (value === undefined) throw new Error(`QR encoder: index ${index} out of range`);
	return value;
}

// prettier-ignore
const ECC_CODEWORDS_PER_BLOCK = [
	[-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
	[-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
	[-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
	[-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
// prettier-ignore
const NUM_ERROR_CORRECTION_BLOCKS = [
	[-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
	[-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
	[-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
	[-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

function rawDataModules(ver: number): number {
	let result = (16 * ver + 128) * ver + 64;
	if (ver >= 2) {
		const numAlign = Math.floor(ver / 7) + 2;
		result -= (25 * numAlign - 10) * numAlign - 55;
		if (ver >= 7) result -= 36;
	}
	return result;
}

function dataCodewords(ver: number, ecl: number): number {
	return Math.floor(rawDataModules(ver) / 8) - at(at(ECC_CODEWORDS_PER_BLOCK, ecl), ver) * at(at(NUM_ERROR_CORRECTION_BLOCKS, ecl), ver);
}

const charCountBits = (ver: number): number => (ver <= 9 ? 8 : 16); // byte mode

// ------------------------------------------------------------ Reed-Solomon ---
function gfMultiply(x: number, y: number): number {
	let z = 0;
	for (let i = 7; i >= 0; i--) {
		z = (z << 1) ^ ((z >>> 7) * 0x11d);
		z ^= ((y >>> i) & 1) * x;
	}
	return z & 0xff;
}

function rsDivisor(degree: number): number[] {
	const result = new Array<number>(degree).fill(0);
	result[degree - 1] = 1;
	let root = 1;
	for (let i = 0; i < degree; i++) {
		for (let j = 0; j < result.length; j++) {
			result[j] = gfMultiply(at(result, j), root) ^ (j + 1 < result.length ? at(result, j + 1) : 0);
		}
		root = gfMultiply(root, 0x02);
	}
	return result;
}

function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
	const result = divisor.map(() => 0);
	for (const b of data) {
		const factor = b ^ (result.shift() ?? 0);
		result.push(0);
		divisor.forEach((coef, i) => {
			result[i] = at(result, i) ^ gfMultiply(coef, factor);
		});
	}
	return result;
}

// ------------------------------------------------------------------ encode ---
/** Encode `text` (UTF-8) as a QR code. */
export function encodeQr(text: string, { ecl = "M", boostEcl = true }: EncodeOptions = {}): QrCode {
	const bytes = [...Buffer.from(text, "utf8")];
	// Own keys only: an inherited name ("toString") is not a level.
	if (!Object.hasOwn(ECL, ecl)) throw new Error(`unknown error-correction level ${ecl}`);
	let level: number = ECL[ecl];

	let version = 0;
	for (let v = 1; v <= 40; v++) {
		if (4 + charCountBits(v) + bytes.length * 8 <= dataCodewords(v, level) * 8) {
			version = v;
			break;
		}
	}
	if (!version) throw new Error("data too long for a QR code");
	if (boostEcl) {
		for (let up = level + 1; up <= ECL.H; up++) {
			if (4 + charCountBits(version) + bytes.length * 8 <= dataCodewords(version, up) * 8) level = up;
		}
	}

	// Bit stream: mode, count, data, terminator, padding.
	const bits: number[] = [];
	const push = (value: number, len: number): void => {
		for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
	};
	push(0b0100, 4);
	push(bytes.length, charCountBits(version));
	for (const b of bytes) push(b, 8);
	const capacity = dataCodewords(version, level) * 8;
	push(0, Math.min(4, capacity - bits.length));
	push(0, (8 - (bits.length % 8)) % 8);
	for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
	const data: number[] = [];
	for (let i = 0; i < bits.length; i += 8) {
		let b = 0;
		for (let j = 0; j < 8; j++) b = (b << 1) | at(bits, i + j);
		data.push(b);
	}

	const codewords = addEccAndInterleave(data, version, level);
	const qr = new Matrix(version);
	qr.drawFunctionPatterns(level);
	qr.drawCodewords(codewords);

	let best = 0;
	let bestPenalty = Infinity;
	for (let mask = 0; mask < 8; mask++) {
		qr.applyMask(mask);
		qr.drawFormatBits(level, mask);
		const penalty = qr.penalty();
		if (penalty < bestPenalty) {
			best = mask;
			bestPenalty = penalty;
		}
		qr.applyMask(mask); // XOR again to undo
	}
	qr.applyMask(best);
	qr.drawFormatBits(level, best);
	return {
		version,
		size: qr.size,
		ecl: at(ECL_NAMES, level),
		mask: best,
		modules: qr.modules.map((row) => row.slice()),
	};
}

function addEccAndInterleave(data: readonly number[], ver: number, ecl: number): number[] {
	const numBlocks = at(at(NUM_ERROR_CORRECTION_BLOCKS, ecl), ver);
	const blockEccLen = at(at(ECC_CODEWORDS_PER_BLOCK, ecl), ver);
	const rawCodewords = Math.floor(rawDataModules(ver) / 8);
	const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
	const shortBlockLen = Math.floor(rawCodewords / numBlocks);
	const divisor = rsDivisor(blockEccLen);
	const blocks: number[][] = [];
	for (let i = 0, k = 0; i < numBlocks; i++) {
		const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
		k += dat.length;
		const ecc = rsRemainder(dat, divisor);
		if (i < numShortBlocks) dat.push(0);
		blocks.push(dat.concat(ecc));
	}
	const result: number[] = [];
	for (let i = 0; i < at(blocks, 0).length; i++) {
		blocks.forEach((block, j) => {
			if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(at(block, i));
		});
	}
	return result;
}

class Matrix {
	readonly version: number;
	readonly size: number;
	readonly modules: boolean[][];
	readonly isFunction: boolean[][];

	constructor(version: number) {
		this.version = version;
		this.size = version * 4 + 17;
		this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
		this.isFunction = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
	}

	dark(x: number, y: number): boolean {
		return at(at(this.modules, y), x);
	}

	fixed(x: number, y: number): boolean {
		return at(at(this.isFunction, y), x);
	}

	put(x: number, y: number, dark: boolean): void {
		at(this.modules, y)[x] = dark;
	}

	set(x: number, y: number, dark: boolean): void {
		this.put(x, y, dark);
		at(this.isFunction, y)[x] = true;
	}

	drawFunctionPatterns(ecl: number): void {
		for (let i = 0; i < this.size; i++) {
			this.set(6, i, i % 2 === 0);
			this.set(i, 6, i % 2 === 0);
		}
		this.drawFinder(3, 3);
		this.drawFinder(this.size - 4, 3);
		this.drawFinder(3, this.size - 4);
		const positions = this.alignmentPositions();
		const n = positions.length;
		for (let i = 0; i < n; i++) {
			for (let j = 0; j < n; j++) {
				if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
				this.drawAlignment(at(positions, i), at(positions, j));
			}
		}
		this.drawFormatBits(ecl, 0); // reserves the area; redrawn per mask
		this.drawVersion();
	}

	drawFinder(x: number, y: number): void {
		for (let dy = -4; dy <= 4; dy++) {
			for (let dx = -4; dx <= 4; dx++) {
				const dist = Math.max(Math.abs(dx), Math.abs(dy));
				const xx = x + dx;
				const yy = y + dy;
				if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) this.set(xx, yy, dist !== 2 && dist !== 4);
			}
		}
	}

	drawAlignment(x: number, y: number): void {
		for (let dy = -2; dy <= 2; dy++) {
			for (let dx = -2; dx <= 2; dx++) this.set(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
		}
	}

	alignmentPositions(): number[] {
		if (this.version === 1) return [];
		const numAlign = Math.floor(this.version / 7) + 2;
		const step = this.version === 32 ? 26 : Math.ceil((this.version * 4 + 4) / (numAlign * 2 - 2)) * 2;
		const result = [6];
		for (let pos = this.size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
		return result;
	}

	drawFormatBits(ecl: number, mask: number): void {
		const data = (at(ECL_FORMAT_BITS, ecl) << 3) | mask;
		let rem = data;
		for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
		const bits = ((data << 10) | rem) ^ 0x5412;
		const bit = (i: number): boolean => ((bits >>> i) & 1) !== 0;
		for (let i = 0; i <= 5; i++) this.set(8, i, bit(i));
		this.set(8, 7, bit(6));
		this.set(8, 8, bit(7));
		this.set(7, 8, bit(8));
		for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(i));
		for (let i = 0; i < 8; i++) this.set(this.size - 1 - i, 8, bit(i));
		for (let i = 8; i < 15; i++) this.set(8, this.size - 15 + i, bit(i));
		this.set(8, this.size - 8, true);
	}

	drawVersion(): void {
		if (this.version < 7) return;
		let rem = this.version;
		for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
		const bits = (this.version << 12) | rem;
		for (let i = 0; i < 18; i++) {
			const dark = ((bits >>> i) & 1) !== 0;
			const a = this.size - 11 + (i % 3);
			const b = Math.floor(i / 3);
			this.set(a, b, dark);
			this.set(b, a, dark);
		}
	}

	drawCodewords(data: readonly number[]): void {
		let i = 0;
		for (let right = this.size - 1; right >= 1; right -= 2) {
			if (right === 6) right = 5;
			for (let vert = 0; vert < this.size; vert++) {
				for (let j = 0; j < 2; j++) {
					const x = right - j;
					const upward = ((right + 1) & 2) === 0;
					const y = upward ? this.size - 1 - vert : vert;
					if (!this.fixed(x, y) && i < data.length * 8) {
						this.put(x, y, ((at(data, i >>> 3) >>> (7 - (i & 7))) & 1) !== 0);
						i++;
					}
				}
			}
		}
	}

	applyMask(mask: number): void {
		const masks: readonly ((x: number, y: number) => boolean)[] = [
			(x, y) => (x + y) % 2 === 0,
			(_x, y) => y % 2 === 0,
			(x) => x % 3 === 0,
			(x, y) => (x + y) % 3 === 0,
			(x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
			(x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
			(x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
			(x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
		];
		const test = at(masks, mask);
		for (let y = 0; y < this.size; y++) {
			for (let x = 0; x < this.size; x++) {
				if (!this.fixed(x, y) && test(x, y)) this.put(x, y, !this.dark(x, y));
			}
		}
	}

	penalty(): number {
		const n = this.size;
		const m = (x: number, y: number): boolean => this.dark(x, y);
		let score = 0;
		const finderLike = [
			[true, false, true, true, true, false, true, false, false, false, false],
			[false, false, false, false, true, false, true, true, true, false, true],
		];
		for (let pass = 0; pass < 2; pass++) {
			for (let a = 0; a < n; a++) {
				const line: boolean[] = [];
				for (let b = 0; b < n; b++) line.push(pass === 0 ? m(b, a) : m(a, b));
				let run = 1;
				for (let b = 1; b <= n; b++) {
					if (b < n && line[b] === line[b - 1]) run++;
					else {
						if (run >= 5) score += 3 + (run - 5);
						run = 1;
					}
				}
				for (let b = 0; b + 11 <= n; b++) {
					for (const pattern of finderLike) {
						if (pattern.every((v, k) => line[b + k] === v)) score += 40;
					}
				}
			}
		}
		for (let y = 0; y < n - 1; y++) {
			for (let x = 0; x < n - 1; x++) {
				const c = m(x, y);
				if (c === m(x + 1, y) && c === m(x, y + 1) && c === m(x + 1, y + 1)) score += 3;
			}
		}
		let dark = 0;
		for (const row of this.modules) for (const v of row) if (v) dark++;
		const total = n * n;
		const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
		score += Math.max(0, k) * 10;
		return score;
	}
}

/**
 * Draw a QR matrix with Unicode half blocks: two module rows per text line, dark modules
 * black on a white background (ANSI colours), so it scans on light and dark terminals alike.
 */
export function renderHalfBlocks(qr: QrMatrix, { quiet = 2, ansi = true }: RenderOptions = {}): string[] {
	const size = qr.size + quiet * 2;
	const dark = (x: number, y: number): boolean => {
		const qx = x - quiet;
		const qy = y - quiet;
		return qx >= 0 && qy >= 0 && qx < qr.size && qy < qr.size && qr.modules[qy]?.[qx] === true;
	};
	const lines = [];
	for (let y = 0; y < size; y += 2) {
		let line = "";
		for (let x = 0; x < size; x++) {
			const top = dark(x, y);
			const bottom = y + 1 < size ? dark(x, y + 1) : false;
			line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
		}
		lines.push(ansi ? `\x1b[30;107m${line}\x1b[0m` : line);
	}
	return lines;
}
