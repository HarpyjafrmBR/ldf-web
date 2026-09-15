/*
 * Referência temporal auxiliar do LDF Web.
 *
 * O navegador consulta uma única vez o cabeçalho HTTP Date do mesmo servidor que
 * entregou a aplicação. A consulta começa no carregamento da página, antes da
 * inclusão de vestígios, e nunca transporta dados da operação. Depois disso, o
 * relógio monotônico do navegador permite observar a continuidade da sessão sem
 * realizar novas consultas de rede.
 *
 * Esta referência não é carimbo do tempo, não certifica a data da coleta e não
 * substitui a revisão e a assinatura externa das declarações pelo operador.
 */
(function () {
  "use strict";

  // O limiar de 120 s absorve a granularidade de 1 s do HTTP Date, o RTT e
  // pequenas variações operacionais sem deixar de detectar mudanças materiais.
  const DRIFT_THRESHOLD_MS = 2 * 60 * 1000;
  const REQUEST_TIMEOUT_MS = 5000;
  const MAX_LIFECYCLE_EVENTS = 32;
  const activeSessions = new Set();

  function isoOrEmpty(milliseconds) {
    return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : "";
  }

  function localIsoWithOffset(milliseconds, utcOffsetMinutes) {
    if (!Number.isFinite(milliseconds) || !Number.isFinite(utcOffsetMinutes)) return "";
    const date = new Date(milliseconds);
    const pad = value => String(value).padStart(2, "0");
    const sign = utcOffsetMinutes >= 0 ? "+" : "-";
    const absoluteOffset = Math.abs(utcOffsetMinutes);
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
      + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
      + `${sign}${pad(Math.floor(absoluteOffset / 60))}:${pad(absoluteOffset % 60)}`;
  }

  function deviceContext(deviceNowMs = Date.now()) {
    const date = new Date(deviceNowMs);
    const utcOffsetMinutes = -date.getTimezoneOffset();
    let timeZone = "";
    try {
      timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    } catch {
      // O offset continua disponível mesmo se a zona IANA não for exposta.
    }
    return {
      utcOffsetMinutes,
      timeZone,
      localIso: localIsoWithOffset(deviceNowMs, utcOffsetMinutes)
    };
  }

  function unavailableReference(reason) {
    return {
      available: false,
      reason,
      sourceOrigin: window.location.origin,
      sourceProtocol: window.location.protocol
    };
  }

  async function captureSameOriginReference() {
    if (typeof fetch !== "function" || typeof performance?.now !== "function") {
      return unavailableReference("API temporal indisponível");
    }
    if (window.LDFOperationCoordination && !await window.LDFOperationCoordination.networkAllowed()) {
      return unavailableReference("Outra aba mantém uma operação formal");
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const requestStartedMonotonicMs = performance.now();

    try {
      const response = await fetch(window.location.href.split("#")[0], {
        method: "HEAD",
        cache: "no-store",
        credentials: "same-origin",
        redirect: "follow",
        signal: controller.signal
      });
      const responseReceivedMonotonicMs = performance.now();
      const serverDateHeader = response.headers.get("Date");
      const serverDateMs = Date.parse(serverDateHeader || "");
      if (!response.ok || !Number.isFinite(serverDateMs)) {
        return unavailableReference("Cabeçalho Date indisponível");
      }

      const responseUrl = new URL(response.url || window.location.href, window.location.href);
      if (responseUrl.origin !== window.location.origin) {
        return unavailableReference("Origem da resposta temporal divergente");
      }

      const roundTripMs = Math.max(0, responseReceivedMonotonicMs - requestStartedMonotonicMs);
      return {
        available: true,
        source: "HTTP Date do servidor de publicação",
        sourceOrigin: responseUrl.origin,
        sourceProtocol: responseUrl.protocol,
        receivedAtMonotonicMs: responseReceivedMonotonicMs,
        referenceAtReceiveMs: serverDateMs + (roundTripMs / 2),
        serverDateHeader,
        roundTripMs,
        uncertaintyMs: 500 + (roundTripMs / 2)
      };
    } catch (error) {
      return unavailableReference(
        error?.name === "AbortError" ? "Tempo limite da consulta" : "Servidor indisponível"
      );
    } finally {
      window.clearTimeout(timeout);
    }
  }

  // A promessa é criada uma única vez. Todas as sessões reutilizam o mesmo
  // resultado e, portanto, não provocam nova comunicação durante uma operação.
  const initialReferencePromise = captureSameOriginReference();

  function evaluateSession(
    session,
    deviceNowMs = Date.now(),
    monotonicNowMs = performance.now(),
    currentDeviceContext = deviceContext(deviceNowMs)
  ) {
    const elapsedMs = Math.max(0, monotonicNowMs - session.startedAtMonotonicMs);
    const deviceElapsedMs = deviceNowMs - session.startedAtDeviceMs;
    const clockChangeMs = deviceElapsedMs - elapsedMs;
    const initialDeviceContext = session.initialDeviceContext || deviceContext(session.startedAtDeviceMs);
    const timezoneChanged = initialDeviceContext.utcOffsetMinutes !== currentDeviceContext.utcOffsetMinutes
      || initialDeviceContext.timeZone !== currentDeviceContext.timeZone;

    if (!session.reference.available) {
      let status = "reference-unavailable";
      if (Math.abs(clockChangeMs) >= DRIFT_THRESHOLD_MS) status = "clock-changed";
      else if (timezoneChanged) status = "timezone-changed";
      return {
        status,
        deviceNowMs,
        monotonicNowMs,
        elapsedMs,
        clockChangeMs,
        currentDeviceContext,
        timezoneChanged,
        referenceExpectedNowMs: null,
        referenceDifferenceMs: null
      };
    }

    const referenceExpectedNowMs = session.reference.referenceAtReceiveMs
      + (monotonicNowMs - session.reference.receivedAtMonotonicMs);
    const referenceDifferenceMs = deviceNowMs - referenceExpectedNowMs;
    let status = "coherent";
    if (Math.abs(clockChangeMs) >= DRIFT_THRESHOLD_MS) status = "clock-changed";
    else if (timezoneChanged) status = "timezone-changed";
    else if (Math.abs(referenceDifferenceMs) >= DRIFT_THRESHOLD_MS) status = "device-divergent";

    return {
      status,
      deviceNowMs,
      monotonicNowMs,
      elapsedMs,
      clockChangeMs,
      currentDeviceContext,
      timezoneChanged,
      referenceExpectedNowMs,
      referenceDifferenceMs
    };
  }

  function appendLifecycleEvent(session, type, deviceNowMs, monotonicNowMs, context, extra = {}) {
    if (!Array.isArray(session.lifecycleEvents)) session.lifecycleEvents = [];
    if (session.lifecycleEvents.length >= MAX_LIFECYCLE_EVENTS) return;
    session.lifecycleEvents.push({
      type,
      observedAtDeviceIso: isoOrEmpty(deviceNowMs),
      observedAtDeviceLocal: context.localIso,
      observedAtMonotonicMs: monotonicNowMs,
      utcOffsetMinutes: context.utcOffsetMinutes,
      timeZone: context.timeZone,
      ...extra
    });
  }

  function observeLifecycle(type) {
    const deviceNowMs = Date.now();
    const monotonicNowMs = performance.now();
    const context = deviceContext(deviceNowMs);
    for (const session of activeSessions) {
      const previous = session.lastLifecycleObservation;
      appendLifecycleEvent(session, type, deviceNowMs, monotonicNowMs, context);
      if (previous && ["visible", "page-restored", "page-shown"].includes(type)) {
        const discontinuityMs = (deviceNowMs - previous.deviceNowMs)
          - (monotonicNowMs - previous.monotonicNowMs);
        if (Math.abs(discontinuityMs) >= DRIFT_THRESHOLD_MS) {
          appendLifecycleEvent(
            session,
            "temporal-discontinuity",
            deviceNowMs,
            monotonicNowMs,
            context,
            { discontinuityMs }
          );
        }
      }
      session.lastLifecycleObservation = { deviceNowMs, monotonicNowMs };
    }
  }

  document.addEventListener("visibilitychange", () => {
    observeLifecycle(document.hidden ? "hidden" : "visible");
  });
  window.addEventListener("pagehide", () => observeLifecycle("page-hidden"));
  window.addEventListener("pageshow", event => {
    observeLifecycle(event.persisted ? "page-restored" : "page-shown");
  });

  async function startSession(kind) {
    const reference = await initialReferencePromise;
    const startedAtDeviceMs = Date.now();
    const startedAtMonotonicMs = performance.now();
    const initialDeviceContext = deviceContext(startedAtDeviceMs);
    const expectedAtStartMs = reference.available
      ? reference.referenceAtReceiveMs + (startedAtMonotonicMs - reference.receivedAtMonotonicMs)
      : null;

    for (const activeSession of activeSessions) {
      if (activeSession.kind === kind) activeSessions.delete(activeSession);
    }
    const session = {
      sessionId: crypto.randomUUID(),
      kind,
      reference,
      startedAtDeviceMs,
      startedAtMonotonicMs,
      initialDeviceContext,
      initialDifferenceMs: expectedAtStartMs === null ? null : startedAtDeviceMs - expectedAtStartMs,
      lifecycleEvents: [],
      lastLifecycleObservation: { deviceNowMs: startedAtDeviceMs, monotonicNowMs: startedAtMonotonicMs }
    };
    activeSessions.add(session);
    return session;
  }

  function summarize(session) {
    if (!session) return null;
    const current = evaluateSession(session);
    return {
      sessionId: session.sessionId,
      kind: session.kind,
      status: current.status,
      referenceAvailable: session.reference.available,
      referenceSource: session.reference.available ? session.reference.source : "",
      referenceReason: session.reference.available ? "" : session.reference.reason,
      referenceOrigin: session.reference.sourceOrigin || "",
      referenceProtocol: session.reference.sourceProtocol || "",
      referenceHeader: session.reference.available ? session.reference.serverDateHeader : "",
      referenceRoundTripMs: session.reference.available ? session.reference.roundTripMs : null,
      referenceUncertaintyMs: session.reference.available ? session.reference.uncertaintyMs : null,
      referenceTimeIso: session.reference.available ? isoOrEmpty(session.reference.referenceAtReceiveMs) : "",
      sessionStartedAtDeviceIso: isoOrEmpty(session.startedAtDeviceMs),
      sessionStartedAtDeviceLocal: session.initialDeviceContext?.localIso || "",
      initialUtcOffsetMinutes: session.initialDeviceContext?.utcOffsetMinutes ?? null,
      initialTimeZone: session.initialDeviceContext?.timeZone || "",
      initialDifferenceMs: session.initialDifferenceMs,
      elapsedMs: current.elapsedMs,
      clockChangeMs: current.clockChangeMs,
      observedAtDeviceIso: isoOrEmpty(current.deviceNowMs),
      observedAtDeviceLocal: current.currentDeviceContext.localIso,
      currentUtcOffsetMinutes: current.currentDeviceContext.utcOffsetMinutes,
      currentTimeZone: current.currentDeviceContext.timeZone,
      timezoneChanged: current.timezoneChanged,
      expectedByReferenceIso: current.referenceExpectedNowMs === null ? "" : isoOrEmpty(current.referenceExpectedNowMs),
      referenceDifferenceMs: current.referenceDifferenceMs,
      lifecycleEvents: Array.isArray(session.lifecycleEvents)
        ? session.lifecycleEvents.map(event => ({ ...event }))
        : []
    };
  }

  window.LDFTemporal = {
    DRIFT_THRESHOLD_MS,
    initialReferencePromise,
    startSession,
    evaluateSession,
    summarize
  };
})();
