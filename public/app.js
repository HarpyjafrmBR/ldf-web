(function () {
  "use strict";

  let appFactories;
  try {
    const registry = window.__LDF_APP_MODULES__;
    if (!registry) throw new Error("Registro interno dos módulos da aplicação indisponível.");
    appFactories = registry.consume([
      "core", "ui", "fileIo", "lot", "sealing", "audit", "offline"
    ]);
  } finally {
    delete window.__LDF_APP_MODULES__;
  }
  const {
    core: createCore,
    ui: createUi,
    fileIo: createFileIo,
    lot: createLot,
    sealing: createSealing,
    audit: createAudit,
    offline: createOffline
  } = appFactories;

  const MEMORY_FALLBACK_LIMIT_BYTES = 512 * 1024 * 1024;
  const MAX_EVIDENCE = 400;
  const MIN_SECRET_LENGTH = 12;
  const MAX_SECRET_LENGTH = 256;
  const MAX_DESCRIPTION_LENGTH = 4000;
  const MAX_UNAVAILABILITY_LENGTH = 2000;
  const MAX_AUDIT_EVENTS = 4000;
  const RUNTIME_IDENTITY = window.LDFRuntimeIdentity;
  const operationCoordination = window.LDFOperationCoordination;
  if (!RUNTIME_IDENTITY
    || RUNTIME_IDENTITY.releaseToken !== "beta-2.0.0"
    || !/^[0-9a-f]{64}$/.test(RUNTIME_IDENTITY.buildId)
    || !(RUNTIME_IDENTITY.sourceCommit === null || /^[0-9a-f]{40}$/.test(RUNTIME_IDENTITY.sourceCommit))
    || RUNTIME_IDENTITY.cacheName !== `ldf-web-${RUNTIME_IDENTITY.releaseToken}-${RUNTIME_IDENTITY.buildId}`) {
    throw new Error("Identidade da build indisponível ou divergente.");
  }
  if (!operationCoordination) throw new Error("Coordenação entre abas indisponível.");
  const MAX_PHOTOS_PER_EVIDENCE = 10;
  const MAX_DOCUMENTS_PER_EVIDENCE = 10;
  const LARGE_FILE_WARNING_BYTES = 500 * 1024 * 1024;
  const LARGE_LOT_WARNING_BYTES = 1000 * 1024 * 1024;
  const LARGE_LOT_WARNING_FILES = 20;
  const SOURCE_TYPE_LABELS = {
    direct: "Obtido diretamente da fonte, equipamento ou sistema",
    received: "Recebido ou encaminhado digitalmente",
    recaptured: "Recapturado",
    "other-acquisition": "Outra forma de obtenção"
  };
  const PRIMARY_SOURCE_STATUS_LABELS = {
    accompanies: "Acompanha o lote",
    preserved: "Não acompanha, mas permanece preservado e disponível",
    "local-copy": "Não acompanha: foi realizada cópia no local para evitar a retenção do equipamento",
    "remote-content": "Não acompanha: o conteúdo está em infraestrutura remota, nuvem ou rede descentralizada",
    "essential-service": "Não acompanha: a retenção afetaria serviços essenciais ou terceiros alheios ao procedimento",
    unavailable: "A fonte primária está indisponível ou não foi localizada",
    "not-applicable": "Não se aplica ao tipo de arquivo",
    other: "Outra situação"
  };

  const core = createCore({
    now: () => new Date(),
    randomUUID: () => crypto.randomUUID(),
    validateCpf: value => window.LDFValidation.isValidCpf(value)
  });
  const { creation: state, audit: auditState, routine: routineState } = core.stores;
  const {
    totalLotBytes,
    totalLotBytesWithoutEditingAttachments,
    totalLotFileCount,
    totalLotFileCountWithoutEditingAttachments,
    isCreationUnavailable,
    hasPendingContainer,
    hasCreationDraft,
    isAwaitingSignedDeclaration
  } = core.selectors;
  const {
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
  } = core.transitions;
  const {
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
  } = core.domain;

  const byId = id => document.getElementById(id);
  function fieldErrorMessage(element) {
    if (element.name === "meta-source-type") return "Selecione a forma de obtenção do vestígio.";
    switch (element.id) {
      case "lot-code": return "Use de 1 a 60 letras, números, hífens ou sublinhados na identificação do lote.";
      case "operator-name": return "Informe o nome do operador com até 120 caracteres, usando letras, espaços, hífens ou apóstrofos.";
      case "receiver-name": return "Informe o nome do recebedor com até 120 caracteres, usando letras, espaços, hífens ou apóstrofos.";
      case "meta-responsible": return "Informe o nome do responsável pela coleta com até 120 caracteres, usando letras, espaços, hífens ou apóstrofos.";
      case "operator-cpf":
      case "receiver-cpf": return "Informe um CPF válido com 11 dígitos.";
      case "lot-secret":
      case "audit-secret": return "Informe uma chave de acesso entre 12 e 256 caracteres.";
      case "lot-secret-confirm": return "Repita exatamente a chave de acesso informada.";
      case "meta-datetime": {
        if (!element.value.trim() || element.validity.patternMismatch) return "Informe a data e hora no formato DD/MM/AAAA HH:mm:ss.";
        try {
          const date = brazilianDateTimeToInput(element.value.trim());
          if (!window.LDFValidation.isCollectionDateTimeOnOrBefore(date, localDateTime())) return "A data e hora da coleta não podem estar no futuro.";
        } catch { return "Informe uma data e hora válidas no formato DD/MM/AAAA HH:mm:ss."; }
        return "Informe uma data e hora válidas no formato DD/MM/AAAA HH:mm:ss.";
      }
      case "meta-id": return "Informe o código de rastreamento do vestígio com até 80 caracteres.";
      case "meta-nature": return "Informe o tipo ou a descrição do vestígio com até 120 caracteres.";
      case "meta-location": return "Informe o local da coleta com até 240 caracteres.";
      case "meta-description": return "Descreva o procedimento de coleta com até 4000 caracteres.";
      case "meta-unavailability-reason": return "Selecione a situação do equipamento ou da fonte primária.";
      case "meta-unavailability": return "Ao selecionar Outro, descreva a situação da fonte primária com até 1600 caracteres.";
      default: return "Preencha este campo com uma informação válida.";
    }
  }
  function setFieldValidity(element, valid) {
    if (!element) return valid;
    const field = element.closest(".field");
    if (!field) return valid;
    const errorId = `${element.id || element.name}-error`;
    let message = field.querySelector(`[id="${errorId}"]`);
    if (!valid && !message) {
      message = document.createElement("small");
      message.id = errorId;
      message.className = "field-error";
      message.setAttribute("role", "alert");
      field.append(message);
    }
    if (message) message.hidden = valid;
    const related = element.name === "meta-source-type"
      ? Array.from(document.querySelectorAll('input[name="meta-source-type"]')) : [element];
    const errorText = valid ? "" : fieldErrorMessage(element);
    if (!valid) message.textContent = errorText;
    for (const input of related) {
      input.setCustomValidity?.(errorText);
      input.classList.toggle("invalid", !valid);
      const descriptions = new Set((input.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean));
      descriptions.delete(errorId);
      if (valid) input.removeAttribute("aria-invalid");
      else { input.setAttribute("aria-invalid", "true"); descriptions.add(errorId); }
      if (descriptions.size) input.setAttribute("aria-describedby", Array.from(descriptions).join(" "));
      else input.removeAttribute("aria-describedby");
    }
    return valid;
  }
  function validateFields(checks) {
    let firstInvalid = null;
    let allValid = true;
    for (const [element, valid] of checks) {
      if (!setFieldValidity(element, valid)) {
        allValid = false;
        if (!firstInvalid && element && (!element.disabled || element.dataset.routineDisabled === "true") && element.getClientRects().length) firstInvalid = element;
      }
    }
    if (firstInvalid) {
      // A recusa encerra o bloqueio temporário da rotina antes de apresentar o balão.
      queueMicrotask(() => {
        if (firstInvalid.disabled || !firstInvalid.getClientRects().length || firstInvalid.getAttribute("aria-invalid") !== "true") return;
        firstInvalid.focus();
        firstInvalid.reportValidity?.();
      });
    }
    return allValid;
  }
  function clearFieldErrors(container) {
    container.querySelectorAll(".invalid").forEach(element => setFieldValidity(element, true));
  }
  const lotCodeInput = byId("lot-code");
  const operatorNameInput = byId("operator-name");
  const operatorCpfInput = byId("operator-cpf");
  const lotSecretInput = byId("lot-secret");
  const lotSecretConfirmInput = byId("lot-secret-confirm");
  const evidenceInput = byId("evidence-input");
  const signedInput = byId("signed-declaration");
  const evidenceList = byId("evidence-list");
  const evidenceEmpty = byId("evidence-empty");
  const metadataDialog = byId("metadata-dialog");
  const metadataForm = byId("metadata-form");
  const operationLog = byId("operation-log");
  const fileInfoDialog = byId("file-info-dialog");


  let ui;
  let temporalPreflightRecord = null;
  let environmentPreparationFailureRecord = null;

  function synchronizeCreationControls() {
    ui.setCreationControlsUnavailable(isCreationUnavailable());
    if (isAwaitingSignedDeclaration()) ui.enableSignedDeclarationControls();
    if (hasPendingContainer()) ui.lockPreparedContainerControls();
    renderEvidence();
    ui.renderCreationStages();
    byId("select-container").disabled = routineState.active || byId("container-input").disabled;
    byId("replace-container").disabled = byId("select-container").disabled;
    byId("open-receipt").disabled = routineState.active || byId("container-input").disabled || !auditState.selectedContainer;
  }

  ui = createUi({
    elements: Object.freeze({
      body: document.body,
      privacyStrip: document.querySelector(".privacy-strip"),
      toastRegion: byId("toast-region"),
      activityIndicators: Object.freeze({
        "operation-progress": byId("operation-progress"),
        "audit-progress": byId("audit-progress")
      }),
      listRoutineControls: () => Array.from(document.querySelectorAll("button, input, textarea, select")),
      listRoutineLabels: () => Array.from(document.querySelectorAll("label.button[for]")),
      creationControls: Object.freeze([
        lotCodeInput,
        operatorNameInput,
        operatorCpfInput,
        lotSecretInput,
        lotSecretConfirmInput,
        evidenceInput,
        byId("generate-secret")
      ]),
      generateDeclaration: byId("generate-declaration"),
      evidenceAddLabel: byId("evidence-add-label"),
      generateSecret: byId("generate-secret"),
      signedInput,
      signedLabel: byId("signed-label"),
      creationSecretInputs: Object.freeze([lotSecretInput, lotSecretConfirmInput]),
      secretInputs: Object.freeze([lotSecretInput, lotSecretConfirmInput, byId("audit-secret")]),
      tabButtons: Object.freeze(Array.from(document.querySelectorAll(".tab-button"))),
      tabPanels: Object.freeze(Array.from(document.querySelectorAll(".tab-panel"))),
      stageButtons: Array.from(document.querySelectorAll("[data-stage]")), stagePanels: Array.from(document.querySelectorAll("[data-stage-panel]")),
      nextStageButtons: Array.from(document.querySelectorAll("[data-next-stage]")),
      qualificationStatus: byId("qualification-status"),
      firstFile: byId("first-file"), evidencePanel: byId("evidence-panel"), addFirstFile: byId("add-first-file"),
      emitDocument: byId("emit-document"), declarationStatus: byId("declaration-status"),
      signedSelection: byId("signed-selection"), signedChecks: byId("signed-checks"), signedName: byId("signed-file-name"), signedHash: byId("signed-file-hash"), signedCheckResults: byId("signed-check-results"),
      sealCount: byId("seal-count"), sealDocument: byId("seal-document"), beginSealing: byId("begin-sealing"), closingStatus: byId("closing-status"), homeDraft: byId("home-draft"),
      backHome: byId("back-home"), environmentHome: byId("home-environment-slot"),
      aboutPanel: byId("about-panel"), aboutContent: byId("about-session-content"),
      aboutTemplate: byId("about-content-template")
    }),
    routine: routineState,
    beginRoutineTransition: beginRoutine,
    endRoutineTransition: endRoutine,
    createElement: tagName => document.createElement(tagName),
    scrollToStart: () => window.scrollTo({ top: 0, behavior: "instant" }),
    schedule: (callback, milliseconds) => window.setTimeout(callback, milliseconds),
    synchronizeCreationControls,
    creationPresentation: () => ({
      hasShownEvidenceList: state.hasShownEvidenceList, locked: state.locked, runtimeReady: state.runtimeReady,
      documentId: state.documentId, evidenceCount: state.evidence.length,
      qualifiedCount: state.evidence.filter(item => item.metadata).length,
      signedSelection: state.signedSelection ? { name: state.signedSelection.file.name, sha256: state.signedSelection.sha256, inspection: state.signedSelection.inspection } : null,
      planPending: Boolean(state.pendingContainer), downloadRequested: Boolean(state.pendingContainer?.fallbackArtifact), containerSaved: state.containerSaved
    }),
    creationStages: core.selectors.creationStages
  });
  const {
    escapeHtml,
    showToast,
    friendlyErrorMessage,
    setActivityProgress,
    beginExclusiveRoutine,
    endExclusiveRoutine,
    switchTab,
    maskSecretInputs
  } = ui;

  document.querySelector(".intro-learn-more").addEventListener("click", event => {
    event.preventDefault();
    ui.openAbout(event.currentTarget);
  });
  byId("about-session-content").addEventListener("click", event => {
    if (event.target.closest("[data-close-about]")) { event.preventDefault(); ui.closeAbout(); }
  });


  const fileIo = createFileIo({
    cryptoApi: window.LDFCrypto,
    validationApi: window.LDFValidation,
    fileApi: Object.freeze({
      getSaveFilePicker: () => (
        "showSaveFilePicker" in window
          ? options => window.showSaveFilePicker(options)
          : null
      ),
      createObjectUrl: blob => URL.createObjectURL(blob),
      revokeObjectUrl: url => URL.revokeObjectURL(url),
      createDownloadAnchor: () => document.createElement("a"),
      appendDownloadAnchor: anchor => document.body.append(anchor),
      createBlob: (parts, options) => new Blob(parts, options),
      schedule: (callback, milliseconds) => window.setTimeout(callback, milliseconds)
    }),
    feedback: Object.freeze({ setActivityProgress, formatBytes }),
    diagnostics: Object.freeze({
      nowIso: () => new Date().toISOString(),
      monotonicNow: () => performance.now(),
      newOccurrenceId: () => `LDF-SAVE-${crypto.randomUUID().replaceAll("-", "").slice(0, 16).toUpperCase()}`,
      browserFamily: /Edg\//.test(navigator.userAgent)
        ? "Edge"
        : /Chrome\//.test(navigator.userAgent)
          ? "Chrome"
          : "Other"
    }),
    limits: Object.freeze({ memoryFallbackBytes: MEMORY_FALLBACK_LIMIT_BYTES })
  });
  const { saveBlob, saveContainerPlan, saveProtectedRecord } = fileIo;


  const reuseFields = Object.freeze({
    "meta-id": "Código/ID de rastreamento", "meta-nature": "Tipo/descrição do vestígio",
    "meta-responsible": "Responsável pela coleta", "meta-datetime": "Data e hora da coleta",
    "meta-location": "Local físico ou ambiente virtual", "meta-description": "Descrição do procedimento",
    "meta-source-type": "Origem/forma de obtenção", "meta-unavailability-reason": "Situação da fonte primária",
    "meta-unavailability": "Informações complementares"
  });
  const reuseControls = Object.entries(reuseFields).map(([fieldId, label]) => {
    const input = fieldId === "meta-source-type" ? metadataForm.querySelector('input[name="meta-source-type"]') : byId(fieldId);
    const disclosure = document.createElement("details");
    disclosure.className = "reuse-disclosure";
    disclosure.hidden = true;
    const trigger = document.createElement("summary");
    trigger.textContent = "Reaproveitar dados";
    trigger.setAttribute("aria-label", `Reaproveitar dados: ${label}`);
    const select = document.createElement("select");
    select.dataset.copyField = fieldId;
    select.setAttribute("aria-label", `Selecionar vestígio para copiar: ${label}`);
    disclosure.append(trigger, select);
    input.closest(".field").append(disclosure);
    return select;
  });
  const lot = createLot({
    store: state,
    elements: Object.freeze({
      evidenceInput,
      evidenceList,
      evidenceEmpty,
      evidenceCount: byId("evidence-count"),
      operatorNameInput,
      metadataDialog,
      metadataFileName: byId("metadata-file-name"),
      metadataReviewDialog: byId("metadata-review-dialog"),
      metadataReviewFileName: byId("metadata-review-file-name"),
      reviewMetaId: byId("review-meta-id"),
      reviewMetaNature: byId("review-meta-nature"),
      reviewMetaResponsible: byId("review-meta-responsible"),
      reviewMetaDateTime: byId("review-meta-datetime"),
      reviewMetaLocation: byId("review-meta-location"),
      reviewMetaSourceType: byId("review-meta-source-type"),
      reviewMetaSourceStatus: byId("review-meta-source-status"),
      reviewMetaSourceDetailsRow: byId("review-meta-source-information-row"),
      reviewMetaSourceDetails: byId("review-meta-source-information"),
      reviewMetaDescription: byId("review-meta-description"),
      reviewMetaPhotos: byId("review-meta-photos"),
      reviewMetaDocuments: byId("review-meta-documents"),
      metaId: byId("meta-id"),
      metaNature: byId("meta-nature"),
      metaResponsible: byId("meta-responsible"),
      metaDateTime: byId("meta-datetime"),
      metaDateTimePicker: byId("meta-datetime-picker"),
      metaLocation: byId("meta-location"),
      metaDescription: byId("meta-description"),
      metaSourceTypes: Object.freeze(Array.from(document.querySelectorAll('input[name="meta-source-type"]'))),
      metaUnavailabilityReason: byId("meta-unavailability-reason"),
      metaUnavailability: byId("meta-unavailability"),
      sourceDetailsField: byId("source-information-field"),
      sourceDetailsRequired: byId("source-information-required"),
      sourceDetailsOptional: byId("source-information-optional"),
      qualificationStatuses: Object.freeze(Array.from(document.querySelectorAll("[data-status-block]"))),
      qualificationCompletionSummary: byId("qualification-completion-summary"),
      metaPhotos: byId("meta-photos"),
      photoCount: byId("photo-count"),
      photoAddLabel: byId("photo-add-label"),
      photoList: byId("photo-list"),
      metaDocuments: byId("meta-documents"),
      metadataForm,
      reuseControls: Object.freeze(reuseControls),
      reuseStatus: byId("reuse-status"),
      documentCount: byId("document-count"),
      documentAddLabel: byId("document-add-label"),
      documentList: byId("document-list"),
      operationLog
    }),
    ui: Object.freeze({
      escapeHtml,
      showToast,
      friendlyErrorMessage,
      validateFields,
      clearFieldErrors,
      refreshCreationPresentation: () => ui.renderCreationStages(),
      setActivityProgress,
      beginExclusiveRoutine,
      endExclusiveRoutine
    }),
    cryptoApi: window.LDFCrypto,
    fileAnalysisApi: window.LDFFileAnalysis,
    validationApi: window.LDFValidation,
    temporalApi: window.LDFTemporal,
    selectors: Object.freeze({
      totalLotBytes,
      totalLotBytesWithoutEditingAttachments,
      totalLotFileCount,
      totalLotFileCountWithoutEditingAttachments
    }),
    domain: Object.freeze({
      formatBytes,
      localDateTime,
      localDateTimeFromIso,
      dateTimeInputValue,
      inputDateToBrazilian,
      brazilianDateTimeToInput
    }),
    limits: Object.freeze({
      maxEvidence: MAX_EVIDENCE,
      maxPhotosPerEvidence: MAX_PHOTOS_PER_EVIDENCE,
      maxDocumentsPerEvidence: MAX_DOCUMENTS_PER_EVIDENCE,
      maxDescriptionLength: MAX_DESCRIPTION_LENGTH,
      maxUnavailabilityLength: MAX_UNAVAILABILITY_LENGTH,
      maxAuditEvents: MAX_AUDIT_EVENTS,
      largeFileWarningBytes: LARGE_FILE_WARNING_BYTES,
      largeLotWarningBytes: LARGE_LOT_WARNING_BYTES,
      largeLotWarningFiles: LARGE_LOT_WARNING_FILES
    }),
    sourceTypeLabels: SOURCE_TYPE_LABELS,
    primarySourceStatusLabels: PRIMARY_SOURCE_STATUS_LABELS,
    confirmAction: message => window.confirm(message),
    randomUUID: () => crypto.randomUUID(),
    createElement: tagName => document.createElement(tagName)
  });
  const {
    addLog,
    ensureCreationTemporalSession,
    temporalSummaryForDocument,
    requireCoherentTemporalSession,
    renderEvidence,
    addEvidenceFiles,
    openMetadata,
    closeMetadata,
    addMetadataPhotos,
    addMetadataDocuments,
    applySelectedMetadataDateTime,
    synchronizeMetadataDateTimePicker,
    openMetadataDateTimePicker,
    reviewMetadata,
    closeMetadataReview,
    saveMetadata,
    removeEvidence,
    updateSourceDetailsVisibility,
    updateQualificationProgress,
    removeMetadataPhoto,
    removeMetadataDocument
  } = lot;

  function setCreateControlsLocked(locked) {
    setCreationLocked(locked);
    synchronizeCreationControls();
  }

  let preparedStatusText = "";

  function setCoordinationBlocked(blocked) {
    if (!state.runtimeReady) return;
    setCreateControlsLocked(blocked);
    byId("container-input").disabled = blocked;
    byId("open-container").disabled = blocked;
    byId("select-container").disabled = blocked;
    byId("replace-container").disabled = blocked;
    byId("open-receipt").disabled = blocked || !auditState.selectedContainer;
    const status = byId("secure-context-status");
    if (blocked) {
      status.textContent = "Outra aba mantém uma operação formal";
      status.classList.add("warning");
    } else if (preparedStatusText) {
      status.textContent = preparedStatusText;
      status.dataset.prepared = "true";
      status.classList.remove("warning");
    }
  }

  async function acquireFormalOperation() {
    if (await operationCoordination.acquire()) return true;
    setCoordinationBlocked(true);
    showToast("Outra aba do LDF Web mantém uma operação formal. Encerre-a antes de iniciar esta operação.", "warning");
    return false;
  }

  const FILE_INFO_ORIGIN_LABELS = Object.freeze({
    title: "Nome/título registrado",
    recordedDate: "Data registrada",
    encodedDate: "Data de codificação registrada",
    taggedDate: "Data de marcação registrada",
    manufacturer: "Fabricante registrado",
    model: "Modelo registrado",
    software: "Software/encoder registrado",
    comment: "Comentário registrado"
  });
  const FILE_INFO_GPS_LABELS = Object.freeze({
    latitude: "Latitude registrada",
    longitude: "Longitude registrada",
    altitude: "Altitude registrada",
    location: "Localização registrada"
  });
  const FILE_INFO_TECHNICAL_LABELS = Object.freeze({
    format: "Formato",
    profile: "Perfil",
    durationSeconds: "Duração (segundos)",
    width: "Largura (px)",
    height: "Altura (px)",
    frameRate: "Quadros por segundo",
    bitRate: "Taxa de bits",
    channels: "Canais",
    samplingRate: "Taxa de amostragem (Hz)"
  });
  const PDF_STRUCTURE_LABELS = Object.freeze({
    version: "Versão registrada no cabeçalho",
    encrypted: "Criptografia indicada na estrutura",
    incrementalUpdates: "Atualizações incrementais encontradas"
  });
  const PDF_INFO_LABELS = Object.freeze({
    title: "Título registrado (Info)",
    author: "Autor registrado (Info)",
    subject: "Assunto registrado (Info)",
    keywords: "Palavras-chave registradas (Info)",
    creator: "Software criador registrado (Info)",
    producer: "Produtor registrado (Info)",
    creationDate: "Data de criação registrada (Info)",
    modificationDate: "Data de modificação registrada (Info)",
    trapped: "Estado Trapped registrado (Info)"
  });
  const PDF_IDENTIFIER_LABELS = Object.freeze({
    original: "Primeiro identificador registrado no trailer",
    current: "Segundo identificador registrado no trailer"
  });
  const PDF_XMP_LABELS = Object.freeze({
    title: "Título registrado (XMP)",
    creators: "Autor(es) registrado(s) (XMP)",
    description: "Descrição registrada (XMP)",
    subjects: "Assunto(s) registrado(s) (XMP)",
    keywords: "Palavras-chave registradas (XMP)",
    creatorTool: "Ferramenta criadora registrada (XMP)",
    producer: "Produtor registrado (XMP)",
    createDate: "Data de criação registrada (XMP)",
    modifyDate: "Data de modificação registrada (XMP)",
    metadataDate: "Data dos metadados registrada (XMP)",
    documentId: "DocumentID registrado (XMP)",
    instanceId: "InstanceID registrado (XMP)",
    originalDocumentId: "OriginalDocumentID registrado (XMP)"
  });

  function appendDefinitionList(list, values, labels) {
    list.textContent = "";
    for (const [key, label] of Object.entries(labels)) {
      if (values?.[key] === undefined) continue;
      const term = document.createElement("dt");
      const description = document.createElement("dd");
      term.textContent = label;
      description.textContent = String(values[key]);
      list.append(term, description);
    }
  }

  function c2paDialogMessage(result) {
    if (result?.status === "detected") {
      return "Credencial C2PA detectada. O reconhecimento é somente estrutural e local.";
    }
    if (result?.status === "absent") {
      return "Nenhuma credencial C2PA foi detectada. Isso não indica que o arquivo seja autêntico, inalterado ou não tenha sido gerado por IA.";
    }
    return `Verificação C2PA indisponível. ${result?.reason || "Formato não suportado, limite técnico ou erro de leitura."}`;
  }

  function renderPdfInformation(pdf) {
    const panel = byId("file-info-pdf");
    const info = byId("file-info-pdf-info");
    const infoEmpty = byId("file-info-pdf-info-empty");
    const identifiersSection = byId("file-info-pdf-identifiers-section");
    const identifiers = byId("file-info-pdf-identifiers");
    const xmpStatus = byId("file-info-pdf-xmp-status");
    const xmpFields = byId("file-info-pdf-xmp");
    const rawDetails = byId("file-info-pdf-xmp-raw");
    const rawNote = byId("file-info-pdf-xmp-raw-note");
    const rawText = byId("file-info-pdf-xmp-raw-text");
    const structure = {
      version: pdf?.structure?.version,
      encrypted: typeof pdf?.structure?.encrypted === "boolean"
        ? (pdf.structure.encrypted ? "Sim" : "Não")
        : undefined,
      incrementalUpdates: pdf?.structure?.incrementalUpdates
    };

    panel.classList.remove("hidden");
    appendDefinitionList(byId("file-info-pdf-structure"), structure, PDF_STRUCTURE_LABELS);
    appendDefinitionList(info, pdf?.info, PDF_INFO_LABELS);
    infoEmpty.classList.toggle("hidden", info.children.length > 0);
    appendDefinitionList(identifiers, pdf?.identifiers, PDF_IDENTIFIER_LABELS);
    identifiersSection.classList.toggle("hidden", identifiers.children.length === 0);
    appendDefinitionList(xmpFields, pdf?.xmp?.fields, PDF_XMP_LABELS);
    xmpFields.classList.toggle("hidden", xmpFields.children.length === 0);

    if (pdf?.xmp?.status === "available") {
      xmpStatus.textContent = pdf.xmp.normalized === false
        ? (pdf.xmp.reason || "O fluxo XMP foi preservado como texto, sem normalização dos campos.")
        : "Fluxo XMP referenciado pelo catálogo encontrado. Os campos selecionados permanecem registros editáveis do arquivo.";
    } else if (pdf?.xmp?.status === "unavailable") {
      xmpStatus.textContent = `Fluxo XMP indisponível. ${pdf.xmp.reason || "Limite técnico ou construção não suportada."}`;
    } else {
      xmpStatus.textContent = "Nenhum fluxo XMP referenciado pelo catálogo foi encontrado.";
    }

    const hasRawXml = typeof pdf?.xmp?.rawXml === "string";
    rawDetails.hidden = !hasRawXml;
    rawDetails.open = false;
    rawText.textContent = hasRawXml ? pdf.xmp.rawXml : "";
    rawNote.textContent = hasRawXml
      ? `${Number.isSafeInteger(pdf.xmp.rawBytes) ? `${pdf.xmp.rawBytes} byte(s) decodificado(s). ` : ""}${pdf.xmp.rawTruncated ? "A exibição foi truncada pelo limite local; o arquivo não foi alterado." : "Exibição textual completa dentro do limite local."}`
      : "";
  }

  function openFileInfoDialog(name, c2pa, fileInfo) {
    byId("file-info-name").textContent = name;
    byId("file-info-c2pa").textContent = c2paDialogMessage(c2pa);
    const engine = byId("file-info-engine");
    const origin = byId("file-info-origin");
    const gpsControl = byId("file-info-gps-control");
    const gpsList = byId("file-info-gps");
    const gpsButton = byId("reveal-file-info-gps");
    const technicalDetails = byId("file-info-technical-details");
    const technical = byId("file-info-technical");
    const pdfPanel = byId("file-info-pdf");
    technical.textContent = "";
    technicalDetails.hidden = true;
    technicalDetails.open = false;
    pdfPanel.classList.add("hidden");
    appendDefinitionList(origin, {}, FILE_INFO_ORIGIN_LABELS);
    appendDefinitionList(gpsList, {}, FILE_INFO_GPS_LABELS);
    gpsControl.classList.add("hidden");
    gpsList.classList.add("hidden");
    gpsButton.setAttribute("aria-expanded", "false");
    gpsButton.textContent = "Exibir localização registrada";

    if (fileInfo?.status === "available") {
      engine.textContent = `Leitura local: ${fileInfo.engine}. Os valores abaixo são apresentados conforme registrados no arquivo.`;
      if (fileInfo.kind === "pdf" && fileInfo.pdf) {
        origin.classList.add("hidden");
        renderPdfInformation(fileInfo.pdf);
      } else {
        origin.classList.remove("hidden");
        appendDefinitionList(origin, fileInfo.origin, FILE_INFO_ORIGIN_LABELS);
        if (Object.keys(fileInfo.gps || {}).length) gpsControl.classList.remove("hidden");
        appendDefinitionList(gpsList, fileInfo.gps, FILE_INFO_GPS_LABELS);
        const curatedTracks = curateTechnicalTracks(fileInfo);
        technicalDetails.hidden = curatedTracks.length === 0;
        for (const track of curatedTracks) {
          const section = document.createElement("section");
          const heading = document.createElement("h4");
          const list = document.createElement("dl");
          heading.textContent = track.heading;
          list.className = "file-info-fields";
          appendDefinitionList(list, track, FILE_INFO_TECHNICAL_LABELS);
          section.append(heading, list);
          technical.append(section);
        }
        if (!Object.keys(fileInfo.origin || {}).length) {
          const empty = document.createElement("p");
          empty.className = "file-info-empty";
          empty.textContent = "Nenhum campo selecionado de origem ou histórico foi encontrado.";
          origin.append(empty);
        }
      }
    } else if (fileInfo?.status === "unavailable") {
      origin.classList.remove("hidden");
      engine.textContent = `Informações técnicas indisponíveis. ${fileInfo.reason || "Limite técnico ou erro de leitura."}`;
    } else {
      origin.classList.remove("hidden");
      engine.textContent = "Informações técnicas ainda não consultadas para este vestígio.";
    }
    fileInfoDialog.showModal();
  }

  function closeFileInfoDialog() {
    fileInfoDialog.close();
  }


  const sealing = createSealing({
    store: state,
    elements: Object.freeze({
      lotCodeInput,
      operatorNameInput,
      operatorCpfInput,
      lotSecretInput,
      lotSecretConfirmInput,
      signedInput,
      lotSecretHelp: byId("lot-secret-help"),
      signedLabel: byId("signed-label"),
      stepOne: byId("step-one"),
      stepTwo: byId("step-two"),
      saveContainerButton: byId("save-container"),
      confirmContainerDownloadButton: byId("confirm-container-download"),
      saveShippingReceiptButton: byId("save-shipping-receipt")
    }),
    ui: Object.freeze({
      showToast,
      friendlyErrorMessage,
      validateFields,
      beginExclusiveRoutine,
      endExclusiveRoutine,
      setActivityProgress,
      setCreateControlsLocked,
      confirmManualDownload: message => window.confirm(message)
    }),
    lot: Object.freeze({ addLog }),
    temporal: Object.freeze({
      ensureCreationSession: ensureCreationTemporalSession,
      summaryForDocument: temporalSummaryForDocument,
      requireCoherentSession: action => requireCoherentTemporalSession(state.temporalSession, action)
    }),
    fileIo: Object.freeze({ saveBlob, saveContainerPlan }),
    cryptoApi: window.LDFCrypto,
    pdfApi: window.LDFPdf,
    validationApi: window.LDFValidation,
    selectors: Object.freeze({ hasPendingContainer }),
    sourceTypeLabels: SOURCE_TYPE_LABELS,
    primarySourceStatusLabels: PRIMARY_SOURCE_STATUS_LABELS,
    transitions: Object.freeze({ setPendingContainer, setContainerSaved, setShippingReceipt }),
    domain: Object.freeze({
      formatCpfInput,
      isValidCpf,
      localDateTime,
      safeName,
      newDocumentId,
      compactTimestamp: () => new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)
    }),
    limits: Object.freeze({ minSecretLength: MIN_SECRET_LENGTH, maxSecretLength: MAX_SECRET_LENGTH })
  });
  const {
    generateStrongSecret,
    generateInitialDeclaration,
    selectSignedDeclaration,
    prepareContainerPlan,
    savePendingContainer,
    confirmFallbackContainerDownload,
    saveShippingReceipt
  } = sealing;

  async function saveOperationTrailPdf() {
    const visibleEntries = state.logs.filter(entry => entry.visible !== false);
    if (!visibleEntries.length) {
      showToast("Não há registros visíveis para salvar.", "warning");
      return;
    }
    if (!beginExclusiveRoutine("geração e salvamento da trilha da operação")) return;
    setActivityProgress("operation-progress", true, "Gerando o PDF da trilha da operação...");
    try {
      const lotCode = lotCodeInput.value.trim();
      const fileName = `Trilha_Operacao_${safeName(lotCode || "LDF")}.pdf`;
      const pdf = LDFPdf.operationTrail({
        documentId: newDocumentId("TRI"),
        lotCode,
        generatedAt: localDateTime(),
        temporalSummary: temporalSummaryForDocument(state.temporalSession),
        entries: visibleEntries.map(({ timestamp, message, type }) => ({ timestamp, message, type }))
      });
      const result = await saveBlob(pdf, fileName);
      if (result === "cancelled") {
        showToast("O salvamento da trilha da operação foi cancelado.", "warning");
      } else if (result === "download-requested") {
        addLog(`Download da trilha da operação solicitado: ${fileName} [DOWNLOAD_REQUESTED].`, "warning");
        showToast("Download da trilha da operação solicitado. Confirme a conclusão no navegador; a ação permanece disponível para nova tentativa.", "warning");
      } else {
        addLog(`Trilha da operação salva: ${fileName}`);
        showToast("Trilha da operação salva.");
      }
    } catch (error) {
      showToast(friendlyErrorMessage(error, "salvar a trilha da operação"), "error");
    } finally {
      setActivityProgress("operation-progress", false);
      endExclusiveRoutine();
    }
  }

  function resetOperation() {
    if (routineState.active) {
      const confirmed = window.confirm(
        `A rotina "${routineState.label}" está em andamento. Reiniciar agora cancelará o processamento e descartará os dados não salvos. Deseja continuar?`
      );
      if (confirmed) window.location.reload();
      return;
    }
    if (hasCreationDraft() && !window.confirm("Cancelar o lote atual e reiniciar toda a operação?")) return;
    resetCreation();
    operationCoordination.release();
    byId("lot-form").reset();
    byId("seal-form").reset();
    ui.clearCreationSecret();
    byId("declarant-dialog").close();
    byId("seal-dialog").close();
    ui.resetNavigation();
    byId("lot-secret-help").textContent = "O servidor não recebe nem recupera esta chave. Insira uma senha no mínimo com 12 caracteres.";
    signedInput.value = "";
    signedInput.disabled = true;
    byId("signed-label").classList.add("disabled");
    byId("save-container").classList.add("hidden");
    byId("save-container").disabled = false;
    byId("save-container").textContent = "Salvar contêiner LDF";
    byId("confirm-container-download").classList.add("hidden");
    byId("confirm-container-download").disabled = false;
    byId("save-shipping-receipt").classList.add("hidden");
    byId("save-shipping-receipt").disabled = false;
    ui.resetNavigation();
    setActivityProgress("operation-progress", false);
    operationLog.innerHTML = "";
    setCreateControlsLocked(false);
    renderEvidence();
    addLog("Nova operação iniciada.");
    appendTemporalPreflightLog();
    appendEnvironmentPreparationFailureLog();
    showToast("Registro reiniciado.");
  }


  const audit = createAudit({
    store: auditState,
    routine: routineState,
    elements: Object.freeze({
      auditForm: byId("audit-form"),
      receivingDialog: byId("audit-receipt-dialog"), selectedContainerName: byId("selected-container-name"),
      signatureNote: byId("audit-signature-note"),
      auditFirst: byId("audit-first"), auditSelected: byId("audit-selected"),
      auditSteps: [...document.querySelectorAll("[data-audit-step]")], auditResults: byId("audit-results"),
      containerInput: byId("container-input"),
      receiverNameInput: byId("receiver-name"),
      receiverCpfInput: byId("receiver-cpf"),
      auditSecretInput: byId("audit-secret"),
      auditSummary: byId("audit-summary"),
      auditContent: byId("audit-content"),
      auditEmpty: byId("audit-empty"),
      openContainerButton: byId("open-container"),
      downloadAuditPdfButton: () => byId("download-audit-pdf")
    }),
    ui: Object.freeze({
      escapeHtml,
      showToast,
      friendlyErrorMessage,
      validateFields,
      setActivityProgress,
      beginExclusiveRoutine,
      endExclusiveRoutine
    }),
    fileIo: Object.freeze({ saveBlob, saveProtectedRecord }),
    fileAnalysisApi: window.LDFFileAnalysis,
    cryptoApi: Object.freeze({
      get FORMAT() { return window.LDFCrypto.FORMAT; },
      openContainer: (...args) => window.LDFCrypto.openContainer(...args),
      canonicalJson: value => window.LDFCrypto.canonicalJson(value),
      sha256Canonical: value => window.LDFCrypto.sha256Canonical(value)
    }),
    pdfApi: Object.freeze({ auditDeclaration: data => window.LDFPdf.auditDeclaration(data) }),
    validationApi: Object.freeze({
      signedDeclarationFileName: lotCode => window.LDFValidation.signedDeclarationFileName(lotCode),
      reviewDeclarationFileName: lotCode => window.LDFValidation.reviewDeclarationFileName(lotCode),
      validateManifest: (...args) => window.LDFValidation.validateManifest(...args),
      normalizePersonalName: value => window.LDFValidation.normalizePersonalName(value),
      isValidPersonalName: value => window.LDFValidation.isValidPersonalName(value),
      inspectPdf: (...args) => window.LDFValidation.inspectPdf(...args),
      qualifiedLotRecordFromManifest: manifest => window.LDFValidation.qualifiedLotRecordFromManifest(manifest)
    }),
    temporal: Object.freeze({
      startSession: purpose => window.LDFTemporal.startSession(purpose),
      summaryForDocument: temporalSummaryForDocument,
      requireCoherentSession: action => requireCoherentTemporalSession(auditState.temporalSession, action)
    }),
    selectors: Object.freeze({ isRuntimeReady: () => state.runtimeReady }),
    transitions: Object.freeze({
      clearAuditDownloads,
      clearAudit: () => { clearAudit(); operationCoordination.release(); }
    }),
    domain: Object.freeze({ formatCpfInput, isValidCpf, localDateTime, safeName, newDocumentId }),
    limits: Object.freeze({ minSecretLength: MIN_SECRET_LENGTH, maxSecretLength: MAX_SECRET_LENGTH }),
    confirmAction: message => window.confirm(message),
    reloadApplication: () => window.location.reload()
  });
  const { resetAudit, openAndAudit, selectContainer, clearReceivingSecret, saveAuditDownload, analyzeAuditFile } = audit;

  function initializeSessionDisclosures() {
    const groups = [
      { key: "environment", details: [byId("environment-disclosure")], status: byId("secure-context-status"), signal: byId("secure-context-status") },
      { key: "temporal", details: [byId("temporal-disclosure"), byId("audit-temporal-disclosure")], status: byId("temporal-preflight-status"), signal: byId("temporal-preflight") }
    ];
    for (const group of groups) {
      const key = `ldf-web-disclosure-${group.key}`;
      const rendered = new Map();
      let signature = "";
      function present(open) {
        for (const details of group.details) {
          rendered.set(details, open);
          details.open = open;
        }
      }
      let saved = false;
      try { saved = sessionStorage.getItem(key) === "open"; } catch { /* Escolha local à página. */ }
      present(saved);
      for (const details of group.details) {
        details.addEventListener("toggle", () => {
          if (details.open === rendered.get(details)) return;
          const open = details.open;
          present(open);
          try { sessionStorage.setItem(key, open ? "open" : "closed"); } catch { /* Sem dados operacionais. */ }
        });
      }
      function revealNewAlert() {
        const next = `${group.signal.className}|${group.status.textContent}`;
        if (next === signature) return;
        signature = next;
        if (group.signal.matches(".warning, .error, .preparation-failed")) present(true);
      }
      const observer = new MutationObserver(revealNewAlert);
      observer.observe(group.signal, { attributes: true, attributeFilter: ["class"], childList: true, characterData: true, subtree: true });
      revealNewAlert();
    }
  }

  function initializeSecurityStatus() {
    const status = byId("secure-context-status");
    const available = window.isSecureContext && window.crypto?.subtle;
    if (available) {
      status.textContent = "Preparando ambiente criptográfico...";
      status.classList.remove("warning", "preparation-failed");
    } else {
      status.textContent = "Abra por HTTPS ou localhost";
      status.classList.add("warning");
      showToast("A criptografia exige HTTPS ou execução por localhost.", "error");
    }
    return Boolean(available);
  }

  function renderTemporalPreflight(reference) {
    function present(stateClass, statusText, detailText) {
      const hidden = stateClass === "coherent" ? " hidden" : "";
      for (const prefix of ["temporal-preflight", "audit-temporal-preflight", "home-temporal-preflight"]) {
        byId(prefix).className = `temporal-preflight ${stateClass}${hidden}`;
        byId(`${prefix}-status`).textContent = statusText;
        byId(`${prefix}-detail`).textContent = detailText;
      }
      return {
        message: `Verificação de Data/Hora - ${statusText.toLocaleLowerCase("pt-BR")} - ${detailText}`,
        type: stateClass === "coherent" ? "info" : "warning"
      };
    }

    if (!reference?.available) {
      return present("warning", "CONTINGÊNCIA", "A referência técnica inicial não ficou disponível. O fluxo poderá continuar, no entanto, os documentos não conterão os registros de data e hora.");
    }

    try {
      const monotonicNowMs = performance.now();
      const referenceExpectedNowMs = reference.referenceAtReceiveMs
        + (monotonicNowMs - reference.receivedAtMonotonicMs);
      const deviceNowMs = Date.now();
      const differenceSeconds = Math.round((deviceNowMs - referenceExpectedNowMs) / 1000);
      const referenceTime = localDateTimeFromIso(new Date(referenceExpectedNowMs).toISOString());
      const deviceTime = localDateTime(new Date(deviceNowMs));
      const conciseDetail = `Dispositivo: ${deviceTime}. Referência: ${referenceTime}. Diferença: ${differenceSeconds} s.`;

      if (Math.abs(deviceNowMs - referenceExpectedNowMs) >= LDFTemporal.DRIFT_THRESHOLD_MS) {
        return present("error", "DIVERGÊNCIA", `${conciseDetail} Corrija o relógio e recarregue a página antes dos atos críticos.`);
      }

      return present("coherent", "COERENTE", conciseDetail);
    } catch {
      return present("preparation-failed", "FALHA", "A verificação de Data/Hora não pôde ser concluída. Recarregue a página antes dos atos críticos.");
    }
  }

  function appendTemporalPreflightLog() {
    if (temporalPreflightRecord) addLog(temporalPreflightRecord.message, temporalPreflightRecord.type);
  }

  function appendEnvironmentPreparationFailureLog() {
    if (environmentPreparationFailureRecord) {
      addLog(environmentPreparationFailureRecord.message, environmentPreparationFailureRecord.type);
    }
  }


  const offline = createOffline({
    expectedIdentity: RUNTIME_IDENTITY,
    coordination: operationCoordination,
    platform: Object.freeze({
      hasServiceWorker: () => "serviceWorker" in navigator,
      isSecureContext: () => window.isSecureContext,
      getRegistration: () => navigator.serviceWorker.getRegistration(),
      getController: () => navigator.serviceWorker.controller,
      register: (...args) => navigator.serviceWorker.register(...args),
      createMessageChannel: () => new MessageChannel(),
      schedule: (callback, milliseconds) => window.setTimeout(callback, milliseconds),
      clearSchedule: timeoutId => window.clearTimeout(timeoutId)
    }),
    ui: Object.freeze({ showToast })
  });

  async function initializeApplication() {
    renderEvidence();
    if (!initializeSecurityStatus()) {
      setCreateControlsLocked(false);
      byId("open-container").disabled = true;
      addLog("LDF Web bloqueado: ambiente criptográfico indisponível.", "error");
      return;
    }

    const [runtime, analysisRuntime, temporalReference, offlineReady] = await Promise.all([
      LDFCrypto.prepareRuntime(),
      LDFFileAnalysis.prepareRuntime(),
      LDFTemporal.initialReferencePromise.catch(() => null),
      offline.prepare()
    ]);
    temporalPreflightRecord = renderTemporalPreflight(temporalReference);
    appendTemporalPreflightLog();
    if (!offlineReady) throw new Error("O cache local exato não foi confirmado.");
    setRuntimeReady(true);
    const blockedByOther = await operationCoordination.blockedByOther();
    if (blockedByOther) {
      preparedStatusText = runtime.workerAvailable
        ? "Ambiente criptográfico preparado"
        : "Ambiente preparado com processamento local";
      setCoordinationBlocked(true);
      addLog("Operação bloqueada: outra aba mantém uma operação formal.", "warning");
      return;
    }
    setCreateControlsLocked(false);
    byId("container-input").disabled = false;
    byId("select-container").disabled = false;
    byId("replace-container").disabled = false;
    byId("open-container").disabled = false;
    const status = byId("secure-context-status");
    preparedStatusText = runtime.workerAvailable
      ? "Ambiente criptográfico preparado"
      : "Ambiente preparado com processamento local";
    status.textContent = preparedStatusText;
    status.dataset.prepared = "true";
    if (!analysisRuntime.available) {
      addLog("MediaInfo local indisponível nesta sessão; o fluxo principal permanece disponível.", "warning");
    }
    addLog("LDF Web inicializado com recursos locais preparados.");
  }

  operationCoordination.onChange(async () => {
    if (!state.runtimeReady) return;
    setCoordinationBlocked(await operationCoordination.blockedByOther());
  });

  document.querySelectorAll(".tab-button").forEach(button => button.addEventListener("click", () => switchTab(button.dataset.tab)));
  document.querySelectorAll(".toggle-secret").forEach(button => button.addEventListener("click", () => {
    const input = byId(button.dataset.target);
    input.type = input.type === "password" ? "text" : "password";
  }));
  for (const secretInput of [lotSecretInput, lotSecretConfirmInput, byId("audit-secret")]) {
    secretInput.addEventListener("blur", () => { secretInput.type = "password"; });
  }
  window.addEventListener("blur", maskSecretInputs);
  window.addEventListener("pagehide", maskSecretInputs);
  window.addEventListener("pageshow", maskSecretInputs);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) maskSecretInputs();
  });
  for (const cpfInput of [operatorCpfInput, byId("receiver-cpf")]) {
    cpfInput.addEventListener("input", () => { cpfInput.value = formatCpfInput(cpfInput.value); });
  }
  function liveFieldValidity(element) {
    const value = element.value.trim();
    switch (element.id) {
      case "lot-code": return /^[\p{L}\p{N}_-]{1,60}$/u.test(value);
      case "operator-name":
      case "receiver-name":
      case "meta-responsible": return window.LDFValidation.isValidPersonalName(element.value);
      case "operator-cpf":
      case "receiver-cpf": return isValidCpf(formatCpfInput(value));
      case "lot-secret":
      case "audit-secret": return element.value.length >= MIN_SECRET_LENGTH && element.value.length <= MAX_SECRET_LENGTH;
      case "lot-secret-confirm": return Boolean(element.value) && element.value === lotSecretInput.value;
      case "meta-datetime": {
        try {
          return window.LDFValidation.isCollectionDateTimeOnOrBefore(brazilianDateTimeToInput(value), localDateTime());
        } catch { return false; }
      }
      case "meta-id": return value.length >= 1 && value.length <= 80;
      case "meta-nature": return value.length >= 1 && value.length <= 120;
      case "meta-location": return value.length >= 1 && value.length <= 240;
      case "meta-description": return value.length >= 1 && value.length <= MAX_DESCRIPTION_LENGTH;
      case "meta-unavailability-reason": return value in PRIMARY_SOURCE_STATUS_LABELS;
      case "meta-unavailability": return byId("meta-unavailability-reason").value !== "other" || value.length >= 1;
      default: return true;
    }
  }
  const controlledFields = [
    "lot-code", "operator-name", "operator-cpf", "lot-secret", "lot-secret-confirm",
    "receiver-name", "receiver-cpf", "audit-secret", "meta-id", "meta-nature",
    "meta-responsible", "meta-datetime", "meta-location", "meta-description",
    "meta-unavailability-reason", "meta-unavailability"
  ];
  function refreshFieldError(element) {
    if (element.classList.contains("invalid")) setFieldValidity(element, liveFieldValidity(element));
  }
  // A quebra é visual: estes campos preservam a entrada e o Enter de uma linha.
  const textareaValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
  for (const field of document.querySelectorAll("textarea.scrollable-text-field")) {
    const stripLineBreaks = value => value.replace(/[\r\n]/g, "");
    // Atribuições de abertura/reaproveitamento também conservam a remoção de CR/LF.
    Object.defineProperty(field, "value", {
      configurable: true,
      enumerable: textareaValue.enumerable,
      get() { return textareaValue.get.call(this); },
      set(value) { textareaValue.set.call(this, stripLineBreaks(value === null ? "" : String(value))); }
    });
    field.addEventListener("input", () => {
      const value = field.value;
      if (!/[\r\n]/.test(value)) return;
      const start = stripLineBreaks(value.slice(0, field.selectionStart)).length;
      const end = stripLineBreaks(value.slice(0, field.selectionEnd)).length;
      field.value = stripLineBreaks(value);
      field.setSelectionRange(start, end);
    }, { capture: true });
    field.addEventListener("beforeinput", event => {
      if (["insertLineBreak", "insertParagraph"].includes(event.inputType)) event.preventDefault();
    });
    field.addEventListener("paste", event => {
      const text = event.clipboardData?.getData("text/plain");
      if (!text || !/[\r\n]/.test(text)) return;
      event.preventDefault();
      const available = Math.max(0, field.maxLength - (field.value.length - (field.selectionEnd - field.selectionStart)));
      field.setRangeText(stripLineBreaks(text).slice(0, available), field.selectionStart, field.selectionEnd, "end");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    field.addEventListener("keydown", event => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      const submit = field.form?.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
      if (submit && !submit.matches(":disabled")) submit.click();
    });
  }
  for (const id of controlledFields) {
    const element = byId(id);
    element.addEventListener("invalid", () => setFieldValidity(element, false));
    for (const eventName of ["input", "change"]) element.addEventListener(eventName, () => {
      refreshFieldError(element);
      if (id === "lot-secret") refreshFieldError(lotSecretConfirmInput);
      if (id === "meta-unavailability-reason") refreshFieldError(byId("meta-unavailability"));
      lot.discardReuseReference(id);
    });
    element.addEventListener("blur", () => {
      if ((element.value.trim() || element.classList.contains("invalid")) && !element.disabled && !element.closest("[hidden]")) setFieldValidity(element, liveFieldValidity(element));
    });
  }
  for (const sourceType of document.querySelectorAll('input[name="meta-source-type"]')) {
    sourceType.addEventListener("invalid", () => setFieldValidity(sourceType, false));
    sourceType.addEventListener("change", () => { setFieldValidity(sourceType, true); lot.discardReuseReference("meta-source-type"); });
  }
  for (const select of reuseControls) select.addEventListener("change", () => {
    if (select.value) lot.copyMetadataField(select.dataset.copyField, select.value);
    select.value = "";
    select.closest("details").open = false;
    select.closest("details").querySelector("summary").focus();
  });
  evidenceInput.addEventListener("change", async () => {
    if (evidenceInput.files.length && !await acquireFormalOperation()) {
      evidenceInput.value = "";
      return;
    }
    await addEvidenceFiles(evidenceInput.files);
  });
  evidenceList.addEventListener("click", event => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    if (button.dataset.action === "edit") openMetadata(button.dataset.id);
    if (button.dataset.action === "remove") removeEvidence(button.dataset.id);
    if (button.dataset.action === "file-info") {
      const item = state.evidence.find(entry => entry.id === button.dataset.id);
      if (item) openFileInfoDialog(item.file.name, item.analysis?.c2pa, item.analysis?.fileInfo);
    }
  });
  metadataForm.addEventListener("submit", reviewMetadata);
  byId("meta-unavailability-reason").addEventListener("change", event => {
    updateSourceDetailsVisibility(event.target.value, { focus: event.target.value === "other" });
  });
  metadataForm.addEventListener("input", updateQualificationProgress);
  metadataForm.addEventListener("change", updateQualificationProgress);
  byId("meta-datetime-picker").addEventListener("change", () => { applySelectedMetadataDateTime(); refreshFieldError(byId("meta-datetime")); });
  byId("meta-datetime").addEventListener("blur", synchronizeMetadataDateTimePicker);
  byId("meta-datetime-trigger").addEventListener("click", openMetadataDateTimePicker);
  byId("meta-photos").addEventListener("change", () => addMetadataPhotos(byId("meta-photos").files));
  byId("photo-list").addEventListener("click", event => {
    const button = event.target.closest("button[data-photo-remove]");
    if (!button) return;
    removeMetadataPhoto(button.dataset.photoRemove);
  });
  byId("meta-documents").addEventListener("change", () => addMetadataDocuments(byId("meta-documents").files));
  byId("document-list").addEventListener("click", event => {
    const button = event.target.closest("button[data-document-remove]");
    if (!button) return;
    removeMetadataDocument(button.dataset.documentRemove);
  });
  byId("close-metadata").addEventListener("click", closeMetadata);
  byId("cancel-metadata").addEventListener("click", closeMetadata);
  byId("close-metadata-review").addEventListener("click", closeMetadataReview);
  byId("back-to-metadata").addEventListener("click", closeMetadataReview);
  byId("confirm-metadata").addEventListener("click", saveMetadata);
  byId("close-file-info").addEventListener("click", closeFileInfoDialog);
  byId("dismiss-file-info").addEventListener("click", closeFileInfoDialog);
  byId("reveal-file-info-gps").addEventListener("click", event => {
    const gps = byId("file-info-gps");
    const reveal = gps.classList.contains("hidden");
    gps.classList.toggle("hidden", !reveal);
    event.currentTarget.setAttribute("aria-expanded", String(reveal));
    event.currentTarget.textContent = reveal ? "Ocultar localização registrada" : "Exibir localização registrada";
  });
  byId("generate-secret").addEventListener("click", () => { generateStrongSecret(); refreshFieldError(lotSecretInput); refreshFieldError(lotSecretConfirmInput); });
  const declarantDialog = byId("declarant-dialog");
  const sealDialog = byId("seal-dialog");
  byId("emit-document").addEventListener("click", event => {
    clearFieldErrors(byId("lot-form"));
    ui.openCreationDialog(declarantDialog, event.currentTarget, lotCodeInput);
  });
  byId("lot-form").addEventListener("submit", async event => {
    event.preventDefault();
    await generateInitialDeclaration();
    if (core.selectors.creationStages()[1].completed) { declarantDialog.close(); ui.visitCreationStage(3); }
    ui.renderCreationStages();
  });
  for (const id of ["close-declaration", "cancel-declaration"]) byId(id).addEventListener("click", () => declarantDialog.close());
  declarantDialog.addEventListener("close", () => ui.returnFromCreationDialog(declarantDialog));
  byId("begin-sealing").addEventListener("click", event => {
    clearFieldErrors(byId("seal-form"));
    ui.openCreationDialog(sealDialog, event.currentTarget, lotSecretInput, true);
  });
  byId("seal-form").addEventListener("submit", async event => {
    event.preventDefault();
    if (await prepareContainerPlan()) sealDialog.close();
    ui.renderCreationStages();
  });
  for (const id of ["close-seal", "cancel-seal"]) byId(id).addEventListener("click", () => sealDialog.close());
  sealDialog.addEventListener("close", () => ui.returnFromCreationDialog(sealDialog, true));
  signedInput.addEventListener("change", async () => { await selectSignedDeclaration(signedInput.files[0]); ui.renderCreationStages(); });
  byId("signed-label").addEventListener("click", event => { if (signedInput.disabled || routineState.active) event.preventDefault(); });
  byId("signed-label").addEventListener("keydown", event => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); if (!signedInput.disabled && !routineState.active) signedInput.click(); } });
  byId("add-first-file").addEventListener("click", () => { if (!evidenceInput.disabled) evidenceInput.click(); });
  document.querySelectorAll("[data-stage], [data-next-stage]").forEach(button => button.addEventListener("click", () => ui.visitCreationStage(Number(button.dataset.stage || button.dataset.nextStage))));
  byId("back-home").addEventListener("click", () => switchTab("home"));
  byId("save-container").addEventListener("click", savePendingContainer);
  byId("confirm-container-download").addEventListener("click", () => { confirmFallbackContainerDownload(); ui.renderCreationStages(); });
  byId("save-shipping-receipt").addEventListener("click", saveShippingReceipt);
  byId("reset-operation").addEventListener("click", resetOperation);
  byId("reset-audit").addEventListener("click", () => { resetAudit(); synchronizeCreationControls(); });
  byId("save-log-pdf").addEventListener("click", saveOperationTrailPdf);
  byId("clear-log").addEventListener("click", () => {
    state.logs.forEach(entry => { entry.visible = false; });
    operationLog.innerHTML = "";
  });
  const receivingDialog = byId("audit-receipt-dialog");
  let receivingTrigger = null;
  function openReceivingDialog(trigger) {
    if (routineState.active || !state.runtimeReady || !auditState.selectedContainer) return;
    clearReceivingSecret();
    clearFieldErrors(byId("audit-form"));
    receivingTrigger = trigger;
    byId("receipt-container-name").textContent = auditState.selectedContainer.name;
    receivingDialog.showModal();
    byId("receiver-name").focus({ preventScroll: true });
  }
  byId("select-container").addEventListener("click", () => { if (!routineState.active && !byId("container-input").disabled) byId("container-input").click(); });
  byId("replace-container").addEventListener("click", () => { if (!routineState.active && !byId("container-input").disabled) byId("container-input").click(); });
  byId("open-receipt").addEventListener("click", event => openReceivingDialog(event.currentTarget));
  byId("container-input").addEventListener("change", async event => {
    const file = event.target.files[0];
    if (!file || routineState.active) return;
    if (!file.name.toLowerCase().endsWith(".ldf")) { selectContainer(file); synchronizeCreationControls(); return; }
    if (!await acquireFormalOperation()) { event.target.value = ""; return; }
    if (selectContainer(file)) {
      byId("open-receipt").disabled = false;

    }
  });
  byId("audit-form").addEventListener("submit", async event => { if (await openAndAudit(event)) receivingDialog.close(); });
  for (const id of ["close-receipt", "cancel-receipt"]) byId(id).addEventListener("click", () => receivingDialog.close());
  receivingDialog.addEventListener("close", () => {
    clearReceivingSecret();
    if (receivingTrigger?.isConnected) receivingTrigger.focus({ preventScroll: true });
    receivingTrigger = null;
  });
  byId("audit-content").addEventListener("click", async event => {
    const infoButton = event.target.closest("button[data-file-info-index]");
    if (!infoButton) {
      await saveAuditDownload(event);
      return;
    }
    const downloadIndex = Number(infoButton.dataset.fileInfoIndex);
    const item = auditState.downloads[downloadIndex];
    if (!item?.mainEvidence) return;
    if (infoButton.dataset.c2paOnly === "true" || !item.integrityConvergent) {
      openFileInfoDialog(item.name, item.c2pa, item.fileInfo);
      return;
    }
    infoButton.disabled = true;
    if (!beginExclusiveRoutine(`consulta das informações de ${item.name}`)) {
      infoButton.disabled = false;
      return;
    }
    setActivityProgress("audit-progress", true, `Lendo informações técnicas de ${item.name}...`);
    try {
      const fileInfo = await analyzeAuditFile(downloadIndex);
      if (auditState.downloads[downloadIndex] === item) openFileInfoDialog(item.name, item.c2pa, fileInfo);
    } finally {
      setActivityProgress("audit-progress", false);
      endExclusiveRoutine();
      infoButton.disabled = false;
    }
  });

  initializeSessionDisclosures();
  initializeApplication().catch(() => {
    setRuntimeReady(false);
    setCreateControlsLocked(false);
    byId("open-container").disabled = true;
    byId("secure-context-status").textContent = "Falha na preparação do ambiente";
    byId("secure-context-status").classList.add("preparation-failed");
    environmentPreparationFailureRecord = Object.freeze({
      message: "O ambiente local não pôde ser preparado. Recarregue a página antes de tentar novamente.",
      type: "error"
    });
    appendEnvironmentPreparationFailureLog();
    showToast("Não foi possível preparar o ambiente local com segurança.", "error");
  });
})();
