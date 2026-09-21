/*
 * Gerador PDF autocontido do LDF Web.
 *
 * A aplicacao continua sem carregar bibliotecas ou fontes externas. Este modulo
 * mede os caracteres das fontes padrao do PDF, organiza o conteudo em blocos e
 * pagina cada declaracao antes de escrever os comandos finais do documento.
 */
(function () {
  "use strict";

  const PAGE_WIDTH = 595;
  const PAGE_HEIGHT = 842;
  const BODY_LEFT = 62;
  const BODY_RIGHT = 62;
  const BODY_WIDTH = PAGE_WIDTH - BODY_LEFT - BODY_RIGHT;
  const CONTENT_TOP = 758;
  const CONTENT_BOTTOM = 66;
  const MAX_WORD_SPACING = 2.2;
  const MAX_CHARACTER_SPACING = 0.12;
  const COMFORTABLE_WORD_SPACING = 1.1;
  const JUSTIFICATION_TOLERANCE = 0.25;

  const COLORS = {
    navy: "0.055 0.094 0.160",
    ink: "0.075 0.130 0.205",
    blue: "0.105 0.365 0.665",
    muted: "0.330 0.400 0.490",
    white: "1 1 1",
    green: "0.055 0.430 0.310"
  };

  window.LDFPdf = { initialDeclaration, auditDeclaration, shippingReceipt, operationTrail };

  function initialDeclaration(data) {
    const items = [];
    addTitle(items, "DECLARAÇÃO DE REGISTRO");
    addMetaPanel(items, [
      { label: "Lote", value: data.lotCode },
      { label: "Declarante", value: data.operator.name },
      { label: "CPF", value: data.operator.cpf }
    ]);
    addHashPanel(items, "SHA-256 DO CONJUNTO QUALIFICADO", data.qualifiedLotHash, {
      size: 7.2,
      after: 7
    });
    addRegistrationTemporalSummary(items, data.temporalSummary, data.issuedAt);
    addSecurityProtocol(items);
    addParagraph(
      items,
      "Declaro que realizei o registro, a qualificação e o acondicionamento técnico dos vestígios digitais discriminados neste documento, vinculando cada arquivo ao respectivo hash SHA-256 e aos dados informados durante a coleta.",
      { after: 13 }
    );

    data.evidence.forEach((item, index) => {
      const evidenceStart = items.length;
      const evidenceTitle = `MÍDIA VESTÍGIO #${index + 1}: ${item.name}`;
      addSection(items, evidenceTitle);
      addHashPanel(items, "Hash SHA-256 do arquivo", item.hash);
      addLabelValue(items, "Identificação", item.metadata.id, { indent: 8 });
      addLabelValue(items, "Natureza", item.metadata.nature, { indent: 8 });
      addLabelValue(items, "Responsável pela coleta", item.metadata.responsible, { indent: 8 });
      addLabelValue(items, "Data e hora da coleta informadas pelo declarante", item.metadata.dateTime, { indent: 8 });
      addLabelValue(items, "Localização", item.metadata.location, { indent: 8, after: 3 });
      addLabelValue(items, "Descrição detalhada", item.metadata.description, {
        indent: 8,
        stacked: true,
        justify: true,
        after: 5
      });
      addLabelValue(items, "Origem e situação da fonte", item.metadata.unavailability, {
        indent: 8,
        stacked: true,
        justify: true,
        after: 7
      });
      if (item.metadata.photos?.length) {
        addText(items, "FOTOS COMPLEMENTARES PRESERVADAS NO LOTE", {
          size: 7.8,
          font: "F2",
          color: COLORS.muted,
          indent: 8,
          leading: 11,
          keepWithNext: true
        });
        item.metadata.photos.forEach(photo => {
          addText(items, photo.name, {
            size: 8.2,
            font: "F2",
            indent: 8,
            leading: 11,
            keepWithNext: true
          });
          addHashPanel(items, "SHA-256 da foto complementar", photo.hash, {
            indent: 8,
            size: 6.9,
            after: 4
          });
        });
      }
      if (item.metadata.documents?.length) {
        addText(items, "DOCUMENTOS COMPLEMENTARES PRESERVADOS NO LOTE", {
          size: 7.8,
          font: "F2",
          color: COLORS.muted,
          indent: 8,
          leading: 11,
          keepWithNext: true
        });
        item.metadata.documents.forEach(document => {
          addText(items, document.name, {
            size: 8.2,
            font: "F2",
            indent: 8,
            leading: 11,
            keepWithNext: true
          });
          addHashPanel(items, "SHA-256 do documento complementar", document.hash, {
            indent: 8,
            size: 6.9,
            after: 4
          });
        });
      }
      markContinuation(
        items,
        evidenceStart,
        `MÍDIA VESTÍGIO #${index + 1} (CONTINUAÇÃO): ${item.name}`
      );
      addSpace(items, 6);
    });

    const responsibilityStart = items.length;
    addSection(items, "DECLARAÇÃO DE RESPONSABILIDADE");
    addParagraph(
      items,
      "Declaro que conferi integralmente as informações apresentadas e que elas são verdadeiras, exatas e correspondem aos vestígios qualificados. Comprometo-me com a guarda adequada das mídias até a transferência formal, reconhecendo que o LDF Web não substitui controles externos de custódia e armazenamento.",
      { after: 8 }
    );
    addSignature(
      items,
      "DECLARANTE",
      data.operator.name,
      data.operator.cpf
    );
    keepTogether(items, responsibilityStart);

    return buildPdf(
      `Declaração de Registro - ${data.lotCode}`,
      data.documentId,
      `Declaração de registro | Lote: ${data.lotCode}`,
      items
    );
  }

  function auditDeclaration(data) {
    const items = [];
    addTitle(items, "DECLARAÇÃO DE RECEBIMENTO");
    addMetaPanel(items, [
      { label: "Lote", value: data.lotCode },
      { label: "Recebedor", value: data.receiver.name },
      { label: "CPF", value: data.receiver.cpf },
      { label: "ID da Declaração de Registro", value: data.initialDocumentId }
    ]);
    addReceptionTemporalSummary(
      items,
      data.sealingTemporalSummary,
      data.sealedAt,
      data.openingTemporalSummary,
      data.openedAt
    );
    addParagraph(
      items,
      "Declaro que procedi à abertura do lote, à conferência dos hashes SHA-256 e à consulta dos dados informados para cada vestígio digital discriminado na Declaração de Registro identificada acima.",
      { after: 13 }
    );

    data.results.forEach((item, index) => {
      const evidenceStart = items.length;
      const evidenceTitle = `VESTÍGIO ${String(index + 1).padStart(2, "0")} | ${item.name}`;
      addSection(items, evidenceTitle);
      addComparisonPanel(items, item.expectedHash, item.actualHash, item.status);
      (item.photos ?? []).forEach(photo => {
        addText(items, `FOTO COMPLEMENTAR: ${photo.name}`, {
          size: 8.3,
          font: "F2",
          color: COLORS.navy,
          indent: 8,
          leading: 12,
          keepWithNext: true
        });
        addComparisonPanel(
          items,
          photo.expectedHash,
          photo.actualHash,
          photo.status,
          { indent: 8, after: 5 }
        );
      });
      (item.documents ?? []).forEach(document => {
        addText(items, `DOCUMENTO COMPLEMENTAR: ${document.name}`, {
          size: 8.3,
          font: "F2",
          color: COLORS.navy,
          indent: 8,
          leading: 12,
          keepWithNext: true
        });
        addComparisonPanel(
          items,
          document.expectedHash,
          document.actualHash,
          document.status,
          { indent: 8, after: 5 }
        );
      });
      markContinuation(
        items,
        evidenceStart,
        `VESTÍGIO ${String(index + 1).padStart(2, "0")} (CONTINUAÇÃO) | ${item.name}`
      );
      addSpace(items, 5);
    });

    const responsibilityStart = items.length;
    addSection(items, "DECLARAÇÃO DE RESPONSABILIDADE");
    addParagraph(
      items,
      "Declaro que conferi os resultados da abertura e que os hashes SHA-256 recalculados para os vestígios extraídos e seus arquivos complementares coincidiram com os valores registrados no momento do lacre. A partir deste recebimento, assumo a responsabilidade pela guarda, preservação e destinação adequada dos arquivos, reconhecendo que o LDF Web não substitui os controles externos de custódia e armazenamento.",
      { after: 8 }
    );
    addSignature(
      items,
      "DECLARANTE",
      data.receiver.name,
      data.receiver.cpf
    );
    keepTogether(items, responsibilityStart);

    return buildPdf(
      `Declaração de Recebimento - ${data.lotCode}`,
      data.documentId,
      `Declaração de Recebimento | Lote: ${data.lotCode}`,
      items
    );
  }

  function operationTrail(data) {
    const items = [];
    addTitle(items, "TRILHA DA OPERAÇÃO");
    addMetaPanel(items, [
      { label: "Identificação do lote", value: data.lotCode || "Não informada" },
      { label: "Data e hora informadas pelo dispositivo", value: data.generatedAt },
      { label: "Registros exibidos", value: String(data.entries.length) }
    ]);
    addParagraph(
      items,
      "Este relatório reproduz os registros que estavam visíveis na Trilha da operação no momento da emissão. A limpeza da visualização não apaga o histórico interno protegido do lote.",
      { size: 8.6, after: 12 }
    );
    addTemporalSummary(items, data.temporalSummary);
    addSection(items, "REGISTROS VISÍVEIS");
    if (!data.entries.length) {
      addText(items, "Nenhum registro estava visível no momento da emissão.", { size: 8.6 });
    } else {
      data.entries.forEach(entry => {
        addText(items, `[${entry.timestamp}] ${entry.message}`, {
          size: 7.6,
          font: "F3",
          color: entry.type === "error" ? "0.65 0.12 0.12" : entry.type === "warning" ? "0.58 0.36 0.05" : COLORS.ink,
          leading: 10.8,
          after: 2
        });
      });
    }

    return buildPdf(
      `Trilha da Operação - ${data.lotCode || "LDF"}`,
      data.documentId,
      `Trilha da operação | Lote: ${data.lotCode || "Não informado"}`,
      items,
      { footerNotice: "none" }
    );
  }

  function shippingReceipt(data) {
    const items = [];
    addTitle(items, "RECIBO DE REMESSA DO CONTÊINER LDF");
    addMetaPanel(items, [
      { label: "Identificação do lote", value: data.lotCode },
      { label: "Arquivo remetido", value: data.fileName },
      {
        label: "SHA-256 do arquivo .LDF",
        value: data.containerHash,
        fullWidth: true,
        size: 7.2
      },
      {
        label: "Confirmação da gravação",
        value: data.persistenceConfirmation === "manual"
          ? "Informada manualmente pelo operador após conferência do download"
          : "Confirmada automaticamente pela API de gravação do navegador",
        fullWidth: true
      }
    ]);

    return buildPdf(
      `Recibo de Remessa - ${data.lotCode}`,
      data.documentId,
      `Recibo de remessa | Lote: ${data.lotCode}`,
      items,
      { footerNotice: "none" }
    );
  }

  function addSpace(items, height) {
    if (height > 0) items.push({ type: "space", height });
  }

  function addText(items, text, options = {}) {
    const size = options.size ?? 9.4;
    const font = options.font ?? (options.bold ? "F2" : "F1");
    const indent = options.indent ?? 0;
    const rightIndent = options.rightIndent ?? 0;
    const leading = options.leading ?? size * 1.42;
    const maxWidth = BODY_WIDTH - indent - rightIndent;
    const lines = options.wrap === false
      ? [{ text: String(text), width: measureText(String(text), size, font) }]
      : options.justify
        ? wrapJustifiedText(text, { size, font, maxWidth })
        : wrapText(text, { size, font, maxWidth });

    lines.forEach((line, index) => {
      items.push({
        type: "text",
        text: line.text,
        naturalWidth: line.width,
        size,
        font,
        indent,
        maxWidth,
        align: options.align ?? "left",
        justified: Boolean(line.justified),
        wordSpacing: line.wordSpacing ?? 0,
        characterSpacing: line.characterSpacing ?? 0,
        color: options.color ?? COLORS.ink,
        height: leading,
        keepWithNext: Boolean(options.keepWithNext)
      });
    });
    addSpace(items, options.after ?? 0);
  }

  function addTitle(items, text) {
    addText(items, text, {
      size: 15.5,
      font: "F2",
      color: COLORS.navy,
      leading: 19,
      after: 7
    });
    items.push({ type: "rule", color: "0.20 0.47 0.76", height: 12 });
  }

  function addParagraph(items, text, options = {}) {
    addText(items, text, {
      size: options.size ?? 9.4,
      font: "F1",
      color: COLORS.ink,
      leading: options.leading ?? 13.4,
      justify: true,
      after: options.after ?? 11
    });
  }

  function createSectionItem(title) {
    const lines = wrapText(title, {
      size: 10.1,
      font: "F2",
      maxWidth: BODY_WIDTH - 24
    });
    return {
      type: "section",
      lines,
      height: 13 + lines.length * 12,
      keepWithNext: true
    };
  }

  function addSection(items, title) {
    items.push(createSectionItem(title));
  }

  function addMetaPanel(items, rows, after = 13) {
    const innerWidth = BODY_WIDTH - 24;
    const regularRows = rows.filter(row => !row.fullWidth);
    const widestLabel = Math.max(0, ...regularRows.map(row => (
      measureText(`${row.label}:`, 8.1, "F2")
    )));
    const labelWidth = Math.min(170, Math.max(110, widestLabel + 14));
    const valueWidth = innerWidth - labelWidth;
    const preparedRows = rows.map(row => {
      const size = row.size ?? 8.7;
      return {
        label: row.label,
        fullWidth: Boolean(row.fullWidth),
        size,
        lines: wrapText(row.value, {
          size,
          font: "F1",
          maxWidth: row.fullWidth ? innerWidth : valueWidth
        })
      };
    });
    const lineCount = preparedRows.reduce((total, row) => (
      total + row.lines.length + (row.fullWidth ? 1 : 0)
    ), 0);
    items.push({
      type: "metaPanel",
      rows: preparedRows,
      labelWidth,
      height: 18 + lineCount * 11.8
    });
    addSpace(items, after);
  }

  function addLabelValue(items, label, value, options = {}) {
    const indent = options.indent ?? 0;
    if (options.stacked) {
      addText(items, label.toUpperCase(), {
        size: 7.6,
        font: "F2",
        color: COLORS.muted,
        indent,
        leading: 10.5,
        keepWithNext: true
      });
      addText(items, value, {
        size: options.size ?? 8.8,
        font: "F1",
        color: COLORS.ink,
        indent: indent + 8,
        leading: options.leading ?? 12.2,
        justify: Boolean(options.justify),
        after: options.after ?? 4
      });
      return;
    }

    const size = options.size ?? 8.8;
    const labelText = `${label}:`;
    const labelWidth = measureText(`${labelText} `, size, "F2");
    const availableWidth = BODY_WIDTH - indent - labelWidth;
    const lines = wrapText(value, { size, font: "F1", maxWidth: availableWidth });
    const leading = options.leading ?? 12;

    items.push({
      type: "labelValue",
      label: labelText,
      value: lines[0]?.text ?? "",
      size,
      indent,
      labelWidth,
      color: options.color ?? COLORS.ink,
      height: leading,
      keepWithNext: Boolean(options.keepWithNext)
    });
    lines.slice(1).forEach(line => {
      items.push({
        type: "text",
        text: line.text,
        naturalWidth: line.width,
        size,
        font: "F1",
        indent: indent + labelWidth,
        maxWidth: availableWidth,
        align: "left",
        justify: false,
        color: options.color ?? COLORS.ink,
        height: leading
      });
    });
    addSpace(items, options.after ?? 1);
  }

  function addHashPanel(items, label, hash, options = {}) {
    const indent = options.indent ?? 0;
    const width = BODY_WIDTH - indent - (options.rightIndent ?? 0);
    const hashLines = wrapText(hash, {
      size: options.size ?? 7.35,
      font: "F1",
      maxWidth: width - 24
    });
    items.push({
      type: "hashPanel",
      label,
      hashLines,
      indent,
      width,
      size: options.size ?? 7.35,
      height: 22 + hashLines.length * 10
    });
    addSpace(items, options.after ?? 6);
  }

  function addTemporalSummary(items, summary) {
    if (!summary?.referenceAvailable) return;
    addText(items, "REFERÊNCIA TEMPORAL AUXILIAR", {
      size: 7.4,
      font: "F2",
      color: COLORS.muted,
      leading: 10,
      keepWithNext: true
    });
    addText(items, "Este registro auxilia a conferência e não constitui carimbo do tempo.", {
      size: 7.4,
      color: COLORS.muted,
      leading: 10.5,
      keepWithNext: true
    });
    const technicalLines = [
      `Referência UTC estimada: ${summary.referenceTimeIso || summary.referenceTime || "Não disponível"}.`,
      `Origem e protocolo: ${summary.referenceOrigin || "Não disponível"} (${summary.referenceProtocol || "não disponível"}). RTT: ${Number.isFinite(summary.referenceRoundTripMs) ? `${Math.round(summary.referenceRoundTripMs)} ms` : "não disponível"}; incerteza estimada: ${Number.isFinite(summary.referenceUncertaintyMs) ? `${Math.round(summary.referenceUncertaintyMs)} ms` : "não disponível"}.`,
      `Dispositivo na observação: ${summary.observedAtDeviceLocal || summary.observedDeviceTime || "Não disponível"}; offset ${summary.currentUtcOffset || "não disponível"}; zona ${summary.currentTimeZone || "não disponível"}.`,
      `Diferença total estimada: ${Number.isFinite(summary.referenceDifferenceSeconds) ? `${summary.referenceDifferenceSeconds} s` : "não disponível"}. Situação: ${summary.statusText || "não determinada"}.`
    ];
    technicalLines.forEach((line, index) => {
      addText(items, line, {
        size: 7.4,
        color: COLORS.muted,
        leading: 10.5,
        keepWithNext: index < technicalLines.length - 1,
        after: index === technicalLines.length - 1 ? 9 : 0
      });
    });
  }

  function addTemporalReferenceBlock(items, lines) {
    addText(items, "REFERÊNCIA TEMPORAL AUXILIAR", {
      size: 7.4,
      font: "F2",
      color: COLORS.muted,
      leading: 10,
      keepWithNext: true
    });
    addText(items, "Este registro auxilia a conferência e não constitui carimbo do tempo.", {
      size: 7.4,
      color: COLORS.muted,
      leading: 10.5,
      keepWithNext: true
    });
    lines.forEach((line, index) => {
      addText(items, line, {
        size: 7.4,
        color: COLORS.muted,
        leading: 10.5,
        keepWithNext: index < lines.length - 1,
        after: index === lines.length - 1 ? 9 : 0
      });
    });
  }

  function temporalReferenceTime(summary) {
    return summary?.referenceAvailable && summary.referenceTime
      ? summary.referenceTime
      : "Não disponível";
  }

  function addRegistrationTemporalSummary(items, summary, issuedAt) {
    if (!summary?.referenceAvailable) return;
    addTemporalReferenceBlock(items, [
      `Referência técnica inicial para o fechamento: ${temporalReferenceTime(summary)}.`,
      `Data e hora informadas pelo dispositivo na emissão da declaração: ${issuedAt}.`
    ]);
  }

  function addReceptionTemporalSummary(items, sealingSummary, sealedAt, openingSummary, openedAt) {
    if (!sealingSummary?.referenceAvailable || !openingSummary?.referenceAvailable) return;
    addTemporalReferenceBlock(items, [
      `Referência técnica inicial para o fechamento: ${temporalReferenceTime(sealingSummary)}.`,
      `Data e hora informadas pelo dispositivo no início do lacre e salvamento: ${sealedAt}.`,
      `Referência técnica inicial para a abertura: ${temporalReferenceTime(openingSummary)}.`,
      `Data e hora informadas pelo dispositivo na conclusão da abertura: ${openedAt}.`
    ]);
  }

  function addSecurityProtocol(items) {
    addText(items, "PROTOCOLOS DE SEGURANÇA", {
      size: 7.4,
      font: "F2",
      color: COLORS.muted,
      leading: 10,
      keepWithNext: true
    });
    addText(
      items,
      "Antes do lacre, cada vestígio é vinculado ao respectivo hash SHA-256. Em seguida, o conjunto de dados e registros da operação é encapsulado no contêiner LDF Web e protegido por criptografia autenticada AES-256-GCM, com chave derivada localmente por PBKDF2-SHA-256.",
      {
        size: 7.4,
        color: COLORS.muted,
        leading: 10.5,
        justify: true,
        after: 9
      }
    );
  }

  function addComparisonPanel(items, expectedHash, actualHash, status, options = {}) {
    items.push({
      type: "comparisonPanel",
      expectedHash,
      actualHash,
      status,
      indent: options.indent ?? 0,
      height: 58
    });
    addSpace(items, options.after ?? 7);
  }

  function addSignature(items, role, name, cpf, caption = "") {
    const identityLines = wrapText(`${role}: ${name}`, {
      size: 8.8,
      font: "F2",
      maxWidth: BODY_WIDTH
    });
    items.push({
      type: "signature",
      identityLines,
      cpf,
      caption,
      height: (caption ? 59 : 46) + identityLines.length * 13
    });
  }

  /*
   * Alguns trechos perdem clareza quando uma quebra de pagina separa a
   * declaracao de responsabilidade de sua assinatura. Este marcador permite
   * que o paginador mova o conjunto inteiro para a pagina seguinte.
   */
  function keepTogether(items, startIndex) {
    keepGroupCounter += 1;
    const group = `keep-${keepGroupCounter}`;
    for (let index = startIndex; index < items.length; index += 1) {
      items[index].keepGroup = group;
    }
  }

  function keepGroupHeight(items, startIndex, group) {
    let height = 0;
    for (let index = startIndex; index < items.length; index += 1) {
      if (items[index].keepGroup !== group) break;
      height += items[index].height;
    }
    return height;
  }

  /*
   * Quando uma ficha extensa atravessa paginas, a faixa de continuacao repete
   * qual vestigio esta sendo descrito. Isso evita que campos ou fotografias
   * aparecam isolados, sem contexto, no inicio da pagina seguinte.
   */
  function markContinuation(items, startIndex, title) {
    continuationGroupCounter += 1;
    const group = `continuation-${continuationGroupCounter}`;
    for (let index = startIndex; index < items.length; index += 1) {
      items[index].continuationGroup = group;
      items[index].continuationTitle = title;
    }
  }

  function nextContentHeight(items, startIndex) {
    for (let index = startIndex; index < items.length; index += 1) {
      if (items[index].type !== "space") return items[index].height;
    }
    return 0;
  }

  function paginate(items) {
    const pages = [[]];
    let cursor = CONTENT_TOP;

    items.forEach((item, index) => {
      if (item.type === "space" && pages[pages.length - 1].length === 0) return;
      if (item.type === "space" && cursor - item.height < CONTENT_BOTTOM) return;
      const beginsKeepGroup = item.keepGroup
        && items[index - 1]?.keepGroup !== item.keepGroup;
      let reserved = item.height;
      if (beginsKeepGroup) {
        reserved = keepGroupHeight(items, index, item.keepGroup);
      } else if (item.keepWithNext) {
        reserved += nextContentHeight(items, index + 1);
      }
      if (cursor - reserved < CONTENT_BOTTOM) {
        const continuesPreviousGroup = item.continuationGroup
          && items[index - 1]?.continuationGroup === item.continuationGroup;
        pages.push([]);
        cursor = CONTENT_TOP;
        if (item.type === "space") return;
        if (continuesPreviousGroup) {
          const continuation = createSectionItem(item.continuationTitle);
          pages[pages.length - 1].push({ ...continuation, top: cursor });
          cursor -= continuation.height;
        }
      }
      pages[pages.length - 1].push({ ...item, top: cursor });
      cursor -= item.height;
    });
    return pages;
  }

  function number(value) {
    return Number(value).toFixed(2).replace(/\.00$/, "");
  }

  function spacingNumber(value) {
    return Number(value).toFixed(4).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
  }

  function textCommand(text, {
    font,
    size,
    x,
    y,
    color,
    wordSpacing = 0,
    characterSpacing = 0
  }) {
    const characterSpacingCommand = characterSpacing > 0
      ? ` ${spacingNumber(characterSpacing)} Tc`
      : "";
    const command = `BT /${font} ${number(size)} Tf ${spacingNumber(wordSpacing)} Tw${characterSpacingCommand} ${color} rg 1 0 0 1 ${number(x)} ${number(y)} Tm (${pdfText(text)}) Tj ET`;
    return characterSpacing > 0 ? `q ${command} Q` : command;
  }

  function rightAlignedX(text, size, font, rightEdge) {
    return rightEdge - measureText(text, size, font);
  }

  function drawTextItem(commands, item) {
    const wordSpacing = item.wordSpacing ?? 0;
    const characterSpacing = item.characterSpacing ?? 0;

    let x = BODY_LEFT + item.indent;
    const renderedWidth = measureText(
      item.text,
      item.size,
      item.font,
      wordSpacing,
      characterSpacing
    );
    if (item.align === "center") x += (item.maxWidth - renderedWidth) / 2;
    if (item.align === "right") x += item.maxWidth - renderedWidth;
    commands.push(textCommand(item.text, {
      font: item.font,
      size: item.size,
      x,
      y: item.top - item.size,
      color: item.color,
      wordSpacing,
      characterSpacing
    }));
  }

  function drawLabelValueItem(commands, item) {
    const baseline = item.top - item.size;
    const x = BODY_LEFT + item.indent;
    commands.push(textCommand(item.label, {
      font: "F2", size: item.size, x, y: baseline, color: item.color
    }));
    commands.push(textCommand(item.value, {
      font: "F1",
      size: item.size,
      x: x + item.labelWidth,
      y: baseline,
      color: item.color
    }));
  }

  function drawRuleItem(commands, item) {
    const y = item.top - 3;
    commands.push(`q ${item.color} RG 0.8 w ${BODY_LEFT} ${number(y)} m ${PAGE_WIDTH - BODY_RIGHT} ${number(y)} l S Q`);
  }

  function drawSectionItem(commands, item) {
    const y = item.top - item.height + 3;
    commands.push(`q 0.945 0.968 0.992 rg ${BODY_LEFT} ${number(y)} ${BODY_WIDTH} ${item.height - 5} re f Q`);
    commands.push(`q 0.105 0.365 0.665 rg ${BODY_LEFT} ${number(y)} 3 ${item.height - 5} re f Q`);
    let baseline = item.top - 15.5;
    item.lines.forEach(line => {
      commands.push(textCommand(line.text, {
        font: "F2", size: 10.1, x: BODY_LEFT + 12, y: baseline, color: COLORS.navy
      }));
      baseline -= 12;
    });
  }

  function drawMetaPanelItem(commands, item) {
    const y = item.top - item.height;
    commands.push(`q 0.965 0.974 0.984 rg ${BODY_LEFT} ${number(y)} ${BODY_WIDTH} ${item.height} re f Q`);
    commands.push(`q 0.105 0.365 0.665 rg ${BODY_LEFT} ${number(y)} 3 ${item.height} re f Q`);
    let baseline = item.top - 14;
    item.rows.forEach(row => {
      if (row.fullWidth) {
        commands.push(textCommand(`${row.label}:`, {
          font: "F2", size: 8.1, x: BODY_LEFT + 12, y: baseline, color: COLORS.muted
        }));
        baseline -= 11.8;
        row.lines.forEach(line => {
          commands.push(textCommand(line.text, {
            font: "F1",
            size: row.size,
            x: BODY_LEFT + 12,
            y: baseline,
            color: COLORS.ink
          }));
          baseline -= 11.8;
        });
        return;
      }
      row.lines.forEach((line, index) => {
        if (index === 0) {
          commands.push(textCommand(`${row.label}:`, {
            font: "F2", size: 8.1, x: BODY_LEFT + 12, y: baseline, color: COLORS.muted
          }));
        }
        commands.push(textCommand(line.text, {
          font: "F1",
          size: row.size,
          x: BODY_LEFT + 12 + item.labelWidth,
          y: baseline,
          color: COLORS.ink
        }));
        baseline -= 11.8;
      });
    });
  }

  function drawHashPanelItem(commands, item) {
    const x = BODY_LEFT + item.indent;
    const y = item.top - item.height;
    commands.push(`q 0.967 0.975 0.983 rg ${number(x)} ${number(y)} ${number(item.width)} ${item.height} re f Q`);
    commands.push(`q 0.105 0.365 0.665 rg ${number(x)} ${number(y)} 3 ${item.height} re f Q`);
    commands.push(textCommand(item.label.toUpperCase(), {
      font: "F2", size: 7.2, x: x + 12, y: item.top - 11, color: COLORS.muted
    }));
    let baseline = item.top - 23;
    item.hashLines.forEach(line => {
      commands.push(textCommand(line.text, {
        font: "F1", size: item.size, x: x + 12, y: baseline, color: COLORS.ink
      }));
      baseline -= 10;
    });
  }

  function drawComparisonPanelItem(commands, item) {
    const x = BODY_LEFT + item.indent;
    const width = BODY_WIDTH - item.indent;
    const y = item.top - item.height;
    commands.push(`q 0.967 0.975 0.983 rg ${number(x)} ${number(y)} ${number(width)} ${item.height} re f Q`);
    commands.push(textCommand("HASH REGISTRADO", {
      font: "F2", size: 6.9, x: x + 12, y: item.top - 13, color: COLORS.muted
    }));
    commands.push(textCommand(item.expectedHash, {
      font: "F1", size: 6.7, x: x + 87, y: item.top - 13, color: COLORS.ink
    }));
    commands.push(textCommand("HASH CALCULADO", {
      font: "F2", size: 6.9, x: x + 12, y: item.top - 27, color: COLORS.muted
    }));
    commands.push(textCommand(item.actualHash, {
      font: "F1", size: 6.7, x: x + 87, y: item.top - 27, color: COLORS.ink
    }));
    commands.push(`q 0.900 0.970 0.945 rg ${number(x + 8)} ${number(y + 7)} ${number(width - 16)} 16 re f Q`);
    commands.push(textCommand(`RESULTADO: ${item.status}`, {
      font: "F2", size: 7.4, x: x + 14, y: y + 11.5, color: COLORS.green
    }));
  }

  function drawSignatureItem(commands, item) {
    const lineY = item.top - 28;
    commands.push(`q 0.22 0.29 0.38 RG 0.8 w ${BODY_LEFT} ${number(lineY)} m ${BODY_LEFT + 255} ${number(lineY)} l S Q`);
    let baseline = lineY - 14;
    item.identityLines.forEach(line => {
      commands.push(textCommand(line.text, {
        font: "F2", size: 8.8, x: BODY_LEFT, y: baseline, color: COLORS.navy
      }));
      baseline -= 13;
    });
    commands.push(textCommand(`CPF: ${item.cpf}`, {
      font: "F1", size: 8.3, x: BODY_LEFT, y: baseline, color: COLORS.ink
    }));
    if (item.caption) {
      commands.push(textCommand(item.caption, {
        font: "F1", size: 7.8, x: BODY_LEFT, y: baseline - 13, color: COLORS.muted
      }));
    }
  }

  const pageItemRenderers = Object.freeze({
    text: drawTextItem,
    labelValue: drawLabelValueItem,
    rule: drawRuleItem,
    section: drawSectionItem,
    metaPanel: drawMetaPanelItem,
    hashPanel: drawHashPanelItem,
    comparisonPanel: drawComparisonPanelItem,
    signature: drawSignatureItem
  });

  function drawPageItem(commands, item) {
    pageItemRenderers[item.type]?.(commands, item);
  }

  function rotatedWatermarkCommand(text, size, centerX, centerY) {
    const diagonal = Math.SQRT1_2;
    const width = measureText(text, size, "F2");
    const x = centerX - diagonal * width / 2;
    const y = centerY - diagonal * width / 2;
    return `q 0.965 g BT /F2 ${size} Tf ${number(diagonal)} ${number(diagonal)} -${number(diagonal)} ${number(diagonal)} ${number(x)} ${number(y)} Tm (${pdfText(text)}) Tj ET Q`;
  }

  function pageStream(pageItems, context) {
    const { header, documentId, pageNumber, totalPages, footerNotice } = context;
    const pageLabel = `${pageNumber}/${totalPages}`;
    const idLine = `Documento gerado localmente pelo LDF Web | ID: ${documentId}`;
    const watermarkOffset = 22;
    const commands = [
      `q ${COLORS.navy} rg 0 790 ${PAGE_WIDTH} 52 re f Q`,
      textCommand("LDF - LACRE DIGITAL FORENSE", {
        font: "F2", size: 13, x: BODY_LEFT, y: 812, color: COLORS.white
      }),
      textCommand(header, {
        font: "F1", size: 8, x: BODY_LEFT, y: 798, color: "0.82 0.87 0.93"
      }),
      rotatedWatermarkCommand(
        "LACRE DIGITAL",
        38,
        PAGE_WIDTH / 2 - Math.SQRT1_2 * watermarkOffset,
        PAGE_HEIGHT / 2 + Math.SQRT1_2 * watermarkOffset
      ),
      rotatedWatermarkCommand(
        "FORENSE",
        38,
        PAGE_WIDTH / 2 + Math.SQRT1_2 * watermarkOffset,
        PAGE_HEIGHT / 2 - Math.SQRT1_2 * watermarkOffset
      ),
      `q 0.35 0.42 0.50 RG 0.8 w ${BODY_LEFT} 50 m ${PAGE_WIDTH - BODY_RIGHT} 50 l S Q`
    ];

    if (footerNotice === "validation") {
      commands.push(
        textCommand(
          "É imprescindível validar a assinatura eletrônica das Declarações no serviço VALIDAR do Governo Federal:",
          { font: "F1", size: 6.2, x: BODY_LEFT, y: 38, color: COLORS.muted }
        ),
        textCommand("https://validar.iti.gov.br/", {
          font: "F1", size: 6.2, x: BODY_LEFT, y: 28, color: COLORS.blue
        })
      );
    }
    commands.push(
      textCommand(idLine, {
        font: "F1", size: 6.1, x: BODY_LEFT, y: 17, color: COLORS.muted
      }),
      textCommand(pageLabel, {
        font: "F1",
        size: 6.2,
        x: rightAlignedX(pageLabel, 6.2, "F1", PAGE_WIDTH - BODY_RIGHT),
        y: 17,
        color: COLORS.muted
      })
    );

    pageItems.forEach(item => drawPageItem(commands, item));
    return commands.join("\n");
  }

  /*
   * A serialização permanece estritamente ASCII: escapes octais, /Length e
   * offsets do xref são calculados sobre os mesmos code units gravados no Blob.
   */
  function buildPdf(title, documentId, header, items, options = {}) {
    const pages = paginate(items);
    const objects = [];
    const pageObjectIds = [];

    objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
    objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
    objects[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
    objects[5] = "<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>";
    objects[6] = "<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>";

    let nextId = 7;
    pages.forEach((page, index) => {
      const pageId = nextId++;
      const contentId = nextId++;
      pageObjectIds.push(pageId);
      const stream = pageStream(page, {
        header,
        documentId,
        pageNumber: index + 1,
        totalPages: pages.length,
        footerNotice: options.footerNotice ?? "validation"
      });
      objects[contentId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
      objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R /F4 6 0 R >> >> /Contents ${contentId} 0 R >>`;
    });

    objects[2] = `<< /Type /Pages /Count ${pages.length} /Kids [${pageObjectIds.map(id => `${id} 0 R`).join(" ")}] >>`;
    const infoId = nextId++;
    objects[infoId] = `<< /Title (${pdfText(title)}) /Author (${pdfText("LDF - Lacre Digital Forense")}) /Subject (${pdfText(documentId)}) /Keywords (${pdfText(`LDF;${documentId}`)}) >>`;

    let pdf = "%PDF-1.4\n";
    const offsets = [0];
    for (let id = 1; id < nextId; id += 1) {
      offsets[id] = pdf.length;
      pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
    }
    const xrefOffset = pdf.length;
    pdf += `xref\n0 ${nextId}\n0000000000 65535 f \n`;
    for (let id = 1; id < nextId; id += 1) {
      pdf += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
    }
    pdf += `trailer\n<< /Size ${nextId} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
    return new Blob([pdf], { type: "application/pdf" });
  }

  /*
   * Helvetica e Helvetica-Bold fazem parte das fontes padrao do PDF. As
   * larguras abaixo, expressas em milesimos da unidade tipografica, permitem
   * quebrar linhas pela largura real em vez de estimar pela quantidade de
   * caracteres.
   */
  function assignWidths(target, characters, width) {
    for (const character of characters) target[character] = width;
  }

  function makeHelveticaWidths(bold = false) {
    const widths = {
      " ": 278, "!": 278, "\"": bold ? 474 : 355, "#": 556, "$": 556,
      "%": 889, "&": bold ? 722 : 667, "'": 191, "(": 333, ")": 333,
      "*": 389, "+": 584, ",": 278, "-": 333, ".": 278, "/": 278,
      ":": 278, ";": 278, "<": 584, "=": 584, ">": 584, "?": 556,
      "@": bold ? 975 : 1015, "[": 278, "\\": 278, "]": 278,
      "^": 469, "_": 556, "`": 333, "{": 334, "|": 260, "}": 334,
      "~": 584
    };
    assignWidths(widths, "0123456789", 556);

    Object.assign(widths, bold ? {
      A: 722, B: 722, C: 722, D: 722, E: 667, F: 611, G: 778,
      H: 722, I: 278, J: 556, K: 722, L: 611, M: 833, N: 722,
      O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611, U: 722,
      V: 667, W: 944, X: 667, Y: 667, Z: 611,
      a: 556, b: 611, c: 556, d: 611, e: 556, f: 333, g: 611,
      h: 611, i: 278, j: 278, k: 556, l: 278, m: 889, n: 611,
      o: 611, p: 611, q: 611, r: 389, s: 556, t: 333, u: 611,
      v: 556, w: 778, x: 556, y: 556, z: 500
    } : {
      A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778,
      H: 722, I: 278, J: 500, K: 667, L: 556, M: 833, N: 722,
      O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611, U: 722,
      V: 667, W: 944, X: 667, Y: 667, Z: 611,
      a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556,
      h: 556, i: 222, j: 222, k: 500, l: 222, m: 833, n: 556,
      o: 556, p: 556, q: 556, r: 333, s: 500, t: 278, u: 556,
      v: 500, w: 722, x: 500, y: 500, z: 500
    });
    return widths;
  }

  const REGULAR_WIDTHS = makeHelveticaWidths(false);
  const BOLD_WIDTHS = makeHelveticaWidths(true);
  let keepGroupCounter = 0;
  let continuationGroupCounter = 0;

  function baseGlyph(character) {
    const substitutions = {
      "Ç": "C", "ç": "c", "Ð": "D", "ð": "d", "Ñ": "N", "ñ": "n",
      "Ø": "O", "ø": "o", "Œ": "O", "œ": "o", "Š": "S", "š": "s",
      "Ž": "Z", "ž": "z", "Ý": "Y", "ý": "y", "ÿ": "y",
      "ª": "a", "º": "o"
    };
    if (substitutions[character]) return substitutions[character];
    const normalized = character.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    return normalized[0] || character;
  }

  function measureText(text, size, font = "F1", wordSpacing = 0, characterSpacing = 0) {
    const value = String(text);
    const characterGaps = Math.max(0, value.length - 1);
    if (font === "F3" || font === "F4") {
      return value.length * size * 0.6
        + (value.match(/ /g) || []).length * wordSpacing
        + characterGaps * characterSpacing;
    }
    const widths = font === "F2" ? BOLD_WIDTHS : REGULAR_WIDTHS;
    let total = 0;
    for (const character of value) {
      total += widths[baseGlyph(character)] ?? 556;
    }
    return total * size / 1000
      + (value.match(/ /g) || []).length * wordSpacing
      + characterGaps * characterSpacing;
  }

  function pdfText(value) {
    const substitutions = {
      "–": "-", "—": "-", "“": "\"", "”": "\"", "‘": "'", "’": "'",
      "•": "-", "…": "..."
    };
    let output = "";
    for (const originalCharacter of String(value ?? "")) {
      const character = substitutions[originalCharacter] ?? originalCharacter;
      for (const unit of character) {
        const code = unit.codePointAt(0);
        if (unit === "\\" || unit === "(" || unit === ")") {
          output += `\\${unit}`;
        } else if (code >= 32 && code <= 126) {
          output += unit;
        } else if (code <= 255) {
          output += `\\${code.toString(8).padStart(3, "0")}`;
        } else {
          output += "?";
        }
      }
    }
    return output;
  }

  function splitLongToken(token, maxWidth, size, font) {
    const pieces = [];
    let current = "";
    for (const character of token) {
      const candidate = current + character;
      if (current && measureText(candidate, size, font) > maxWidth) {
        pieces.push(current);
        current = character;
      } else {
        current = candidate;
      }
    }
    if (current) pieces.push(current);
    return pieces.length ? pieces : [""];
  }

  function tokenizeJustifiedText(text) {
    const words = String(text ?? "").trim().split(/\s+/).filter(Boolean);
    const tokens = [];
    for (let index = 0; index < words.length; index += 1) {
      const next = words[index + 1] ?? "";
      if (words[index] === "LDF" && /^Web(?:[.,;:!?)]*)$/.test(next)) {
        tokens.push(`LDF ${next}`);
        index += 1;
      } else {
        tokens.push(words[index]);
      }
    }
    return tokens;
  }

  function floorSpacing(value) {
    return Math.floor(Math.max(0, value) * 10000 + 1e-9) / 10000;
  }

  function resolveJustificationSpacing(naturalWidth, maxWidth, spaceCount, characterGaps) {
    const deficit = Math.max(0, maxWidth - naturalWidth);
    if (deficit <= JUSTIFICATION_TOLERANCE) {
      return {
        feasible: true,
        wordSpacing: 0,
        characterSpacing: 0,
        residual: deficit
      };
    }
    if (spaceCount < 1) {
      return {
        feasible: false,
        wordSpacing: 0,
        characterSpacing: 0,
        residual: deficit
      };
    }
    const capacity = spaceCount * MAX_WORD_SPACING
      + characterGaps * MAX_CHARACTER_SPACING;
    if (deficit > capacity + JUSTIFICATION_TOLERANCE) {
      return {
        feasible: false,
        wordSpacing: 0,
        characterSpacing: 0,
        residual: deficit
      };
    }

    let wordSpacing = Math.min(COMFORTABLE_WORD_SPACING, deficit / spaceCount);
    let remaining = deficit - spaceCount * wordSpacing;
    let characterSpacing = characterGaps > 0
      ? Math.min(MAX_CHARACTER_SPACING, remaining / characterGaps)
      : 0;
    remaining -= characterGaps * characterSpacing;
    if (remaining > 0) {
      wordSpacing += Math.min(
        MAX_WORD_SPACING - wordSpacing,
        remaining / spaceCount
      );
    }

    wordSpacing = floorSpacing(Math.min(MAX_WORD_SPACING, wordSpacing));
    characterSpacing = floorSpacing(Math.min(MAX_CHARACTER_SPACING, characterSpacing));
    const renderedWidth = naturalWidth
      + spaceCount * wordSpacing
      + characterGaps * characterSpacing;
    const residual = Math.max(0, maxWidth - renderedWidth);
    return {
      feasible: residual <= JUSTIFICATION_TOLERANCE,
      wordSpacing: residual <= JUSTIFICATION_TOLERANCE ? wordSpacing : 0,
      characterSpacing: residual <= JUSTIFICATION_TOLERANCE ? characterSpacing : 0,
      residual: residual <= JUSTIFICATION_TOLERANCE ? residual : deficit
    };
  }

  function justifiedLineCost(metrics, naturalWidth, maxWidth, isFinal, remainingTokens, start) {
    const shortfallRatio = Math.max(0, maxWidth - naturalWidth) / maxWidth;
    if (isFinal) {
      const widowPenalty = start > 0 && remainingTokens <= 2 ? 18 : 0;
      return widowPenalty + shortfallRatio * shortfallRatio * 12;
    }
    if (!metrics.feasible) {
      return 1000000 + shortfallRatio * shortfallRatio * 1000;
    }
    const wordIntensity = metrics.wordSpacing / MAX_WORD_SPACING;
    const characterIntensity = metrics.characterSpacing / MAX_CHARACTER_SPACING;
    return wordIntensity * wordIntensity * 8
      + characterIntensity * characterIntensity * 3
      + metrics.residual * metrics.residual
      + 0.01;
  }

  function prepareJustifiedFallback(tokens, options) {
    const { size, font, maxWidth } = options;
    const lines = [];
    let current = "";
    const pushCurrent = () => {
      if (!current) return;
      lines.push({ text: current, width: measureText(current, size, font) });
      current = "";
    };

    tokens.forEach(token => {
      if (measureText(token, size, font) > maxWidth) {
        pushCurrent();
        const pieces = splitLongToken(token, maxWidth, size, font);
        pieces.forEach((piece, index) => {
          if (index < pieces.length - 1) {
            lines.push({ text: piece, width: measureText(piece, size, font) });
          } else {
            current = piece;
          }
        });
        return;
      }
      const candidate = current ? `${current} ${token}` : token;
      if (current && measureText(candidate, size, font) > maxWidth) pushCurrent();
      current = current ? `${current} ${token}` : token;
    });
    pushCurrent();

    return lines.map((line, index) => {
      const isFinal = index === lines.length - 1;
      const spacing = isFinal
        ? { feasible: true, wordSpacing: 0, characterSpacing: 0 }
        : resolveJustificationSpacing(
          line.width,
          maxWidth,
          (line.text.match(/ /g) || []).length,
          Math.max(0, line.text.length - 1)
        );
      return {
        ...line,
        wordSpacing: spacing.wordSpacing,
        characterSpacing: spacing.characterSpacing,
        justified: !isFinal
          && spacing.feasible
          && (spacing.wordSpacing > 0 || spacing.characterSpacing > 0)
      };
    });
  }

  function wrapJustifiedText(text, options = {}) {
    const size = options.size ?? 9.4;
    const font = options.font ?? "F1";
    const maxWidth = options.maxWidth ?? BODY_WIDTH;
    const tokens = tokenizeJustifiedText(text);
    if (!tokens.length) {
      return [{
        text: "",
        width: 0,
        wordSpacing: 0,
        characterSpacing: 0,
        justified: false
      }];
    }
    if (tokens.some(token => measureText(token, size, font) > maxWidth)) {
      return prepareJustifiedFallback(tokens, { size, font, maxWidth });
    }

    const tokenWidths = tokens.map(token => measureText(token, size, font));
    const tokenSpaces = tokens.map(token => (token.match(/ /g) || []).length);
    const spaceWidth = measureText(" ", size, font);
    const dynamic = Array(tokens.length + 1).fill(null);
    dynamic[tokens.length] = { cost: 0, next: tokens.length };

    for (let start = tokens.length - 1; start >= 0; start -= 1) {
      let naturalWidth = 0;
      let characterCount = 0;
      let spaceCount = 0;
      for (let end = start; end < tokens.length; end += 1) {
        if (end > start) {
          naturalWidth += spaceWidth;
          characterCount += 1;
          spaceCount += 1;
        }
        naturalWidth += tokenWidths[end];
        characterCount += tokens[end].length;
        spaceCount += tokenSpaces[end];
        if (naturalWidth > maxWidth + 1e-7) break;
        if (!dynamic[end + 1]) continue;

        const isFinal = end === tokens.length - 1;
        const metrics = isFinal
          ? { feasible: true, wordSpacing: 0, characterSpacing: 0, residual: 0 }
          : resolveJustificationSpacing(
            naturalWidth,
            maxWidth,
            spaceCount,
            Math.max(0, characterCount - 1)
          );
        const cost = dynamic[end + 1].cost + justifiedLineCost(
          metrics,
          naturalWidth,
          maxWidth,
          isFinal,
          tokens.length - start,
          start
        );
        const current = dynamic[start];
        if (!current
          || cost < current.cost - 1e-9
          || (Math.abs(cost - current.cost) <= 1e-9 && end + 1 > current.next)) {
          dynamic[start] = {
            cost,
            next: end + 1,
            naturalWidth,
            metrics,
            isFinal
          };
        }
      }
    }

    if (!dynamic[0]) return prepareJustifiedFallback(tokens, { size, font, maxWidth });
    const lines = [];
    let start = 0;
    while (start < tokens.length) {
      const decision = dynamic[start];
      const lineText = tokens.slice(start, decision.next).join(" ");
      lines.push({
        text: lineText,
        width: decision.naturalWidth,
        wordSpacing: decision.isFinal ? 0 : decision.metrics.wordSpacing,
        characterSpacing: decision.isFinal ? 0 : decision.metrics.characterSpacing,
        justified: !decision.isFinal
          && decision.metrics.feasible
          && (decision.metrics.wordSpacing > 0 || decision.metrics.characterSpacing > 0)
      });
      start = decision.next;
    }
    return lines;
  }

  function wrapText(text, options = {}) {
    const size = options.size ?? 9.4;
    const font = options.font ?? "F1";
    const maxWidth = options.maxWidth ?? BODY_WIDTH;
    const words = String(text ?? "").trim().split(/\s+/).filter(Boolean);
    if (!words.length) return [{ text: "", width: 0 }];

    const lines = [];
    let current = "";
    for (const word of words) {
      const pieces = measureText(word, size, font) > maxWidth
        ? splitLongToken(word, maxWidth, size, font)
        : [word];

      pieces.forEach((piece, pieceIndex) => {
        const candidate = current ? `${current} ${piece}` : piece;
        if (current && measureText(candidate, size, font) > maxWidth) {
          lines.push({ text: current, width: measureText(current, size, font) });
          current = piece;
        } else {
          current = candidate;
        }

        if (pieces.length > 1 && pieceIndex < pieces.length - 1) {
          lines.push({ text: current, width: measureText(current, size, font) });
          current = "";
        }
      });
    }
    if (current) lines.push({ text: current, width: measureText(current, size, font) });
    return lines;
  }

})();
