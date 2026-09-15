/*
 * Leitor estrutural e limitado de metadados PDF para o recurso auxiliar local.
 * O módulo não renderiza documentos, não executa XML e não procura texto solto:
 * somente referências alcançáveis pelo trailer e pelo catálogo são consideradas.
 */
(function (scope) {
  "use strict";

  const MAX_READ_CALLS = 1024;
  const MAX_READ_BYTES = 32 * 1024 * 1024;
  const MAX_XREF_SECTION_BYTES = 4 * 1024 * 1024;
  const MAX_OBJECT_BYTES = 2 * 1024 * 1024;
  const MAX_DECODED_STREAM_BYTES = 2 * 1024 * 1024;
  const MAX_XMP_BYTES = 512 * 1024;
  const MAX_RAW_XML_CHARS = 128 * 1024;
  const MAX_XREF_ENTRIES = 200000;
  const MAX_XREF_SECTIONS = 32;
  const MAX_OBJECT_STREAM_ITEMS = 4096;
  const MAX_TOKENS = 100000;
  const MAX_PARSE_DEPTH = 32;
  const LATIN1 = new TextDecoder("iso-8859-1");

  function fail(message) {
    throw new Error(message);
  }

  function isWhite(byte) {
    return byte === 0 || byte === 9 || byte === 10 || byte === 12 || byte === 13 || byte === 32;
  }

  function isDelimiter(byte) {
    return isWhite(byte) || [0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25].includes(byte);
  }

  function ascii(bytes) {
    return LATIN1.decode(bytes);
  }

  function cleanText(value, maximum = 512) {
    if (typeof value !== "string") return null;
    const cleaned = value
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return cleaned ? cleaned.slice(0, maximum) : null;
  }

  function codeUnitsToString(codeUnits) {
    let result = "";
    for (let index = 0; index < codeUnits.length; index += 8192) {
      result += String.fromCharCode(...codeUnits.slice(index, index + 8192));
    }
    return result;
  }

  function named(value) {
    return Object.freeze({ kind: "name", value });
  }

  function referenced(objectNumber, generation) {
    return Object.freeze({ kind: "ref", objectNumber, generation });
  }

  function stringBytes(bytes) {
    return Object.freeze({ kind: "string", bytes });
  }

  function isName(value, expected = null) {
    return value?.kind === "name" && (expected === null || value.value === expected);
  }

  function isReference(value) {
    return value?.kind === "ref"
      && Number.isSafeInteger(value.objectNumber)
      && Number.isSafeInteger(value.generation);
  }

  class PdfParser {
    constructor(bytes, position = 0) {
      this.bytes = bytes;
      this.position = position;
      this.tokenCount = 0;
    }

    skipSpace() {
      while (this.position < this.bytes.length) {
        const byte = this.bytes[this.position];
        if (isWhite(byte)) {
          this.position += 1;
          continue;
        }
        if (byte === 0x25) {
          while (this.position < this.bytes.length && ![10, 13].includes(this.bytes[this.position])) {
            this.position += 1;
          }
          continue;
        }
        break;
      }
    }

    nextToken() {
      this.skipSpace();
      this.tokenCount += 1;
      if (this.tokenCount > MAX_TOKENS) fail("O PDF excedeu o limite de elementos estruturais.");
      if (this.position >= this.bytes.length) return { kind: "eof" };
      const byte = this.bytes[this.position++];

      if (byte === 0x3c && this.bytes[this.position] === 0x3c) {
        this.position += 1;
        return { kind: "dictStart" };
      }
      if (byte === 0x3e && this.bytes[this.position] === 0x3e) {
        this.position += 1;
        return { kind: "dictEnd" };
      }
      if (byte === 0x5b) return { kind: "arrayStart" };
      if (byte === 0x5d) return { kind: "arrayEnd" };
      if (byte === 0x2f) return { kind: "name", value: this.readName() };
      if (byte === 0x28) return { kind: "string", value: this.readLiteralString() };
      if (byte === 0x3c) return { kind: "string", value: this.readHexString() };

      const start = this.position - 1;
      while (this.position < this.bytes.length && !isDelimiter(this.bytes[this.position])) {
        this.position += 1;
      }
      const word = ascii(this.bytes.subarray(start, this.position));
      if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(word)) return { kind: "number", value: Number(word) };
      return { kind: "keyword", value: word };
    }

    readName() {
      const result = [];
      while (this.position < this.bytes.length && !isDelimiter(this.bytes[this.position])) {
        if (this.bytes[this.position] === 0x23
            && /^[0-9a-f]{2}$/i.test(ascii(this.bytes.subarray(this.position + 1, this.position + 3)))) {
          result.push(Number.parseInt(ascii(this.bytes.subarray(this.position + 1, this.position + 3)), 16));
          this.position += 3;
        } else {
          result.push(this.bytes[this.position]);
          this.position += 1;
        }
      }
      return ascii(Uint8Array.from(result));
    }

    readLiteralString() {
      const result = [];
      let depth = 1;
      while (this.position < this.bytes.length && depth > 0) {
        let byte = this.bytes[this.position++];
        if (byte === 0x5c) {
          if (this.position >= this.bytes.length) break;
          byte = this.bytes[this.position++];
          const escaped = new Map([
            [0x6e, 10], [0x72, 13], [0x74, 9], [0x62, 8], [0x66, 12]
          ]);
          if (escaped.has(byte)) result.push(escaped.get(byte));
          else if (byte === 13) {
            if (this.bytes[this.position] === 10) this.position += 1;
          } else if (byte !== 10 && byte >= 0x30 && byte <= 0x37) {
            let octal = String.fromCharCode(byte);
            for (let count = 1; count < 3; count += 1) {
              const next = this.bytes[this.position];
              if (next < 0x30 || next > 0x37) break;
              octal += String.fromCharCode(next);
              this.position += 1;
            }
            result.push(Number.parseInt(octal, 8) & 0xff);
          } else if (byte !== 10) result.push(byte);
          continue;
        }
        if (byte === 0x28) {
          depth += 1;
          if (depth > MAX_PARSE_DEPTH) fail("Uma string do PDF excedeu o limite de aninhamento.");
          result.push(byte);
        } else if (byte === 0x29) {
          depth -= 1;
          if (depth > 0) result.push(byte);
        } else if (byte === 13) {
          if (this.bytes[this.position] === 10) this.position += 1;
          result.push(10);
        } else {
          result.push(byte);
        }
        if (result.length > MAX_OBJECT_BYTES) fail("Uma string do PDF excedeu o limite local.");
      }
      if (depth !== 0) fail("String PDF incompleta.");
      return Uint8Array.from(result);
    }

    readHexString() {
      let hex = "";
      while (this.position < this.bytes.length) {
        const byte = this.bytes[this.position++];
        if (byte === 0x3e) break;
        if (!isWhite(byte)) hex += String.fromCharCode(byte);
      }
      if (!/^[0-9a-f]*$/i.test(hex)) fail("String hexadecimal inválida no PDF.");
      if (hex.length % 2) hex += "0";
      const result = new Uint8Array(hex.length / 2);
      for (let index = 0; index < result.length; index += 1) {
        result[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
      }
      return result;
    }

    parseValue(depth = 0) {
      if (depth > MAX_PARSE_DEPTH) fail("O PDF excedeu o limite de aninhamento.");
      const token = this.nextToken();
      if (token.kind === "dictStart") {
        const dictionary = Object.create(null);
        while (true) {
          const key = this.nextToken();
          if (key.kind === "dictEnd") return dictionary;
          if (key.kind !== "name") fail("Dicionário PDF inválido.");
          dictionary[key.value] = this.parseValue(depth + 1);
        }
      }
      if (token.kind === "arrayStart") {
        const result = [];
        while (true) {
          const checkpoint = this.position;
          const end = this.nextToken();
          if (end.kind === "arrayEnd") return result;
          this.position = checkpoint;
          result.push(this.parseValue(depth + 1));
          if (result.length > MAX_XREF_ENTRIES) fail("Array PDF excessivo.");
        }
      }
      if (token.kind === "name") return named(token.value);
      if (token.kind === "string") return stringBytes(token.value);
      if (token.kind === "number") {
        const checkpoint = this.position;
        const second = this.nextToken();
        const third = second.kind === "number" ? this.nextToken() : null;
        if (Number.isSafeInteger(token.value) && Number.isSafeInteger(second.value)
            && third?.kind === "keyword" && third.value === "R") {
          return referenced(token.value, second.value);
        }
        this.position = checkpoint;
        return token.value;
      }
      if (token.kind === "keyword") {
        if (token.value === "true") return true;
        if (token.value === "false") return false;
        if (token.value === "null") return null;
        return Object.freeze({ kind: "keyword", value: token.value });
      }
      fail("Valor PDF incompleto.");
    }
  }

  function findDictionary(bytes, start = 0) {
    for (let index = start; index + 1 < bytes.length; index += 1) {
      if (bytes[index] === 0x3c && bytes[index + 1] === 0x3c) {
        const parser = new PdfParser(bytes, index);
        const dictionary = parser.parseValue();
        return { dictionary, end: parser.position };
      }
    }
    fail("Dicionário PDF não encontrado.");
  }

  function createReader(size, readRange) {
    let calls = 0;
    let bytesRead = 0;
    return async (offset, length) => {
      calls += 1;
      bytesRead += length;
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length)
          || offset < 0 || length < 0 || offset > size || length > size - offset
          || calls > MAX_READ_CALLS || bytesRead > MAX_READ_BYTES) {
        fail("O PDF excedeu o orçamento local de leitura.");
      }
      const buffer = await readRange(offset, length);
      if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== length) {
        fail("A fonte PDF devolveu um intervalo divergente.");
      }
      return new Uint8Array(buffer);
    };
  }

  function parseInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
    if (!Number.isSafeInteger(value) || value < 0 || value > maximum) fail(`${label} inválido no PDF.`);
    return value;
  }

  function findStreamStart(bytes, dictionaryEnd) {
    const tail = ascii(bytes.subarray(dictionaryEnd));
    const match = /\bstream(?:\r\n|\r|\n)/.exec(tail);
    const objectEnd = /\bendobj\b/.exec(tail);
    if (!match || (objectEnd && objectEnd.index < match.index)) return null;
    return dictionaryEnd + match.index + match[0].length;
  }

  async function readIndirectObject(read, size, offset) {
    parseInteger(offset, "Offset de objeto", size - 1);
    const length = Math.min(MAX_OBJECT_BYTES, size - offset);
    const bytes = await read(offset, length);
    const header = /^\s*(\d+)\s+(\d+)\s+obj\b/.exec(ascii(bytes.subarray(0, Math.min(bytes.length, 128))));
    if (!header) fail("Objeto indireto PDF inválido.");
    const parsed = findDictionary(bytes, header[0].length);
    const streamStart = findStreamStart(bytes, parsed.end);
    let stream = null;
    if (streamStart !== null) {
      const streamLength = parseInteger(parsed.dictionary.Length, "Comprimento de fluxo", MAX_OBJECT_BYTES);
      if (streamStart + streamLength > bytes.length) fail("Fluxo PDF excedeu o limite local.");
      stream = bytes.slice(streamStart, streamStart + streamLength);
    }
    return Object.freeze({
      objectNumber: Number(header[1]),
      generation: Number(header[2]),
      dictionary: parsed.dictionary,
      stream
    });
  }

  function filterNames(dictionary) {
    const value = dictionary.Filter;
    if (value === undefined) return [];
    const filters = Array.isArray(value) ? value : [value];
    if (!filters.every(item => isName(item))) fail("Filtro de fluxo PDF inválido.");
    return filters.map(item => item.value);
  }

  async function inflateBounded(bytes, maximum) {
    if (typeof DecompressionStream !== "function") fail("Descompressão PDF indisponível neste navegador.");
    const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate")).getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        fail("Fluxo PDF descompactado excedeu o limite local.");
      }
      chunks.push(value);
    }
    const result = new Uint8Array(total);
    let position = 0;
    for (const chunk of chunks) {
      result.set(chunk, position);
      position += chunk.byteLength;
    }
    return result;
  }

  function paeth(left, above, upperLeft) {
    const estimate = left + above - upperLeft;
    const leftDistance = Math.abs(estimate - left);
    const aboveDistance = Math.abs(estimate - above);
    const upperDistance = Math.abs(estimate - upperLeft);
    if (leftDistance <= aboveDistance && leftDistance <= upperDistance) return left;
    return aboveDistance <= upperDistance ? above : upperLeft;
  }

  function undoPngPredictor(bytes, parameters) {
    const predictor = Number(parameters?.Predictor ?? 1);
    if (!Number.isSafeInteger(predictor) || predictor <= 1) return bytes;
    if (predictor < 10 || predictor > 15) fail("Preditor de fluxo PDF não suportado.");
    const colors = parseInteger(Number(parameters?.Colors ?? 1), "Cores do preditor", 32);
    const bits = parseInteger(Number(parameters?.BitsPerComponent ?? 8), "Bits do preditor", 16);
    const columns = parseInteger(Number(parameters?.Columns), "Colunas do preditor", MAX_XREF_ENTRIES);
    if (bits !== 8 || colors < 1 || columns < 1) fail("Configuração de preditor PDF não suportada.");
    const rowBytes = colors * columns;
    const hasRowFilter = bytes.length % (rowBytes + 1) === 0;
    const fixedFilter = predictor === 15 ? null : predictor - 10;
    if (!hasRowFilter && (fixedFilter === null || bytes.length % rowBytes !== 0)) {
      fail("Dados de preditor PDF inválidos.");
    }
    const rowCount = bytes.length / (hasRowFilter ? rowBytes + 1 : rowBytes);
    const result = new Uint8Array(rowCount * rowBytes);
    let input = 0;
    for (let row = 0; row < rowCount; row += 1) {
      const filter = hasRowFilter ? bytes[input++] : fixedFilter;
      if (!Number.isInteger(filter) || filter < 0 || filter > 4) fail("Filtro de preditor PDF inválido.");
      for (let column = 0; column < rowBytes; column += 1) {
        const raw = bytes[input++];
        const outputIndex = row * rowBytes + column;
        const left = column >= colors ? result[outputIndex - colors] : 0;
        const above = row > 0 ? result[outputIndex - rowBytes] : 0;
        const upperLeft = row > 0 && column >= colors ? result[outputIndex - rowBytes - colors] : 0;
        if (filter === 0) result[outputIndex] = raw;
        else if (filter === 1) result[outputIndex] = (raw + left) & 0xff;
        else if (filter === 2) result[outputIndex] = (raw + above) & 0xff;
        else if (filter === 3) result[outputIndex] = (raw + Math.floor((left + above) / 2)) & 0xff;
        else result[outputIndex] = (raw + paeth(left, above, upperLeft)) & 0xff;
      }
    }
    return result;
  }

  async function decodeStream(object, maximum = MAX_DECODED_STREAM_BYTES) {
    if (!(object.stream instanceof Uint8Array)) fail("Fluxo PDF ausente.");
    const filters = filterNames(object.dictionary);
    if (filters.length > 1 || (filters[0] && !["FlateDecode", "Fl"].includes(filters[0]))) {
      fail("O PDF usa filtro de metadados não suportado.");
    }
    let decoded = object.stream;
    if (filters.length === 1) decoded = await inflateBounded(decoded, maximum);
    if (decoded.byteLength > maximum) fail("Fluxo PDF excedeu o limite local.");
    const parameters = Array.isArray(object.dictionary.DecodeParms)
      ? object.dictionary.DecodeParms[0]
      : object.dictionary.DecodeParms;
    return undoPngPredictor(decoded, parameters);
  }

  function parseClassicXref(bytes) {
    const source = ascii(bytes);
    if (!/^\s*xref\b/.test(source)) fail("Tabela de referência PDF não reconhecida.");
    let position = source.indexOf("xref") + 4;
    const entries = new Map();
    let countTotal = 0;
    while (position < source.length) {
      while (/\s/.test(source[position] || "")) position += 1;
      if (source.startsWith("trailer", position)) {
        const parsed = findDictionary(bytes, position + 7);
        return { entries, trailer: parsed.dictionary };
      }
      const section = /^(\d+)\s+(\d+)/.exec(source.slice(position));
      if (!section) fail("Seção xref inválida no PDF.");
      const first = parseInteger(Number(section[1]), "Índice xref", MAX_XREF_ENTRIES);
      const count = parseInteger(Number(section[2]), "Contagem xref", MAX_XREF_ENTRIES);
      countTotal += count;
      if (countTotal > MAX_XREF_ENTRIES) fail("O PDF excedeu o limite de referências.");
      position += section[0].length;
      for (let index = 0; index < count; index += 1) {
        while (source[position] === " " || source[position] === "\t" || source[position] === "\r" || source[position] === "\n") position += 1;
        const entry = /^(\d{10})\s+(\d{5})\s+([nf])(?:\s|$)/.exec(source.slice(position));
        if (!entry) fail("Entrada xref inválida no PDF.");
        if (entry[3] === "n") {
          entries.set(first + index, Object.freeze({
            type: 1,
            offset: Number(entry[1]),
            generation: Number(entry[2])
          }));
        }
        position += entry[0].length;
      }
    }
    fail("Trailer PDF não encontrado.");
  }

  function readBigEndian(bytes, position, width) {
    let result = 0;
    for (let index = 0; index < width; index += 1) result = result * 256 + bytes[position + index];
    if (!Number.isSafeInteger(result)) fail("Entrada xref excede a precisão local.");
    return result;
  }

  async function parseXrefStream(object) {
    if (!isName(object.dictionary.Type, "XRef")) fail("Fluxo xref inválido no PDF.");
    const widths = object.dictionary.W;
    if (!Array.isArray(widths) || widths.length !== 3) fail("Larguras xref inválidas no PDF.");
    const safeWidths = widths.map(value => parseInteger(value, "Largura xref", 8));
    const rowWidth = safeWidths.reduce((sum, value) => sum + value, 0);
    if (rowWidth < 1 || rowWidth > 24) fail("Largura total xref inválida no PDF.");
    const size = parseInteger(object.dictionary.Size, "Tamanho xref", MAX_XREF_ENTRIES);
    const index = object.dictionary.Index ?? [0, size];
    if (!Array.isArray(index) || index.length % 2 !== 0) fail("Índice de fluxo xref inválido.");
    const decoded = await decodeStream(object, MAX_XREF_SECTION_BYTES);
    const entries = new Map();
    let position = 0;
    let countTotal = 0;
    for (let pair = 0; pair < index.length; pair += 2) {
      const first = parseInteger(index[pair], "Índice xref", MAX_XREF_ENTRIES);
      const count = parseInteger(index[pair + 1], "Contagem xref", MAX_XREF_ENTRIES);
      countTotal += count;
      if (countTotal > MAX_XREF_ENTRIES) fail("O PDF excedeu o limite de referências.");
      for (let offset = 0; offset < count; offset += 1) {
        if (position + rowWidth > decoded.length) fail("Fluxo xref truncado.");
        const fields = [];
        let cursor = position;
        for (const width of safeWidths) {
          fields.push(width === 0 ? 0 : readBigEndian(decoded, cursor, width));
          cursor += width;
        }
        position += rowWidth;
        const type = safeWidths[0] === 0 ? 1 : fields[0];
        if (type === 1) entries.set(first + offset, Object.freeze({ type, offset: fields[1], generation: fields[2] }));
        if (type === 2) entries.set(first + offset, Object.freeze({ type, objectStream: fields[1], index: fields[2] }));
      }
    }
    return { entries, trailer: object.dictionary };
  }

  async function parseXrefSection(read, size, offset) {
    const length = Math.min(MAX_XREF_SECTION_BYTES, size - offset);
    if (length <= 0) fail("Offset xref fora do arquivo.");
    const bytes = await read(offset, length);
    if (/^\s*xref\b/.test(ascii(bytes.subarray(0, 32)))) return parseClassicXref(bytes);
    return parseXrefStream(await readIndirectObject(read, size, offset));
  }

  async function collectXref(read, size, startOffset) {
    const entries = new Map();
    const trailers = [];
    const visited = new Set();
    let current = startOffset;
    let revisions = 0;
    while (current !== null) {
      parseInteger(current, "Offset xref", size - 1);
      if (visited.has(current)) fail("A cadeia incremental do PDF contém ciclo.");
      if (revisions >= MAX_XREF_SECTIONS) fail("O PDF excedeu o limite de atualizações incrementais.");
      visited.add(current);
      const section = await parseXrefSection(read, size, current);
      revisions += 1;
      trailers.push(section.trailer);
      for (const [objectNumber, entry] of section.entries) {
        if (!entries.has(objectNumber)) entries.set(objectNumber, entry);
      }
      const supplemental = section.trailer.XRefStm;
      if (Number.isSafeInteger(supplemental) && !visited.has(supplemental)) {
        visited.add(supplemental);
        const hybrid = await parseXrefSection(read, size, supplemental);
        for (const [objectNumber, entry] of hybrid.entries) {
          if (!entries.has(objectNumber)) entries.set(objectNumber, entry);
        }
      }
      current = Number.isSafeInteger(section.trailer.Prev) ? section.trailer.Prev : null;
    }
    return { entries, trailers, revisions };
  }

  function firstTrailerValue(trailers, key) {
    for (const trailer of trailers) {
      if (trailer[key] !== undefined) return trailer[key];
    }
    return undefined;
  }

  function createObjectResolver(read, size, entries) {
    const objectCache = new Map();
    const streamCache = new Map();

    async function loadObject(reference) {
      if (!isReference(reference)) fail("Referência PDF inválida.");
      if (objectCache.has(reference.objectNumber)) return objectCache.get(reference.objectNumber);
      const entry = entries.get(reference.objectNumber);
      if (!entry) fail("Objeto referenciado não consta do xref.");
      let result;
      if (entry.type === 1) {
        const object = await readIndirectObject(read, size, entry.offset);
        if (object.objectNumber !== reference.objectNumber) fail("Objeto PDF divergente do xref.");
        result = object;
      } else if (entry.type === 2) {
        result = await loadFromObjectStream(reference, entry);
      } else {
        fail("Tipo de referência PDF não suportado.");
      }
      objectCache.set(reference.objectNumber, result);
      return result;
    }

    async function loadFromObjectStream(reference, entry) {
      let cached = streamCache.get(entry.objectStream);
      if (!cached) {
        const containerEntry = entries.get(entry.objectStream);
        if (!containerEntry || containerEntry.type !== 1) fail("Fluxo de objetos PDF inválido.");
        const container = await readIndirectObject(read, size, containerEntry.offset);
        if (!isName(container.dictionary.Type, "ObjStm")) fail("Objeto comprimido fora de ObjStm.");
        const count = parseInteger(container.dictionary.N, "Quantidade de objetos comprimidos", MAX_OBJECT_STREAM_ITEMS);
        const first = parseInteger(container.dictionary.First, "Início de objetos comprimidos", MAX_DECODED_STREAM_BYTES);
        const decoded = await decodeStream(container);
        if (first > decoded.length) fail("Cabeçalho ObjStm inválido.");
        const parser = new PdfParser(decoded.subarray(0, first));
        const directory = [];
        for (let index = 0; index < count; index += 1) {
          const objectToken = parser.nextToken();
          const offsetToken = parser.nextToken();
          if (objectToken.kind !== "number" || offsetToken.kind !== "number") fail("Diretório ObjStm inválido.");
          directory.push({
            objectNumber: parseInteger(objectToken.value, "Objeto ObjStm", MAX_XREF_ENTRIES),
            offset: parseInteger(offsetToken.value, "Offset ObjStm", decoded.length - first)
          });
        }
        cached = { decoded, first, directory };
        streamCache.set(entry.objectStream, cached);
      }
      const selected = cached.directory[entry.index];
      if (!selected || selected.objectNumber !== reference.objectNumber) fail("Índice ObjStm divergente.");
      const next = cached.directory[entry.index + 1];
      const start = cached.first + selected.offset;
      const end = next ? cached.first + next.offset : cached.decoded.length;
      if (start < cached.first || end < start || end > cached.decoded.length) fail("Faixa ObjStm inválida.");
      const segment = cached.decoded.slice(start, end);
      const parsed = findDictionary(segment);
      return Object.freeze({
        objectNumber: reference.objectNumber,
        generation: 0,
        dictionary: parsed.dictionary,
        stream: null
      });
    }

    return loadObject;
  }

  function decodePdfString(value) {
    if (value?.kind !== "string" || !(value.bytes instanceof Uint8Array)) return null;
    const bytes = value.bytes.subarray(0, 4096);
    let decoded;
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      const chars = [];
      for (let index = 2; index + 1 < bytes.length; index += 2) chars.push(bytes[index] * 256 + bytes[index + 1]);
      decoded = codeUnitsToString(chars);
    } else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      const chars = [];
      for (let index = 2; index + 1 < bytes.length; index += 2) chars.push(bytes[index] + bytes[index + 1] * 256);
      decoded = codeUnitsToString(chars);
    } else {
      decoded = ascii(bytes);
    }
    return cleanText(decoded);
  }

  function pdfValueText(value) {
    if (value?.kind === "string") return decodePdfString(value);
    if (value?.kind === "name") return cleanText(value.value);
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return null;
  }

  function selectDictionaryFields(dictionary, mapping) {
    const result = Object.create(null);
    for (const [output, source] of Object.entries(mapping)) {
      const value = pdfValueText(dictionary?.[source]);
      if (value !== null) result[output] = value;
    }
    return result;
  }

  function bytesToHex(value) {
    if (value?.kind !== "string" || !(value.bytes instanceof Uint8Array)) return null;
    if (value.bytes.length < 1 || value.bytes.length > 64) return null;
    return Array.from(value.bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  }

  function decodeXml(bytes) {
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      const chars = [];
      for (let index = 2; index + 1 < bytes.length; index += 2) chars.push(bytes[index] * 256 + bytes[index + 1]);
      return codeUnitsToString(chars);
    }
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      const chars = [];
      for (let index = 2; index + 1 < bytes.length; index += 2) chars.push(bytes[index] + bytes[index + 1] * 256);
      return codeUnitsToString(chars);
    }
    return new TextDecoder("utf-8").decode(bytes);
  }

  function decodeXmlEntities(value) {
    return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|amp|lt|gt|quot|apos);/gi, entity => {
      if (entity.toLowerCase() === "&amp;") return "&";
      if (entity.toLowerCase() === "&lt;") return "<";
      if (entity.toLowerCase() === "&gt;") return ">";
      if (entity.toLowerCase() === "&quot;") return "\"";
      if (entity.toLowerCase() === "&apos;") return "'";
      const decimal = /^&#(\d+);$/i.exec(entity);
      const hexadecimal = /^&#x([0-9a-f]+);$/i.exec(entity);
      const codePoint = decimal ? Number(decimal[1]) : Number.parseInt(hexadecimal?.[1] || "", 16);
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : "";
    });
  }

  function xmlFragmentText(fragment) {
    const listItems = Array.from(fragment.matchAll(/<(?:[A-Za-z_][\w.-]*:)?li\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?li\s*>/gi));
    const source = listItems.length ? listItems.map(match => match[1]).join(" | ") : fragment;
    return cleanText(decodeXmlEntities(source
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/<[^>]*>/g, " ")));
  }

  function xmlValue(xml, namespaceUri, localName) {
    const prefixes = Array.from(xml.matchAll(/\bxmlns:([A-Za-z_][\w.-]*)\s*=\s*(["'])(.*?)\2/gi))
      .filter(match => decodeXmlEntities(match[3]) === namespaceUri)
      .map(match => match[1]);
    if (!prefixes.length) return null;
    const escaped = localName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const prefix of prefixes) {
      const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const element = new RegExp(`<${escapedPrefix}:${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escapedPrefix}:${escaped}\\s*>`, "i").exec(xml);
      const elementValue = element ? xmlFragmentText(element[1]) : null;
      if (elementValue) return elementValue;
      const attribute = new RegExp(`(?:^|\\s)${escapedPrefix}:${escaped}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i").exec(xml);
      if (attribute) return cleanText(decodeXmlEntities(attribute[2]));
    }
    return null;
  }

  function extractXmp(bytes) {
    if (bytes.byteLength > MAX_XMP_BYTES) fail("O fluxo XMP excedeu o limite local.");
    const decoded = decodeXml(bytes)
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, " ");
    if (!/<(?:[A-Za-z_][\w.-]*:)?(?:xmpmeta|RDF)\b/i.test(decoded)) {
      fail("O fluxo de metadados do catálogo não contém XMP reconhecível.");
    }
    const unsafeDeclarations = /<!DOCTYPE\b|<!ENTITY\b/i.test(decoded);
    const namespaces = Object.freeze({
      dc: "http://purl.org/dc/elements/1.1/",
      pdf: "http://ns.adobe.com/pdf/1.3/",
      xmp: "http://ns.adobe.com/xap/1.0/",
      xmpMM: "http://ns.adobe.com/xap/1.0/mm/"
    });
    const fields = unsafeDeclarations ? Object.create(null) : Object.fromEntries(Object.entries({
      title: xmlValue(decoded, namespaces.dc, "title"),
      creators: xmlValue(decoded, namespaces.dc, "creator"),
      description: xmlValue(decoded, namespaces.dc, "description"),
      subjects: xmlValue(decoded, namespaces.dc, "subject"),
      keywords: xmlValue(decoded, namespaces.pdf, "Keywords"),
      creatorTool: xmlValue(decoded, namespaces.xmp, "CreatorTool"),
      producer: xmlValue(decoded, namespaces.pdf, "Producer"),
      createDate: xmlValue(decoded, namespaces.xmp, "CreateDate"),
      modifyDate: xmlValue(decoded, namespaces.xmp, "ModifyDate"),
      metadataDate: xmlValue(decoded, namespaces.xmp, "MetadataDate"),
      documentId: xmlValue(decoded, namespaces.xmpMM, "DocumentID"),
      instanceId: xmlValue(decoded, namespaces.xmpMM, "InstanceID"),
      originalDocumentId: xmlValue(decoded, namespaces.xmpMM, "OriginalDocumentID")
    }).filter(([, value]) => value !== null));
    return {
      status: "available",
      fields,
      rawXml: decoded.slice(0, MAX_RAW_XML_CHARS),
      rawBytes: bytes.byteLength,
      rawTruncated: decoded.length > MAX_RAW_XML_CHARS,
      normalized: !unsafeDeclarations,
      ...(unsafeDeclarations ? {
        reason: "O XML contém DOCTYPE ou ENTITY; o LDF não normalizou esses campos."
      } : {})
    };
  }

  async function analyze(size, readRange, suppliedPrefix = null) {
    if (!Number.isSafeInteger(size) || size < 16 || typeof readRange !== "function") {
      fail("Fonte PDF inválida para análise local.");
    }
    const read = createReader(size, readRange);
    const prefix = suppliedPrefix instanceof Uint8Array
      ? suppliedPrefix
      : await read(0, Math.min(1024, size));
    const header = /%PDF-(1\.[0-7]|2\.0)/.exec(ascii(prefix));
    if (!header || header.index > 1024) fail("Envelope PDF não reconhecido.");

    const tailLength = Math.min(1024 * 1024, size);
    const tail = ascii(await read(size - tailLength, tailLength));
    const matches = Array.from(tail.matchAll(/startxref\s+(\d+)\s+(?=%%EOF)/g));
    if (!matches.length) fail("Referência final do PDF não encontrada.");
    const startXref = parseInteger(Number(matches[matches.length - 1][1]), "Offset xref", size - 1);
    const xref = await collectXref(read, size, startXref);
    const rootReference = firstTrailerValue(xref.trailers, "Root");
    if (!isReference(rootReference)) fail("Catálogo PDF não referenciado.");
    const infoReference = firstTrailerValue(xref.trailers, "Info");
    const identifierArray = firstTrailerValue(xref.trailers, "ID");
    const encrypted = firstTrailerValue(xref.trailers, "Encrypt") !== undefined;
    const identifiers = Object.create(null);
    if (Array.isArray(identifierArray)) {
      const original = bytesToHex(identifierArray[0]);
      const current = bytesToHex(identifierArray[1]);
      if (original) identifiers.original = original;
      if (current) identifiers.current = current;
    }

    const structure = {
      version: header[1],
      encrypted,
      incrementalUpdates: Math.max(0, xref.revisions - 1)
    };
    const technical = [{ type: "General", format: "PDF", profile: `PDF ${header[1]}` }];
    if (encrypted) {
      return {
        status: "available",
        engine: "Leitor estrutural PDF local do LDF",
        kind: "pdf",
        origin: {},
        gps: {},
        technical,
        pdf: {
          structure,
          info: {},
          identifiers,
          xmp: {
            status: "unavailable",
            reason: "O PDF indica criptografia; metadados potencialmente cifrados não foram interpretados."
          }
        }
      };
    }

    const loadObject = createObjectResolver(read, size, xref.entries);
    const info = isReference(infoReference)
      ? selectDictionaryFields((await loadObject(infoReference)).dictionary, {
        title: "Title",
        author: "Author",
        subject: "Subject",
        keywords: "Keywords",
        creator: "Creator",
        producer: "Producer",
        creationDate: "CreationDate",
        modificationDate: "ModDate",
        trapped: "Trapped"
      })
      : {};

    const catalog = await loadObject(rootReference);
    const metadataReference = catalog.dictionary.Metadata;
    let xmp = { status: "absent" };
    if (isReference(metadataReference)) {
      try {
        const metadata = await loadObject(metadataReference);
        if (!isName(metadata.dictionary.Type, "Metadata")
            || (metadata.dictionary.Subtype !== undefined && !isName(metadata.dictionary.Subtype, "XML"))) {
          fail("O catálogo referencia fluxo de metadados não XML.");
        }
        xmp = extractXmp(await decodeStream(metadata, MAX_XMP_BYTES));
      } catch (error) {
        xmp = {
          status: "unavailable",
          reason: error instanceof Error ? error.message : "Fluxo XMP indisponível."
        };
      }
    }

    return {
      status: "available",
      engine: "Leitor estrutural PDF local do LDF",
      kind: "pdf",
      origin: {},
      gps: {},
      technical,
      pdf: { structure, info, identifiers, xmp }
    };
  }

  function isPdfHeader(bytes) {
    return bytes instanceof Uint8Array && /%PDF-(?:1\.[0-7]|2\.0)/.test(ascii(bytes.subarray(0, 1024)));
  }

  scope.LDFPdfMetadata = Object.freeze({ analyze, isPdfHeader });
})(typeof self === "object" ? self : window);
