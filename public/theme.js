/*
 * O tema claro e o tema escuro usam a mesma estrutura da aplicação. Somente a
 * preferência visual "light" ou "dark" é gravada no navegador. A abertura usa
 * apenas uma marca de sessão; nenhum dado operacional participa da configuração.
 */
(function () {
  "use strict";

  const STORAGE_KEY = "ldf-web-theme";
  const LIGHT_THEME_COLOR = "#DAC7A1";
  const DARK_THEME_COLOR = "#2D1B16";
  const PAGE_FADE_DELAY_MS = 130;
  const STARTUP_SESSION_KEY = "ldf-web-startup-beta-1.1.0-r3";
  const STARTUP_FALLBACK_MS = 3200;
  const root = document.documentElement;
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  let pageTransitionStarted = false;
  let startupPreparationFallback = 0;

  function prepareStartupBrand() {
    if (!root.hasAttribute("data-startup-brand")) return;
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (reducedMotion?.matches) return;
    try {
      if (sessionStorage.getItem(STARTUP_SESSION_KEY)) return;
      sessionStorage.setItem(STARTUP_SESSION_KEY, "seen");
    } catch {
      // Sem armazenamento, dispensar a abertura evita repetições na recuperação.
      return;
    }
    root.classList.add("startup-brand-pending");
    // Defesa de disponibilidade caso a montagem posterior da página seja interrompida.
    startupPreparationFallback = window.setTimeout(() => root.classList.remove("startup-brand-pending"), 4000);
  }

  function readPreference() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved === "dark" || saved === "light" ? saved : "light";
    } catch {
      return "light";
    }
  }

  function savePreference(theme) {
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // A escolha continua válida nesta página mesmo se o navegador bloquear o armazenamento.
    }
  }

  function updateButton(theme) {
    const button = document.getElementById("theme-toggle");
    if (!button) return;
    const nextTheme = theme === "light" ? "dark" : "light";
    const nextLabel = nextTheme === "dark" ? "Usar tema escuro" : "Usar tema claro";
    button.title = nextLabel;
    button.setAttribute("aria-label", nextLabel);
    button.querySelector('[data-theme-icon="dark"]').hidden = nextTheme !== "dark";
    button.querySelector('[data-theme-icon="light"]').hidden = nextTheme !== "light";
  }

  function applyTheme(theme, persist = false) {
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    if (themeMeta) themeMeta.content = theme === "light" ? LIGHT_THEME_COLOR : DARK_THEME_COLOR;
    updateButton(theme);
    if (persist) savePreference(theme);
  }

  function setupPageTransitions() {
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const links = document.querySelectorAll("a[data-page-transition]");

    for (const link of links) {
      link.addEventListener("click", event => {
        if (
          event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey ||
          event.shiftKey || event.altKey || link.target === "_blank" || link.hasAttribute("download") ||
          reducedMotion?.matches || pageTransitionStarted
        ) return;

        const destination = new URL(link.href, window.location.href);
        if (destination.origin !== window.location.origin || destination.href === window.location.href) return;

        event.preventDefault();
        pageTransitionStarted = true;
        document.body.classList.add("page-fade-out");
        window.setTimeout(() => window.location.assign(destination.href), PAGE_FADE_DELAY_MS);
      });
    }

    window.addEventListener("pageshow", () => {
      pageTransitionStarted = false;
      document.body?.classList.remove("page-fade-out");
    });
  }

  function renderBuildWatermarks() {
    const identity = window.LDFRuntimeIdentity;
    const version = identity?.releaseToken?.match(/(?:^|-)([0-9]+\.[0-9]+\.[0-9]+)$/)?.[1] || "indisponível";
    const commit = /^[0-9a-f]{40}$/.test(identity?.sourceCommit || "")
      ? identity.sourceCommit.slice(0, 7)
      : "local";
    for (const watermark of document.querySelectorAll("[data-build-watermark]")) {
      watermark.textContent = `LDF Web · v${version} (commit ${commit})`;
    }
  }

  function showStartupBrand() {
    if (!root.classList.contains("startup-brand-pending")) return;
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const brand = document.querySelector(".app-header .brand");
    const hasAlert = () => document.querySelector(
      "#secure-context-status.warning, #secure-context-status.preparation-failed, .temporal-preflight.warning, .temporal-preflight.error, .temporal-preflight.preparation-failed"
    );
    let opening;
    let observer;
    let fallback;
    function dismiss() {
      root.classList.remove("startup-brand-pending");
      opening?.remove();
      observer?.disconnect();
      window.clearTimeout(fallback);
      window.clearTimeout(startupPreparationFallback);
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", dismiss, true);
      window.removeEventListener("pagehide", dismiss);
      reducedMotion?.removeEventListener("change", dismiss);
    }
    if (!brand || reducedMotion?.matches || hasAlert()) {
      dismiss();
      return;
    }
    opening = document.createElement("div");
    opening.className = "startup-brand";
    opening.setAttribute("aria-hidden", "true");
    opening.append(brand.cloneNode(true));
    document.body.append(opening);
    observer = new MutationObserver(() => { if (hasAlert()) dismiss(); });
    fallback = window.setTimeout(dismiss, STARTUP_FALLBACK_MS);
    opening.addEventListener("animationend", dismiss, { once: true });
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", dismiss, true);
    window.addEventListener("pagehide", dismiss, { once: true });
    reducedMotion?.addEventListener("change", dismiss, { once: true });
    observer.observe(document.querySelector("main"), { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
  }

  prepareStartupBrand();
  applyTheme(readPreference());

  document.addEventListener("DOMContentLoaded", () => {
    renderBuildWatermarks();
    updateButton(root.dataset.theme);
    setupPageTransitions();
    showStartupBrand();
    document.getElementById("theme-toggle")?.addEventListener("click", () => {
      applyTheme(root.dataset.theme === "light" ? "dark" : "light", true);
    });
  });
})();
