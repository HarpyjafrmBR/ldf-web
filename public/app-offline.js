(function () {
  "use strict";

  const registry = window.__LDF_APP_MODULES__;
  if (!registry) throw new Error("Registro interno dos módulos da aplicação indisponível.");

  function createOffline({ expectedIdentity, coordination, platform, ui: offlineUi }) {
    function statusMatchesIdentity(status) {
      return status?.releaseToken === expectedIdentity.releaseToken
        && status.buildId === expectedIdentity.buildId
        && status.cacheName === expectedIdentity.cacheName;
    }

    function statusHasGeneration(status) {
      return typeof status?.generation === "string"
        && status.generation.startsWith(`${expectedIdentity.cacheName}-generation-`);
    }

    async function sendCommand(worker, action, timeoutMilliseconds = 3000) {
      if (!worker) return null;
      return new Promise((resolve, reject) => {
        const channel = platform.createMessageChannel();
        const timeoutId = platform.schedule(
          () => reject(new Error("A versão do modo offline não respondeu.")),
          timeoutMilliseconds
        );
        channel.port1.onmessage = event => {
          platform.clearSchedule(timeoutId);
          resolve(event.data);
        };
        worker.postMessage({ action }, [channel.port2]);
      });
    }

    const queryStatus = worker => sendCommand(worker, "runtimeStatus");

    async function waitForInstallation(registration, initialInstallation = false) {
      if (!registration.installing) return;
      await new Promise((resolve, reject) => {
        const installing = registration.installing;
        const timeoutId = platform.schedule(
          () => reject(new Error("Tempo de instalação do modo offline excedido.")),
          15000
        );
        const settle = () => {
          if (installing.state === "activated") {
            platform.clearSchedule(timeoutId);
            resolve();
          }
          if (installing.state === "redundant") {
            platform.clearSchedule(timeoutId);
            reject(new Error("A instalação do modo offline foi descartada."));
          }
          if (installing.state === "installed" && !initialInstallation) {
            platform.schedule(() => {
              if (!registration.waiting) return;
              platform.clearSchedule(timeoutId);
              reject(new Error("Há uma atualização pronta. Feche todas as abas do LDF Web e abra a ferramenta novamente."));
            }, 0);
          }
        };
        installing.addEventListener("statechange", settle);
        settle();
      });
    }

    async function prepare() {
      if (!platform.hasServiceWorker() || !platform.isSecureContext()) return false;
      try {
        const existingRegistration = await platform.getRegistration();
        const initialInstallation = !existingRegistration;
        const existingWorker = platform.getController() || existingRegistration?.active;
        const existingStatus = await queryStatus(existingWorker).catch(() => null);
        const networkAllowed = await coordination.networkAllowed();
        let registration = existingRegistration;
        if (statusMatchesIdentity(existingStatus) && existingStatus.ready !== true) {
          if (!networkAllowed) throw new Error("Outra aba mantém uma operação formal.");
          const repaired = await sendCommand(existingWorker, "repairCache", 15000).catch(() => null);
          if (repaired?.ready === true && statusMatchesIdentity(repaired) && statusHasGeneration(repaired)) return true;
        }
        if (existingStatus?.ready === true && statusMatchesIdentity(existingStatus) && statusHasGeneration(existingStatus)) {
          if (!networkAllowed) return true;
          try {
            await registration.update();
          } catch {
            // Um cache atual e completo continua autorizado quando a rede está ausente.
            return true;
          }
        } else {
          if (!networkAllowed) throw new Error("Outra aba mantém uma operação formal.");
          registration = await platform.register("sw.js", { updateViaCache: "none" });
          if (!registration.installing && !registration.waiting) await registration.update();
        }

        await waitForInstallation(registration, initialInstallation);
        if (registration.waiting) {
          throw new Error("Há uma atualização pronta. Feche todas as abas do LDF Web e abra a ferramenta novamente.");
        }

        const activeWorker = platform.getController() || registration.active;
        if (!activeWorker) throw new Error("O modo offline ainda não assumiu o controle da página.");
        const status = await queryStatus(activeWorker);
        return status?.ready === true && statusMatchesIdentity(status) && statusHasGeneration(status);
      } catch (error) {
        const instruction = String(error?.message || "").includes("Feche todas as abas")
          ? error.message
          : "O modo offline seguro não ficou pronto. Verifique a conexão e recarregue a página.";
        offlineUi.showToast(`${instruction} Os controles continuarão bloqueados.`, "warning");
        return false;
      }
    }

    return Object.freeze({ prepare });
  }

  registry.register("offline", createOffline);
})();
