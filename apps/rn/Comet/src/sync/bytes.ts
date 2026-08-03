// Byte primitives — port of the ByteWriter / ByteReader in LoroProtocol.swift.
// ULEB128 varints, length-prefixed varBytes/varString. Operates on Uint8Array.

export class ByteWriter {
  private chunks: number[] = [];

  get bytes(): Uint8Array {
    return new Uint8Array(this.chunks);
  }

  get length(): number {
    return this.chunks.length;
  }

  byte(b: number): this {
    this.chunks.push(b & 0xff);
    return this;
  }

  raw(bytes: ArrayLike<number>): this {
    for (let i = 0; i < bytes.length; i++) this.chunks.push(bytes[i] & 0xff);
    return this;
  }

  uleb128(value: number): this {
    let v = value;
    do {
      let b = v & 0x7f;
      v = Math.floor(v / 128);
      if (v !== 0) b |= 0x80;
      this.chunks.push(b);
    } while (v !== 0);
    return this;
  }

  varBytes(bytes: ArrayLike<number>): this {
    this.uleb128(bytes.length);
    return this.raw(bytes);
  }

  varString(s: string): this {
    const utf8 = new TextEncoder().encode(s);
    return this.varBytes(utf8);
  }
}

export class ByteReader {
  readonly bytes: Uint8Array;
  offset = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  get remaining(): number {
    return this.bytes.length - this.offset;
  }

  readByte(): number | null {
    if (this.offset >= this.bytes.length) return null;
    return this.bytes[this.offset++];
  }

  read(count: number): Uint8Array | null {
    if (this.offset + count > this.bytes.length) return null;
    const slice = this.bytes.subarray(this.offset, this.offset + count);
    this.offset += count;
    return slice;
  }

  uleb128(): number | null {
    let result = 0;
    let shift = 0;
    while (true) {
      const b = this.readByte();
      if (b === null) return null;
      result |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result;
      shift += 7;
      if (shift > 63) return null;
    }
  }

  varBytes(maxLength = Number.MAX_SAFE_INTEGER): Uint8Array | null {
    const len = this.uleb128();
    if (len === null || len > this.remaining || len > maxLength) return null;
    return this.read(len);
  }

  varString(): string | null {
    const b = this.varBytes();
    if (!b) return null;
    return new TextDecoder('utf-8').decode(b);
  }
}

export function randomBatchId(): Uint8Array {
  const out = new Uint8Array(8);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(out);
  } else {
    for (let i = 0; i < 8; i++) out[i] = Math.floor(Math.random() * 256);
  }
  return out;
}
