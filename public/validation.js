(function () {
  "use strict";

  const FORMAT = "LDF-WEB-1";
  const MANIFEST_PROFILE = "LDF-MANIFEST-1";
  const QUALIFIED_LOT_PROFILE = "LDF-QUALIFIED-LOT-1";
  const MAX_PDF_BYTES = 64 * 1024 * 1024;
  const MAX_EVIDENCE = 400;
  const MAX_ATTACHMENTS_PER_EVIDENCE = 10;
  const MAX_AUDIT_EVENTS = 4000;
  const MAX_FILE_NAME = 255;
  const MAX_TEXT = 4000;
  const SIGNED_DECLARATION_FILE_PREFIX = "Declaracao_Registro_";
  const REVIEW_DECLARATION_FILE_PREFIX = "Declaracao_Registro_Para_Conferencia_";
  const SHA256_RE = /^[a-f0-9]{64}$/;
  const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
  const INVALID_MANIFEST_MESSAGE = "O manifesto protegido do contêiner é inválido ou incompatível.";
  const INVALID_PDF_MESSAGE = "A declaração selecionada não possui um envelope PDF válido.";

  window.LDFValidation = Object.freeze({
    FORMAT,
    MANIFEST_PROFILE,
    MAX_PDF_BYTES,
    MAX_EVIDENCE,
    MAX_TEXT,
    signedDeclarationFileName,
    reviewDeclarationFileName,
    inspectPdf,
    validateManifest,
    validateDraftManifest,
    validateQualifiedLotRecord,
    validateProductionQualifiedLotRecord,
    qualifiedLotRecordFromManifest,
    requireSafeFileName,
    normalizePersonalName,
    isValidPersonalName,
    isValidCpf,
    isCollectionDateTimeOnOrBefore
  });

  async function validateManifest(manifest, session, cryptoApi) {
    return validateManifestPayloads(manifest, session.recordCount(), index => session.recordSize(index), cryptoApi);
  }

  async function validateDraftManifest(manifest, payloads, cryptoApi) {
    if (!Array.isArray(payloads) || !payloads.length || payloads.length > 9999
      || payloads.some(payload => !payload || !Number.isSafeInteger(payload.size) || payload.size < 0)) fail();
    return validateManifestPayloads(manifest, payloads.length + 1, index => payloads[index - 1]?.size, cryptoApi);
  }

  async function validateManifestPayloads(manifest, recordCount, recordSize, cryptoApi) {
    validateManifestRoot(manifest);
    const coverage = createRecordCoverage(recordCount);
    validateSignedDeclaration(manifest.signedDeclaration, manifest.lotCode, recordSize, coverage.registerIndex);
    validateEvidenceCoverage(manifest.evidence, recordSize, coverage, manifest.declarationIssuedAt);
    return validateQualifiedLotReconstruction(manifest, cryptoApi);
  }

  /*
   * Esta inspeção reconhece somente o envelope PDF, o fechamento e marcadores
   * textuais de assinatura. Ela não valida a assinatura eletrônica encontrada.
   */
  function inspectPdf(value, searchTerms = []) {
    const bytes = toBytes(value);
    if (bytes.byteLength < 16 || bytes.byteLength > MAX_PDF_BYTES) fail(INVALID_PDF_MESSAGE);
    const decoder = new TextDecoder("latin1");
    const prefix = decoder.decode(bytes.subarray(0, Math.min(bytes.byteLength, 16)));
    if (!/^%PDF-(?:1\.[0-7]|2\.0)(?:[\r\n %])/.test(prefix)) fail(INVALID_PDF_MESSAGE);
    const tail = decoder.decode(bytes.subarray(Math.max(0, bytes.byteLength - 4096)));
    if (!/%%EOF[\x00\t\n\f\r ]*$/.test(tail)) fail(INVALID_PDF_MESSAGE);
    const text = decoder.decode(bytes);
    const markers = [
      "/ByteRange", "/Type /Sig", "/Type/Sig", "/FT /Sig", "/FT/Sig",
      "/adbe.pkcs7.detached", "/ETSI.CAdES"
    ];
    return {
      size: bytes.byteLength,
      signatureMarkersDetected: markers.some(marker => text.includes(marker)),
      textMatches: searchTerms.map(term => typeof term === "string" && term.length > 0 && text.includes(term))
    };
  }

  function fail(message = INVALID_MANIFEST_MESSAGE) {
    throw new Error(message);
  }

  function isPlainObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function requireExactKeys(value, required, optional = []) {
    if (!isPlainObject(value)) fail();
    const actual = Object.keys(value).sort();
    const allowed = new Set([...required, ...optional]);
    if (required.some(key => !Object.prototype.hasOwnProperty.call(value, key))) fail();
    if (actual.some(key => !allowed.has(key))) fail();
  }

  function requireString(value, maximum = MAX_TEXT, minimum = 1) {
    if (typeof value !== "string" || value.length < minimum || value.length > maximum) fail();
  }

  function normalizePersonalName(value) {
    return typeof value === "string" ? value.trim().replace(/\s+/gu, " ") : "";
  }

  function isValidPersonalName(value) {
    if (typeof value !== "string" || /[\x00-\x1f\x7f]/.test(value)) return false;
    const normalized = normalizePersonalName(value);
    return normalized.length >= 1 && normalized.length <= 120
      && /^\p{L}[\p{L}\p{M}]*(?:[ '\u2019-]\p{L}[\p{L}\p{M}]*)*$/u.test(normalized);
  }

  function isValidCpf(value) {
    if (typeof value !== "string" || !/^\d{3}\.\d{3}\.\d{3}-\d{2}$/.test(value)) return false;
    const digits = value.replace(/\D/g, "");
    if (/^(\d)\1{10}$/.test(digits)) return false;
    const checkDigit = partial => {
      let sum = 0;
      for (let index = 0; index < partial.length; index += 1) {
        sum += Number(partial[index]) * (partial.length + 1 - index);
      }
      const result = (sum * 10) % 11;
      return result === 10 ? 0 : result;
    };
    const first = checkDigit(digits.slice(0, 9));
    return digits.endsWith(`${first}${checkDigit(`${digits.slice(0, 9)}${first}`)}`);
  }

  function requireBoolean(value) {
    if (typeof value !== "boolean") fail();
  }

  function requireSafeInteger(value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail();
  }

  function requireSha256(value) {
    if (typeof value !== "string" || !SHA256_RE.test(value)) fail();
  }

  function requireMimeType(value, expected = "") {
    if (typeof value !== "string" || value.length > 127 || !MIME_RE.test(value)) fail();
    if (expected && value !== expected) fail();
  }

  function requireSafeFileName(value, expectedExtension = "") {
    requireString(value, MAX_FILE_NAME);
    if (value === "." || value === ".." || /[\\/\0-\x1f\x7f]/.test(value)) fail();
    if (expectedExtension && !value.toLowerCase().endsWith(expectedExtension)) fail();
  }

  function requireLotCode(value) {
    if (typeof value !== "string" || !/^[\p{L}\p{N}_-]{1,60}$/u.test(value)) fail();
  }

  function signedDeclarationFileName(lotCode) {
    requireLotCode(lotCode);
    return `${SIGNED_DECLARATION_FILE_PREFIX}${lotCode}.pdf`;
  }

  function reviewDeclarationFileName(lotCode) {
    requireLotCode(lotCode);
    return `${REVIEW_DECLARATION_FILE_PREFIX}${lotCode}.pdf`;
  }

  function requireCanonicalLocalDateTime(value) {
    requireString(value, 19, 19);
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(value);
    if (!match) fail();
    const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
    const [year, month, day, hour, minute, second] = [
      yearText, monthText, dayText, hourText, minuteText, secondText
    ].map(Number);
    if (year < 1000 || year > 9999 || month < 1 || month > 12
        || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()
        || hour < 0 || hour > 23 || minute < 0 || minute > 59
        || second < 0 || second > 59) fail();
    return `${dayText}/${monthText}/${yearText} ${hourText}:${minuteText}:${secondText}`;
  }

  function isCollectionDateTimeOnOrBefore(inputDateTime, issuedAt) {
    try {
      requireCanonicalLocalDateTime(inputDateTime);
      if (typeof issuedAt !== "string") return false;
      const match = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(issuedAt);
      if (!match) return false;
      const [, day, month, year, hour, minute, second] = match;
      const issuedCanonical = `${year}-${month}-${day}T${hour}:${minute}:${second}`;
      requireCanonicalLocalDateTime(issuedCanonical);
      return inputDateTime <= issuedCanonical;
    } catch {
      return false;
    }
  }

  function requireBoundedJson(value, depth = 0, budget = { nodes: 0 }) {
    budget.nodes += 1;
    if (budget.nodes > 20000 || depth > 8) fail();
    if (value === null || typeof value === "boolean") return;
    if (typeof value === "string") {
      if (value.length > MAX_TEXT) fail();
      return;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) fail();
      return;
    }
    if (Array.isArray(value)) {
      if (value.length > MAX_AUDIT_EVENTS) fail();
      value.forEach(item => requireBoundedJson(item, depth + 1, budget));
      return;
    }
    if (isPlainObject(value)) {
      const keys = Object.keys(value);
      if (keys.length > 64 || keys.some(key => key.length > 80 || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(key))) fail();
      keys.forEach(key => requireBoundedJson(value[key], depth + 1, budget));
      return;
    }
    fail();
  }

  function requireOperator(operator) {
    requireExactKeys(operator, ["name", "cpf"]);
    if (!isValidPersonalName(operator.name) || !isValidCpf(operator.cpf)) fail();
  }

  function requireQualifiedAttachment(attachment, kind) {
    requireExactKeys(attachment, ["name", "mimeType", "size", "hash"]);
    requireSafeFileName(attachment.name, kind === "document" ? ".pdf" : "");
    requireMimeType(attachment.mimeType, kind === "document" ? "application/pdf" : "");
    if (kind === "photo" && !attachment.mimeType.startsWith("image/")) fail();
    requireSafeInteger(attachment.size);
    requireSha256(attachment.hash);
  }

  function requireAttachment(attachment, kind, recordSize, registerIndex) {
    requireExactKeys(attachment, ["recordIndex", "name", "mimeType", "size", "hash"]);
    requireSafeInteger(attachment.recordIndex, 2);
    requireSafeFileName(attachment.name, kind === "document" ? ".pdf" : "");
    requireMimeType(attachment.mimeType, kind === "document" ? "application/pdf" : "");
    if (kind === "photo" && !attachment.mimeType.startsWith("image/")) fail();
    requireSafeInteger(attachment.size);
    requireSha256(attachment.hash);
    if (recordSize(attachment.recordIndex) !== attachment.size) fail();
    registerIndex(attachment.recordIndex);
  }

  function requireMetadataCore(metadata, declarationIssuedAt) {
    requireExactKeys(metadata, [
      "id", "nature", "responsible", "inputDateTime", "location", "description",
      "unavailabilityReason", "unavailability", "dateTime", "photos", "documents"
    ]);
    requireString(metadata.id, 120);
    requireString(metadata.nature, 200);
    if (!isValidPersonalName(metadata.responsible)) fail();
    const brazilianDateTime = requireCanonicalLocalDateTime(metadata.inputDateTime);
    if (!isCollectionDateTimeOnOrBefore(metadata.inputDateTime, declarationIssuedAt)) fail();
    requireString(metadata.location, 500);
    requireString(metadata.description, MAX_TEXT);
    requireString(metadata.unavailabilityReason, 40);
    requireString(metadata.unavailability, 2000);
    if (metadata.dateTime !== brazilianDateTime) fail();
    if (!Array.isArray(metadata.photos) || metadata.photos.length > MAX_ATTACHMENTS_PER_EVIDENCE) fail();
    if (!Array.isArray(metadata.documents) || metadata.documents.length > MAX_ATTACHMENTS_PER_EVIDENCE) fail();
  }

  function requireMetadata(metadata, recordSize, registerIndex, declarationIssuedAt) {
    requireMetadataCore(metadata, declarationIssuedAt);
    metadata.photos.forEach(photo => requireAttachment(photo, "photo", recordSize, registerIndex));
    metadata.documents.forEach(document => requireAttachment(document, "document", recordSize, registerIndex));
  }

  function validateQualifiedLotRecord(record) {
    requireExactKeys(record, [
      "profile", "containerFormat", "documentId", "lotCode", "operator",
      "issuedAt", "temporalSummary", "evidence"
    ]);
    if (record.profile !== QUALIFIED_LOT_PROFILE || record.containerFormat !== FORMAT) fail();
    requireString(record.documentId, 80);
    requireLotCode(record.lotCode);
    requireOperator(record.operator);
    requireString(record.issuedAt, 40);
    requireBoundedJson(record.temporalSummary);
    if (!Array.isArray(record.evidence) || !record.evidence.length || record.evidence.length > MAX_EVIDENCE) fail();
    record.evidence.forEach(evidence => {
      requireExactKeys(evidence, ["name", "hash", "metadata"]);
      requireSafeFileName(evidence.name);
      requireSha256(evidence.hash);
      requireMetadataCore(evidence.metadata, record.issuedAt);
      evidence.metadata.photos.forEach(photo => requireQualifiedAttachment(photo, "photo"));
      evidence.metadata.documents.forEach(document => requireQualifiedAttachment(document, "document"));
    });
    return record;
  }

  function validateProductionQualifiedLotRecord(record, sourceTypeLabels, primarySourceStatusLabels) {
    validateQualifiedLotRecord(record);
    if (!isPlainObject(sourceTypeLabels) || !isPlainObject(primarySourceStatusLabels)) fail();
    const sourceLines = Object.values(sourceTypeLabels).map(label => `Forma de obtenção: ${label}.`);
    record.evidence.forEach(({ metadata }) => {
      const statusLabel = primarySourceStatusLabels[metadata.unavailabilityReason];
      const [sourceLine, statusLine, ...detailsLines] = metadata.unavailability.split("\n");
      const details = detailsLines.join("\n");
      if (!sourceLines.includes(sourceLine)
        || typeof statusLabel !== "string"
        || statusLine !== `Situação da fonte primária: ${statusLabel}.`
        || (details && !details.startsWith("Informações complementares: "))
        || (metadata.unavailabilityReason === "other"
          && !details.slice("Informações complementares: ".length).trim())) fail();
    });
    return record;
  }

  function qualifiedLotRecordFromManifest(manifest) {
    return {
      profile: manifest.qualifiedLotProfile,
      containerFormat: manifest.format,
      documentId: manifest.initialDocumentId,
      lotCode: manifest.lotCode,
      operator: manifest.operator,
      issuedAt: manifest.declarationIssuedAt,
      temporalSummary: manifest.temporal?.declaration ?? null,
      evidence: manifest.evidence.map(evidence => {
        const { photos, documents, ...metadataFields } = evidence.metadata;
        return {
          name: evidence.name,
          hash: evidence.hash,
          metadata: {
            ...metadataFields,
            photos: photos.map(photo => ({
              name: photo.name,
              size: photo.size,
              mimeType: photo.mimeType,
              hash: photo.hash
            })),
            documents: documents.map(document => ({
              name: document.name,
              size: document.size,
              mimeType: document.mimeType,
              hash: document.hash
            }))
          }
        };
      })
    };
  }

  function validateManifestRoot(manifest) {
    const commonKeys = [
      "format", "application", "lotCode", "initialDocumentId", "qualifiedLotProfile",
      "qualifiedLotHash", "qualifiedLotRecord", "declarationIssuedAt", "sealedAt",
      "temporal", "operator", "signedDeclaration", "evidence", "auditTrail"
    ];
    requireExactKeys(manifest, [...commonKeys, "manifestProfile"]);
    if (manifest.format !== FORMAT || manifest.application !== "LDF Web - Lacre Digital Forense") fail();
    if (manifest.manifestProfile !== MANIFEST_PROFILE) fail();
    requireLotCode(manifest.lotCode);
    requireString(manifest.initialDocumentId, 80);
    if (manifest.qualifiedLotProfile !== QUALIFIED_LOT_PROFILE) fail();
    requireSha256(manifest.qualifiedLotHash);
    requireString(manifest.declarationIssuedAt, 40);
    requireString(manifest.sealedAt, 40);
    requireBoundedJson(manifest.temporal);
    requireOperator(manifest.operator);
    if (!Array.isArray(manifest.evidence) || !manifest.evidence.length || manifest.evidence.length > MAX_EVIDENCE) fail();
    if (!Array.isArray(manifest.auditTrail) || manifest.auditTrail.length > MAX_AUDIT_EVENTS) fail();
    requireBoundedJson(manifest.auditTrail);
  }

  function createRecordCoverage(recordCount) {
    requireSafeInteger(recordCount, 2, 10000);
    const referenced = new Set();
    const registerIndex = recordIndex => {
      requireSafeInteger(recordIndex, 1, recordCount - 1);
      if (referenced.has(recordIndex)) fail();
      referenced.add(recordIndex);
    };
    return { recordCount, referenced, registerIndex };
  }

  function validateSignedDeclaration(declaration, lotCode, recordSize, registerIndex) {
    requireExactKeys(declaration, [
      "recordIndex", "name", "mimeType", "size", "hash", "originalName",
      "documentIdTextDetected", "qualifiedLotHashTextDetected", "signatureMarkersDetected"
    ]);
    requireSafeInteger(declaration.size, 1, MAX_PDF_BYTES);
    requireSha256(declaration.hash);
    requireBoolean(declaration.documentIdTextDetected);
    requireBoolean(declaration.qualifiedLotHashTextDetected);
    requireBoolean(declaration.signatureMarkersDetected);
    if (recordSize(declaration.recordIndex) !== declaration.size) fail();
    if (declaration.recordIndex !== 1) fail();
    requireSafeFileName(declaration.name, ".pdf");
    if (declaration.name !== signedDeclarationFileName(lotCode)) fail();
    requireSafeFileName(declaration.originalName, ".pdf");
    requireMimeType(declaration.mimeType, "application/pdf");
    registerIndex(1);
  }

  function validateEvidenceCoverage(evidenceItems, recordSize, coverage, declarationIssuedAt) {
    for (const evidence of evidenceItems) {
      requireExactKeys(evidence, ["recordIndex", "name", "mimeType", "size", "hash", "metadata"]);
      requireSafeInteger(evidence.recordIndex, 2);
      requireSafeFileName(evidence.name);
      requireMimeType(evidence.mimeType);
      requireSafeInteger(evidence.size);
      requireSha256(evidence.hash);
      if (recordSize(evidence.recordIndex) !== evidence.size) fail();
      coverage.registerIndex(evidence.recordIndex);
      requireMetadata(evidence.metadata, recordSize, coverage.registerIndex, declarationIssuedAt);
    }

    if (coverage.referenced.size !== coverage.recordCount - 1) fail();
    for (let index = 1; index < coverage.recordCount; index += 1) {
      if (!coverage.referenced.has(index)) fail();
    }
  }

  async function validateQualifiedLotReconstruction(manifest, cryptoApi) {
    const reconstructed = qualifiedLotRecordFromManifest(manifest);
    validateQualifiedLotRecord(reconstructed);
    requireExactKeys(manifest.qualifiedLotRecord, [
      "profile", "containerFormat", "documentId", "lotCode", "operator",
      "issuedAt", "temporalSummary", "evidence"
    ]);
    requireBoundedJson(manifest.qualifiedLotRecord);
    if (cryptoApi.canonicalJson(manifest.qualifiedLotRecord) !== cryptoApi.canonicalJson(reconstructed)) fail();
    if (await cryptoApi.sha256Canonical(reconstructed) !== manifest.qualifiedLotHash) fail();

    return { profile: MANIFEST_PROFILE, reconstructed };
  }

  function toBytes(value) {
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    fail(INVALID_PDF_MESSAGE);
  }

})();
