(function () {
  "use strict";

  const registry = window.__LDF_APP_MODULES__;
  if (!registry) throw new Error("Registro interno dos módulos da aplicação indisponível.");

  function createLot({
    store,
    elements,
    ui: lotUi,
    cryptoApi,
    fileAnalysisApi,
    validationApi,
    temporalApi,
    selectors,
    domain,
    limits,
    sourceTypeLabels,
    primarySourceStatusLabels,
    confirmAction,
    randomUUID,
    createElement
  }) {
    function confirmLargeSelection(files, projectedBytes, projectedCount) {
      if (!files.length) return true;
      const reasons = [];
      const largestFile = files.reduce((largest, file) => Math.max(largest, file.size), 0);
      if (largestFile >= limits.largeFileWarningBytes) reasons.push(`há arquivo individual com ${domain.formatBytes(largestFile)}`);
      if (projectedBytes >= limits.largeLotWarningBytes) reasons.push(`o lote alcançará aproximadamente ${domain.formatBytes(projectedBytes)}`);
      if (projectedCount >= limits.largeLotWarningFiles) reasons.push(`o lote passará a conter ${projectedCount} arquivos`);
      if (!reasons.length) return true;
      return confirmAction(
        `Atenção ao volume do lote: ${reasons.join("; ")}. O processamento local em fluxo poderá levar mais tempo e exigir espaço livre suficiente no destino escolhido. Deseja continuar com a inclusão?`
      );
    }

    function temporalStatusText(status) {
      return {
        coherent: "sem divergência relevante detectada",
        "device-divergent": "horário do dispositivo divergente da referência inicial",
        "clock-changed": "alteração relevante do relógio detectada durante a sessão",
        "timezone-changed": "alteração de fuso ou offset detectada durante a sessão",
        "reference-unavailable": "referência temporal técnica indisponível"
      }[status] || "situação temporal não determinada";
    }

    function formatUtcOffset(minutes) {
      if (!Number.isFinite(minutes)) return "Não disponível";
      const sign = minutes >= 0 ? "+" : "-";
      const absolute = Math.abs(minutes);
      return `UTC${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
    }

    function c2paMessage(result) {
      if (result?.status === "detected") {
        return "Credencial C2PA detectada. O LDF não realiza validação da credencial.";
      }
      if (result?.status === "absent") {
        return "Nenhuma credencial C2PA foi detectada. Isso não indica autenticidade, edição ou origem por IA.";
      }
      return `Verificação C2PA indisponível. ${result?.reason || "Limite técnico ou formato não suportado."}`;
    }

    function c2paIndicator(item) {
      const result = item.analysis?.c2pa;
      const message = c2paMessage(result);
      return `<button class="c2pa-indicator ${result?.status === "detected" ? "detected" : "muted"}" type="button" data-action="file-info" data-c2pa-only="true" data-id="${item.id}" data-tooltip="${lotUi.escapeHtml(message)}" aria-label="C2PA — ${lotUi.escapeHtml(message)}">C2PA</button>`;
    }

    function evidenceHashReference(hash) {
      return `ref. SHA-256: ${String(hash).slice(0, 16)}…`;
    }

    /*
     * Os dados abaixo servem para conferência e transparência. Eles permanecem
     * separados da assinatura externa e nunca são apresentados como carimbo do tempo.
     */
    function temporalSummaryForDocument(session) {
      const summary = temporalApi?.summarize(session);
      if (!summary) return null;
      return {
        ...summary,
        statusText: temporalStatusText(summary.status),
        degraded: summary.status === "reference-unavailable",
        referenceTime: summary.referenceAvailable ? domain.localDateTimeFromIso(summary.referenceTimeIso) : "Não disponível",
        deviceStartTime: domain.localDateTimeFromIso(summary.sessionStartedAtDeviceIso),
        observedDeviceTime: domain.localDateTimeFromIso(summary.observedAtDeviceIso),
        initialUtcOffset: formatUtcOffset(summary.initialUtcOffsetMinutes),
        currentUtcOffset: formatUtcOffset(summary.currentUtcOffsetMinutes),
        initialDifferenceSeconds: Number.isFinite(summary.initialDifferenceMs)
          ? Math.round(summary.initialDifferenceMs / 1000)
          : null,
        clockChangeSeconds: Math.round(summary.clockChangeMs / 1000),
        referenceDifferenceSeconds: Number.isFinite(summary.referenceDifferenceMs)
          ? Math.round(summary.referenceDifferenceMs / 1000)
          : null
      };
    }

    function requireCoherentTemporalSession(session, action) {
      const summary = temporalSummaryForDocument(session);
      if (summary?.referenceAvailable === true && summary.status === "coherent") {
        return summary;
      }

      if (summary?.status === "reference-unavailable" && summary.referenceAvailable === false) {
        return summary;
      }

      const prefix = `Não é possível ${action}.`;
      if (!summary) {
        throw new Error(
          `${prefix} A situação temporal não foi iniciada. Recarregue a página e reinicie a operação.`
        );
      }
      if (summary.status === "device-divergent") {
        throw new Error(
          `${prefix} A data e a hora do dispositivo divergem da referência temporal auxiliar. Corrija o relógio, recarregue a página com conexão à internet e reinicie a operação.`
        );
      }
      if (summary.status === "clock-changed") {
        throw new Error(
          `${prefix} Foi detectada alteração relevante do relógio durante a operação. Recarregue a página com conexão à internet e reinicie a operação.`
        );
      }
      if (summary.status === "timezone-changed") {
        throw new Error(
          `${prefix} Foi detectada alteração de fuso horário ou offset UTC durante a operação. Restaure a configuração, recarregue a página e reinicie a operação.`
        );
      }
      throw new Error(
        `${prefix} A situação temporal não pôde ser confirmada. Recarregue a página com conexão à internet e reinicie a operação.`
      );
    }

    function appendLogEntry(message, type = "info", temporal = null) {
      if (store.logs.length >= limits.maxAuditEvents) return;
      if (store.logs.length === limits.maxAuditEvents - 1) {
        message = "A trilha atingiu o limite de 4.000 eventos; ocorrências posteriores não foram persistidas.";
        type = "warning";
      }
      const timestamp = domain.localDateTime();
      const compactTemporal = temporal ? (() => {
        const { lifecycleEvents = [], ...summaryWithoutEvents } = temporal;
        return { ...summaryWithoutEvents, lifecycleEventCount: lifecycleEvents.length };
      })() : null;
      const entry = {
        id: ++store.logSequence,
        timestamp,
        message,
        type,
        visible: true,
        temporal: compactTemporal
      };
      store.logs.push(entry);
      const line = createElement("div");
      line.className = `log-entry ${type}`;
      line.dataset.logId = String(entry.id);
      line.textContent = `[${timestamp}] ${message}`;
      elements.operationLog.append(line);
      elements.operationLog.scrollTop = elements.operationLog.scrollHeight;
    }

    function addLog(message, type = "info") {
      const temporal = temporalSummaryForDocument(store.temporalSession);
      if (temporal?.lifecycleEvents?.length > store.temporalLifecycleEventCount) {
        const unseenEvents = temporal.lifecycleEvents.slice(store.temporalLifecycleEventCount);
        const lifecycleMessages = {
          hidden: "A página foi ocultada durante a operação.",
          visible: "A página voltou a ficar visível durante a operação.",
          "page-hidden": "A página saiu de exibição durante a operação.",
          "page-restored": "A página foi restaurada durante a operação.",
          "page-shown": "A página foi reapresentada durante a operação.",
          "temporal-discontinuity": "Foi observada descontinuidade temporal relevante no retorno à página."
        };
        unseenEvents.forEach(event => {
          const lifecycleMessage = lifecycleMessages[event.type];
          if (lifecycleMessage) {
            appendLogEntry(
              lifecycleMessage,
              event.type === "temporal-discontinuity" ? "warning" : "info",
              temporal
            );
          }
        });
        store.temporalLifecycleEventCount = temporal.lifecycleEvents.length;
      }
      if (temporal && ["device-divergent", "clock-changed", "timezone-changed"].includes(temporal.status)
        && store.temporalAlertKey !== temporal.status) {
        store.temporalAlertKey = temporal.status;
        const warning = {
          "clock-changed": "Foi detectada alteração relevante no relógio do dispositivo durante a operação. Os horários serão preservados para conferência do operador.",
          "timezone-changed": "Foi detectada alteração de fuso horário ou offset UTC durante a operação. Confira a configuração antes de reiniciar.",
          "device-divergent": "O horário do dispositivo apresenta diferença relevante em relação à referência técnica inicial. Confira cuidadosamente as datas antes de assinar a declaração."
        }[temporal.status];
        appendLogEntry(warning, "warning", temporal);
        lotUi.showToast(warning, "warning");
      }
      appendLogEntry(message, type, temporal);
    }

    async function ensureCreationTemporalSession() {
      if (store.temporalSession) return store.temporalSession;
      store.temporalSession = await temporalApi.startSession("fechamento");
      const summary = temporalSummaryForDocument(store.temporalSession);
      if (!summary.referenceAvailable) {
        addLog("Referência temporal auxiliar indisponível. A operação continuará localmente em contingência; o quadro temporal será omitido dos documentos e a ausência permanecerá registrada nesta trilha.", "warning");
        lotUi.showToast("Referência temporal auxiliar indisponível. O fluxo continuará em contingência, sem quadro temporal nos documentos.", "warning");
      } else if (summary.status === "coherent") {
        addLog("Referência temporal técnica registrada para apoiar a conferência dos horários.");
      } else {
        addLog("Referência temporal técnica registrada com divergência a ser conferida pelo operador.", "warning");
      }
      return store.temporalSession;
    }

    function renderEvidence() {
      const hasEvidence = store.evidence.length > 0;
      elements.evidenceEmpty.classList.toggle("hidden", hasEvidence);
      elements.evidenceList.classList.toggle("hidden", !hasEvidence);
      elements.evidenceCount.textContent = hasEvidence
        ? `${store.evidence.length} vestígio(s) • ${domain.formatBytes(selectors.totalLotBytes())}`
        : "Nenhum arquivo incluído";

      elements.evidenceList.innerHTML = store.evidence.map(item => `
        <article class="evidence-item">
          <div class="evidence-main">
            <div class="evidence-title-line">
              <strong title="${lotUi.escapeHtml(item.file.name)}">${lotUi.escapeHtml(item.file.name)}</strong>
              ${c2paIndicator(item)}
              <button class="file-info-button" type="button" data-action="file-info" data-id="${item.id}">Informações do arquivo</button>
            </div>
            <div class="evidence-meta">
              <span>${domain.formatBytes(item.file.size)}</span>
              <span class="hash" title="${item.hash}">SHA-256 ${item.hash.slice(0, 18)}…</span>
              <span class="badge ${item.metadata ? "ok" : "pending"}">${item.metadata ? "QUALIFICADO" : "PENDENTE"}</span>
              ${item.metadata?.photos?.length ? `<span>${item.metadata.photos.length} foto(s) complementar(es)</span>` : ""}
              ${item.metadata?.documents?.length ? `<span>${item.metadata.documents.length} documento(s) complementar(es)</span>` : ""}
            </div>
          </div>
          <div class="evidence-actions">
            <button class="icon-button" type="button" data-action="edit" data-id="${item.id}" title="Qualificar vestígio" aria-label="Qualificar ${lotUi.escapeHtml(item.file.name)}" ${store.locked ? "disabled" : ""}>
              <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>
            </button>
            <button class="icon-button" type="button" data-action="remove" data-id="${item.id}" title="Remover vestígio" aria-label="Remover ${lotUi.escapeHtml(item.file.name)}" ${store.locked ? "disabled" : ""}>
              <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>
            </button>
          </div>
        </article>
      `).join("");
    }

    async function addEvidenceFiles(files) {
      if (store.locked || !store.runtimeReady) {
        elements.evidenceInput.value = "";
        lotUi.showToast("Aguarde a preparação do ambiente antes de adicionar arquivos.", "warning");
        return;
      }
      const selected = Array.from(files);
      const existing = new Set(store.evidence.map(item => `${item.file.name}|${item.file.size}|${item.file.lastModified}`));
      const uniqueSelected = selected.filter(file => !existing.has(`${file.name}|${file.size}|${file.lastModified}`));
      if (store.evidence.length + uniqueSelected.length > limits.maxEvidence) {
        elements.evidenceInput.value = "";
        lotUi.showToast(`O lote aceita no máximo ${limits.maxEvidence} vestígios. Nenhum arquivo desta seleção foi lido.`, "error");
        return;
      }
      try {
        uniqueSelected.forEach(file => validationApi.requireSafeFileName(file.name));
      } catch (error) {
        elements.evidenceInput.value = "";
        lotUi.showToast(lotUi.friendlyErrorMessage(error, "validar os nomes dos arquivos selecionados"), "error");
        return;
      }
      const currentTotal = selectors.totalLotBytes();
      const newTotal = uniqueSelected.reduce((total, file) => total + file.size, currentTotal);
      if (!confirmLargeSelection(uniqueSelected, newTotal, selectors.totalLotFileCount() + uniqueSelected.length)) {
        elements.evidenceInput.value = "";
        return;
      }

      if (uniqueSelected.length && !lotUi.beginExclusiveRoutine("cálculo dos hashes dos vestígios")) {
        elements.evidenceInput.value = "";
        return;
      }
      if (uniqueSelected.length) lotUi.setActivityProgress("operation-progress", true, "Calculando os resumos SHA-256...");
      try {
        if (uniqueSelected.length) await ensureCreationTemporalSession();
        for (const file of selected) {
          const identity = `${file.name}|${file.size}|${file.lastModified}`;
          if (existing.has(identity)) {
            addLog("Arquivo duplicado ignorado.", "warning");
            continue;
          }
          try {
            const progressMessage = `Calculando SHA-256 de ${file.name}...`;
            lotUi.setActivityProgress("operation-progress", true, progressMessage);
            addLog("Cálculo SHA-256 iniciado para um vestígio.");
            const inspection = await cryptoApi.inspectBlob(file);
            const hash = inspection.sha256;
            store.evidence.push({
              id: randomUUID(),
              file,
              hash,
              metadata: null,
              analysis: {
                c2pa: inspection.c2pa,
                fileInfo: { status: "pending" }
              }
            });
            existing.add(identity);
            addLog(`Vestígio incluído e fixado ao hash | ${evidenceHashReference(hash)}`);
            renderEvidence();
            const item = store.evidence[store.evidence.length - 1];
            try {
              lotUi.setActivityProgress("operation-progress", true, `Lendo informações técnicas de ${file.name}...`);
              item.analysis.fileInfo = await fileAnalysisApi.analyzeFile(file);
            } catch (error) {
              item.analysis.fileInfo = {
                status: "unavailable",
                reason: error instanceof Error ? error.message : "Análise local indisponível."
              };
            }
            renderEvidence();
          } catch (error) {
            addLog("Um vestígio não pôde ser processado e não foi incluído.", "error");
            lotUi.showToast(lotUi.friendlyErrorMessage(error, `processar o arquivo "${file.name}"`), "error");
          }
        }
      } finally {
        lotUi.setActivityProgress("operation-progress", false);
        elements.evidenceInput.value = "";
        if (uniqueSelected.length) lotUi.endExclusiveRoutine();
      }
    }

    const SOURCE_TYPE_PREFIX = "Forma de obtenção: ";
    const PRIMARY_SOURCE_PREFIX = "Situação da fonte primária: ";
    const SOURCE_DETAILS_PREFIX = "Informações complementares: ";
    const SOURCE_DETAILS_HIDDEN_STATUSES = new Set(["accompanies", "not-applicable"]);

    function selectedSourceType() {
      return elements.metaSourceTypes.find(input => input.checked)?.value ?? "";
    }

    function serializeSourceInformation(sourceType, status, details) {
      const lines = [
        `${SOURCE_TYPE_PREFIX}${sourceTypeLabels[sourceType]}.`,
        `${PRIMARY_SOURCE_PREFIX}${primarySourceStatusLabels[status]}.`
      ];
      if (details) lines.push(`${SOURCE_DETAILS_PREFIX}${details}`);
      return lines.join("\n");
    }

    function parseSourceInformation(value) {
      const text = String(value ?? "").trim();
      if (!text.includes(SOURCE_TYPE_PREFIX) || !text.includes(PRIMARY_SOURCE_PREFIX)) {
        return { sourceType: "", details: text };
      }
      const sourceType = Object.entries(sourceTypeLabels)
        .find(([, label]) => text.includes(`${SOURCE_TYPE_PREFIX}${label}.`))?.[0] ?? "";
      const detailStart = text.indexOf(SOURCE_DETAILS_PREFIX);
      return {
        sourceType,
        details: detailStart >= 0 ? text.slice(detailStart + SOURCE_DETAILS_PREFIX.length).trim() : ""
      };
    }

    function setQualificationStatus(block, status) {
      const item = elements.qualificationStatuses.find(entry => entry.dataset.statusBlock === String(block));
      if (!item) return;
      item.classList.remove("pending", "in-progress", "complete", "optional");
      item.classList.add(status);
      const statusText = item.querySelector(".status-text");
      statusText.textContent = {
        pending: "Pendente",
        "in-progress": "Em preenchimento",
        complete: "Concluído",
        optional: "Opcional"
      }[status];
    }

    function qualificationBlockState(values, requiredValues = values) {
      const hasAny = values.some(value => String(value ?? "").trim());
      const complete = requiredValues.every(value => String(value ?? "").trim());
      if (complete) return "complete";
      return hasAny ? "in-progress" : "pending";
    }

    function updateQualificationProgress() {
      const status = elements.metaUnavailabilityReason.value;
      const details = elements.metaUnavailability.value;
      const blockStates = [
        qualificationBlockState([elements.metaId.value, elements.metaNature.value]),
        qualificationBlockState([
          elements.metaResponsible.value,
          elements.metaDateTime.value,
          elements.metaLocation.value
        ]),
        qualificationBlockState(
          [selectedSourceType(), elements.metaDescription.value, status, details],
          [selectedSourceType(), elements.metaDescription.value, status, status === "other" ? details : "not-required"]
        )
      ];
      blockStates.forEach((state, index) => setQualificationStatus(index + 1, state));
      const hasAttachments = store.editingPhotos.length + store.editingDocuments.length > 0;
      setQualificationStatus(4, hasAttachments ? "complete" : "optional");
      const completed = blockStates.filter(state => state === "complete").length;
      elements.qualificationCompletionSummary.textContent = completed === 3
        ? "3 de 3 blocos obrigatórios concluídos · pronto para revisão"
        : `${completed} de 3 blocos obrigatórios concluídos · campos com * são obrigatórios`;
      elements.qualificationCompletionSummary.classList.toggle("complete", completed === 3);
    }

    function updateSourceDetailsVisibility(status = elements.metaUnavailabilityReason.value, options = {}) {
      const hidden = !status || SOURCE_DETAILS_HIDDEN_STATUSES.has(status);
      const required = status === "other";
      elements.sourceDetailsField.hidden = hidden;
      elements.metaUnavailability.disabled = hidden;
      elements.metaUnavailability.required = required;
      elements.sourceDetailsRequired.hidden = !required;
      elements.sourceDetailsOptional.hidden = required;
      if (hidden && options.preserveValue !== true) elements.metaUnavailability.value = "";
      updateQualificationProgress();
      if (required && options.focus === true) elements.metaUnavailability.focus();
    }

    function openMetadata(itemId) {
      const item = store.evidence.find(entry => entry.id === itemId);
      if (!item || store.locked) return;
      store.editingEvidenceId = itemId;
      const metadata = item.metadata ?? {};
      store.editingPhotos = (metadata.photos ?? []).map(photo => ({ ...photo }));
      store.editingDocuments = (metadata.documents ?? []).map(document => ({ ...document }));
      elements.metadataFileName.textContent = item.file.name;
      elements.metaId.value = metadata.id ?? `VEST-${String(store.evidence.indexOf(item) + 1).padStart(3, "0")}`;
      elements.metaNature.value = metadata.nature ?? "";
      elements.metaResponsible.value = metadata.responsible ?? elements.operatorNameInput.value.trim();
      const inputDateTime = metadata.inputDateTime ?? domain.dateTimeInputValue();
      elements.metaDateTime.value = domain.inputDateToBrazilian(inputDateTime);
      elements.metaDateTimePicker.value = inputDateTime;
      elements.metaLocation.value = metadata.location ?? "";
      elements.metaDescription.value = metadata.description ?? "";
      const sourceInformation = parseSourceInformation(metadata.unavailability);
      elements.metaSourceTypes.forEach(input => { input.checked = input.value === sourceInformation.sourceType; });
      let status = metadata.unavailabilityReason ?? "";
      if (status === "cloud-data") status = "remote-content";
      if (!(status in primarySourceStatusLabels)) status = "";
      elements.metaUnavailabilityReason.value = status;
      elements.metaUnavailability.value = sourceInformation.details;
      updateSourceDetailsVisibility(status, { preserveValue: true });
      renderMetadataPhotos();
      renderMetadataDocuments();
      updateQualificationProgress();
      elements.metadataDialog.showModal();
    }

    function applySelectedMetadataDateTime() {
      if (!elements.metaDateTimePicker.value) return;
      const selectedValue = elements.metaDateTimePicker.value;
      const canonicalValue = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(selectedValue)
        ? `${selectedValue}:00`
        : selectedValue;
      elements.metaDateTime.value = domain.inputDateToBrazilian(canonicalValue);
    }

    function synchronizeMetadataDateTimePicker() {
      try {
        elements.metaDateTimePicker.value = domain.brazilianDateTimeToInput(elements.metaDateTime.value.trim());
      } catch {
        // A validação completa e a mensagem ao operador permanecem no envio do formulário.
      }
    }

    function openMetadataDateTimePicker() {
      synchronizeMetadataDateTimePicker();
      const picker = elements.metaDateTimePicker;
      if (typeof picker.showPicker === "function") {
        try {
          picker.showPicker();
          return;
        } catch (error) {
          const fallbackErrors = new Set([
            "InvalidStateError",
            "NotAllowedError",
            "NotSupportedError",
            "SecurityError"
          ]);
          if (!fallbackErrors.has(String(error?.name || ""))) throw error;
        }
      }
      picker.focus({ preventScroll: true });
      picker.click();
    }

    function closeMetadata() {
      if (elements.metadataReviewDialog.open) elements.metadataReviewDialog.close();
      store.editingEvidenceId = null;
      store.editingPhotos = [];
      store.editingDocuments = [];
      elements.metaPhotos.value = "";
      elements.metaDocuments.value = "";
      elements.metadataDialog.close();
    }

    function closeMetadataReview() {
      if (!elements.metadataReviewDialog.open) return;
      elements.metadataReviewDialog.close();
      elements.metadataDialog.querySelector('button[type="submit"]')?.focus({ preventScroll: true });
    }

    function renderMetadataPhotos() {
      const count = store.editingPhotos.length;
      elements.photoCount.textContent = count ? `${count} imagem(ns) selecionada(s)` : "Nenhuma imagem selecionada";
      elements.photoAddLabel.classList.toggle("disabled", count >= limits.maxPhotosPerEvidence);
      elements.photoList.innerHTML = store.editingPhotos.map(photo => `
        <div class="photo-item">
          <div>
            <strong title="${lotUi.escapeHtml(photo.file.name)}">${lotUi.escapeHtml(photo.file.name)}</strong>
            <small title="${photo.hash}">SHA-256 ${photo.hash.slice(0, 24)}…</small>
          </div>
          <button class="icon-button" type="button" data-photo-remove="${photo.id}" title="Remover imagem" aria-label="Remover ${lotUi.escapeHtml(photo.file.name)}">
            <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>
          </button>
        </div>
      `).join("");
      updateQualificationProgress();
    }

    async function addMetadataPhotos(files) {
      const existing = new Set(store.editingPhotos.map(photo => `${photo.file.name}|${photo.file.size}|${photo.file.lastModified}`));
      const selected = Array.from(files).filter(file => file.type.startsWith("image/"));
      const availableSlots = limits.maxPhotosPerEvidence - store.editingPhotos.length;
      if (selected.length > availableSlots) {
        elements.metaPhotos.value = "";
        lotUi.showToast(`Selecione no máximo ${availableSlots} imagem(ns) complementar(es). Nenhum arquivo desta seleção foi lido.`, "warning");
        return;
      }
      const uniqueSelected = selected.filter(file => !existing.has(`${file.name}|${file.size}|${file.lastModified}`));
      try {
        uniqueSelected.forEach(file => validationApi.requireSafeFileName(file.name));
      } catch (error) {
        elements.metaPhotos.value = "";
        lotUi.showToast(lotUi.friendlyErrorMessage(error, "validar os nomes das imagens selecionadas"), "error");
        return;
      }
      const accepted = uniqueSelected;
      const currentEditingPhotoBytes = store.editingPhotos.reduce((total, photo) => total + photo.file.size, 0);
      const currentEditingDocumentBytes = store.editingDocuments.reduce((total, document) => total + document.file.size, 0);
      const projectedBytes = accepted.reduce((total, file) => total + file.size, selectors.totalLotBytesWithoutEditingAttachments() + currentEditingPhotoBytes + currentEditingDocumentBytes);
      const projectedCount = selectors.totalLotFileCountWithoutEditingAttachments() + store.editingPhotos.length + store.editingDocuments.length + accepted.length;

      if (!confirmLargeSelection(accepted, projectedBytes, projectedCount)) {
        elements.metaPhotos.value = "";
        return;
      }

      if (accepted.length && !lotUi.beginExclusiveRoutine("cálculo dos hashes das imagens complementares")) {
        elements.metaPhotos.value = "";
        return;
      }
      if (accepted.length) lotUi.setActivityProgress("operation-progress", true, "Calculando SHA-256 das imagens complementares...");
      try {
        for (const file of accepted) {
          const identity = `${file.name}|${file.size}|${file.lastModified}`;
          try {
            lotUi.setActivityProgress("operation-progress", true, `Calculando SHA-256 de ${file.name}...`);
            const hash = await cryptoApi.sha256Blob(file);
            store.editingPhotos.push({ id: randomUUID(), file, hash });
            existing.add(identity);
          } catch (error) {
            lotUi.showToast(lotUi.friendlyErrorMessage(error, `processar a imagem complementar "${file.name}"`), "error");
          }
        }
      } finally {
        lotUi.setActivityProgress("operation-progress", false);
        if (accepted.length) lotUi.endExclusiveRoutine();
      }

      elements.metaPhotos.value = "";
      renderMetadataPhotos();
      if (store.editingPhotos.length >= limits.maxPhotosPerEvidence) {
        lotUi.showToast(`Limite de ${limits.maxPhotosPerEvidence} imagens complementares atingido.`, "warning");
      }
    }

    function renderMetadataDocuments() {
      const count = store.editingDocuments.length;
      elements.documentCount.textContent = count ? `${count} documento(s) selecionado(s)` : "Nenhum documento selecionado";
      elements.documentAddLabel.classList.toggle("disabled", count >= limits.maxDocumentsPerEvidence);
      elements.documentList.innerHTML = store.editingDocuments.map(document => `
        <div class="document-item">
          <div>
            <strong title="${lotUi.escapeHtml(document.file.name)}">${lotUi.escapeHtml(document.file.name)}</strong>
            <small title="${document.hash}">SHA-256 ${document.hash.slice(0, 24)}…</small>
          </div>
          <button class="icon-button" type="button" data-document-remove="${document.id}" title="Remover documento" aria-label="Remover ${lotUi.escapeHtml(document.file.name)}">
            <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>
          </button>
        </div>
      `).join("");
      updateQualificationProgress();
    }

    async function hasValidPdfEnvelope(file) {
      if (file.size > validationApi.MAX_PDF_BYTES) return false;
      try {
        validationApi.requireSafeFileName(file.name, ".pdf");
        validationApi.inspectPdf(await file.arrayBuffer());
        return true;
      } catch {
        return false;
      }
    }

    async function addMetadataDocuments(files) {
      const existing = new Set(store.editingDocuments.map(document => `${document.file.name}|${document.file.size}|${document.file.lastModified}`));
      const selected = Array.from(files);
      const availableSlots = limits.maxDocumentsPerEvidence - store.editingDocuments.length;
      if (selected.length > availableSlots) {
        elements.metaDocuments.value = "";
        lotUi.showToast(`Selecione no máximo ${availableSlots} documento(s) complementar(es). Nenhum arquivo desta seleção foi lido.`, "warning");
        return;
      }
      const valid = [];
      const rejected = [];
      for (const file of selected) {
        if (await hasValidPdfEnvelope(file)) valid.push(file);
        else rejected.push(file.name);
      }

      const uniqueSelected = valid.filter(file => !existing.has(`${file.name}|${file.size}|${file.lastModified}`));
      const accepted = uniqueSelected;
      const currentEditingPhotoBytes = store.editingPhotos.reduce((total, photo) => total + photo.file.size, 0);
      const currentEditingDocumentBytes = store.editingDocuments.reduce((total, document) => total + document.file.size, 0);
      const projectedBytes = accepted.reduce((total, file) => total + file.size, selectors.totalLotBytesWithoutEditingAttachments() + currentEditingPhotoBytes + currentEditingDocumentBytes);
      const projectedCount = selectors.totalLotFileCountWithoutEditingAttachments() + store.editingPhotos.length + store.editingDocuments.length + accepted.length;

      if (!confirmLargeSelection(accepted, projectedBytes, projectedCount)) {
        elements.metaDocuments.value = "";
        return;
      }
      if (accepted.length && !lotUi.beginExclusiveRoutine("cálculo dos hashes dos documentos complementares")) {
        elements.metaDocuments.value = "";
        return;
      }
      if (accepted.length) lotUi.setActivityProgress("operation-progress", true, "Calculando SHA-256 dos documentos complementares...");
      try {
        for (const file of accepted) {
          try {
            lotUi.setActivityProgress("operation-progress", true, `Calculando SHA-256 de ${file.name}...`);
            const hash = await cryptoApi.sha256Blob(file);
            store.editingDocuments.push({ id: randomUUID(), file, hash });
          } catch (error) {
            lotUi.showToast(lotUi.friendlyErrorMessage(error, `processar o documento complementar "${file.name}"`), "error");
          }
        }
      } finally {
        lotUi.setActivityProgress("operation-progress", false);
        if (accepted.length) lotUi.endExclusiveRoutine();
      }

      elements.metaDocuments.value = "";
      renderMetadataDocuments();
      if (rejected.length) {
        lotUi.showToast("Um ou mais arquivos foram ignorados porque não são documentos PDF válidos.", "warning");
      }
      if (store.editingDocuments.length >= limits.maxDocumentsPerEvidence) {
        lotUi.showToast(`Limite de ${limits.maxDocumentsPerEvidence} documentos complementares atingido.`, "warning");
      }
    }

    function collectMetadataValues() {
      const item = store.evidence.find(entry => entry.id === store.editingEvidenceId);
      if (!item) return null;
      const displayedDateTime = elements.metaDateTime.value.trim();
      const sourceType = selectedSourceType();
      const sourceStatus = elements.metaUnavailabilityReason.value;
      const sourceDetails = elements.metaUnavailability.value.trim();
      const values = {
        id: elements.metaId.value.trim(),
        nature: elements.metaNature.value.trim(),
        responsible: elements.metaResponsible.value.trim(),
        location: elements.metaLocation.value.trim(),
        description: elements.metaDescription.value.trim(),
        unavailabilityReason: sourceStatus,
        unavailability: ""
      };
      const sourceDetailsRequired = sourceStatus === "other";
      if (!displayedDateTime || !sourceType || !sourceStatus || (sourceDetailsRequired && !sourceDetails)
        || [values.id, values.nature, values.responsible, values.location, values.description].some(value => !value)) {
        lotUi.showToast("Todos os campos da qualificação são obrigatórios.", "error");
        return null;
      }
      values.unavailability = serializeSourceInformation(sourceType, sourceStatus, sourceDetails);
      if (values.id.length > 80 || values.nature.length > 120 || values.responsible.length > 120
        || values.location.length > 240 || values.description.length > limits.maxDescriptionLength
        || values.unavailability.length > limits.maxUnavailabilityLength) {
        lotUi.showToast("Um ou mais campos da qualificação excedem o limite permitido.", "error");
        return null;
      }
      try {
        values.inputDateTime = domain.brazilianDateTimeToInput(displayedDateTime);
        values.dateTime = domain.inputDateToBrazilian(values.inputDateTime);
        elements.metaDateTimePicker.value = values.inputDateTime;
      } catch (error) {
        lotUi.showToast(lotUi.friendlyErrorMessage(error, "validar a data e a hora informadas"), "error");
        return null;
      }
      return { item, values, sourceType, sourceStatus, sourceDetails };
    }

    function renderMetadataReview(review) {
      const setText = (element, value) => { element.textContent = value; };
      setText(elements.metadataReviewFileName, review.item.file.name);
      setText(elements.reviewMetaId, review.values.id);
      setText(elements.reviewMetaNature, review.values.nature);
      setText(elements.reviewMetaResponsible, review.values.responsible);
      setText(elements.reviewMetaDateTime, review.values.dateTime);
      setText(elements.reviewMetaLocation, review.values.location);
      setText(elements.reviewMetaSourceType, sourceTypeLabels[review.sourceType]);
      setText(elements.reviewMetaSourceStatus, primarySourceStatusLabels[review.sourceStatus]);
      elements.reviewMetaSourceDetailsRow.hidden = !review.sourceDetails;
      setText(elements.reviewMetaSourceDetails, review.sourceDetails);
      setText(elements.reviewMetaDescription, review.values.description);
      setText(
        elements.reviewMetaPhotos,
        store.editingPhotos.length
          ? `${store.editingPhotos.length} — ${store.editingPhotos.map(photo => photo.file.name).join(", ")}`
          : "Nenhuma fotografia selecionada"
      );
      setText(
        elements.reviewMetaDocuments,
        store.editingDocuments.length
          ? `${store.editingDocuments.length} — ${store.editingDocuments.map(document => document.file.name).join(", ")}`
          : "Nenhum documento selecionado"
      );
    }

    function reviewMetadata(event) {
      event?.preventDefault();
      const review = collectMetadataValues();
      if (!review) return;
      renderMetadataReview(review);
      if (!elements.metadataReviewDialog.open) elements.metadataReviewDialog.showModal();
    }

    function saveMetadata(event) {
      event?.preventDefault();
      const review = collectMetadataValues();
      if (!review) return;
      const { item, values } = review;
      item.metadata = {
        ...values,
        photos: store.editingPhotos.map(photo => ({ ...photo })),
        documents: store.editingDocuments.map(document => ({ ...document }))
      };
      const photoSummary = store.editingPhotos.length ? ` | ${store.editingPhotos.length} foto(s) complementar(es)` : "";
      const documentSummary = store.editingDocuments.length ? ` | ${store.editingDocuments.length} documento(s) complementar(es)` : "";
      addLog(`Qualificação gravada para o vestígio | ${evidenceHashReference(item.hash)}${photoSummary}${documentSummary}.`);
      renderEvidence();
      closeMetadata();
    }

    function removeEvidence(itemId) {
      const item = store.evidence.find(entry => entry.id === itemId);
      if (!item || !confirmAction(`Remover "${item.file.name}" do lote?`)) return;
      store.evidence = store.evidence.filter(entry => entry.id !== item.id);
      addLog(`Vestígio removido do lote | ${evidenceHashReference(item.hash)}`, "warning");
      renderEvidence();
    }

    function removeMetadataPhoto(photoId) {
      store.editingPhotos = store.editingPhotos.filter(photo => photo.id !== photoId);
      renderMetadataPhotos();
    }

    function removeMetadataDocument(documentId) {
      store.editingDocuments = store.editingDocuments.filter(document => document.id !== documentId);
      renderMetadataDocuments();
    }

    return Object.freeze({
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
    });
  }

  registry.register("lot", createLot);
})();
