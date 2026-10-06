(function () {
  "use strict";

  const registry = window.__LDF_APP_MODULES__;
  if (!registry) throw new Error("Registro interno dos módulos da aplicação indisponível.");

  function createSealing({
    store,
    elements,
    ui: sealingUi,
    lot: lotController,
    temporal: sealingTemporal,
    fileIo: sealingFileIo,
    cryptoApi,
    pdfApi,
    validationApi,
    selectors,
    sourceTypeLabels,
    primarySourceStatusLabels,
    transitions,
    domain,
    limits
  }) {
    function getValidatedRegistrationData() {
      if (!store.runtimeReady) throw new Error("Aguarde a preparação do ambiente criptográfico.");
      const lotCode = elements.lotCodeInput.value.trim();
      const operatorName = validationApi.normalizePersonalName(elements.operatorNameInput.value);
      const operatorCpf = domain.formatCpfInput(elements.operatorCpfInput.value);

      sealingUi.validateFields?.([
        [elements.lotCodeInput, /^[\p{L}\p{N}_-]{1,60}$/u.test(lotCode)],
        [elements.operatorNameInput, validationApi.isValidPersonalName(elements.operatorNameInput.value)],
        [elements.operatorCpfInput, domain.isValidCpf(operatorCpf)]
      ]);
      if (!/^[\p{L}\p{N}_-]{1,60}$/u.test(lotCode)) throw new Error("Use de 1 a 60 letras, números, hífens ou sublinhados na identificação do lote.");
      if (!validationApi.isValidPersonalName(elements.operatorNameInput.value)) throw new Error("Informe o nome completo do operador.");
      if (!domain.isValidCpf(operatorCpf)) throw new Error("Informe um CPF válido para o operador.");
      if (!store.evidence.length) throw new Error("Adicione ao menos um vestígio ao lote.");
      if (store.evidence.some(item => !item.metadata)) throw new Error("Conclua a qualificação de todos os vestígios.");

      elements.operatorCpfInput.value = operatorCpf;
      elements.operatorNameInput.value = operatorName;
      return { lotCode, operator: { name: operatorName, cpf: operatorCpf } };
    }

    function getValidatedSealingSecret() {
      const secret = elements.lotSecretInput.value;
      const confirmation = elements.lotSecretConfirmInput.value;
      sealingUi.validateFields?.([
        [elements.lotSecretInput, secret.length >= limits.minSecretLength && secret.length <= limits.maxSecretLength],
        [elements.lotSecretConfirmInput, Boolean(confirmation) && secret === confirmation]
      ]);
      if (secret.length < limits.minSecretLength) throw new Error(`A chave do lote precisa ter pelo menos ${limits.minSecretLength} caracteres.`);
      if (secret.length > limits.maxSecretLength) throw new Error(`A chave do lote pode ter no máximo ${limits.maxSecretLength} caracteres.`);
      if (secret !== confirmation) throw new Error("A confirmação da chave não corresponde ao valor informado.");
      return secret;
    }

    function buildInitialData(lotData) {
      return {
        documentId: store.documentId,
        lotCode: lotData.lotCode,
        operator: lotData.operator,
        issuedAt: store.issuedAt,
        qualifiedLotHash: store.qualifiedLotHash,
        temporalSummary: store.declarationTemporalSummary,
        evidence: store.evidence.map(item => ({
          name: item.file.name,
          hash: item.hash,
          metadata: {
            ...item.metadata,
            photos: (item.metadata.photos ?? []).map(photo => ({
              name: photo.file.name,
              size: photo.file.size,
              mimeType: photo.file.type || "application/octet-stream",
              hash: photo.hash
            })),
            documents: (item.metadata.documents ?? []).map(document => ({
              name: document.file.name,
              size: document.file.size,
              mimeType: "application/pdf",
              hash: document.hash
            }))
          }
        }))
      };
    }

    function buildQualifiedLotRecord(lotData) {
      const declarationData = buildInitialData(lotData);
      return {
        profile: "LDF-QUALIFIED-LOT-1",
        containerFormat: cryptoApi.FORMAT,
        documentId: declarationData.documentId,
        lotCode: declarationData.lotCode,
        operator: declarationData.operator,
        issuedAt: declarationData.issuedAt,
        temporalSummary: declarationData.temporalSummary,
        evidence: declarationData.evidence
      };
    }

    async function generateInitialDeclaration() {
      if (store.locked || selectors.hasPendingContainer() || store.containerSaved) return;
      let routineStarted = false;
      let declarationDrafted = false;
      try {
        const lotData = getValidatedRegistrationData();
        routineStarted = sealingUi.beginExclusiveRoutine("geração e salvamento da declaração de registro");
        if (!routineStarted) return;
        sealingUi.setActivityProgress("operation-progress", true, "Gerando e salvando a declaração de registro...");
        await sealingTemporal.ensureCreationSession();
        sealingTemporal.requireCoherentSession("emitir a declaração de registro");
        store.documentId = domain.newDocumentId("REG");
        declarationDrafted = true;
        store.issuedAt = domain.localDateTime();
        store.declarationTemporalSummary = sealingTemporal.requireCoherentSession("emitir a declaração de registro");
        store.qualifiedLotRecord = buildQualifiedLotRecord(lotData);
        validationApi.validateProductionQualifiedLotRecord(store.qualifiedLotRecord, sourceTypeLabels, primarySourceStatusLabels);
        store.qualifiedLotHash = await cryptoApi.sha256Canonical(store.qualifiedLotRecord);
        const pdf = pdfApi.initialDeclaration({ ...store.qualifiedLotRecord, qualifiedLotHash: store.qualifiedLotHash });
        const fileName = validationApi.signedDeclarationFileName(lotData.lotCode);
        const saveResult = await sealingFileIo.saveBlob(pdf, fileName);
        if (saveResult === "cancelled") {
          store.documentId = "";
          store.issuedAt = "";
          store.qualifiedLotHash = "";
          store.qualifiedLotRecord = null;
          store.declarationTemporalSummary = null;
          sealingUi.showToast("O salvamento da declaração de registro foi cancelado.", "warning");
          return;
        }
        sealingUi.setActivityProgress("operation-progress", false);
        sealingUi.endExclusiveRoutine();
        routineStarted = false;
        sealingUi.setCreateControlsLocked(true);
        elements.lotSecretInput.value = "";
        elements.lotSecretConfirmInput.value = "";
        elements.lotSecretInput.type = "password";
        elements.lotSecretConfirmInput.type = "password";
        elements.lotSecretHelp.textContent = "O servidor não recebe nem recupera esta chave. Insira uma senha no mínimo com 12 caracteres.";

        lotController.addLog(`Declaração de registro emitida: ${fileName}`);
        lotController.addLog(`Identificador da declaração: ${store.documentId}`);
        lotController.addLog(`SHA-256 do conjunto qualificado: ${store.qualifiedLotHash}`);
        if (saveResult === "download-requested") {
          lotController.addLog(`Download da declaração de registro solicitado: ${fileName} [DOWNLOAD_REQUESTED].`, "warning");
          sealingUi.showToast("Download da declaração de registro solicitado. Confirme a conclusão no navegador, assine o PDF e selecione-o na etapa 3.", "warning");
        } else {
          sealingUi.showToast("Declaração de registro gerada. Assine o PDF e selecione-o na etapa 3.");
        }
      } catch (error) {
        if (declarationDrafted) {
          store.documentId = "";
          store.issuedAt = "";
          store.qualifiedLotHash = "";
          store.qualifiedLotRecord = null;
          store.declarationTemporalSummary = null;
        }
        sealingUi.showToast(sealingUi.friendlyErrorMessage(error, "gerar ou salvar a declaração de registro"), "error");
      } finally {
        if (routineStarted) {
          sealingUi.setActivityProgress("operation-progress", false);
          sealingUi.endExclusiveRoutine();
        }
      }
    }

    async function requireUnchangedQualifiedLot(lotData) {
      const currentQualifiedLotHash = await cryptoApi.sha256Canonical(store.qualifiedLotRecord);
      const liveQualifiedLotRecord = buildQualifiedLotRecord(lotData);
      validationApi.validateProductionQualifiedLotRecord(liveQualifiedLotRecord, sourceTypeLabels, primarySourceStatusLabels);
      const liveQualifiedLotHash = await cryptoApi.sha256Canonical(liveQualifiedLotRecord);
      if (currentQualifiedLotHash !== store.qualifiedLotHash || liveQualifiedLotHash !== store.qualifiedLotHash) {
        throw new Error("Os dados qualificados do lote mudaram depois da emissão da declaração. Reinicie a operação e gere uma nova declaração.");
      }
    }

    function invalidateSignedSelection() {
      store.selectionRevision += 1;
      store.signedSelection = null;
    }

    function isCurrentSelection(revision, documentId, qualifiedLotHash) {
      return store.runtimeReady && store.locked && !store.containerSaved
        && store.selectionRevision === revision && store.documentId === documentId
        && store.qualifiedLotHash === qualifiedLotHash && !selectors.hasPendingContainer();
    }

    async function selectSignedDeclaration(file) {
      if (!file) return false; // Cancelar o seletor conserva a escolha anterior.
      if (!store.runtimeReady || !store.locked || selectors.hasPendingContainer() || store.containerSaved) return false;
      invalidateSignedSelection();
      const revision = store.selectionRevision;
      const documentId = store.documentId;
      const qualifiedLotHash = store.qualifiedLotHash;
      if (!sealingUi.beginExclusiveRoutine("conferência da declaração assinada")) return false;
      sealingUi.setActivityProgress("operation-progress", true, "Conferindo a declaração assinada...");
      try {
        const lotData = getValidatedRegistrationData();
        sealingTemporal.requireCoherentSession("prosseguir com o lacre");
        validationApi.requireSafeFileName(file.name, ".pdf");
        if (file.size > validationApi.MAX_PDF_BYTES) throw new Error("A declaração PDF excede o limite de 64 MiB.");
        const size = file.size;
        const bytes = await file.arrayBuffer();
        if (bytes.byteLength !== size || file.size !== size) throw new Error("A declaração PDF mudou durante a leitura. Selecione novamente o arquivo.");
        await requireUnchangedQualifiedLot(lotData);
        const pdfInspection = validationApi.inspectPdf(bytes, [documentId, qualifiedLotHash]);
        const [documentIdTextDetected, qualifiedLotHashTextDetected] = pdfInspection.textMatches;
        const signedDeclarationHash = await cryptoApi.sha256Buffer(bytes);
        if (!isCurrentSelection(revision, documentId, qualifiedLotHash)) return false;
        sealingTemporal.requireCoherentSession("prosseguir com o lacre");
        store.signedSelection = Object.freeze({ file, size, sha256: signedDeclarationHash,
          inspection: pdfInspection, documentId, qualifiedLotHash, revision });
        if (!documentIdTextDetected) {
          lotController.addLog("O texto do identificador não foi localizado nos bytes do PDF; a conferência visual e externa permanece obrigatória.", "warning");
        } else {
          lotController.addLog("Texto do identificador localizado nos bytes do PDF; isso é apenas um indício técnico.");
        }

        if (!qualifiedLotHashTextDetected) {
          lotController.addLog("O texto do SHA-256 qualificado não foi localizado nos bytes do PDF; a conferência visual e externa permanece obrigatória.", "warning");
        } else {
          lotController.addLog("Texto do SHA-256 qualificado localizado nos bytes do PDF; isso é apenas um indício técnico.");
        }

        if (!pdfInspection.signatureMarkersDetected) {
          lotController.addLog("Nenhum marcador aparente de assinatura foi localizado; valide o documento externamente.", "warning");
        } else {
          lotController.addLog("Marcadores aparentes de assinatura foram localizados; eles não validam a assinatura.");
        }

        lotController.addLog("Declaração selecionada; conferências técnicas locais concluídas.");
        return true;
      } catch (error) {
        if (store.selectionRevision === revision) {
          const message = sealingUi.friendlyErrorMessage(error, "conferir a declaração assinada");
          lotController.addLog(`Falha no fechamento: ${message}`, "error");
          sealingUi.showToast(message, "error");
        }
        return false;
      } finally {
        elements.signedInput.value = "";
        sealingUi.setActivityProgress("operation-progress", false);
        sealingUi.endExclusiveRoutine();
      }
    }

    async function prepareContainerPlan() {
      if (!store.runtimeReady || !store.locked || selectors.hasPendingContainer() || store.containerSaved) return false;
      if (!sealingUi.beginExclusiveRoutine("preparação do fechamento do lote")) return false;
      sealingUi.setActivityProgress("operation-progress", true, "Preparando o fechamento do lote...");
      try {
        const selection = store.signedSelection;
        if (!selection) throw new Error("Selecione e confira a declaração PDF antes de fechar o lote.");
        const lotData = getValidatedRegistrationData();
        const secret = getValidatedSealingSecret();
        let sealingSummary = sealingTemporal.requireCoherentSession("prosseguir com o lacre");
        await requireUnchangedQualifiedLot(lotData);
        const { file, size, revision, documentId, qualifiedLotHash } = selection;
        let bytes, signedDeclarationHash;
        try {
          validationApi.requireSafeFileName(file.name, ".pdf");
          if (file.size > validationApi.MAX_PDF_BYTES) throw new Error("A declaração PDF excede o limite de 64 MiB.");
          bytes = await file.arrayBuffer();
          signedDeclarationHash = await cryptoApi.sha256Buffer(bytes);
          if (file.size !== size || bytes.byteLength !== size || signedDeclarationHash !== selection.sha256) {
            throw new Error("A declaração PDF mudou depois da conferência. Selecione novamente o arquivo.");
          }
        } catch (error) {
          if (store.signedSelection === selection) invalidateSignedSelection();
          throw error;
        }
        const pdfInspection = validationApi.inspectPdf(bytes, [documentId, qualifiedLotHash]);
        const [documentIdTextDetected, qualifiedLotHashTextDetected] = pdfInspection.textMatches;
        if (!isCurrentSelection(revision, documentId, qualifiedLotHash)) throw new Error("A seleção da declaração PDF mudou. Selecione novamente o arquivo.");
        sealingSummary = sealingTemporal.requireCoherentSession("prosseguir com o lacre");
        const sealedAt = domain.localDateTime();
        const payloads = [file];
        const progressMessages = [`Criptografando declaração: ${file.name}`];

        // Cada carga adicionada após o relatório interno recebe o índice do
        // registro criptográfico usado para recuperá-la durante a auditoria.
        const addPayload = (payload, progressMessage = "") => {
          payloads.push(payload);
          progressMessages.push(progressMessage);
          return payloads.length;
        };
        const evidenceManifest = store.evidence.map((item, index) => {
          const { photos = [], documents = [], ...metadataFields } = item.metadata;
          const attachmentSummary = [
            photos.length ? "foto(s) complementar(es)" : "",
            documents.length ? "documento(s) complementar(es)" : ""
          ].filter(Boolean);
          const progressSuffix = attachmentSummary.length ? ` e ${attachmentSummary.join(" e ")}` : "";
          const recordIndex = addPayload(
            item.file,
            `Criptografando registro ${index + 1}: ${item.file.name}${progressSuffix}`
          );
          const protectedPhotos = photos.map(photo => ({
            recordIndex: addPayload(photo.file),
            name: photo.file.name,
            mimeType: photo.file.type || "application/octet-stream",
            size: photo.file.size,
            hash: photo.hash
          }));
          const protectedDocuments = documents.map(document => ({
            recordIndex: addPayload(document.file),
            name: document.file.name,
            mimeType: "application/pdf",
            size: document.file.size,
            hash: document.hash
          }));
          return {
            recordIndex,
            name: item.file.name,
            mimeType: item.file.type || "application/octet-stream",
            size: item.file.size,
            hash: item.hash,
            metadata: { ...metadataFields, photos: protectedPhotos, documents: protectedDocuments }
          };
        });
        const internalReport = {
          manifestProfile: validationApi.MANIFEST_PROFILE,
          format: cryptoApi.FORMAT,
          application: "LDF Web - Lacre Digital Forense",
          lotCode: lotData.lotCode,
          initialDocumentId: store.documentId,
          qualifiedLotProfile: store.qualifiedLotRecord.profile,
          qualifiedLotHash: store.qualifiedLotHash,
          qualifiedLotRecord: store.qualifiedLotRecord,
          declarationIssuedAt: store.issuedAt,
          sealedAt,
          temporal: {
            declaration: store.declarationTemporalSummary,
            sealing: sealingSummary
          },
          operator: lotData.operator,
          signedDeclaration: {
            recordIndex: 1,
            name: validationApi.signedDeclarationFileName(lotData.lotCode),
            mimeType: "application/pdf",
            size: file.size,
            hash: signedDeclarationHash,
            originalName: file.name,
            documentIdTextDetected,
            qualifiedLotHashTextDetected,
            signatureMarkersDetected: pdfInspection.signatureMarkersDetected
          },
          evidence: evidenceManifest,
          auditTrail: store.logs.map(entry => ({ ...entry }))
        };
        await validationApi.validateDraftManifest(internalReport, payloads, cryptoApi);
        const fileName = `LDF_${domain.safeName(lotData.lotCode)}_${domain.compactTimestamp()}.ldf`;
        const totalBytes = payloads.reduce((total, payload) => total + payload.size, 0);
        await requireUnchangedQualifiedLot(lotData);
        if (!isCurrentSelection(revision, documentId, qualifiedLotHash)) throw new Error("A seleção da declaração PDF mudou. Selecione novamente o arquivo.");
        sealingTemporal.requireCoherentSession("prosseguir com o lacre");
        transitions.setPendingContainer({
          secret,
          internalReport,
          payloads,
          progressMessages,
          totalBytes,
          fileName
        });
        elements.lotSecretInput.value = "";
        elements.lotSecretConfirmInput.value = "";
        elements.lotSecretInput.type = "password";
        elements.lotSecretConfirmInput.type = "password";
        elements.signedInput.disabled = true;
        elements.signedLabel.classList.add("disabled");
        elements.lotSecretHelp.textContent = "A chave foi capturada para este fechamento e retirada da tela. Salve o contêiner ou reinicie a operação.";
        elements.saveContainerButton.textContent = "Salvar contêiner LDF";
        elements.saveContainerButton.classList.remove("hidden");
        elements.confirmContainerDownloadButton.classList.add("hidden");
        sealingUi.showToast("Lote preparado. Escolha onde deseja salvar o contêiner LDF Web.");
        return true;
      } catch (error) {
        const message = sealingUi.friendlyErrorMessage(error, "preparar o fechamento do lote");
        lotController.addLog(`Falha no fechamento: ${message}`, "error");
        sealingUi.showToast(message, "error");
        return false;
      } finally {
        sealingUi.setActivityProgress("operation-progress", false);
        sealingUi.endExclusiveRoutine();
      }
    }

    function finalizeConfirmedContainer(plan, saveResult, persistenceConfirmation) {
      plan.secret = "";
      transitions.setContainerSaved(true);
      transitions.setPendingContainer(null);

      elements.saveContainerButton.classList.add("hidden");
      elements.saveContainerButton.textContent = "Salvar contêiner LDF";
      elements.confirmContainerDownloadButton.classList.add("hidden");
      lotController.addLog(`Contêiner LDF Web salvo: ${plan.fileName}`);
      lotController.addLog(`SHA-256 do contêiner: ${saveResult.sha256}`);
      lotController.addLog(
        persistenceConfirmation === "manual"
          ? "Persistência do contêiner informada manualmente pelo operador após conferência do download [MANUAL_CONFIRMED]."
          : "Persistência do contêiner confirmada pela API de gravação do navegador."
      );

      const receiptFileName = `Recibo_Remessa_${domain.safeName(plan.internalReport.lotCode)}_${domain.compactTimestamp()}.pdf`;
      try {
        transitions.setShippingReceipt({
          blob: pdfApi.shippingReceipt({
            documentId: domain.newDocumentId("REM"),
            qualifiedLotHash: plan.internalReport.qualifiedLotHash,
            lotCode: plan.internalReport.lotCode,
            fileName: plan.fileName,
            containerHash: saveResult.sha256,
            persistenceConfirmation
          }),
          fileName: receiptFileName
        });
        elements.saveShippingReceiptButton.classList.remove("hidden");
        sealingUi.showToast("Contêiner salvo. Salve também o recibo de remessa.");
      } catch {
        transitions.setShippingReceipt(null);
        lotController.addLog("O contêiner foi salvo, mas o recibo de remessa não pôde ser gerado.", "warning");
        sealingUi.showToast("O contêiner foi salvo e a chave foi descartada, mas o recibo não pôde ser gerado.", "warning");
      }
    }

    function confirmFallbackContainerDownload() {
      const plan = store.pendingContainer;
      if (!plan?.fallbackArtifact) return;
      const confirmed = sealingUi.confirmManualDownload(
        "Confirme somente se você verificou que o download do contêiner LDF foi concluído no navegador. Esta declaração manual não realiza uma conferência automática do arquivo."
      );
      if (!confirmed) {
        sealingUi.showToast("A confirmação manual não foi registrada. O contêiner permanece pendente e o download pode ser solicitado novamente.", "warning");
        return;
      }
      finalizeConfirmedContainer(plan, plan.fallbackArtifact, "manual");
    }

    async function savePendingContainer() {
      if (!selectors.hasPendingContainer()) return;
      const plan = store.pendingContainer;
      let sealingSummary;
      try {
        sealingSummary = sealingTemporal.requireCoherentSession("lacrar e salvar o contêiner");
      } catch (error) {
        const message = sealingUi.friendlyErrorMessage(error, "lacrar e salvar o contêiner");
        lotController.addLog(`Lacre bloqueado: ${message}`, "error");
        sealingUi.showToast(message, "error");
        return;
      }
      elements.saveContainerButton.disabled = true;
      elements.signedInput.disabled = true;
      elements.signedLabel.classList.add("disabled");
      if (!sealingUi.beginExclusiveRoutine("criptografia e salvamento do contêiner")) {
        elements.saveContainerButton.disabled = false;
        return;
      }
      sealingUi.setActivityProgress("operation-progress", true, "Derivando a chave e criptografando o contêiner...");
      try {
        plan.internalReport.sealedAt = domain.localDateTime();
        plan.internalReport.temporal.sealing = sealingSummary;
        const liveQualifiedLotRecord = buildQualifiedLotRecord({
          lotCode: plan.internalReport.lotCode,
          operator: plan.internalReport.operator
        });
        validationApi.validateProductionQualifiedLotRecord(liveQualifiedLotRecord, sourceTypeLabels, primarySourceStatusLabels);
        if (await cryptoApi.sha256Canonical(liveQualifiedLotRecord) !== plan.internalReport.qualifiedLotHash) {
          throw new Error("Os dados qualificados do lote mudaram depois da emissão da declaração. Reinicie a operação e gere uma nova declaração.");
        }
        await validationApi.validateDraftManifest(plan.internalReport, plan.payloads, cryptoApi);
        const saveResult = await sealingFileIo.saveContainerPlan(plan, event => {
          const messages = Object.freeze({
            WRITING: "Status do Contêiner: escrita iniciada [WRITING].",
            DATA_WRITTEN: "Status do Contêiner: dados gravados; aguardando confirmação [DATA_WRITTEN]",
            WRITE_FAILED: "Status do Contêiner: falha durante a escrita [WRITE_FAILED].",
            CLOSE_FAILED: "Status do Contêiner: falha na confirmação do arquivo [CLOSE_FAILED]."
          });
          if (event.state === "CLOSE_STARTED" || event.state === "FILE_CONFIRMED") return;
          const type = event.state.endsWith("FAILED") ? "error" : "info";
          lotController.addLog(messages[event.state] || `Status do Contêiner: ${event.state}.`, type);
        });
        if (saveResult.status === "cancelled") {
          sealingUi.showToast("O salvamento do contêiner foi cancelado. Você pode tentar novamente.", "warning");
          return;
        }
        if (saveResult.status === "download-requested") {
          elements.saveContainerButton.textContent = "Solicitar download novamente";
          elements.confirmContainerDownloadButton.classList.remove("hidden");
          lotController.addLog(`Download do contêiner solicitado: ${plan.fileName} [DOWNLOAD_REQUESTED].`, "warning");
          lotController.addLog(`SHA-256 do contêiner preparado: ${saveResult.sha256}`);
          sealingUi.showToast("Download do contêiner solicitado. Verifique a conclusão no navegador; depois, confirme o arquivo baixado ou solicite o download novamente.", "warning");
          return;
        }
        finalizeConfirmedContainer(plan, saveResult, "api");
      } catch (error) {
        const message = sealingUi.friendlyErrorMessage(error, "salvar o contêiner LDF Web");
        if (error?.diagnostic) {
          lotController.addLog(
            `Diagnóstico técnico sanitizado ${error.diagnostic.occurrenceId}: ${JSON.stringify(error.diagnostic)}`,
            "error"
          );
        }
        lotController.addLog(`Falha no fechamento: ${message}`, "error");
        sealingUi.showToast(message, "error");
      } finally {
        sealingUi.setActivityProgress("operation-progress", false);
        sealingUi.endExclusiveRoutine();
        if (selectors.hasPendingContainer()) {
          elements.saveContainerButton.disabled = false;
          elements.signedInput.disabled = true;
          elements.signedLabel.classList.add("disabled");
        }
      }
    }

    async function saveShippingReceipt() {
      if (!store.shippingReceipt) return;
      const button = elements.saveShippingReceiptButton;
      button.disabled = true;
      if (!sealingUi.beginExclusiveRoutine("salvamento do recibo de remessa")) {
        button.disabled = false;
        return;
      }
      sealingUi.setActivityProgress("operation-progress", true, "Salvando o recibo de remessa...");
      try {
        const result = await sealingFileIo.saveBlob(store.shippingReceipt.blob, store.shippingReceipt.fileName);
        if (result === "cancelled") {
          sealingUi.showToast("O salvamento do recibo de remessa foi cancelado. Você pode tentar novamente.", "warning");
          return;
        }
        if (result === "download-requested") {
          lotController.addLog(`Download do recibo de remessa solicitado: ${store.shippingReceipt.fileName} [DOWNLOAD_REQUESTED].`, "warning");
          sealingUi.showToast("Download do recibo de remessa solicitado. Confirme a conclusão no navegador; a ação permanece disponível para nova tentativa.", "warning");
          return;
        }
        lotController.addLog(`Recibo de remessa salvo: ${store.shippingReceipt.fileName}`);
        sealingUi.showToast("Recibo de remessa salvo com sucesso.");
      } catch (error) {
        sealingUi.showToast(sealingUi.friendlyErrorMessage(error, "salvar o recibo de remessa"), "error");
      } finally {
        sealingUi.setActivityProgress("operation-progress", false);
        sealingUi.endExclusiveRoutine();
        if (store.shippingReceipt) button.disabled = false;
      }
    }

    function generateStrongSecret() {
      const bytes = cryptoApi.randomBytes(18);
      const secret = cryptoApi.bytesToBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
      elements.lotSecretInput.value = secret;
      elements.lotSecretConfirmInput.value = "";
      elements.lotSecretInput.type = "password";
      elements.lotSecretConfirmInput.type = "password";
      sealingUi.showToast("Chave forte gerada. Guarde-a em local seguro e informe-a novamente no campo Confirmar chave.", "warning");
    }

    return Object.freeze({
      generateStrongSecret,
      generateInitialDeclaration,
      selectSignedDeclaration,
      prepareContainerPlan,
      savePendingContainer,
      confirmFallbackContainerDownload,
      saveShippingReceipt
    });
  }

  registry.register("sealing", createSealing);
})();
