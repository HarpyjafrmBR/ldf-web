/*
 * MediaInfo executa em Worker e carrega somente os artefatos locais fixados na
 * publicação. Nenhum dado do vestígio é enviado para rede ou serviço externo.
 */
importScripts("mediainfo.min.js?v=beta-1.0.0");
importScripts("pdf-metadata.js?v=beta-1.0.0");

"use strict";

const MEDIAINFO_CHUNK_SIZE = 256 * 1024;
const MAX_SINGLE_READ_BYTES = 4 * 1024 * 1024;
const MAX_READ_REQUESTS = 4096;
const MAX_TOTAL_READ_BYTES = 256 * 1024 * 1024;
const pendingReads = new Map();
let mediaInfoPromise = null;

function cleanText(value, maximum = 240) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const cleaned = String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, maximum) : null;
}

function finiteNumber(value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum ? number : null;
}

function declaredDefault(value) {
  if (value === true || value === 1) return true;
  const normalized = cleanText(value, 16)?.toLowerCase();
  return normalized === "yes" || normalized === "true" || normalized === "1";
}

function firstValue(tracks, keys) {
  for (const track of tracks) {
    for (const key of keys) {
      const value = cleanText(track[key]);
      if (value) return value;
    }
  }
  return null;
}

function allowedTrack(track) {
  const type = cleanText(track["@type"], 20);
  if (!type || !["General", "Image", "Video", "Audio"].includes(type)) return null;
  const result = {
    type,
    default: declaredDefault(track.Default) ? true : null,
    format: cleanText(track.Format, 80),
    profile: cleanText(track.Format_Profile, 80),
    durationSeconds: finiteNumber(track.Duration, 0, 315576000),
    width: finiteNumber(track.Width, 0, 100000),
    height: finiteNumber(track.Height, 0, 100000),
    frameRate: finiteNumber(track.FrameRate, 0, 100000),
    bitRate: finiteNumber(track.BitRate, 0, 1e15),
    channels: finiteNumber(track.Channels, 0, 10000),
    samplingRate: finiteNumber(track.SamplingRate, 0, 1e9)
  };
  return Object.fromEntries(Object.entries(result).filter(([, value]) => value !== null));
}

function summarize(raw) {
  const sourceTracks = Array.isArray(raw?.media?.track) ? raw.media.track.slice(0, 64) : [];
  const technical = sourceTracks.map(allowedTrack).filter(Boolean);
  const types = new Set(technical.map(track => track.type));
  const kind = types.has("Video") ? "video" : types.has("Audio") ? "audio" : types.has("Image") ? "image" : "unknown";
  const origin = {
    title: firstValue(sourceTracks, ["Title", "Track", "FileName"]),
    recordedDate: firstValue(sourceTracks, ["Recorded_Date", "Mastered_Date"]),
    encodedDate: firstValue(sourceTracks, ["Encoded_Date"]),
    taggedDate: firstValue(sourceTracks, ["Tagged_Date"]),
    manufacturer: firstValue(sourceTracks, ["Make", "Manufacturer", "Device_Manufacturer"]),
    model: firstValue(sourceTracks, ["Model", "Device_Model"]),
    software: firstValue(sourceTracks, ["Encoded_Application", "Encoded_Library", "Writing_Application", "Writing_Library"]),
    comment: firstValue(sourceTracks, ["Comment", "Description"])
  };
  const gps = {
    latitude: firstValue(sourceTracks, ["GPS_Latitude", "Latitude"]),
    longitude: firstValue(sourceTracks, ["GPS_Longitude", "Longitude"]),
    altitude: firstValue(sourceTracks, ["GPS_Altitude", "Altitude"]),
    location: firstValue(sourceTracks, ["Recorded_Location", "com.apple.quicktime.location.ISO6709", "GPS"])
  };
  return {
    status: "available",
    engine: "MediaInfo.js 0.3.7 / MediaInfoLib 25.10",
    kind,
    origin: Object.fromEntries(Object.entries(origin).filter(([, value]) => value !== null)),
    gps: Object.fromEntries(Object.entries(gps).filter(([, value]) => value !== null)),
    technical
  };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : "Falha não identificada na análise local.";
}

function reply(requestId, result = null, error = "") {
  self.postMessage({ type: "response", requestId, result, error });
}

function prepareMediaInfo() {
  if (!mediaInfoPromise) {
    mediaInfoPromise = self.MediaInfo.mediaInfoFactory({
      chunkSize: MEDIAINFO_CHUNK_SIZE,
      coverData: false,
      format: "object",
      full: true,
      locateFile: fileName => fileName === "MediaInfoModule.wasm"
        ? new URL("mediainfo.wasm?v=beta-1.0.0", self.location.href).href
        : new URL(fileName, self.location.href).href
    });
  }
  return mediaInfoPromise;
}

function boundedReader(size, readRange) {
  let requestCount = 0;
  let requestedBytes = 0;
  return async (offset, length) => {
    requestCount += 1;
    requestedBytes += length;
    if (
      requestCount > MAX_READ_REQUESTS
      || requestedBytes > MAX_TOTAL_READ_BYTES
      || !Number.isSafeInteger(length)
      || length < 0
      || length > MAX_SINGLE_READ_BYTES
      || !Number.isSafeInteger(offset)
      || offset < 0
      || offset > size
      || length > size - offset
    ) throw new Error("A análise excedeu o orçamento local de leitura.");
    return readRange(offset, length);
  };
}

async function analyzeSource(size, readRange) {
  const read = boundedReader(size, readRange);
  const prefixLength = Math.min(1024, size);
  const prefixBuffer = await read(0, prefixLength);
  const prefix = new Uint8Array(prefixBuffer);
  if (self.LDFPdfMetadata.isPdfHeader(prefix)) {
    return self.LDFPdfMetadata.analyze(size, read, prefix);
  }
  const mediaInfo = await prepareMediaInfo();
  return summarize(await mediaInfo.analyzeData(
    () => size,
    async (length, offset) => new Uint8Array(await read(offset, length))
  ));
}

async function analyzeFile(file) {
  if (!(file instanceof Blob) || !Number.isSafeInteger(file.size)) {
    throw new Error("Fonte local inválida para análise.");
  }
  return analyzeSource(file.size, async (offset, length) => (
    file.slice(offset, offset + length).arrayBuffer()
  ));
}

async function analyzeRangeSource(requestId, size) {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("Tamanho protegido inválido.");
  let requestCount = 0;
  return analyzeSource(size, async (offset, length) => {
      requestCount += 1;
      const readId = `${requestId}:${requestCount}`;
      const buffer = await new Promise((resolve, reject) => {
        pendingReads.set(readId, { resolve, reject });
        self.postMessage({ type: "read", requestId, readId, length, offset });
      });
      return buffer;
  });
}

async function dispatch(data) {
  if (!data || typeof data !== "object") throw new Error("Solicitação de análise inválida.");
  if (data.action === "prepare") {
    await prepareMediaInfo();
    return { ready: true, engine: "mediainfo.js", version: "0.3.7" };
  }
  if (data.action === "analyzeFile") return analyzeFile(data.file);
  if (data.action === "analyzeRangeSource") return analyzeRangeSource(data.requestId, data.size);
  throw new Error("Ação de análise desconhecida.");
}

self.onmessage = async event => {
  const data = event.data;
  if (data?.action === "readResult" || data?.action === "readError") {
    const pending = pendingReads.get(data.readId);
    if (!pending) return;
    pendingReads.delete(data.readId);
    if (data.action === "readError") pending.reject(new Error(data.error || "Leitura protegida indisponível."));
    else pending.resolve(data.buffer);
    return;
  }

  const requestId = data?.requestId;
  if (!Number.isSafeInteger(requestId) || requestId < 1) return;
  try {
    reply(requestId, await dispatch(data));
  } catch (error) {
    reply(requestId, null, errorMessage(error));
  }
};
