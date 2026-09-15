/*
 * O Worker executa o SHA-256 fora da thread da interface. Arquivos grandes são
 * lidos em partes e apenas o estado matemático do hash permanece entre elas.
 */
importScripts("sha256.js?v=beta-1.0.0", "c2pa-detector.js?v=beta-1.0.0");

"use strict";

const CHUNK_SIZE = 8 * 1024 * 1024;
const MAX_SESSIONS = 128;
const sessions = new Map();

function reply(requestId, result = null, error = "") {
  self.postMessage({ requestId, result, error });
}

function handlePing() {
  return true;
}

async function handleHashBlob(data) {
  const { blob, chunkSize } = data;
  if (!(blob instanceof Blob) || chunkSize !== CHUNK_SIZE) {
    throw new Error("Parâmetros de processamento SHA-256 inválidos.");
  }
  const hash = new self.LDFSha256();
  for (let offset = 0; offset < blob.size; offset += chunkSize) {
    const buffer = await blob.slice(offset, Math.min(offset + chunkSize, blob.size)).arrayBuffer();
    hash.update(new Uint8Array(buffer));
  }
  return hash.hex();
}

async function handleInspectBlob(data) {
  const { blob, chunkSize } = data;
  if (!(blob instanceof Blob) || chunkSize !== CHUNK_SIZE) {
    throw new Error("Parâmetros de inspeção inválidos.");
  }
  const hash = new self.LDFSha256();
  const detector = new self.LDFC2paDetector.Detector();
  for (let offset = 0; offset < blob.size; offset += chunkSize) {
    const buffer = await blob.slice(offset, Math.min(offset + chunkSize, blob.size)).arrayBuffer();
    const bytes = new Uint8Array(buffer);
    hash.update(bytes);
    detector.update(bytes);
  }
  return { sha256: hash.hex(), c2pa: detector.finish() };
}

function handleStart(data) {
  const { sessionId } = data;
  if (!/^[a-f0-9-]{36}$/i.test(sessionId || "") || sessions.has(sessionId)) {
    throw new Error("Sessão incremental de SHA-256 inválida.");
  }
  if (sessions.size >= MAX_SESSIONS) throw new Error("Limite de sessões SHA-256 atingido.");
  sessions.set(sessionId, {
    hash: new self.LDFSha256(),
    detector: data.inspect ? new self.LDFC2paDetector.Detector() : null
  });
  return true;
}

function requireSession(data) {
  const session = sessions.get(data.sessionId);
  if (!session) throw new Error("Sessão incremental de SHA-256 inexistente.");
  return session;
}

function handleUpdate(data, session) {
  if (!(data.buffer instanceof ArrayBuffer) || data.buffer.byteLength > CHUNK_SIZE) {
    throw new Error("Bloco incremental de SHA-256 inválido.");
  }
  const bytes = new Uint8Array(data.buffer);
  session.hash.update(bytes);
  session.detector?.update(bytes);
  return true;
}

function handleFinish(data, session) {
  sessions.delete(data.sessionId);
  const sha256 = session.hash.hex();
  return session.detector ? { sha256, c2pa: session.detector.finish() } : sha256;
}

function handleCancel(data) {
  sessions.delete(data.sessionId);
  return true;
}

const directHandlers = Object.freeze({
  ping: handlePing,
  hashBlob: handleHashBlob,
  inspectBlob: handleInspectBlob,
  start: handleStart
});

const sessionHandlers = Object.freeze({
  update: handleUpdate,
  finish: handleFinish,
  cancel: handleCancel
});

async function dispatch(data) {
  const directHandler = directHandlers[data?.action];
  if (directHandler) return directHandler(data);

  const hash = requireSession(data ?? {});
  const sessionHandler = sessionHandlers[data?.action];
  if (!sessionHandler) throw new Error("Operação criptográfica desconhecida.");
  return sessionHandler(data, hash);
}

self.addEventListener("message", async event => {
  const requestId = event.data?.requestId;
  try {
    reply(requestId, await dispatch(event.data));
  } catch (error) {
    reply(requestId, null, error.message || "Falha no processamento criptográfico.");
  }
});
