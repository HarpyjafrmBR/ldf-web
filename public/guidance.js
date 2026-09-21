(function () {
  "use strict";

  const root = document.getElementById("guidance-root");
  const content = window.LDFGuidanceContent;
  if (!root || !content) return;

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function renderList(items) {
    return items.map(item => {
      const lines = Array.isArray(item?.lines) ? item.lines : [item];
      return `<li>${lines.map(escapeHtml).join("<br>")}</li>`;
    }).join("");
  }

  function renderPrinciples() {
    return content.principles.map((item, index) => `
      <article class="guidance-principle">
        <span aria-hidden="true">${String(index + 1).padStart(2, "0")}</span>
        <div>
          <h3>${escapeHtml(item.title)}</h3>
          <p>${escapeHtml(item.text)}</p>
        </div>
      </article>
    `).join("");
  }

  function renderRecommendations() {
    return content.recommendations.map((item, index) => `
      <article class="guidance-recommendation" aria-labelledby="guidance-${escapeHtml(item.id)}">
        <div class="guidance-recommendation-heading">
          <span class="guidance-number" aria-hidden="true">${String(index + 1).padStart(2, "0")}</span>
          <div>
            <p>${escapeHtml(item.label)}</p>
            <h3 id="guidance-${escapeHtml(item.id)}">${escapeHtml(item.title)}</h3>
          </div>
        </div>
        <p class="guidance-summary">${escapeHtml(item.summary)}</p>
        <ul>${renderList(item.items)}</ul>
      </article>
    `).join("");
  }

  function renderSupportChannels() {
    return content.supportChannels.map(item => `
      <article class="guidance-support-item">
        <h3>${escapeHtml(item.title)}</h3>
        <p>${escapeHtml(item.text)}</p>
      </article>
    `).join("");
  }

  function renderSources() {
    return content.sources.map(item => `
      <li>
        <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.label)}</a>
      </li>
    `).join("");
  }

  /*
   * A tela é montada a partir do catálogo acima e não mantém respostas, histórico
   * ou progresso. Os links só são abertos quando o usuário escolhe uma referência.
   */
  root.innerHTML = `
    <section class="guidance-overview" aria-labelledby="guidance-overview-title">
      <p class="guidance-kicker">Ponto de partida</p>
      <h2 id="guidance-overview-title">${escapeHtml(content.introduction.title)}</h2>
      <p>${escapeHtml(content.introduction.text)}</p>
      <div class="guidance-principles">${renderPrinciples()}</div>
    </section>

    <section class="guidance-recommendations" aria-labelledby="guidance-recommendations-title">
      <div class="guidance-section-title">
        <p class="guidance-kicker">Recomendações essenciais</p>
        <h2 id="guidance-recommendations-title">O que deve orientar a sua decisão</h2>
      </div>
      <div class="guidance-recommendation-grid">${renderRecommendations()}</div>
    </section>

    <aside class="guidance-stop" aria-labelledby="guidance-stop-title">
      <div>
        <p class="guidance-kicker">Atenção</p>
        <h2 id="guidance-stop-title">${escapeHtml(content.specialistSupport.title)}</h2>
        <p>${escapeHtml(content.specialistSupport.introduction)}</p>
      </div>
      <ul>${renderList(content.specialistSupport.items)}</ul>
    </aside>

    <section class="guidance-support" aria-labelledby="guidance-support-title">
      <div class="guidance-section-title">
        <p class="guidance-kicker">Encaminhamento</p>
        <h2 id="guidance-support-title">Onde buscar apoio</h2>
      </div>
      <div class="guidance-support-grid">${renderSupportChannels()}</div>
    </section>

    <details class="guidance-references">
      <summary>Fontes confiáveis e data da revisão</summary>
      <div>
        <p>Conteúdo revisado em ${escapeHtml(content.reviewedAt)}. As referências abaixo não são carregadas automaticamente.</p>
        <ul>${renderSources()}</ul>
        <p>${escapeHtml(content.finalNote)}</p>
      </div>
    </details>

    <div class="guidance-footer-action">
      <p>Quando os arquivos já estiverem preservados e documentados, o LDF Web pode apoiar o acondicionamento e a transferência.</p>
      <button class="button primary" type="button" data-guidance-action="create">
        Ir para fechamento de lote
      </button>
    </div>
  `;

  root.addEventListener("click", event => {
    const button = event.target.closest('[data-guidance-action="create"]');
    if (button) document.querySelector('.tab-button[data-tab="create"]')?.click();
  });
})();
