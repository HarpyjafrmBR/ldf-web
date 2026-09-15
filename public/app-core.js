(function () {
  "use strict";

  const EXPECTED_MODULE_NAMES = Object.freeze([
    "core", "ui", "fileIo", "lot", "sealing", "audit", "offline"
  ]);
  const factories = Object.create(null);
  let failed = false;
  let consumed = false;

  function fail() {
    failed = true;
    throw new Error("Falha no registro interno dos módulos da aplicação.");
  }

  function register(name, factory) {
    if (consumed
        || !EXPECTED_MODULE_NAMES.includes(name)
        || typeof factory !== "function"
        || Object.prototype.hasOwnProperty.call(factories, name)) fail();
    factories[name] = factory;
  }

  function consume(expectedNames) {
    if (consumed) fail();
    consumed = true;
    const actualNames = Object.keys(factories);
    if (failed
        || !Array.isArray(expectedNames)
        || expectedNames.length !== EXPECTED_MODULE_NAMES.length
        || expectedNames.some((name, index) => name !== EXPECTED_MODULE_NAMES[index])
        || actualNames.length !== EXPECTED_MODULE_NAMES.length
        || EXPECTED_MODULE_NAMES.some(name => !Object.prototype.hasOwnProperty.call(factories, name))) fail();
    return Object.freeze(Object.assign(Object.create(null), factories));
  }

  Object.defineProperty(window, "__LDF_APP_MODULES__", {
    value: Object.freeze({ register, consume }),
    enumerable: false,
    configurable: true,
    writable: false
  });

  function createCore({ now, randomUUID }) {
    const creation = {
      runtimeReady: false,
      evidence: [],
      editingEvidenceId: null,
      editingPhotos: [],
      editingDocuments: [],
      locked: false,
      documentId: "",
      issuedAt: "",
      qualifiedLotHash: "",
      qualifiedLotRecord: null,
      declarationTemporalSummary: null,
      temporalSession: null,
      temporalAlertKey: "",
      temporalLifecycleEventCount: 0,
      pendingContainer: null,
      containerSaved: false,
      shippingReceipt: null,
      logs: [],
      logSequence: 0
    };
    const audit = { downloads: [], auditPdf: null, auditPdfName: "", temporalSession: null };
    const routine = { active: false, label: "" };

    function attachmentBytes(item, attachmentType) {
      return (item.metadata?.[attachmentType] ?? [])
        .reduce((subtotal, attachment) => subtotal + attachment.file.size, 0);
    }

    function totalLotBytes() {
      return creation.evidence.reduce((total, item) => (
        total + item.file.size + attachmentBytes(item, "photos") + attachmentBytes(item, "documents")
      ), 0);
    }

    function totalLotBytesWithoutEditingAttachments() {
      return creation.evidence.reduce((total, item) => {
        const editing = item.id === creation.editingEvidenceId;
        return total + item.file.size
          + (editing ? 0 : attachmentBytes(item, "photos"))
          + (editing ? 0 : attachmentBytes(item, "documents"));
      }, 0);
    }

    function totalLotFileCount() {
      return creation.evidence.reduce((total, item) => (
        total + 1 + (item.metadata?.photos?.length ?? 0) + (item.metadata?.documents?.length ?? 0)
      ), 0);
    }

    function totalLotFileCountWithoutEditingAttachments() {
      return creation.evidence.reduce((total, item) => {
        const editing = item.id === creation.editingEvidenceId;
        return total + 1
          + (editing ? 0 : (item.metadata?.photos?.length ?? 0))
          + (editing ? 0 : (item.metadata?.documents?.length ?? 0));
      }, 0);
    }

    function isCreationUnavailable() {
      return creation.locked || !creation.runtimeReady;
    }

    function hasPendingContainer() {
      return creation.pendingContainer !== null;
    }

    function hasCreationDraft() {
      return creation.evidence.length > 0 || Boolean(creation.documentId);
    }

    function isAwaitingSignedDeclaration() {
      return creation.runtimeReady
        && creation.locked
        && !creation.pendingContainer
        && !creation.containerSaved;
    }

    function setCreationLocked(locked) {
      creation.locked = locked;
    }

    function setRuntimeReady(runtimeReady) {
      creation.runtimeReady = runtimeReady;
    }

    function setPendingContainer(pendingContainer) {
      creation.pendingContainer = pendingContainer;
    }

    function setContainerSaved(containerSaved) {
      creation.containerSaved = containerSaved;
    }

    function setShippingReceipt(shippingReceipt) {
      creation.shippingReceipt = shippingReceipt;
    }

    function beginRoutine(label) {
      if (routine.active) return false;
      routine.active = true;
      routine.label = label;
      return true;
    }

    function endRoutine() {
      routine.active = false;
      routine.label = "";
    }

    function resetCreation() {
      creation.evidence = [];
      creation.editingEvidenceId = null;
      creation.editingPhotos = [];
      creation.editingDocuments = [];
      creation.locked = false;
      creation.documentId = "";
      creation.issuedAt = "";
      creation.qualifiedLotHash = "";
      creation.qualifiedLotRecord = null;
      creation.declarationTemporalSummary = null;
      creation.temporalSession = null;
      creation.temporalAlertKey = "";
      creation.temporalLifecycleEventCount = 0;
      if (creation.pendingContainer) creation.pendingContainer.secret = "";
      creation.pendingContainer = null;
      creation.containerSaved = false;
      creation.shippingReceipt = null;
      creation.logs = [];
      creation.logSequence = 0;
    }

    function clearAuditDownloads() {
      audit.downloads = [];
      audit.auditPdf = null;
      audit.auditPdfName = "";
    }

    function clearAudit() {
      clearAuditDownloads();
      audit.temporalSession = null;
    }

    function curateTechnicalTracks(fileInfo) {
      const allowedTypes = new Set(["General", "Image", "Video", "Audio"]);
      const valueKeys = [
        "format", "profile", "durationSeconds", "width", "height",
        "frameRate", "bitRate", "channels", "samplingRate"
      ];
      const labelByType = Object.freeze({
        General: "Arquivo",
        Image: "Imagem",
        Video: "Vídeo",
        Audio: "Áudio"
      });
      const source = Array.isArray(fileInfo?.technical) ? fileInfo.technical : [];
      const tracks = source.map(track => {
        if (!track || typeof track !== "object" || !allowedTypes.has(track.type)) return null;
        const selected = { type: track.type };
        if (track.default === true) selected.default = true;
        for (const key of valueKeys) {
          if (typeof track[key] === "string" || Number.isFinite(track[key])) selected[key] = track[key];
        }
        return selected;
      }).filter(Boolean);

      const generalTracks = tracks.filter(track => track.type === "General");
      const general = generalTracks.length === 1 ? generalTracks[0] : null;
      let content = [];
      if (fileInfo?.kind === "image") {
        const images = tracks.filter(track => track.type === "Image");
        const defaults = images.filter(track => track.default === true);
        if (images.length === 1) content = images;
        else if (defaults.length === 1) content = defaults;
      } else if (fileInfo?.kind === "audio") {
        content = tracks.filter(track => track.type === "Audio");
      } else if (fileInfo?.kind === "video") {
        content = tracks.filter(track => track.type === "Video" || track.type === "Audio");
      }

      const generalFormat = typeof general?.format === "string" ? general.format.toLowerCase() : "";
      const generalProfile = typeof general?.profile === "string" ? general.profile.toLowerCase() : "";
      const reduced = [general, ...content].filter(Boolean).map(track => {
        const copy = { ...track };
        delete copy.default;
        if (copy.type !== "General" && typeof copy.format === "string"
            && copy.format.toLowerCase() === generalFormat) delete copy.format;
        if (copy.type !== "General" && typeof copy.profile === "string"
            && copy.profile.toLowerCase() === generalProfile) delete copy.profile;
        return copy;
      }).filter(track => Object.keys(track).length > 1);

      const signatures = new Set();
      const distinct = reduced.filter(track => {
        const signature = JSON.stringify(track);
        if (signatures.has(signature)) return false;
        signatures.add(signature);
        return true;
      });
      const counts = distinct.reduce((result, track) => {
        result[track.type] = (result[track.type] || 0) + 1;
        return result;
      }, Object.create(null));
      const positions = Object.create(null);
      return distinct.map(track => {
        positions[track.type] = (positions[track.type] || 0) + 1;
        const numbered = counts[track.type] > 1 ? ` ${positions[track.type]}` : "";
        return Object.freeze({ heading: `${labelByType[track.type]}${numbered}`, ...track });
      });
    }

    function formatBytes(bytes) {
      if (bytes < 1024) return `${bytes} B`;
      const units = ["KB", "MB", "GB", "TB"];
      let value = bytes / 1024;
      let unit = 0;
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
      }
      return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unit]}`;
    }

    function formatCpfInput(value) {
      const digits = String(value).replace(/\D/g, "").slice(0, 11);
      if (digits.length <= 3) return digits;
      if (digits.length <= 6) return `${digits.slice(0, 3)}.${digits.slice(3)}`;
      if (digits.length <= 9) return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6)}`;
      return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`;
    }

    function isValidCpf(value) {
      const digits = String(value).replace(/\D/g, "");
      if (digits.length !== 11 || /^(\d)\1{10}$/.test(digits)) return false;
      const digit = partial => {
        let sum = 0;
        for (let index = 0; index < partial.length; index += 1) {
          sum += Number(partial[index]) * (partial.length + 1 - index);
        }
        const result = (sum * 10) % 11;
        return result === 10 ? 0 : result;
      };
      const first = digit(digits.slice(0, 9));
      const second = digit(`${digits.slice(0, 9)}${first}`);
      return digits.endsWith(`${first}${second}`);
    }

    function localDateTime(date = now()) {
      const pad = number => String(number).padStart(2, "0");
      return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }

    function localDateTimeFromIso(value) {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? "Não disponível" : localDateTime(date);
    }

    function dateTimeInputValue(date = now()) {
      const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
      return local.toISOString().slice(0, 19);
    }

    function isValidLocalDateTime(year, month, day, hour, minute, second) {
      if (year < 1000 || year > 9999 || month < 1 || month > 12
          || hour < 0 || hour > 23 || minute < 0 || minute > 59
          || second < 0 || second > 59) return false;
      const maximumDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
      return day >= 1 && day <= maximumDay;
    }

    function inputDateToBrazilian(value) {
      const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(value);
      if (!match) throw new Error("Data e hora de coleta inválidas. Use DD/MM/AAAA HH:mm:ss.");
      const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
      const parts = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
      if (!isValidLocalDateTime(...parts)) {
        throw new Error("Data e hora de coleta inválidas. Use uma data existente no formato DD/MM/AAAA HH:mm:ss.");
      }
      return `${dayText}/${monthText}/${yearText} ${hourText}:${minuteText}:${secondText}`;
    }

    function brazilianDateTimeToInput(value) {
      const match = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
      if (!match) throw new Error("Data e hora de coleta inválidas. Use DD/MM/AAAA HH:mm:ss.");
      const [, dayText, monthText, yearText, hourText, minuteText, secondText] = match;
      const parts = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
      if (!isValidLocalDateTime(...parts)) {
        throw new Error("Data e hora de coleta inválidas. Use uma data existente no formato DD/MM/AAAA HH:mm:ss.");
      }
      return `${yearText}-${monthText}-${dayText}T${hourText}:${minuteText}:${secondText}`;
    }

    function safeName(value, fallback = "LOTE") {
      const sanitized = String(value).trim().replace(/[^\p{L}\p{N}_-]+/gu, "_");
      return sanitized || fallback;
    }

    function newDocumentId(prefix) {
      const date = now();
      const datePart = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
      const random = randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase();
      return `LDF-${prefix}-${datePart}-${random}`;
    }

    return Object.freeze({
      stores: Object.freeze({ creation, audit, routine }),
      selectors: Object.freeze({
        totalLotBytes,
        totalLotBytesWithoutEditingAttachments,
        totalLotFileCount,
        totalLotFileCountWithoutEditingAttachments,
        isCreationUnavailable,
        hasPendingContainer,
        hasCreationDraft,
        isAwaitingSignedDeclaration
      }),
      transitions: Object.freeze({
        setCreationLocked,
        setRuntimeReady,
        setPendingContainer,
        setContainerSaved,
        setShippingReceipt,
        beginRoutine,
        endRoutine,
        resetCreation,
        clearAuditDownloads,
        clearAudit
      }),
      domain: Object.freeze({
        formatBytes,
        formatCpfInput,
        isValidCpf,
        localDateTime,
        localDateTimeFromIso,
        dateTimeInputValue,
        inputDateToBrazilian,
        brazilianDateTimeToInput,
        safeName,
        newDocumentId,
        curateTechnicalTracks
      })
    });
  }

  window.__LDF_APP_MODULES__.register("core", createCore);
})();
