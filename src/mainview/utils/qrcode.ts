/**
 * Minimal QR Code generator (byte mode, ECC level L/M) → SVG string.
 * Sufficient for short LAN URLs. No external dependencies.
 *
 * Based on the standard QR encoding pipeline (ISO/IEC 18004).
 */

// prettier-ignore
const ECC_CODEWORDS_PER_BLOCK: Record<number, number[]> = {
  // [L, M, Q, H] for versions 1–10 (we only need a few)
  1: [7, 10, 13, 17],
  2: [10, 16, 22, 28],
  3: [15, 26, 36, 44],
  4: [20, 36, 52, 64],
  5: [26, 48, 72, 88],
  6: [36, 64, 96, 112],
  7: [40, 72, 108, 130],
  8: [48, 88, 132, 156],
  9: [60, 110, 160, 192],
  10: [72, 130, 192, 224],
};

// prettier-ignore
const NUM_ERROR_CORRECTION_BLOCKS: Record<number, number[]> = {
  1: [1, 1, 1, 1],
  2: [1, 1, 1, 1],
  3: [1, 1, 2, 2],
  4: [1, 2, 2, 4],
  5: [1, 2, 4, 4],
  6: [2, 4, 4, 4],
  7: [2, 4, 6, 5],
  8: [2, 4, 6, 6],
  9: [2, 5, 8, 8],
  10: [4, 5, 8, 8],
};

type EccLevel = 0 | 1 | 2 | 3; // L M Q H

function getNumRawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function getNumDataCodewords(version: number, ecl: EccLevel): number {
  return (
    Math.floor(getNumRawDataModules(version) / 8) -
    ECC_CODEWORDS_PER_BLOCK[version]![ecl]! *
      NUM_ERROR_CORRECTION_BLOCKS[version]![ecl]!
  );
}

function reedSolomonComputeDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = reedSolomonMultiply(result[j]!, root);
      if (j + 1 < result.length) result[j]! ^= result[j + 1]!;
    }
    root = reedSolomonMultiply(root, 0x02);
  }
  return result;
}

function reedSolomonComputeRemainder(
  data: number[],
  divisor: number[],
): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ result[0]!;
    result.shift();
    result.push(0);
    for (let i = 0; i < result.length; i++) {
      result[i]! ^= reedSolomonMultiply(divisor[i]!, factor);
    }
  }
  return result;
}

function reedSolomonMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = ((z << 1) ^ ((z >>> 7) * 0x11d)) & 0xff;
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function addEccAndInterleave(data: number[], version: number, ecl: EccLevel): number[] {
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[version]![ecl]!;
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[version]![ecl]!;
  const rawCodewords = Math.floor(getNumRawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);

  const blocks: number[][] = [];
  const rsDiv = reedSolomonComputeDivisor(blockEccLen);
  let k = 0;
  for (let i = 0; i < numBlocks; i++) {
    const dat = data.slice(
      k,
      k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1),
    );
    k += dat.length;
    const ecc = reedSolomonComputeRemainder(dat, rsDiv);
    if (i < numShortBlocks) dat.push(0);
    blocks.push(dat.concat(ecc));
  }

  const result: number[] = [];
  for (let i = 0; i < blocks[0]!.length; i++) {
    for (let j = 0; j < blocks.length; j++) {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) {
        result.push(blocks[j]![i]!);
      }
    }
  }
  return result;
}

function getBit(x: number, i: number): number {
  return (x >>> i) & 1;
}

class QrCode {
  readonly size: number;
  private modules: boolean[][];
  private isFunction: boolean[][];

  constructor(
    readonly version: number,
    readonly errorCorrectionLevel: EccLevel,
    dataCodewords: number[],
    mask: number,
  ) {
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () =>
      Array<boolean>(this.size).fill(false),
    );
    this.isFunction = Array.from({ length: this.size }, () =>
      Array<boolean>(this.size).fill(false),
    );

    this.drawFunctionPatterns();
    const allCodewords = addEccAndInterleave(
      dataCodewords,
      version,
      errorCorrectionLevel,
    );
    this.drawCodewords(allCodewords);
    if (mask === -1) {
      let minPenalty = Infinity;
      for (let i = 0; i < 8; i++) {
        this.applyMask(i);
        this.drawFormatBits(i);
        const penalty = this.getPenaltyScore();
        if (penalty < minPenalty) {
          mask = i;
          minPenalty = penalty;
        }
        this.applyMask(i);
      }
    }
    this.applyMask(mask);
    this.drawFormatBits(mask);
  }

  getModule(x: number, y: number): boolean {
    return this.modules[y]![x]!;
  }

  private drawFunctionPatterns() {
    for (let i = 0; i < this.size; i++) {
      this.setFunctionModule(6, i, i % 2 === 0);
      this.setFunctionModule(i, 6, i % 2 === 0);
    }
    this.drawFinderPattern(3, 3);
    this.drawFinderPattern(this.size - 4, 3);
    this.drawFinderPattern(3, this.size - 4);
    const align = getAlignmentPatternPositions(this.version);
    for (let i = 0; i < align.length; i++) {
      for (let j = 0; j < align.length; j++) {
        if (
          (i === 0 && j === 0) ||
          (i === 0 && j === align.length - 1) ||
          (i === align.length - 1 && j === 0)
        )
          continue;
        this.drawAlignmentPattern(align[i]!, align[j]!);
      }
    }
    this.drawFormatBits(0);
    this.drawVersion();
  }

  private drawFinderPattern(x: number, y: number) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) {
          this.setFunctionModule(xx, yy, dist !== 2 && dist !== 4);
        }
      }
    }
  }

  private drawAlignmentPattern(x: number, y: number) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        this.setFunctionModule(
          x + dx,
          y + dy,
          Math.max(Math.abs(dx), Math.abs(dy)) !== 1,
        );
      }
    }
  }

  private drawFormatBits(mask: number) {
    const data = (this.errorCorrectionLevel << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) this.setFunctionModule(8, i, getBit(bits, i) !== 0);
    this.setFunctionModule(8, 7, getBit(bits, 6) !== 0);
    this.setFunctionModule(8, 8, getBit(bits, 7) !== 0);
    this.setFunctionModule(7, 8, getBit(bits, 8) !== 0);
    for (let i = 9; i < 15; i++)
      this.setFunctionModule(14 - i, 8, getBit(bits, i) !== 0);
    for (let i = 0; i < 8; i++)
      this.setFunctionModule(this.size - 1 - i, 8, getBit(bits, i) !== 0);
    for (let i = 8; i < 15; i++)
      this.setFunctionModule(8, this.size - 15 + i, getBit(bits, i) !== 0);
    this.setFunctionModule(8, this.size - 8, true);
  }

  private drawVersion() {
    if (this.version < 7) return;
    let rem = this.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (this.version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = getBit(bits, i) !== 0;
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.setFunctionModule(a, b, bit);
      this.setFunctionModule(b, a, bit);
    }
  }

  private setFunctionModule(x: number, y: number, isDark: boolean) {
    this.modules[y]![x] = isDark;
    this.isFunction[y]![x] = true;
  }

  private drawCodewords(data: number[]) {
    let i = 0;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < this.size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? this.size - 1 - vert : vert;
          if (!this.isFunction[y]![x] && i < data.length * 8) {
            this.modules[y]![x] = getBit(data[i >>> 3]!, 7 - (i & 7)) !== 0;
            i++;
          }
        }
      }
    }
  }

  private applyMask(mask: number) {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (this.isFunction[y]![x]) continue;
        let invert = false;
        switch (mask) {
          case 0:
            invert = (x + y) % 2 === 0;
            break;
          case 1:
            invert = y % 2 === 0;
            break;
          case 2:
            invert = x % 3 === 0;
            break;
          case 3:
            invert = (x + y) % 3 === 0;
            break;
          case 4:
            invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
            break;
          case 5:
            invert = ((x * y) % 2) + ((x * y) % 3) === 0;
            break;
          case 6:
            invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
            break;
          case 7:
            invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
            break;
          default:
            throw new Error("bad mask");
        }
        this.modules[y]![x] = this.modules[y]![x]! !== invert;
      }
    }
  }

  private getPenaltyScore(): number {
    let result = 0;
    for (let y = 0; y < this.size; y++) {
      let runColor = false;
      let runX = 0;
      const runHistory = [0, 0, 0, 0, 0, 0, 0];
      for (let x = 0; x < this.size; x++) {
        if (this.modules[y]![x] === runColor) {
          runX++;
          if (runX === 5) result += 3;
          else if (runX > 5) result++;
        } else {
          this.finderPenaltyAddHistory(runX, runHistory);
          if (!runColor) result += this.finderPenaltyCountPatterns(runHistory) * 40;
          runColor = this.modules[y]![x]!;
          runX = 1;
        }
      }
      result +=
        this.finderPenaltyTerminateAndCount(runColor, runX, runHistory) * 40;
    }
    for (let x = 0; x < this.size; x++) {
      let runColor = false;
      let runY = 0;
      const runHistory = [0, 0, 0, 0, 0, 0, 0];
      for (let y = 0; y < this.size; y++) {
        if (this.modules[y]![x] === runColor) {
          runY++;
          if (runY === 5) result += 3;
          else if (runY > 5) result++;
        } else {
          this.finderPenaltyAddHistory(runY, runHistory);
          if (!runColor) result += this.finderPenaltyCountPatterns(runHistory) * 40;
          runColor = this.modules[y]![x]!;
          runY = 1;
        }
      }
      result +=
        this.finderPenaltyTerminateAndCount(runColor, runY, runHistory) * 40;
    }
    for (let y = 0; y < this.size - 1; y++) {
      for (let x = 0; x < this.size - 1; x++) {
        const color = this.modules[y]![x];
        if (
          color === this.modules[y]![x + 1] &&
          color === this.modules[y + 1]![x] &&
          color === this.modules[y + 1]![x + 1]
        )
          result += 3;
      }
    }
    let dark = 0;
    for (const row of this.modules) {
      for (const cell of row) if (cell) dark++;
    }
    const total = this.size * this.size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += k * 10;
    return result;
  }

  private finderPenaltyCountPatterns(runHistory: number[]): number {
    const n = runHistory[1]!;
    const core =
      n > 0 &&
      runHistory[2]! === n &&
      runHistory[3]! === n * 3 &&
      runHistory[4]! === n &&
      runHistory[5]! === n;
    return (
      (core && runHistory[0]! >= n * 4 && runHistory[6]! >= n ? 1 : 0) +
      (core && runHistory[6]! >= n * 4 && runHistory[0]! >= n ? 1 : 0)
    );
  }

  private finderPenaltyTerminateAndCount(
    currentRunColor: boolean,
    currentRunLength: number,
    runHistory: number[],
  ): number {
    if (currentRunColor) {
      this.finderPenaltyAddHistory(currentRunLength, runHistory);
      currentRunLength = 0;
    }
    currentRunLength += this.size;
    this.finderPenaltyAddHistory(currentRunLength, runHistory);
    return this.finderPenaltyCountPatterns(runHistory);
  }

  private finderPenaltyAddHistory(currentRunLength: number, runHistory: number[]) {
    if (runHistory[0] === 0) currentRunLength += this.size;
    runHistory.pop();
    runHistory.unshift(currentRunLength);
  }
}

function getAlignmentPatternPositions(version: number): number[] {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const step =
    version === 32
      ? 26
      : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = thisSize(version) - 7; result.length < numAlign; pos -= step) {
    result.splice(1, 0, pos);
  }
  return result;
}

function thisSize(version: number): number {
  return version * 4 + 17;
}

function encodeSegments(text: string, ecl: EccLevel): QrCode {
  const segData = encodeByteSegment(text);
  let version: number;
  for (version = 1; version <= 10; version++) {
    const dataCapacityBits = getNumDataCodewords(version, ecl) * 8;
    const used = totalBits(segData, version);
    if (used <= dataCapacityBits) break;
  }
  if (version > 10) throw new Error("Data too long for QR");

  const bb: number[] = [];
  appendBits(0x4, 4, bb); // byte mode
  appendBits(segData.length, version <= 9 ? 8 : 16, bb);
  for (const b of segData) appendBits(b, 8, bb);

  const dataCapacityBits = getNumDataCodewords(version, ecl) * 8;
  appendBits(0, Math.min(4, dataCapacityBits - bb.length), bb);
  appendBits(0, (8 - (bb.length % 8)) % 8, bb);
  for (let pad = 0xec; bb.length < dataCapacityBits; pad ^= 0xec ^ 0x11) {
    appendBits(pad, 8, bb);
  }

  const dataCodewords: number[] = [];
  for (let i = 0; i < bb.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bb[i + j]!;
    dataCodewords.push(b);
  }
  return new QrCode(version, ecl, dataCodewords, -1);
}

function encodeByteSegment(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

function totalBits(data: number[], version: number): number {
  return 4 + (version <= 9 ? 8 : 16) + data.length * 8;
}

function appendBits(val: number, len: number, bb: number[]) {
  for (let i = len - 1; i >= 0; i--) bb.push((val >>> i) & 1);
}

/** Render text as a QR SVG (white quiet zone, black modules). */
export function qrToSvg(text: string, moduleSize = 4, margin = 2): string {
  const qr = encodeSegments(text, 0 /* L */);
  const n = qr.size;
  const dim = (n + margin * 2) * moduleSize;
  let path = "";
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!qr.getModule(x, y)) continue;
      const px = (x + margin) * moduleSize;
      const py = (y + margin) * moduleSize;
      path += `M${px},${py}h${moduleSize}v${moduleSize}h${-moduleSize}z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path fill="#000" d="${path}"/></svg>`;
}

export function qrToDataUrl(text: string, moduleSize = 4, margin = 2): string {
  const svg = qrToSvg(text, moduleSize, margin);
  // btoa may not handle unicode; SVG here is ASCII.
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}
