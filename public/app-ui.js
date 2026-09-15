(function () {
  "use strict";

  const registry = window.__LDF_APP_MODULES__;
  if (!registry) throw new Error("Registro interno dos módulos da aplicação indisponível.");

  function createUi({
    elements,
    routine,
    beginRoutineTransition,
    endRoutineTransition,
    createElement,
    schedule,
    synchronizeCreationControls
  }) {
    function escapeHtml(value) {
      return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
    }

    function showToast(message, type = "info") {
      const toast = createElement("div");
      toast.className = `toast ${type}`;
      toast.textContent = message;
      elements.toastRegion.append(toast);
      schedule(() => toast.remove(), 5200);
    }

    /*
     * APIs nativas do navegador podem devolver mensagens técnicas em inglês.
     * Esta camada converte as falhas mais comuns em orientação curta e acionável,
     * sem expor ao operador detalhes internos que não ajudam a resolver o problema.
     */
    function friendlyErrorMessage(error, action = "concluir a operação") {
      const name = String(error?.name || "");
      const original = String(error?.message || error || "").trim();
      const normalized = original.toLowerCase();
      const occurrenceSuffix = /^[A-Z0-9-]{8,80}$/.test(String(error?.occurrenceId || ""))
        ? ` Ocorrência: ${error.occurrenceId}.`
        : "";
      const withOccurrence = message => `${message}${occurrenceSuffix}`;

      if (name === "AbortError") {
        return withOccurrence("A operação foi cancelada. Tente novamente quando desejar.");
      }
      const isFileStateError = name === "InvalidStateError"
        || normalized.includes("state cached in an interface object")
        || normalized.includes("state had changed since it was read from disk");
      if (error?.diagnostic?.phase === "CLOSE_FAILED" && isFileStateError) {
        return withOccurrence("O navegador não confirmou o salvamento do arquivo. Isso pode estar relacionado às configurações de segurança do navegador. Se o problema persistir, tente usar outro navegador compatível.");
      }
      if (isFileStateError) {
        return withOccurrence("O arquivo ou a pasta de destino mudou durante o salvamento. Selecione novamente o destino e não mova, renomeie, exclua ou substitua esse item até a conclusão. Se a falha persistir, escolha outro nome ou outra pasta.");
      }
      if (name === "QuotaExceededError"
        || normalized.includes("not enough space")
        || normalized.includes("disk is full")
        || normalized.includes("quota exceeded")) {
        return withOccurrence("Não há espaço disponível suficiente para concluir a gravação. Libere espaço no destino ou selecione outra unidade ou pasta e tente novamente.");
      }
      if (name === "NotAllowedError" || name === "SecurityError") {
        return withOccurrence("O navegador não autorizou o acesso necessário. Tente novamente, confirme a permissão solicitada e, se necessário, escolha outro arquivo ou outra pasta.");
      }
      if (name === "NotFoundError") {
        return withOccurrence("O arquivo, a unidade ou a pasta selecionada não está mais disponível. Reconecte a unidade ou selecione novamente o item e tente outra vez.");
      }
      if (name === "NotReadableError") {
        return withOccurrence("O arquivo não pôde ser lido. Feche outros programas que possam estar usando o item, confirme se a unidade está conectada e selecione-o novamente.");
      }
      if (name === "NetworkError") {
        return withOccurrence("A unidade ou pasta de rede ficou indisponível durante a operação. Verifique a conexão, selecione novamente o destino e tente outra vez.");
      }
      if (name === "TimeoutError") {
        return withOccurrence("A operação não foi concluída no tempo esperado. Verifique se o arquivo ou a unidade continua disponível e tente novamente.");
      }
      if (name === "NotSupportedError") {
        return withOccurrence("Este navegador não oferece suporte a essa operação. Use uma versão atual do Google Chrome ou Microsoft Edge e tente novamente.");
      }
      if (name === "RangeError"
        || normalized.includes("out of memory")
        || normalized.includes("array buffer allocation failed")) {
        return withOccurrence("O navegador não conseguiu reservar memória suficiente. Feche abas e programas desnecessários, reinicie a operação e tente novamente.");
      }

      const appearsToBePortuguese = /[áàâãéêíóôõúç]/i.test(original)
        || /^(não|o |a |os |as |este|esta|esse|essa|chave|arquivo|contêiner|selecione|informe|use |adicione|conclua|todos|falha|formato)/i.test(original);
      if (original && appearsToBePortuguese) return withOccurrence(original);

      return withOccurrence(`Não foi possível ${action} por uma falha inesperada. Tente novamente. Se a falha persistir, reinicie a operação e escolha outro arquivo ou outra pasta.`);
    }

    /*
     * A barra é intencionalmente cíclica: ela informa que a rotina continua ativa,
     * sem apresentar uma porcentagem fictícia para operações de duração variável.
     */
    function setActivityProgress(elementId, active, message = "Processando...") {
      const indicator = elements.activityIndicators[elementId];
      if (!indicator) return;
      const label = indicator.querySelector(".activity-label");
      if (label) label.textContent = message;
      indicator.classList.toggle("hidden", !active);
    }

    /*
     * Somente uma rotina demorada pode usar os arquivos e o estado da interface
     * por vez. Reinício e tema ficam disponíveis para recuperação e conforto visual.
     */
    function beginExclusiveRoutine(label) {
      if (!beginRoutineTransition(label)) {
        showToast(`Aguarde a conclusão da rotina em andamento: ${routine.label}.`, "warning");
        return false;
      }
      elements.body.classList.add("routine-active");
      elements.body.setAttribute("aria-busy", "true");

      const allowedIds = new Set(["theme-toggle", "reset-operation", "reset-audit"]);
      elements.listRoutineControls().forEach(element => {
        if (allowedIds.has(element.id) || element.disabled) return;
        element.disabled = true;
        element.dataset.routineDisabled = "true";
      });
      elements.listRoutineLabels().forEach(labelElement => {
        if (labelElement.classList.contains("disabled")) return;
        labelElement.classList.add("disabled");
        labelElement.dataset.routineDisabled = "true";
      });
      return true;
    }

    function endExclusiveRoutine() {
      if (!routine.active) return;
      [...elements.listRoutineControls(), ...elements.listRoutineLabels()].forEach(element => {
        if (element.dataset.routineDisabled !== "true") return;
        if (element.matches("button, input, textarea, select")) element.disabled = false;
        if (element.matches("label.button[for]")) element.classList.remove("disabled");
        delete element.dataset.routineDisabled;
      });
      endRoutineTransition();
      elements.body.classList.remove("routine-active");
      elements.body.removeAttribute("aria-busy");
      synchronizeCreationControls();
    }

    function setCreationControlsUnavailable(unavailable) {
      elements.creationControls.forEach(element => { element.disabled = unavailable; });
      elements.generateDeclaration.disabled = unavailable;
      elements.evidenceAddLabel.classList.toggle("disabled", unavailable);
    }

    function enableSignedDeclarationControls() {
      elements.creationSecretInputs.forEach(element => { element.disabled = false; });
      elements.generateSecret.disabled = false;
      elements.signedInput.disabled = false;
      elements.signedLabel.classList.remove("disabled");
    }

    function lockPreparedContainerControls() {
      elements.signedInput.disabled = true;
      elements.signedLabel.classList.add("disabled");
      elements.creationSecretInputs.forEach(element => { element.disabled = true; });
      elements.generateSecret.disabled = true;
    }

    function switchTab(tabName) {
      elements.privacyStrip.classList.toggle("hidden", tabName === "guidance");
      elements.tabButtons.forEach(button => {
        const active = button.dataset.tab === tabName;
        button.classList.toggle("active", active);
        button.setAttribute("aria-selected", String(active));
      });
      elements.tabPanels.forEach(panel => {
        panel.classList.toggle("active", panel.id === `${tabName}-panel`);
      });
    }

    function maskSecretInputs() {
      elements.secretInputs.forEach(input => { input.type = "password"; });
    }

    return Object.freeze({
      escapeHtml,
      showToast,
      friendlyErrorMessage,
      setActivityProgress,
      beginExclusiveRoutine,
      endExclusiveRoutine,
      setCreationControlsUnavailable,
      enableSignedDeclarationControls,
      lockPreparedContainerControls,
      switchTab,
      maskSecretInputs
    });
  }

  registry.register("ui", createUi);
})();
