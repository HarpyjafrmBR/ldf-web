(function () {
  "use strict";

  const MARKER_KEY = "ldf-web-operation-coordination-v1";
  const LOCK_NAME = "ldf-web-formal-operation-v1";
  const CHANNEL_NAME = "ldf-web-operation-coordination-v1";
  const HEARTBEAT_MS = 2000;
  const STALE_AFTER_MS = 7000;
  const identity = window.LDFRuntimeIdentity;
  const tabId = crypto.randomUUID();
  const listeners = new Set();
  const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel(CHANNEL_NAME) : null;
  let held = false;
  let clientId = "";
  let heartbeat = null;
  let resolveHold = null;

  function readMarker() {
    try {
      const marker = JSON.parse(localStorage.getItem(MARKER_KEY) || "null");
      if (marker?.schema !== "LDF-OPERATION-COORDINATION-1"
          || typeof marker.tabId !== "string"
          || typeof marker.clientId !== "string"
          || typeof marker.buildId !== "string"
          || marker.state !== "active"
          || !Number.isFinite(marker.heartbeatAt)) return null;
      return marker;
    } catch {
      return null;
    }
  }

  function markerForThisTab() {
    return {
      schema: "LDF-OPERATION-COORDINATION-1",
      tabId,
      clientId,
      buildId: identity.buildId,
      state: "active",
      heartbeatAt: Date.now()
    };
  }

  function writeHeartbeat() {
    if (!held) return;
    localStorage.setItem(MARKER_KEY, JSON.stringify(markerForThisTab()));
    channel?.postMessage({ type: "changed" });
  }

  async function serviceWorkerClients() {
    const registration = await navigator.serviceWorker?.getRegistration?.();
    const worker = navigator.serviceWorker?.controller || registration?.active;
    if (!worker) return null;
    return new Promise(resolve => {
      const messageChannel = new MessageChannel();
      const timer = setTimeout(() => resolve(null), 2000);
      messageChannel.port1.onmessage = event => {
        clearTimeout(timer);
        resolve(event.data?.action === "coordinationClients" ? event.data : null);
      };
      worker.postMessage({ action: "coordinationClients" }, [messageChannel.port2]);
    });
  }

  async function blockedByOther() {
    const marker = readMarker();
    if (!marker || marker.tabId === tabId) return false;
    if (Date.now() - marker.heartbeatAt <= STALE_AFTER_MS) return true;
    const clients = await serviceWorkerClients().catch(() => null);
    if (!clients || clients.clientIds.includes(marker.clientId)) return true;
    if (localStorage.getItem(MARKER_KEY) === JSON.stringify(marker)) localStorage.removeItem(MARKER_KEY);
    return false;
  }

  async function acquire() {
    if (held) return true;
    if (await blockedByOther()) return false;
    const clients = await serviceWorkerClients().catch(() => null);
    clientId = clients?.requesterId || "";
    if (!clientId) return false;

    if (navigator.locks?.request) {
      return new Promise(resolve => {
        navigator.locks.request(LOCK_NAME, { mode: "exclusive", ifAvailable: true }, async lock => {
          if (!lock || await blockedByOther()) { resolve(false); return; }
          held = true;
          writeHeartbeat();
          heartbeat = setInterval(writeHeartbeat, HEARTBEAT_MS);
          resolve(true);
          await new Promise(done => { resolveHold = done; });
        }).catch(() => resolve(false));
      });
    }

    localStorage.setItem(MARKER_KEY, JSON.stringify(markerForThisTab()));
    await new Promise(resolve => setTimeout(resolve, 60));
    if (readMarker()?.tabId !== tabId) return false;
    held = true;
    writeHeartbeat();
    heartbeat = setInterval(writeHeartbeat, HEARTBEAT_MS);
    return true;
  }

  function release() {
    if (!held) return;
    held = false;
    clearInterval(heartbeat);
    heartbeat = null;
    if (readMarker()?.tabId === tabId) localStorage.removeItem(MARKER_KEY);
    resolveHold?.();
    resolveHold = null;
    channel?.postMessage({ type: "changed" });
    notify();
  }

  async function networkAllowed() {
    return held || !await blockedByOther();
  }

  function notify() {
    for (const listener of listeners) listener();
  }

  function onChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  addEventListener("storage", event => { if (event.key === MARKER_KEY) notify(); });
  channel?.addEventListener("message", notify);
  addEventListener("beforeunload", release);
  addEventListener("pagehide", event => { if (!event.persisted) release(); });

  window.LDFOperationCoordination = Object.freeze({ acquire, blockedByOther, networkAllowed, onChange, release });
})();
