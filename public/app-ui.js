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
    scrollToStart,
    synchronizeCreationControls,
    creationPresentation,
    creationStages
  }) {
    let aboutReturnFocus = null;
    let view = "home";
    let informationalReturnFocus = null;
    let visitedCreationStage = 1;
    const dialogTriggers = new Map();
    const environmentIssues = new Map();
    const toastParent = elements.toastRegion.parentElement;

    function raiseNotifications() {
      const region = elements.toastRegion;
      if (!region.childElementCount) {
        if (typeof region.hidePopover === "function" && region.matches(":popover-open")) region.hidePopover();
        return;
      }
      const dialogs = Array.from(elements.body.querySelectorAll("dialog[open]"));
      const focusedDialog = elements.body.ownerDocument.activeElement?.closest("dialog[open]");
      const host = focusedDialog || dialogs.at(-1) || toastParent;
      // O aviso deve pertencer ao diálogo ativo para permanecer acessível fora da área inerte.
      if (region.parentElement !== host) host.append(region);
      if (typeof region.showPopover === "function") {
        if (region.matches(":popover-open")) region.hidePopover();
        region.showPopover();
      } else {
        region.removeAttribute("popover");
      }
    }

    const dialogObserver = new MutationObserver(records => {
      if (records.some(record => record.target.matches("dialog"))) raiseNotifications();
    });
    dialogObserver.observe(elements.body, { attributes: true, attributeFilter: ["open"], subtree: true });

    function setEnvironmentIssue(key, message = "") {
      if (message) environmentIssues.set(key, String(message));
      else environmentIssues.delete(key);
      const list = elements.environmentMessages;
      list.replaceChildren();
      for (const text of environmentIssues.values()) {
        const item = createElement("li");
        item.textContent = text;
        list.append(item);
      }
      list.hidden = environmentIssues.size === 0;
      if (environmentIssues.size) elements.environmentDisclosure.open = true;
    }

    function setEnvironmentStatus(message, state = "", prepared = false) {
      const status = elements.environmentStatus;
      status.textContent = message;
      status.classList.remove("warning", "preparation-failed");
      if (state) status.classList.add(state);
      status.dataset.prepared = String(prepared);
      if (state) elements.environmentDisclosure.open = true;
    }

    function renderCreationStages() {
      const creationStore = creationPresentation();
      const stages = creationStages();
      if (!stages[visitedCreationStage - 1].available && visitedCreationStage !== 1) visitedCreationStage = 1;
      elements.stageButtons.forEach(button => {
        const stage = Number(button.dataset.stage);
        button.disabled = routine.active || !stages[stage - 1].available;
        button.classList.toggle("done", stages[stage - 1].completed);
        button.classList.toggle("current", stage === visitedCreationStage);
        if (stage === visitedCreationStage) button.setAttribute("aria-current", "step");
        else button.removeAttribute("aria-current");
        button.setAttribute("aria-label", `${stage}. ${button.textContent.trim()}. ${stages[stage - 1].completed ? "Concluída" : "Pendente"}`);
      });
      elements.stagePanels.forEach(panel => { panel.hidden = Number(panel.dataset.stagePanel) !== visitedCreationStage; });
      elements.nextStageButtons.forEach(button => { button.disabled = routine.active || !stages[Number(button.dataset.nextStage) - 1].available; });
      if (elements.qualificationStatus) {
        const pending = creationStore.evidenceCount - creationStore.qualifiedCount;
        elements.qualificationStatus.textContent = stages[1].completed
          ? "Declaração emitida. Dados preservados; reinicie para alterar os vestígios."
          : creationStore.evidenceCount === 0 ? "Adicione arquivos para continuar."
          : pending ? `${pending} vestígio(s) aguardando qualificação.`
          : "Todos os vestígios estão qualificados. Revise e prossiga para a declaração.";
      }
      elements.firstFile.hidden = creationStore.hasShownEvidenceList;
      elements.evidencePanel.hidden = !creationStore.hasShownEvidenceList;
      elements.addFirstFile.disabled = routine.active || creationStore.locked || !creationStore.runtimeReady;
      elements.emitDocument.disabled = routine.active || !stages[1].available || stages[1].completed || creationStore.locked;
      elements.generateDeclaration.disabled = elements.emitDocument.disabled;
      elements.declarationStatus.textContent = stages[1].completed ? `Declaração emitida: ${creationStore.documentId}` : `${creationStore.qualifiedCount} vestígio(s) qualificado(s).`;
      const selected = creationStore.signedSelection;
      elements.signedSelection.hidden = !selected;
      elements.signedChecks.hidden = !selected;
      elements.signedName.textContent = selected?.name || "";
      elements.signedHash.textContent = selected ? `SHA-256 ${selected.sha256}` : "";
      elements.signedCheckResults.textContent = selected ? `PDF dentro do limite e envelope conferido. Texto do identificador: ${selected.inspection.textMatches[0] ? "localizado" : "não localizado"}; SHA-256 qualificado: ${selected.inspection.textMatches[1] ? "localizado" : "não localizado"}; marcadores aparentes de assinatura: ${selected.inspection.signatureMarkersDetected ? "localizados" : "não localizados"}.` : "";
      elements.sealCount.textContent = String(creationStore.evidenceCount);
      elements.sealDocument.textContent = selected?.name || "Nenhum documento selecionado";
      elements.beginSealing.hidden = Boolean(creationStore.planPending || creationStore.containerSaved);
      elements.beginSealing.disabled = routine.active || !stages[3].available;
      elements.closingStatus.textContent = creationStore.containerSaved ? "Persistência do contêiner confirmada." : creationStore.downloadRequested ? "Download solicitado. Aguardando confirmação manual de conclusão." : creationStore.planPending ? "Plano preparado. Aguardando salvamento do contêiner." : "Defina a chave na janela final para preparar o fechamento.";
      elements.homeDraft.hidden = !creationStore.evidenceCount;
    }

    function visitCreationStage(stage, focus = true) {
      if (routine.active || !creationStages()[stage - 1]?.available) return false;
      visitedCreationStage = stage;
      renderCreationStages();
      if (focus) elements.stagePanels[stage - 1].querySelector("h2").focus({ preventScroll: true });
      return true;
    }

    function resetNavigation() { visitedCreationStage = 1; renderCreationStages(); }
    function openCreationDialog(dialog, trigger, firstField, secret = false) {
      const creationStore = creationPresentation();
      if (routine.active) return false;
      if (secret && (!creationStages()[3].available || creationStore.planPending || creationStore.containerSaved)) return false;
      if (!secret && (!creationStages()[1].available || creationStore.locked)) return false;
      if (secret) clearCreationSecret();
      dialogTriggers.set(dialog, trigger);
      dialog.showModal();
      firstField.focus({ preventScroll: true });
      return true;
    }
    function clearCreationSecret() { elements.creationSecretInputs.forEach(input => { input.value = ""; input.type = "password"; }); }
    function returnFromCreationDialog(dialog, secret = false) {
      if (secret) clearCreationSecret();
      const trigger = dialogTriggers.get(dialog);
      dialogTriggers.delete(dialog);
      if (trigger?.isConnected && !trigger.hidden) trigger.focus({ preventScroll: true });
    }

    function openAbout(trigger) {
      if (routine.active || view === "about") return;
      aboutReturnFocus = trigger;
      if (!elements.aboutContent.childElementCount) {
        const fragment = elements.aboutTemplate.content.cloneNode(true);
        const ids = new Set(Array.from(fragment.querySelectorAll("[id]"), node => node.id));
        for (const node of fragment.querySelectorAll("[id]")) node.id = `session-about-${node.id}`;
        for (const node of fragment.querySelectorAll("[aria-labelledby], [aria-describedby], a[href^='#']")) {
          for (const attribute of ["aria-labelledby", "aria-describedby"]) {
            if (node.hasAttribute(attribute)) node.setAttribute(attribute, node.getAttribute(attribute).split(/\s+/).map(id => ids.has(id) ? `session-about-${id}` : id).join(" "));
          }
          const href = node.getAttribute("href");
          if (href?.startsWith("#") && ids.has(href.slice(1))) node.setAttribute("href", `#session-about-${href.slice(1)}`);
        }
        for (const anchor of fragment.querySelectorAll('a[href="index.html"]')) {
          anchor.removeAttribute("data-page-transition");
          anchor.setAttribute("href", "#home-panel");
          anchor.dataset.closeAbout = "true";
        }
        elements.aboutContent.append(fragment);
      }
      switchTab("about");
    }

    function closeAbout() {
      switchTab("home");
    }

    function returnFromAbout() {
      if (aboutReturnFocus?.isConnected) aboutReturnFocus.focus({ preventScroll: true });
      aboutReturnFocus = null;
    }
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
      toast.setAttribute("role", type === "error" || type === "warning" ? "alert" : "status");
      raiseNotifications();
      schedule(() => { toast.remove(); raiseNotifications(); }, 5200);
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
      if (routine.active || !["home", "create", "audit", "guidance", "about"].includes(tabName)) return false;
      const previousView = view;
      if (tabName === "guidance") informationalReturnFocus = elements.tabButtons.find(button => button.dataset.tab === "guidance");
      view = tabName;
      elements.body.dataset.view = tabName;
      elements.privacyStrip.classList.toggle("hidden", ["guidance", "about"].includes(tabName));
      if (tabName === "home") elements.environmentHome.prepend(elements.privacyStrip);
      else elements.aboutPanel.parentElement.insertBefore(elements.privacyStrip, elements.tabPanels[0]);
      elements.backHome.hidden = tabName === "home";
      elements.tabButtons.forEach(button => {
        const active = button.dataset.tab === tabName;
        button.classList.toggle("active", active);
        button.setAttribute("aria-selected", String(active));
      });
      elements.tabPanels.forEach(panel => {
        const active = panel.id === `${tabName}-panel`;
        panel.classList.toggle("active", active);
        panel.hidden = !active;
        if (active) panel.querySelector("h1")?.focus({ preventScroll: true });
      });
      renderCreationStages();
      scrollToStart();
      if (tabName === "home" && previousView === "about") returnFromAbout();
      if (tabName === "home" && previousView === "guidance") informationalReturnFocus?.focus({ preventScroll: true });
      return true;
    }

    function maskSecretInputs() {
      elements.secretInputs.forEach(input => { input.type = "password"; });
    }

    return Object.freeze({
      escapeHtml,
      showToast,
      setEnvironmentIssue,
      setEnvironmentStatus,
      friendlyErrorMessage,
      setActivityProgress,
      beginExclusiveRoutine,
      endExclusiveRoutine,
      setCreationControlsUnavailable,
      enableSignedDeclarationControls,
      lockPreparedContainerControls,
      switchTab,
      maskSecretInputs,
      openAbout,
      closeAbout,
      returnFromAbout, renderCreationStages, visitCreationStage, resetNavigation, openCreationDialog, returnFromCreationDialog, clearCreationSecret
    });
  }

  registry.register("ui", createUi);
})();
