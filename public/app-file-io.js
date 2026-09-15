(function () {
  "use strict";

  const registry = window.__LDF_APP_MODULES__;
  if (!registry) throw new Error("Registro interno dos módulos da aplicação indisponível.");

  function createFileIo({ cryptoApi, validationApi, fileApi, feedback, diagnostics, limits }) {
    function sanitizeDiagnosticText(value, maximumLength, forbiddenValues = []) {
      let sanitized = String(value ?? "")
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
        .replace(/\bfile:\/\/\/?[^\s)]+/gi, "[caminho removido]")
        .replace(/(?:[a-z]:\\|\\\\)[^\r\n\t\"'<>]*/gi, "[caminho removido]")
        .replace(/\b(https?:\/\/[^\s?#]+)[?#][^\s]*/gi, "$1?[consulta removida]");
      for (const forbidden of forbiddenValues) {
        const token = String(forbidden ?? "");
        if (token.length >= 4) sanitized = sanitized.replaceAll(token, "[segredo removido]");
      }
      sanitized = sanitized.replace(/\s+/g, " ").trim();
      return sanitized.slice(0, maximumLength);
    }

    function writtenPartBytes(part) {
      const data = part?.type === "write" ? part.data : part;
      if (Number.isSafeInteger(data?.byteLength) && data.byteLength >= 0) return data.byteLength;
      if (Number.isSafeInteger(data?.size) && data.size >= 0) return data.size;
      return 0;
    }

    function containerFailure(error, phase, context, cleanupError = null) {
      const forbiddenValues = [context.secret];
      const errorName = sanitizeDiagnosticText(error?.name || "Error", 80, forbiddenValues) || "Error";
      const errorMessage = sanitizeDiagnosticText(error?.message || error || "Falha sem mensagem.", 600, forbiddenValues);
      const diagnostic = Object.freeze({
        occurrenceId: context.occurrenceId,
        phase,
        errorName,
        errorMessage,
        errorCode: sanitizeDiagnosticText(error?.code, 80, forbiddenValues),
        errorStack: sanitizeDiagnosticText(error?.stack, 2000, forbiddenValues),
        cleanupErrorName: sanitizeDiagnosticText(cleanupError?.name, 80, forbiddenValues),
        cleanupErrorMessage: sanitizeDiagnosticText(cleanupError?.message, 300, forbiddenValues),
        startedAt: context.startedAt,
        elapsedMs: Math.max(0, Math.round(diagnostics.monotonicNow() - context.startedMonotonic)),
        browserFamily: diagnostics.browserFamily,
        logicalBytes: Number.isSafeInteger(context.logicalBytes) ? context.logicalBytes : 0,
        writtenBytes: context.writtenBytes
      });
      const failure = new Error(errorMessage || "Falha técnica durante o salvamento do contêiner.");
      failure.name = errorName;
      failure.occurrenceId = context.occurrenceId;
      failure.diagnostic = diagnostic;
      return failure;
    }

    function downloadBlobFallback(blob, fileName) {
      const url = fileApi.createObjectUrl(blob);
      const anchor = fileApi.createDownloadAnchor();
      anchor.href = url;
      anchor.download = fileName;
      fileApi.appendDownloadAnchor(anchor);
      anchor.click();
      anchor.remove();
      fileApi.schedule(() => fileApi.revokeObjectUrl(url), 30000);
    }

    /*
     * Em navegadores compatíveis, abre a janela nativa "Salvar como" para que o
     * usuário escolha nome e pasta. O download convencional permanece apenas como
     * alternativa para navegadores que ainda não oferecem essa API.
     */
    async function saveBlob(blob, fileName) {
      const showSaveFilePicker = fileApi.getSaveFilePicker();
      if (showSaveFilePicker) {
        let writable;
        try {
          const extensionMatch = fileName.match(/(\.[a-zA-Z0-9_-]{1,16})$/);
          const extension = extensionMatch?.[1].toLowerCase();
          const mimeType = /^[\w.+-]+\/[\w.+-]+$/.test(blob.type)
            ? blob.type
            : "application/octet-stream";
          const description = extension === ".pdf"
            ? "Documento PDF"
            : extension === ".ldf"
              ? "Contêiner LDF Web"
              : "Arquivo de vestígio";
          const pickerOptions = { suggestedName: fileName };
          if (extension) {
            pickerOptions.types = [{ description, accept: { [mimeType]: [extension] } }];
          }
          const handle = await showSaveFilePicker(pickerOptions);
          writable = await handle.createWritable();
          await writable.write(blob);
          await writable.close();
          return "saved";
        } catch (error) {
          if (writable) await writable.abort().catch(() => {});
          if (error.name === "AbortError") return "cancelled";
          throw error;
        }
      }
      downloadBlobFallback(blob, fileName);
      return "fallback";
    }

    /*
     * O contêiner grande precisa de um destino antes da criptografia. Assim, cada
     * bloco protegido pode ser gravado imediatamente e liberado da memória.
     */
    async function saveContainerPlan(plan, onState = () => {}) {
      const onProgress = (_current, _total, message) => {
        feedback.setActivityProgress("operation-progress", true, message);
      };
      const showSaveFilePicker = fileApi.getSaveFilePicker();

      if (showSaveFilePicker) {
        let writable;
        let state = "PICKER";
        const context = {
          occurrenceId: diagnostics.newOccurrenceId(),
          startedAt: diagnostics.nowIso(),
          startedMonotonic: diagnostics.monotonicNow(),
          logicalBytes: plan.totalBytes,
          writtenBytes: 0,
          secret: plan.secret
        };
        try {
          const handle = await showSaveFilePicker({
            suggestedName: plan.fileName,
            types: [{
              description: "Contêiner LDF Web",
              accept: { "application/octet-stream": [".ldf"] }
            }]
          });
          writable = await handle.createWritable();
          state = "WRITING";
          onState(Object.freeze({ state, logicalBytes: context.logicalBytes, writtenBytes: 0 }));
          const trackedWritable = Object.freeze({
            async write(part) {
              await writable.write(part);
              context.writtenBytes += writtenPartBytes(part);
            }
          });
          const containerResult = await cryptoApi.sealContainerToWritable(
            plan.secret,
            plan.internalReport,
            plan.payloads,
            trackedWritable,
            onProgress,
            plan.progressMessages
          );
          state = "DATA_WRITTEN";
          onState(Object.freeze({
            state,
            logicalBytes: context.logicalBytes,
            writtenBytes: context.writtenBytes,
            containerBytes: containerResult.size
          }));
          feedback.setActivityProgress(
            "operation-progress",
            true,
            "Dados gravados. Confirmando o arquivo no destino..."
          );
          state = "CLOSE_STARTED";
          onState(Object.freeze({
            state,
            logicalBytes: context.logicalBytes,
            writtenBytes: context.writtenBytes,
            containerBytes: containerResult.size
          }));
          await writable.close();
          state = "FILE_CONFIRMED";
          onState(Object.freeze({
            state,
            logicalBytes: context.logicalBytes,
            writtenBytes: context.writtenBytes,
            containerBytes: containerResult.size
          }));
          return { status: "saved", ...containerResult };
        } catch (error) {
          if (state === "PICKER" && !writable && error.name === "AbortError") {
            return { status: "cancelled" };
          }
          let cleanupError = null;
          if (writable) {
            try {
              await writable.abort();
            } catch (abortError) {
              cleanupError = abortError;
            }
          }
          const failureState = state === "CLOSE_STARTED" ? "CLOSE_FAILED" : "WRITE_FAILED";
          const failure = containerFailure(error, failureState, context, cleanupError);
          onState(Object.freeze({
            state: failureState,
            occurrenceId: context.occurrenceId,
            logicalBytes: context.logicalBytes,
            writtenBytes: context.writtenBytes
          }));
          throw failure;
        }
      }

      /*
       * Navegadores sem a API de gravação direta ainda recebem uma alternativa
       * compatível. O limite existe somente nessa modalidade, pois ela precisa
       * montar o arquivo final em memória antes de iniciar o download.
       */
      if (plan.totalBytes > limits.memoryFallbackBytes) {
        throw new Error(
          `Este navegador não oferece gravação progressiva. Para lotes acima de ${feedback.formatBytes(limits.memoryFallbackBytes)}, utilize uma versão atual do Chrome ou Edge.`
        );
      }
      const blob = await cryptoApi.sealContainer(
        plan.secret,
        plan.internalReport,
        plan.payloads,
        onProgress,
        plan.progressMessages
      );
      const containerHash = await cryptoApi.sha256Blob(blob);
      downloadBlobFallback(blob, plan.fileName);
      return {
        status: "fallback",
        sha256: containerHash,
        size: blob.size
      };
    }

    async function saveProtectedRecord(item) {
      validationApi.requireSafeFileName(item.name);
      if (!/^[a-f0-9]{64}$/.test(item.expectedHash || "")) {
        throw new Error("O arquivo protegido não possui um SHA-256 esperado válido.");
      }
      const showSaveFilePicker = fileApi.getSaveFilePicker();
      if (showSaveFilePicker) {
        let writable;
        try {
          const extensionMatch = item.name.match(/(\.[a-zA-Z0-9_-]{1,16})$/);
          const extension = extensionMatch?.[1].toLowerCase();
          const pickerOptions = { suggestedName: item.name };
          if (extension) {
            pickerOptions.types = [{
              description: "Arquivo de vestígio",
              accept: { [item.mimeType || "application/octet-stream"]: [extension] }
            }];
          }
          const handle = await showSaveFilePicker(pickerOptions);
          writable = await handle.createWritable();
          const actualHash = await item.session.extractRecord(item.recordIndex, writable);
          if (item.expectedHash && actualHash !== item.expectedHash) {
            throw new Error("O arquivo extraído não corresponde ao hash registrado no lote.");
          }
          await writable.close();
          return "saved";
        } catch (error) {
          if (writable) await writable.abort().catch(() => {});
          if (error.name === "AbortError") return "cancelled";
          throw error;
        }
      }

      const decrypted = await item.session.decryptRecordWithHash(item.recordIndex);
      if (decrypted.sha256 !== item.expectedHash) {
        throw new Error("O arquivo extraído não corresponde ao hash registrado no lote.");
      }
      const blob = fileApi.createBlob(
        [decrypted.buffer],
        { type: item.mimeType || "application/octet-stream" }
      );
      downloadBlobFallback(blob, item.name);
      return "fallback";
    }

    return Object.freeze({ saveBlob, saveContainerPlan, saveProtectedRecord });
  }

  registry.register("fileIo", createFileIo);
})();
