(function (root) {
  "use strict";

  const MAX_PREFIX_BYTES = 4 * 1024 * 1024;
  const BMFF_C2PA_UUID = Object.freeze([
    0xd8, 0xfe, 0xc3, 0xd6, 0x1b, 0x0e, 0x48, 0x3c,
    0x92, 0x97, 0x58, 0x28, 0x87, 0x7e, 0xc4, 0x81
  ]);

  const detected = format => Object.freeze({ status: "detected", format });
  const absent = format => Object.freeze({ status: "absent", format });
  const unavailable = reason => Object.freeze({ status: "unavailable", reason });

  function ascii(bytes, offset, length) {
    let value = "";
    for (let index = 0; index < length && offset + index < bytes.length; index += 1) {
      value += String.fromCharCode(bytes[offset + index]);
    }
    return value;
  }

  function equalsAt(bytes, offset, expected) {
    if (offset < 0 || offset + expected.length > bytes.length) return false;
    for (let index = 0; index < expected.length; index += 1) {
      if (bytes[offset + index] !== expected[index]) return false;
    }
    return true;
  }

  function containsAscii(bytes, value, from = 0, to = bytes.length) {
    const expected = Array.from(value, character => character.charCodeAt(0));
    const end = Math.min(bytes.length, to) - expected.length;
    for (let offset = Math.max(0, from); offset <= end; offset += 1) {
      if (equalsAt(bytes, offset, expected)) return true;
    }
    return false;
  }

  function uint32be(bytes, offset) {
    return (((bytes[offset] * 0x1000000) + (bytes[offset + 1] << 16)
      + (bytes[offset + 2] << 8) + bytes[offset + 3]) >>> 0);
  }

  function uint32le(bytes, offset) {
    return ((bytes[offset]) + (bytes[offset + 1] << 8)
      + (bytes[offset + 2] << 16) + (bytes[offset + 3] * 0x1000000)) >>> 0;
  }

  function inspectPng(bytes, complete) {
    let offset = 8;
    while (offset + 12 <= bytes.length) {
      const length = uint32be(bytes, offset);
      if (length > 0x7fffffff) return unavailable("Estrutura PNG inválida.");
      const end = offset + 12 + length;
      if (end > bytes.length) return complete ? unavailable("Estrutura PNG truncada.") : unavailable("Limite técnico de leitura atingido.");
      if (ascii(bytes, offset + 4, 4) === "caBX") return detected("PNG");
      if (ascii(bytes, offset + 4, 4) === "IEND") return absent("PNG");
      offset = end;
    }
    return complete ? absent("PNG") : unavailable("Limite técnico de leitura atingido.");
  }

  function inspectJpeg(bytes, complete) {
    let offset = 2;
    while (offset + 1 < bytes.length) {
      if (bytes[offset] !== 0xff) return unavailable("Estrutura JPEG inválida.");
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) return absent("JPEG");
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const length = (bytes[offset] << 8) | bytes[offset + 1];
      if (length < 2) return unavailable("Estrutura JPEG inválida.");
      const end = offset + length;
      if (end > bytes.length) break;
      if (marker === 0xeb && bytes[offset + 2] === 0x4a && bytes[offset + 3] === 0x50
        && containsAscii(bytes, "c2pa", offset + 4, end)) return detected("JPEG");
      offset = end;
    }
    return complete ? absent("JPEG") : unavailable("Limite técnico de leitura atingido.");
  }

  function inspectRiff(bytes, complete) {
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const length = uint32le(bytes, offset + 4);
      const end = offset + 8 + length + (length % 2);
      if (end > bytes.length) return complete ? unavailable("Estrutura RIFF truncada.") : unavailable("Limite técnico de leitura atingido.");
      if (ascii(bytes, offset, 4) === "C2PA") return detected(`RIFF/${ascii(bytes, 8, 4)}`);
      offset = end;
    }
    return complete ? absent(`RIFF/${ascii(bytes, 8, 4)}`) : unavailable("Limite técnico de leitura atingido.");
  }

  function inspectGif(bytes, complete) {
    for (let offset = 6; offset + 14 <= bytes.length; offset += 1) {
      if (bytes[offset] === 0x21 && bytes[offset + 1] === 0xff && bytes[offset + 2] === 0x0b
        && ascii(bytes, offset + 3, 8) === "C2PA_GIF") return detected("GIF");
    }
    return complete ? absent("GIF") : unavailable("Limite técnico de leitura atingido.");
  }

  function inspectId3(bytes, complete) {
    if (bytes.length < 10) return complete ? unavailable("Cabeçalho ID3 truncado.") : unavailable("Limite técnico de leitura atingido.");
    const tagSize = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
    const tagEnd = Math.min(10 + tagSize, bytes.length);
    let offset = 10;
    while (offset + 10 <= tagEnd) {
      const id = ascii(bytes, offset, 4);
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      const length = bytes[3] === 4
        ? ((bytes[offset + 4] & 0x7f) << 21) | ((bytes[offset + 5] & 0x7f) << 14) | ((bytes[offset + 6] & 0x7f) << 7) | (bytes[offset + 7] & 0x7f)
        : uint32be(bytes, offset + 4);
      const end = offset + 10 + length;
      if (end > tagEnd) break;
      if (id === "GEOB" && containsAscii(bytes, "application/x-c2pa-manifest-store", offset + 11, end)) return detected("ID3");
      offset = end;
    }
    if (10 + tagSize <= bytes.length) return absent("ID3");
    return complete ? unavailable("Estrutura ID3 truncada.") : unavailable("Limite técnico de leitura atingido.");
  }

  function inspectOgg(bytes, complete) {
    if (containsAscii(bytes, "\u0000c2pa", 0, bytes.length)) return detected("Ogg");
    return complete ? absent("Ogg") : unavailable("Limite técnico de leitura atingido.");
  }

  function inspectTiff(bytes, complete) {
    const little = bytes[0] === 0x49;
    const read16 = offset => little
      ? bytes[offset] | (bytes[offset + 1] << 8)
      : (bytes[offset] << 8) | bytes[offset + 1];
    const read32 = offset => little ? uint32le(bytes, offset) : uint32be(bytes, offset);
    if (bytes.length < 8 || read16(2) !== 42) return unavailable("Estrutura TIFF inválida.");
    let ifdOffset = read32(4);
    const visited = new Set();
    for (let depth = 0; depth < 8 && ifdOffset; depth += 1) {
      if (visited.has(ifdOffset) || ifdOffset + 2 > bytes.length) break;
      visited.add(ifdOffset);
      const count = read16(ifdOffset);
      if (!Number.isSafeInteger(count) || count > 4096 || ifdOffset + 2 + count * 12 + 4 > bytes.length) break;
      for (let index = 0; index < count; index += 1) {
        if (read16(ifdOffset + 2 + index * 12) === 0xcd41) return detected("TIFF/DNG");
      }
      ifdOffset = read32(ifdOffset + 2 + count * 12);
    }
    return complete ? absent("TIFF/DNG") : unavailable("Limite técnico de leitura atingido.");
  }

  function inspectBmff(bytes, complete) {
    let offset = 0;
    while (offset + 8 <= bytes.length) {
      let length = uint32be(bytes, offset);
      const type = ascii(bytes, offset + 4, 4);
      let headerLength = 8;
      if (length === 1) {
        if (offset + 16 > bytes.length) break;
        const high = uint32be(bytes, offset + 8);
        const low = uint32be(bytes, offset + 12);
        length = high * 0x100000000 + low;
        headerLength = 16;
      } else if (length === 0) {
        length = bytes.length - offset;
      }
      if (!Number.isSafeInteger(length) || length < headerLength) return unavailable("Estrutura BMFF inválida.");
      if (type === "uuid" && length >= headerLength + 16 && equalsAt(bytes, offset + headerLength, BMFF_C2PA_UUID)) {
        return detected("BMFF");
      }
      if (offset + length > bytes.length) return complete ? unavailable("Estrutura BMFF truncada.") : unavailable("Limite técnico de leitura atingido.");
      offset += length;
    }
    return complete ? absent("BMFF") : unavailable("Limite técnico de leitura atingido.");
  }

  function inspect(bytes, totalBytes) {
    const complete = totalBytes <= bytes.length;
    if (equalsAt(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return inspectPng(bytes, complete);
    if (equalsAt(bytes, 0, [0xff, 0xd8])) return inspectJpeg(bytes, complete);
    if (ascii(bytes, 0, 4) === "RIFF" && bytes.length >= 12) return inspectRiff(bytes, complete);
    if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") return inspectGif(bytes, complete);
    if (ascii(bytes, 0, 3) === "ID3") return inspectId3(bytes, complete);
    if (ascii(bytes, 0, 4) === "OggS") return inspectOgg(bytes, complete);
    if (equalsAt(bytes, 0, [0x49, 0x49, 0x2a, 0x00]) || equalsAt(bytes, 0, [0x4d, 0x4d, 0x00, 0x2a])) return inspectTiff(bytes, complete);
    if (bytes.length >= 12 && ascii(bytes, 4, 4) === "ftyp") return inspectBmff(bytes, complete);
    return unavailable("Formato não suportado para verificação C2PA.");
  }

  class Detector {
    constructor() {
      this.parts = [];
      this.prefixBytes = 0;
      this.totalBytes = 0;
    }

    update(value) {
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      this.totalBytes += bytes.byteLength;
      if (this.prefixBytes >= MAX_PREFIX_BYTES) return;
      const accepted = bytes.slice(0, Math.min(bytes.byteLength, MAX_PREFIX_BYTES - this.prefixBytes));
      this.parts.push(accepted);
      this.prefixBytes += accepted.byteLength;
    }

    finish() {
      const prefix = new Uint8Array(this.prefixBytes);
      let offset = 0;
      for (const part of this.parts) {
        prefix.set(part, offset);
        offset += part.byteLength;
      }
      this.parts.length = 0;
      return inspect(prefix, this.totalBytes);
    }
  }

  root.LDFC2paDetector = Object.freeze({ Detector, inspect, MAX_PREFIX_BYTES });
})(typeof self !== "undefined" ? self : globalThis);

