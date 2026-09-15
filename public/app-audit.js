(function () {
  "use strict";

  const registry = window.__LDF_APP_MODULES__;
  if (!registry) throw new Error("Registro interno dos módulos da aplicação indisponível.");

  const HASH_CONVERGENT_STATUS = "HASH CONVERGENTE";
  const HASH_DIVERGENT_STATUS = "DIVERGENTE - VERIFICAR";

  function createAudit({
    store,
    routine,
    elements,
    ui: auditUi,
    fileIo: auditFileIo,
    cryptoApi,
    fileAnalysisApi,
    pdfApi,
    validationApi,
    temporal,
    selectors,
    transitions,
    domain,
    limits,
    confirmAction,
    reloadApplication
  }) {
    function c2paMessage(result) {
      if (result?.status === "detected") {
        return "Credencial C2PA detectada. O LDF não realiza validação da credencial.";
      }
      if (result?.status === "absent") {
        return "Nenhuma credencial C2PA foi detectada. Isso não indica autenticidade, edição ou origem por IA.";
      }
      return `Verificação C2PA indisponível. ${result?.reason || "Limite técnico ou formato não suportado."}`;
    }

    function c2paIndicator(result, downloadIndex) {
      const message = c2paMessage(result.c2pa);
      return `<button class="c2pa-indicator ${result.c2pa?.status === "detected" ? "detected" : "muted"}" type="button" data-file-info-index="${downloadIndex}" data-c2pa-only="true" data-tooltip="${auditUi.escapeHtml(message)}" aria-label="C2PA — ${auditUi.escapeHtml(message)}">C2PA</button>`;
    }
    async function ensureTemporalSession() {
      if (!store.temporalSession) {
        store.temporalSession = await temporal.startSession("abertura e auditoria");
      }
      return store.temporalSession;
    }

    function allFileHashesConverge(results) {
      return results.every(result => result.status === HASH_CONVERGENT_STATUS
        && result.photos.every(photo => photo.status === HASH_CONVERGENT_STATUS)
        && result.documents.every(documentResult => documentResult.status === HASH_CONVERGENT_STATUS));
    }

    function resetAudit() {
      if (routine.active) {
        const confirmed = confirmAction(
          `A rotina "${routine.label}" está em andamento. Reiniciar agora cancelará o processamento e descartará os dados não salvos. Deseja continuar?`
        );
        if (confirmed) reloadApplication();
        return;
      }
      const hasFormData = Boolean(
        elements.containerInput.files[0]
        || elements.receiverNameInput.value
        || elements.receiverCpfInput.value
        || elements.auditSecretInput.value
      );
      const hasResults = !elements.auditContent.classList.contains("hidden");
      if ((hasFormData || hasResults) && !confirmAction("Limpar os dados e os resultados da auditoria atual?")) return;

      elements.auditForm.reset();
      elements.auditSecretInput.type = "password";
      elements.auditSummary.textContent = "Aguardando um contêiner";
      auditUi.setActivityProgress("audit-progress", false);
      elements.auditContent.innerHTML = "";
      elements.auditContent.classList.add("hidden");
      elements.auditEmpty.classList.remove("hidden");
      transitions.clearAudit();
      auditUi.showToast("Auditoria reiniciada.");
    }

    function registerDownload(item, session) {
      return store.downloads.push({
        name: item.name,
        mimeType: item.mimeType,
        expectedHash: item.expectedHash,
        recordIndex: item.recordIndex,
        session,
        mainEvidence: Boolean(item.mainEvidence),
        integrityConvergent: item.status === HASH_CONVERGENT_STATUS,
        c2pa: item.c2pa ?? null,
        fileInfo: item.fileInfo ?? null
      }) - 1;
    }

    function createResultViewModel(result, session) {
      return {
        ...result,
        downloadIndex: registerDownload({ ...result, mainEvidence: true }, session),
        photos: result.photos.map(photo => ({
          ...photo,
          downloadIndex: registerDownload(photo, session)
        })),
        documents: result.documents.map(documentResult => ({
          ...documentResult,
          downloadIndex: registerDownload(documentResult, session)
        }))
      };
    }

    function renderAudit(manifest, results, declarationCheck, session, auditPdf, declarationBlockReason = "") {
      const evidenceOk = allFileHashesConverge(results);
      const photoCount = results.reduce((total, result) => total + result.photos.length, 0);
      const documentCount = results.reduce((total, result) => total + result.documents.length, 0);
      elements.auditEmpty.classList.add("hidden");
      elements.auditContent.classList.remove("hidden");
      if (!evidenceOk) {
        elements.auditSummary.textContent = "Foram encontradas divergências de hash";
      } else if (!declarationCheck.canonicalLotHashMatches) {
        elements.auditSummary.textContent = "Os arquivos têm hash convergente, mas o conjunto qualificado protegido diverge do manifesto";
      } else {
        elements.auditSummary.textContent = `${results.length} vestígio(s), ${photoCount} foto(s) e ${documentCount} documento(s) com hash convergente; a declaração exige conferência visual e validação externa`;
      }

      store.downloads = [];
      const resultViewModels = results.map(result => createResultViewModel(result, session));
      const signedDeclarationDownloadIndex = registerDownload({
        name: validationApi.reviewDeclarationFileName(manifest.lotCode),
        mimeType: manifest.signedDeclaration.mimeType,
        expectedHash: declarationCheck.signedDeclarationHash,
        recordIndex: manifest.signedDeclaration.recordIndex
      }, session);
      store.auditPdf = auditPdf;
      store.auditPdfName = `Declaracao_Recebimento_${domain.safeName(manifest.lotCode)}.pdf`;

      elements.auditContent.innerHTML = `
      <div class="audit-header">
        <div class="metric"><span>Lote</span><strong>${auditUi.escapeHtml(manifest.lotCode)}</strong></div>
        <div class="metric"><span>Declaração de registro</span><strong>${auditUi.escapeHtml(manifest.initialDocumentId)}</strong></div>
        <div class="metric"><span>Início do lacre e salvamento</span><strong>${auditUi.escapeHtml(manifest.sealedAt)}</strong></div>
      </div>
      <div class="declaration-checks" aria-label="Conferência da declaração de registro">
        <div class="declaration-check-row">
          <strong>Busca textual do identificador na declaração</strong>
          <span class="result-status ${declarationCheck.idMatches ? "" : "warning"}">${declarationCheck.idMatches ? "TEXTO LOCALIZADO — INDÍCIO" : "TEXTO NÃO LOCALIZADO"}</span>
        </div>
        <div class="declaration-check-row">
          <strong>Vínculo do conjunto qualificado</strong>
          <span class="result-status ${declarationCheck.lotHashMatches ? "" : "bad"}">${declarationCheck.lotHashMatches ? "HASH CANÔNICO CONFERE; TEXTO LOCALIZADO" : "HASH OU TEXTO DIVERGENTE"}</span>
        </div>
        <div class="declaration-check-row">
          <strong>Estruturas aparentes de assinatura digital</strong>
          <span class="result-status warning">${declarationCheck.signatureMarkersDetected ? "INDÍCIOS LOCALIZADOS" : "INDÍCIOS NÃO LOCALIZADOS"}</span>
        </div>
        <p class="declaration-check-note">Buscas textuais e marcadores aparentes não validam assinatura, autoria ou vínculo semântico. Confira visualmente a declaração e valide a assinatura no serviço VALIDAR do Governo Federal.</p>
      </div>
      <div class="result-list">
        ${resultViewModels.map(result => `
          <div class="result-row">
            <div class="result-file">
              <strong title="${auditUi.escapeHtml(result.name)}">${auditUi.escapeHtml(result.name)}</strong>
              <div class="auxiliary-controls">
                ${c2paIndicator(result, result.downloadIndex)}
                <button class="file-info-button" type="button" data-file-info-index="${result.downloadIndex}" ${result.status === HASH_CONVERGENT_STATUS ? "" : "disabled title=\"Disponível somente após hash convergente\""}>Informações do arquivo</button>
              </div>
            </div>
            <span class="result-status ${result.status === HASH_CONVERGENT_STATUS ? "" : "bad"}">${auditUi.escapeHtml(result.status)}</span>
            <div class="save-control">
              <button class="button secondary" type="button" data-download-index="${result.downloadIndex}">Salvar</button>
              <div class="inline-activity hidden" role="status" aria-label="Salvamento em andamento"><div class="activity-track" aria-hidden="true"><span></span></div></div>
            </div>
          </div>
          ${result.photos.map(photo => `
            <div class="result-row photo-result">
              <strong title="${auditUi.escapeHtml(photo.name)}">Foto complementar: ${auditUi.escapeHtml(photo.name)}</strong>
              <span class="result-status ${photo.status === HASH_CONVERGENT_STATUS ? "" : "bad"}">${auditUi.escapeHtml(photo.status)}</span>
              <div class="save-control">
                <button class="button secondary" type="button" data-download-index="${photo.downloadIndex}">Salvar</button>
                <div class="inline-activity hidden" role="status" aria-label="Salvamento em andamento"><div class="activity-track" aria-hidden="true"><span></span></div></div>
              </div>
            </div>
          `).join("")}
          ${result.documents.map(documentResult => `
            <div class="result-row document-result">
              <strong title="${auditUi.escapeHtml(documentResult.name)}">Documento complementar: ${auditUi.escapeHtml(documentResult.name)}</strong>
              <span class="result-status ${documentResult.status === HASH_CONVERGENT_STATUS ? "" : "bad"}">${auditUi.escapeHtml(documentResult.status)}</span>
              <div class="save-control">
                <button class="button secondary" type="button" data-download-index="${documentResult.downloadIndex}">Salvar</button>
                <div class="inline-activity hidden" role="status" aria-label="Salvamento em andamento"><div class="activity-track" aria-hidden="true"><span></span></div></div>
              </div>
            </div>
          `).join("")}
        `).join("")}
      </div>
      ${declarationBlockReason ? `<p class="declaration-check-note" role="alert">${auditUi.escapeHtml(declarationBlockReason)}</p>` : ""}
      <div class="audit-actions">
        <div class="save-control">
          <button class="button secondary" type="button" data-download-index="${signedDeclarationDownloadIndex}">Declaração de registro</button>
          <div class="inline-activity hidden" role="status" aria-label="Salvamento em andamento"><div class="activity-track" aria-hidden="true"><span></span></div></div>
        </div>
        ${auditPdf ? `
          <div class="save-control">
            <button class="button primary" type="button" id="download-audit-pdf">Declaração de recebimento</button>
            <div class="inline-activity hidden" role="status" aria-label="Salvamento em andamento"><div class="activity-track" aria-hidden="true"><span></span></div></div>
          </div>
        ` : ""}
      </div>
    `;
      elements.downloadAuditPdfButton()?.addEventListener("click", saveAuditPdf);
      if (declarationBlockReason) {
        auditUi.showToast(declarationBlockReason, "error");
      } else if (!evidenceOk || !declarationCheck.canonicalLotHashMatches) {
        auditUi.showToast("Auditoria concluída com divergência de hash.", "error");
      } else {
        auditUi.showToast("Hashes conferidos. Valide visualmente o PDF e a assinatura no serviço externo.", "warning");
      }
    }

    async function saveAuditPdf(event) {
      const button = event.currentTarget;
      const activity = button.closest(".save-control")?.querySelector(".inline-activity");
      button.disabled = true;
      if (!auditUi.beginExclusiveRoutine("salvamento da declaração de recebimento")) {
        button.disabled = false;
        return;
      }
      activity?.classList.remove("hidden");
      try {
        const saveResult = await auditFileIo.saveBlob(store.auditPdf, store.auditPdfName);
        if (saveResult === "cancelled") {
          auditUi.showToast("O salvamento da declaração de recebimento foi cancelado.", "warning");
        } else {
          auditUi.showToast("Revise e assine externamente a Declaração de Recebimento. Este documento não é enviado automaticamente para o remetente.");
        }
      } catch (error) {
        auditUi.showToast(auditUi.friendlyErrorMessage(error, "salvar a declaração de recebimento"), "error");
      } finally {
        activity?.classList.add("hidden");
        auditUi.endExclusiveRoutine();
        button.disabled = false;
      }
    }

    async function analyzeAuditFile(downloadIndex) {
      const item = store.downloads[downloadIndex];
      if (!item?.mainEvidence) throw new Error("Informações auxiliares não se aplicam a arquivo complementar.");
      if (!item.integrityConvergent) throw new Error("As informações auxiliares exigem hash convergente.");
      if (item.fileInfo?.status && item.fileInfo.status !== "pending") return item.fileInfo;
      item.fileInfo = { status: "pending" };
      try {
        const size = item.session.recordSize(item.recordIndex);
        const readRange = item.session.createRecordRangeReader(item.recordIndex);
        item.fileInfo = await fileAnalysisApi.analyzeRangeSource(size, readRange);
      } catch (error) {
        item.fileInfo = {
          status: "unavailable",
          reason: error instanceof Error ? error.message : "Análise local indisponível."
        };
      }
      return item.fileInfo;
    }

    async function openAndAudit(event) {
      event.preventDefault();
      if (!selectors.isRuntimeReady()) return auditUi.showToast("Aguarde a preparação do ambiente criptográfico.", "warning");
      const file = elements.containerInput.files[0];
      const receiverName = elements.receiverNameInput.value.trim();
      const receiverCpf = domain.formatCpfInput(elements.receiverCpfInput.value);
      const secret = elements.auditSecretInput.value;
      if (!file) return auditUi.showToast("Selecione um contêiner LDF Web.", "error");
      if (!file.name.toLowerCase().endsWith(".ldf")) {
        elements.containerInput.value = "";
        return auditUi.showToast("O arquivo selecionado não é um contêiner LDF Web.", "error");
      }
      if (receiverName.length < 3) return auditUi.showToast("Informe o nome completo do recebedor.", "error");
      if (!domain.isValidCpf(receiverCpf)) return auditUi.showToast("Informe um CPF válido para o recebedor.", "error");
      if (secret.length < limits.minSecretLength || secret.length > limits.maxSecretLength) {
        return auditUi.showToast(`A chave de acesso deve ter entre ${limits.minSecretLength} e ${limits.maxSecretLength} caracteres.`, "error");
      }
      try {
        await ensureTemporalSession();
        const openingTemporalSummary = temporal.requireCoherentSession("abrir o lote");
        if (openingTemporalSummary.degraded) {
          auditUi.showToast("Referência temporal auxiliar indisponível. A auditoria continuará localmente em contingência e sem quadro temporal na Declaração de Recebimento.", "warning");
        }
      } catch (error) {
        elements.auditSummary.textContent = "A abertura foi bloqueada pela referência temporal";
        return auditUi.showToast(auditUi.friendlyErrorMessage(error, "abrir o lote"), "error");
      }
      elements.auditSecretInput.value = "";
      elements.auditSecretInput.type = "password";
      elements.receiverCpfInput.value = receiverCpf;
      elements.openContainerButton.disabled = true;
      if (!auditUi.beginExclusiveRoutine("abertura e conferência do contêiner")) {
        elements.openContainerButton.disabled = !selectors.isRuntimeReady();
        return;
      }
      elements.auditSummary.textContent = "Autenticando contêiner protegido...";
      auditUi.setActivityProgress("audit-progress", true, "Autenticando contêiner protegido...");
      transitions.clearAuditDownloads();

      try {
        const session = await cryptoApi.openContainer(file, secret, message => {
          elements.auditSummary.textContent = message;
          auditUi.setActivityProgress("audit-progress", true, message);
        });
        const manifest = session.manifest;
        await validationApi.validateManifest(manifest, session, cryptoApi);
        const signedResult = await session.decryptRecordWithHash(manifest.signedDeclaration.recordIndex);
        if (signedResult.sha256 !== manifest.signedDeclaration.hash) {
          throw new Error("A declaração protegida diverge do SHA-256 registrado no manifesto.");
        }
        const signedPdfInspection = validationApi.inspectPdf(
          signedResult.buffer,
          [manifest.initialDocumentId, manifest.qualifiedLotHash]
        );
        const recalculatedQualifiedLotHash = await cryptoApi.sha256Canonical(
          validationApi.qualifiedLotRecordFromManifest(manifest)
        );
        const [idTextDetected, lotHashTextDetected] = signedPdfInspection.textMatches;
        const canonicalLotHashMatches = recalculatedQualifiedLotHash === manifest.qualifiedLotHash;
        const declarationCheck = {
          idMatches: idTextDetected,
          lotHashMatches: canonicalLotHashMatches && lotHashTextDetected,
          canonicalLotHashMatches,
          lotHashTextDetected,
          signatureMarkersDetected: signedPdfInspection.signatureMarkersDetected,
          signedDeclarationHash: manifest.signedDeclaration.hash
        };
        const results = [];

        for (let index = 0; index < manifest.evidence.length; index += 1) {
          const evidence = manifest.evidence[index];
          const progressMessage = `Conferindo ${index + 1} de ${manifest.evidence.length}: ${evidence.name}`;
          elements.auditSummary.textContent = progressMessage;
          auditUi.setActivityProgress("audit-progress", true, progressMessage);
          const inspection = await session.inspectRecord(evidence.recordIndex);
          const actualHash = inspection.sha256;
          const status = actualHash === evidence.hash ? HASH_CONVERGENT_STATUS : HASH_DIVERGENT_STATUS;
          const photoResults = [];
          for (const photo of evidence.metadata?.photos ?? []) {
            const photoHash = await session.hashRecord(photo.recordIndex);
            photoResults.push({
              name: photo.name,
              mimeType: photo.mimeType,
              recordIndex: photo.recordIndex,
              expectedHash: photo.hash,
              actualHash: photoHash,
              status: photoHash === photo.hash ? HASH_CONVERGENT_STATUS : HASH_DIVERGENT_STATUS
            });
          }
          const documentResults = [];
          for (const documentAttachment of evidence.metadata?.documents ?? []) {
            const documentHash = await session.hashRecord(documentAttachment.recordIndex);
            documentResults.push({
              name: documentAttachment.name,
              mimeType: documentAttachment.mimeType,
              recordIndex: documentAttachment.recordIndex,
              expectedHash: documentAttachment.hash,
              actualHash: documentHash,
              status: documentHash === documentAttachment.hash ? HASH_CONVERGENT_STATUS : HASH_DIVERGENT_STATUS
            });
          }
          results.push({
            name: evidence.name,
            mimeType: evidence.mimeType,
            recordIndex: evidence.recordIndex,
            expectedHash: evidence.hash,
            actualHash,
            status,
            c2pa: inspection.c2pa,
            photos: photoResults,
            documents: documentResults
          });
        }

        const receiver = { name: receiverName, cpf: receiverCpf };
        const openedAt = domain.localDateTime();
        let auditPdf = null;
        let declarationBlockReason = "";
        const hashesConverge = allFileHashesConverge(results)
          && declarationCheck.canonicalLotHashMatches;
        if (!hashesConverge) {
          declarationBlockReason = "A Declaração de Recebimento não foi emitida. Verifique os registros marcados como divergentes e a conferência do conjunto qualificado.";
        } else {
          try {
            const openingTemporalSummary = temporal.requireCoherentSession("emitir a Declaração de Recebimento");
            const auditDocumentId = domain.newDocumentId("REC");
            auditPdf = pdfApi.auditDeclaration({
              documentId: auditDocumentId,
              initialDocumentId: manifest.initialDocumentId,
              lotCode: manifest.lotCode,
              receiver,
              sealedAt: manifest.sealedAt,
              openedAt,
              sealingTemporalSummary: manifest.temporal?.sealing ?? null,
              openingTemporalSummary,
              declarationCheck,
              results: results.map(({ c2pa, ...result }) => result)
            });
          } catch (error) {
            declarationBlockReason = auditUi.friendlyErrorMessage(
              error,
              "emitir a Declaração de Recebimento"
            );
          }
        }
        renderAudit(manifest, results, declarationCheck, session, auditPdf, declarationBlockReason);
      } catch (error) {
        elements.auditSummary.textContent = "A abertura não foi concluída";
        auditUi.showToast(auditUi.friendlyErrorMessage(error, "abrir e conferir o lote"), "error");
      } finally {
        auditUi.setActivityProgress("audit-progress", false);
        auditUi.endExclusiveRoutine();
        elements.openContainerButton.disabled = !selectors.isRuntimeReady();
      }
    }

    async function saveAuditDownload(event) {
      const button = event.target.closest("button[data-download-index]");
      if (!button) return;
      const item = store.downloads[Number(button.dataset.downloadIndex)];
      if (!item) return;
      const activity = button.closest(".save-control")?.querySelector(".inline-activity");
      button.disabled = true;
      if (!auditUi.beginExclusiveRoutine(`salvamento de ${item.name}`)) {
        button.disabled = false;
        return;
      }
      activity?.classList.remove("hidden");
      try {
        const result = await auditFileIo.saveProtectedRecord(item);
        if (result === "cancelled") {
          auditUi.showToast("O salvamento do arquivo foi cancelado.", "warning");
        } else {
          auditUi.showToast(`Arquivo salvo: ${item.name}`);
        }
      } catch (error) {
        auditUi.showToast(auditUi.friendlyErrorMessage(error, "salvar o arquivo extraído"), "error");
      } finally {
        activity?.classList.add("hidden");
        auditUi.endExclusiveRoutine();
        button.disabled = false;
      }
    }

    return Object.freeze({ resetAudit, openAndAudit, saveAuditDownload, analyzeAuditFile });
  }

  registry.register("audit", createAudit);
})();
