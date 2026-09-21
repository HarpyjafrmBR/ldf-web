/*
 * Formato LDF-WEB-1:
 * [8 bytes magic][4 bytes tamanho do cabeçalho][cabeçalho JSON][blocos AES-GCM]
 *
 * O relatório interno do sistema é o registro criptográfico 0. Cada arquivo
 * seguinte forma outro registro, dividido em blocos autenticados independentes.
 * Nomes, hashes e qualificações permanecem inacessíveis sem a chave do lote.
 */
(function () {
  "use strict";

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const MAGIC_TEXT = "LDFWEB1\n";
  const MAGIC = encoder.encode(MAGIC_TEXT);
  const FORMAT = "LDF-WEB-1";
  const ITERATIONS = 600000;
  const CHUNK_SIZE = 8 * 1024 * 1024;
  const AUTH_TAG_BYTES = 16;
  const MAX_HEADER_BYTES = 16 * 1024 * 1024;
  const MAX_BUFFERED_RECORD_BYTES = 64 * 1024 * 1024;
  const MAX_RECORDS = 10000;
  const MAX_TOTAL_CHUNKS = 100000;
  const MIN_SECRET_LENGTH = 12;
  const MAX_SECRET_LENGTH = 256;
  const INVALID_CONTAINER_MESSAGE = "O arquivo selecionado não é um contêiner LDF Web.";

  let worker = null;
  let workerSequence = 0;
  let workerUnavailable = false;
  let workerPrepared = false;
  let runtimePreparation = null;
  const workerRequests = new Map();

  window.LDFCrypto = {
    FORMAT,
    CHUNK_SIZE,
    ITERATIONS,
    prepareRuntime,
    runtimeStatus,
    sha256Blob,
    inspectBlob,
    sha256Buffer,
    canonicalJson,
    sha256Canonical,
    sealContainer,
    sealContainerToWritable,
    openContainer,
    randomBytes,
    bytesToBase64
  };

  /*
   * A saída deve oferecer write(). Em navegadores compatíveis, ela será o
   * FileSystemWritableFileStream escolhido pelo usuário. Cada bloco é gravado
   * imediatamente, evitando que o contêiner completo permaneça na memória.
   */
  async function sealContainerToWritable(
    secret,
    internalReport,
    payloads,
    writable,
    onProgress = () => {},
    progressMessages = []
  ) {
    return writeContainer({
      secret,
      internalReport,
      payloads,
      writable,
      onProgress,
      progressMessages
    });
  }

  async function sealContainer(secret, internalReport, payloads, onProgress = () => {}, progressMessages = []) {
    const parts = [];
    const memoryWritable = {
      async write(part) {
        parts.push(part);
      }
    };
    await sealContainerToWritable(
      secret,
      internalReport,
      payloads,
      memoryWritable,
      onProgress,
      progressMessages
    );
    return new Blob(parts, { type: "application/octet-stream" });
  }

  async function openContainer(file, secret, onProgress = () => {}) {
    if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH || secret.length > MAX_SECRET_LENGTH) {
      throw new Error("A chave de acesso deve ter entre 12 e 256 caracteres.");
    }
    if (file.size < 12) throw new Error(INVALID_CONTAINER_MESSAGE);
    const prefix = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    if (decoder.decode(prefix.slice(0, 8)) !== MAGIC_TEXT) throw new Error(INVALID_CONTAINER_MESSAGE);

    const headerLength = new DataView(prefix.buffer, 8, 4).getUint32(0, true);
    if (headerLength <= 0 || headerLength > MAX_HEADER_BYTES || 12 + headerLength > file.size) {
      throw new Error(INVALID_CONTAINER_MESSAGE);
    }

    let outerHeader;
    try {
      const headerDecoder = new TextDecoder("utf-8", { fatal: true });
      outerHeader = JSON.parse(headerDecoder.decode(await file.slice(12, 12 + headerLength).arrayBuffer()));
    } catch {
      throw new Error(INVALID_CONTAINER_MESSAGE);
    }
    const validatedHeader = validateOuterHeader(outerHeader, file.size, headerLength);
    onProgress("Derivando chave e autenticando o contêiner");
    const key = await deriveKey(secret, validatedHeader.saltBytes);

    return createContainerSession({
      file,
      outerHeader,
      records: validatedHeader.records,
      key
    });
  }

  function randomBytes(length) {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return bytes;
  }

  function bytesToBase64(bytes) {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  function base64ToBytes(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  function decodeCanonicalBase64(value, expectedBytes) {
    if (typeof value !== "string" || value.length > Math.ceil(expectedBytes / 3) * 4) {
      throw new Error(INVALID_CONTAINER_MESSAGE);
    }
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
      throw new Error(INVALID_CONTAINER_MESSAGE);
    }
    let bytes;
    try {
      bytes = base64ToBytes(value);
    } catch {
      throw new Error(INVALID_CONTAINER_MESSAGE);
    }
    if (bytes.byteLength !== expectedBytes || bytesToBase64(bytes) !== value) {
      throw new Error(INVALID_CONTAINER_MESSAGE);
    }
    return bytes;
  }

  function disableHashWorker(message = "Web Worker indisponível.") {
    workerUnavailable = true;
    workerPrepared = false;
    const activeWorker = worker;
    worker = null;
    activeWorker?.terminate();
    for (const pending of workerRequests.values()) pending.reject(new Error(message));
    workerRequests.clear();
  }

  function getHashWorker() {
    if (worker) return worker;
    if (workerUnavailable || typeof Worker === "undefined") {
      workerUnavailable = true;
      return null;
    }
    try {
      worker = new Worker("crypto-worker.js?v=beta-1.1.2");
      worker.addEventListener("message", event => {
        const pending = workerRequests.get(event.data.requestId);
        if (!pending) return;
        workerRequests.delete(event.data.requestId);
        if (event.data.error) pending.reject(new Error(event.data.error));
        else pending.resolve(event.data.result);
      });
      worker.addEventListener("error", () => disableHashWorker(
        "O processamento criptográfico em segundo plano foi interrompido."
      ));
      return worker;
    } catch {
      workerUnavailable = true;
      return null;
    }
  }

  function askWorker(action, data = {}, transfer = []) {
    const activeWorker = getHashWorker();
    if (!activeWorker) return Promise.reject(new Error("Web Worker indisponível."));
    const requestId = ++workerSequence;
    return new Promise((resolve, reject) => {
      workerRequests.set(requestId, { resolve, reject });
      try {
        activeWorker.postMessage({ requestId, action, ...data }, transfer);
      } catch (error) {
        workerRequests.delete(requestId);
        disableHashWorker("O processamento criptográfico em segundo plano não pôde ser iniciado.");
        reject(error);
      }
    });
  }

  async function prepareRuntime() {
    if (!runtimePreparation) {
      runtimePreparation = (async () => {
        try {
          await askWorker("ping");
          workerPrepared = true;
        } catch {
          disableHashWorker();
        }
        return Object.freeze({ workerAvailable: workerPrepared });
      })();
    }
    return runtimePreparation;
  }

  function runtimeStatus() {
    return Object.freeze({
      prepared: Boolean(runtimePreparation),
      workerAvailable: workerPrepared,
      workerUnavailable
    });
  }

  async function sha256BlobLocally(blob) {
    const hash = new window.LDFSha256();
    for (let offset = 0; offset < blob.size; offset += CHUNK_SIZE) {
      const buffer = await blob.slice(offset, Math.min(offset + CHUNK_SIZE, blob.size)).arrayBuffer();
      hash.update(new Uint8Array(buffer));
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    return hash.hex();
  }

  async function sha256Blob(blob) {
    const runtime = await prepareRuntime();
    if (runtime.workerAvailable) {
      try {
        return await askWorker("hashBlob", { blob, chunkSize: CHUNK_SIZE });
      } catch {
        disableHashWorker();
      }
    }
    return sha256BlobLocally(blob);
  }

  async function inspectBlobLocally(blob) {
    const hash = new window.LDFSha256();
    const detector = new window.LDFC2paDetector.Detector();
    for (let offset = 0; offset < blob.size; offset += CHUNK_SIZE) {
      const buffer = await blob.slice(offset, Math.min(offset + CHUNK_SIZE, blob.size)).arrayBuffer();
      const bytes = new Uint8Array(buffer);
      hash.update(bytes);
      detector.update(bytes);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    return { sha256: hash.hex(), c2pa: detector.finish() };
  }

  async function inspectBlob(blob) {
    const runtime = await prepareRuntime();
    if (runtime.workerAvailable) {
      try {
        return await askWorker("inspectBlob", { blob, chunkSize: CHUNK_SIZE });
      } catch {
        disableHashWorker();
      }
    }
    return inspectBlobLocally(blob);
  }

  async function sha256Buffer(buffer) {
    return Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", buffer)),
      byte => byte.toString(16).padStart(2, "0")
    ).join("");
  }

  /*
   * JSON canônico: objetos equivalentes produzem exatamente a mesma sequência
   * de bytes, mesmo quando suas propriedades foram inseridas em outra ordem.
   * Isso permite fixar um único SHA-256 para todo o lote já qualificado.
   */
  function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object") {
      return Object.keys(value).sort().reduce((result, key) => {
        if (value[key] !== undefined) result[key] = canonicalize(value[key]);
        return result;
      }, {});
    }
    return value;
  }

  function canonicalJson(value) {
    return JSON.stringify(canonicalize(value));
  }

  async function sha256Canonical(value) {
    return sha256Buffer(encoder.encode(canonicalJson(value)));
  }

  async function createIncrementalHasher(inspect = false) {
    const sessionId = crypto.randomUUID();
    const runtime = await prepareRuntime();
    if (runtime.workerAvailable) try {
      await askWorker("start", { sessionId, inspect });
      return {
        async update(buffer) {
          await askWorker("update", { sessionId, buffer }, [buffer]);
        },
        async finish() {
          return askWorker("finish", { sessionId });
        },
        async cancel() {
          try {
            await askWorker("cancel", { sessionId });
          } catch {
            // A sessão já pode ter sido encerrada junto com o Worker.
          }
        }
      };
    } catch {
      disableHashWorker();
    }
    const localHash = new window.LDFSha256();
    const localDetector = inspect ? new window.LDFC2paDetector.Detector() : null;
    return {
      async update(buffer) {
        const bytes = new Uint8Array(buffer);
        localHash.update(bytes);
        localDetector?.update(bytes);
        await new Promise(resolve => setTimeout(resolve, 0));
      },
      async finish() {
        const sha256 = localHash.hex();
        return localDetector ? { sha256, c2pa: localDetector.finish() } : sha256;
      },
      async cancel() {}
    };
  }

  async function deriveKey(secret, salt) {
    const material = await crypto.subtle.importKey(
      "raw", encoder.encode(secret), { name: "PBKDF2" }, false, ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations: ITERATIONS },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  function sourceLength(source) {
    if (source instanceof Blob) return source.size;
    if (source instanceof ArrayBuffer) return source.byteLength;
    if (ArrayBuffer.isView(source)) return source.byteLength;
    throw new Error("Fonte criptográfica inválida.");
  }

  async function readSourceChunk(source, offset, length) {
    if (source instanceof Blob) return source.slice(offset, offset + length).arrayBuffer();
    const bytes = source instanceof ArrayBuffer
      ? new Uint8Array(source)
      : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    return bytes.slice(offset, offset + length).buffer;
  }

  function buildRecordPlan(plainLength, chunkCount) {
    const chunks = [];
    for (let index = 0; index < chunkCount; index += 1) {
      const offset = index * CHUNK_SIZE;
      const chunkPlainLength = Math.min(CHUNK_SIZE, Math.max(0, plainLength - offset));
      chunks.push({
        iv: bytesToBase64(randomBytes(12)),
        plainLength: chunkPlainLength,
        length: chunkPlainLength + AUTH_TAG_BYTES
      });
    }
    return { plainLength, chunks };
  }

  function additionalData(containerId, recordIndex, chunkIndex, record) {
    const chunk = record.chunks[chunkIndex];
    return encoder.encode([
      MAGIC_TEXT.trim(),
      containerId,
      recordIndex,
      chunkIndex,
      record.plainLength,
      record.chunks.length,
      chunk.plainLength,
      chunkIndex === record.chunks.length - 1 ? 1 : 0
    ].join("|"));
  }

  function prepareContainer(sources) {
    if (!Array.isArray(sources) || !sources.length || sources.length > MAX_RECORDS) {
      throw new Error("O lote excede o limite de registros criptográficos.");
    }
    const salt = randomBytes(16);
    const containerId = bytesToBase64(randomBytes(18));
    const records = [];
    let totalChunks = 0;
    for (const source of sources) {
      const plainLength = sourceLength(source);
      const chunkCount = Math.max(1, Math.ceil(plainLength / CHUNK_SIZE));
      if (chunkCount > MAX_TOTAL_CHUNKS - totalChunks) {
        throw new Error("O lote excede o limite de blocos criptográficos.");
      }
      totalChunks += chunkCount;
      const record = buildRecordPlan(plainLength, chunkCount);
      records.push(record);
    }
    const outerHeader = {
      format: FORMAT,
      containerId,
      kdf: "PBKDF2-SHA-256",
      iterations: ITERATIONS,
      salt: bytesToBase64(salt),
      cipher: "AES-256-GCM",
      chunkSize: CHUNK_SIZE,
      records
    };
    const headerBytes = encoder.encode(JSON.stringify(outerHeader));
    if (headerBytes.byteLength > MAX_HEADER_BYTES) {
      throw new Error("O lote possui registros demais para o cabeçalho criptográfico.");
    }
    const headerLength = new Uint8Array(4);
    new DataView(headerLength.buffer).setUint32(0, headerBytes.byteLength, true);
    return { salt, containerId, records, headerBytes, headerLength };
  }


  async function writeContainer({
    secret,
    internalReport,
    payloads,
    writable,
    onProgress,
    progressMessages
  }) {
    if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH || secret.length > MAX_SECRET_LENGTH) {
      throw new Error("A chave do lote deve ter entre 12 e 256 caracteres.");
    }
    const sources = [encoder.encode(JSON.stringify(internalReport)), ...payloads];
    const plan = prepareContainer(sources);
    const containerHash = new window.LDFSha256();
    let containerSize = 0;

    const writeContainerPart = async part => {
      const bytes = part instanceof Uint8Array ? part : new Uint8Array(part);
      containerHash.update(bytes);
      containerSize += bytes.byteLength;
      await writable.write(part);
    };

    await writeContainerPart(MAGIC);
    await writeContainerPart(plan.headerLength);
    await writeContainerPart(plan.headerBytes);

    onProgress(0, sources.length, "Derivando chave criptográfica");
    const key = await deriveKey(secret, plan.salt);

    for (let recordIndex = 0; recordIndex < sources.length; recordIndex += 1) {
      const message = recordIndex > 0 ? progressMessages[recordIndex - 1] : "";
      if (message) onProgress(recordIndex, sources.length, message);
      const record = plan.records[recordIndex];

      for (let chunkIndex = 0; chunkIndex < record.chunks.length; chunkIndex += 1) {
        const chunk = record.chunks[chunkIndex];
        const plain = await readSourceChunk(
          sources[recordIndex],
          chunkIndex * CHUNK_SIZE,
          chunk.plainLength
        );
        const ciphertext = await crypto.subtle.encrypt(
          {
            name: "AES-GCM",
            iv: base64ToBytes(chunk.iv),
            additionalData: additionalData(plan.containerId, recordIndex, chunkIndex, record),
            tagLength: 128
          },
          key,
          plain
        );
        await writeContainerPart(new Uint8Array(ciphertext));
      }
    }

    onProgress(sources.length, sources.length, "Dados do contêiner gravados");
    return {
      sha256: containerHash.hex(),
      size: containerSize
    };
  }


  function hasExactKeys(value, expected) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const actual = Object.keys(value).sort();
    const sortedExpected = [...expected].sort();
    return actual.length === sortedExpected.length
      && actual.every((key, index) => key === sortedExpected[index]);
  }

  function validateOuterHeader(header, fileSize, headerLength) {
    if (
      !hasExactKeys(header, ["format", "containerId", "kdf", "iterations", "salt", "cipher", "chunkSize", "records"])
      || header.format !== FORMAT
      || header.kdf !== "PBKDF2-SHA-256"
      || header.iterations !== ITERATIONS
      || header.cipher !== "AES-256-GCM"
      || header.chunkSize !== CHUNK_SIZE
      || !Array.isArray(header.records)
      || !header.records.length
      || header.records.length > MAX_RECORDS
      || !Number.isSafeInteger(fileSize)
      || fileSize < 0
    ) {
      throw new Error(INVALID_CONTAINER_MESSAGE);
    }

    decodeCanonicalBase64(header.containerId, 18);
    const saltBytes = decodeCanonicalBase64(header.salt, 16);
    let offset = 12 + headerLength;
    let totalChunks = 0;
    const observedIvs = new Set();
    const records = header.records.map(record => {
      if (
        !hasExactKeys(record, ["plainLength", "chunks"])
        || !Number.isSafeInteger(record.plainLength)
        || record.plainLength < 0
        || !Array.isArray(record.chunks)
        || !record.chunks.length
        || record.chunks.length !== Math.max(1, Math.ceil(record.plainLength / CHUNK_SIZE))
      ) {
        throw new Error(INVALID_CONTAINER_MESSAGE);
      }

      let accumulatedPlainLength = 0;
      const chunks = record.chunks.map((chunk, chunkIndex) => {
        totalChunks += 1;
        const isFinal = chunkIndex === record.chunks.length - 1;
        const expectedPlainLength = record.plainLength === 0
          ? 0
          : isFinal
            ? record.plainLength - (chunkIndex * CHUNK_SIZE)
            : CHUNK_SIZE;
        if (
          !hasExactKeys(chunk, ["iv", "plainLength", "length"])
          || totalChunks > MAX_TOTAL_CHUNKS
          || chunk.plainLength !== expectedPlainLength
          || !Number.isSafeInteger(chunk.length)
          || chunk.length !== chunk.plainLength + AUTH_TAG_BYTES
          || offset > fileSize - chunk.length
        ) {
          throw new Error(INVALID_CONTAINER_MESSAGE);
        }
        const ivBytes = decodeCanonicalBase64(chunk.iv, 12);
        if (observedIvs.has(chunk.iv)) throw new Error(INVALID_CONTAINER_MESSAGE);
        observedIvs.add(chunk.iv);
        const protectedChunk = { ...chunk, ivBytes, offset };
        offset += chunk.length;
        accumulatedPlainLength += chunk.plainLength;
        return protectedChunk;
      });

      if (accumulatedPlainLength !== record.plainLength) {
        throw new Error(INVALID_CONTAINER_MESSAGE);
      }
      return { ...record, chunks };
    });

    if (offset !== fileSize) throw new Error(INVALID_CONTAINER_MESSAGE);
    return { records, saltBytes };
  }


  async function createContainerSession({ file, outerHeader, records, key }) {

    const rangeCache = new Map();

    async function decryptChunk(recordIndex, chunkIndex) {
      const cacheKey = `${recordIndex}:${chunkIndex}`;
      if (rangeCache.has(cacheKey)) {
        const cached = rangeCache.get(cacheKey);
        rangeCache.delete(cacheKey);
        rangeCache.set(cacheKey, cached);
        return cached;
      }
      const record = records[recordIndex];
      const chunk = record?.chunks[chunkIndex];
      if (!record || !chunk) throw new Error("Bloco protegido inexistente.");
      const ciphertext = await file.slice(chunk.offset, chunk.offset + chunk.length).arrayBuffer();
      let plaintext;
      try {
        plaintext = await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: chunk.ivBytes,
            additionalData: additionalData(outerHeader.containerId, recordIndex, chunkIndex, record),
            tagLength: 128
          },
          key,
          ciphertext
        );
      } catch {
        throw new Error("Chave incorreta ou contêiner corrompido.");
      }
      if (plaintext.byteLength !== chunk.plainLength) {
        throw new Error("O contêiner apresenta divergência no tamanho de um bloco protegido.");
      }
      const bytes = new Uint8Array(plaintext);
      rangeCache.set(cacheKey, bytes);
      while (rangeCache.size > 2) rangeCache.delete(rangeCache.keys().next().value);
      return bytes;
    }

    function createRecordRangeReader(recordIndex) {
      const record = records[recordIndex];
      if (!record) throw new Error("Registro criptográfico inexistente.");
      return async function readRange(offset, length) {
        if (
          !Number.isSafeInteger(offset)
          || !Number.isSafeInteger(length)
          || offset < 0
          || length < 0
          || length > 1024 * 1024
          || offset > record.plainLength
          || length > record.plainLength - offset
        ) throw new Error("Intervalo protegido inválido.");
        if (length === 0) return new ArrayBuffer(0);
        const output = new Uint8Array(length);
        const firstChunk = Math.floor(offset / CHUNK_SIZE);
        const finalOffset = offset + length;
        const lastChunk = Math.floor((finalOffset - 1) / CHUNK_SIZE);
        let outputOffset = 0;
        for (let chunkIndex = firstChunk; chunkIndex <= lastChunk; chunkIndex += 1) {
          const plaintext = await decryptChunk(recordIndex, chunkIndex);
          const chunkStart = chunkIndex * CHUNK_SIZE;
          const sliceStart = Math.max(offset, chunkStart) - chunkStart;
          const sliceEnd = Math.min(finalOffset, chunkStart + plaintext.byteLength) - chunkStart;
          const slice = plaintext.subarray(sliceStart, sliceEnd);
          output.set(slice, outputOffset);
          outputOffset += slice.byteLength;
        }
        return output.buffer;
      };
    }

    async function processRecord(recordIndex, onPlainChunk = async () => {}) {
      const record = records[recordIndex];
      if (!record) throw new Error("Registro criptográfico inexistente.");

      for (let chunkIndex = 0; chunkIndex < record.chunks.length; chunkIndex += 1) {
        const chunk = record.chunks[chunkIndex];
        const ciphertext = await file.slice(chunk.offset, chunk.offset + chunk.length).arrayBuffer();
        let plaintext;
        try {
          plaintext = await crypto.subtle.decrypt(
            {
              name: "AES-GCM",
              iv: chunk.ivBytes,
              additionalData: additionalData(outerHeader.containerId, recordIndex, chunkIndex, record),
              tagLength: 128
            },
            key,
            ciphertext
          );
        } catch {
          throw new Error("Chave incorreta ou contêiner corrompido.");
        }
        if (plaintext.byteLength !== chunk.plainLength) {
          throw new Error("O contêiner apresenta divergência no tamanho de um bloco protegido.");
        }
        await onPlainChunk(plaintext, chunkIndex, record.chunks.length);
      }
      return record.plainLength;
    }

    async function decryptRecordWithHash(recordIndex) {
      const record = records[recordIndex];
      if (!record) throw new Error("Registro criptográfico inexistente.");
      if (record.plainLength > MAX_BUFFERED_RECORD_BYTES) {
        throw new Error("Este registro deve ser extraído diretamente para um arquivo.");
      }
      const parts = [];
      const hasher = new window.LDFSha256();
      await processRecord(recordIndex, async plaintext => {
        parts.push(plaintext);
        hasher.update(new Uint8Array(plaintext));
      });
      return { buffer: await new Blob(parts).arrayBuffer(), sha256: hasher.hex() };
    }

    async function decryptRecord(recordIndex) {
      return (await decryptRecordWithHash(recordIndex)).buffer;
    }

    async function hashRecord(recordIndex) {
      const hasher = await createIncrementalHasher();
      try {
        await processRecord(recordIndex, async plaintext => {
          await hasher.update(plaintext);
        });
        return await hasher.finish();
      } catch (error) {
        await hasher.cancel();
        throw error;
      }
    }

    async function inspectRecord(recordIndex) {
      const hasher = await createIncrementalHasher(true);
      try {
        await processRecord(recordIndex, async plaintext => {
          await hasher.update(plaintext);
        });
        return await hasher.finish();
      } catch (error) {
        await hasher.cancel();
        throw error;
      }
    }

    async function extractRecord(recordIndex, writable) {
      const hasher = await createIncrementalHasher();
      try {
        await processRecord(recordIndex, async plaintext => {
          await writable.write(new Uint8Array(plaintext));
          await hasher.update(plaintext);
        });
        return await hasher.finish();
      } catch (error) {
        await hasher.cancel();
        throw error;
      }
    }

    const internalReportBuffer = await decryptRecord(0);
    let internalReport;
    try {
      const manifestDecoder = new TextDecoder("utf-8", { fatal: true });
      internalReport = JSON.parse(manifestDecoder.decode(internalReportBuffer));
    } catch {
      throw new Error("Os dados internos protegidos não puderam ser interpretados.");
    }
    if (internalReport.format !== FORMAT) {
      throw new Error("O conteúdo interno não é compatível com esta versão.");
    }

    return {
      manifest: internalReport,
      decryptRecord,
      decryptRecordWithHash,
      hashRecord,
      inspectRecord,
      createRecordRangeReader,
      extractRecord,
      recordCount() {
        return records.length;
      },
      recordSize(recordIndex) {
        return records[recordIndex]?.plainLength ?? null;
      }
    };
  }

})();
