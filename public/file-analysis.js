(function () {
  "use strict";

  const REQUEST_TIMEOUT_MS = 20000;
  const MAX_SOURCE_BYTES = Number.MAX_SAFE_INTEGER;
  let worker = null;
  let prepared = null;
  let permanentlyUnavailableReason = "";
  let requestSequence = 0;
  const pending = new Map();

  function terminateWorker(reason) {
    permanentlyUnavailableReason ||= reason;
    if (worker) worker.terminate();
    worker = null;
    for (const request of pending.values()) {
      clearTimeout(request.timeoutId);
      request.reject(new Error(reason));
    }
    pending.clear();
  }

  function handleMessage(event) {
    const data = event.data;
    if (data?.type === "read") {
      const request = pending.get(data.requestId);
      if (!request?.readRange) {
        worker?.postMessage({ action: "readError", readId: data.readId, error: "Fonte protegida indisponível." });
        return;
      }
      Promise.resolve(request.readRange(data.offset, data.length)).then(buffer => {
        if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== data.length) {
          throw new Error("A fonte protegida devolveu um intervalo divergente.");
        }
        worker?.postMessage({ action: "readResult", readId: data.readId, buffer }, [buffer]);
      }).catch(error => {
        worker?.postMessage({
          action: "readError",
          readId: data.readId,
          error: error instanceof Error ? error.message : "Leitura protegida indisponível."
        });
      });
      return;
    }
    if (data?.type !== "response") return;
    const request = pending.get(data.requestId);
    if (!request) return;
    pending.delete(data.requestId);
    clearTimeout(request.timeoutId);
    if (data.error) request.reject(new Error(data.error));
    else request.resolve(data.result);
  }

  function createWorker() {
    if (worker) return worker;
    if (permanentlyUnavailableReason) {
      throw new Error(permanentlyUnavailableReason);
    }
    worker = new Worker("file-analysis-worker.js?v=beta-1.0.0");
    worker.addEventListener("message", handleMessage);
    worker.addEventListener("error", () => terminateWorker("O processo local de análise foi encerrado por segurança."));
    return worker;
  }

  function request(action, payload = {}, readRange = null) {
    const activeWorker = createWorker();
    const requestId = ++requestSequence;
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        terminateWorker("A análise local excedeu o tempo permitido.");
        reject(new Error("A análise local excedeu o tempo permitido."));
      }, REQUEST_TIMEOUT_MS);
      pending.set(requestId, { resolve, reject, timeoutId, readRange });
      activeWorker.postMessage({ requestId, action, ...payload });
    });
  }

  function prepareRuntime() {
    if (!prepared) {
      prepared = request("prepare").then(result => Object.freeze({
        available: true,
        engine: result.engine,
        version: result.version
      })).catch(error => {
        terminateWorker("O MediaInfo local ficou indisponível.");
        return Object.freeze({ available: false, error: error.message });
      });
    }
    return prepared;
  }

  async function analyzeFile(file) {
    if (!(file instanceof Blob) || !Number.isSafeInteger(file.size) || file.size > MAX_SOURCE_BYTES) {
      throw new Error("Arquivo inválido para análise local.");
    }
    const runtime = await prepareRuntime();
    if (!runtime.available) throw new Error("O MediaInfo local está indisponível nesta sessão.");
    return request("analyzeFile", { file });
  }

  async function analyzeRangeSource(size, readRange) {
    if (!Number.isSafeInteger(size) || size < 0 || typeof readRange !== "function") {
      throw new Error("Fonte protegida inválida para análise local.");
    }
    const runtime = await prepareRuntime();
    if (!runtime.available) throw new Error("O MediaInfo local está indisponível nesta sessão.");
    return request("analyzeRangeSource", { size }, readRange);
  }

  window.LDFFileAnalysis = Object.freeze({
    prepareRuntime,
    analyzeFile,
    analyzeRangeSource
  });
})();
