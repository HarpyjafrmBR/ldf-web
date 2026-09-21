"use strict";

// Oráculo independente: não importa nem reutiliza o gerador de integridade.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const BEGIN = "// BEGIN GENERATED RUNTIME INTEGRITY";
const END = "// END GENERATED RUNTIME INTEGRITY";
const PLACEHOLDER = `${BEGIN}\n// Generated descriptors are excluded while hashing Service Worker logic.\n${END}`;
const DEFINITIONS = Object.freeze([
  ["./", "index.html", "text/html"],
  ["index.html", "index.html", "text/html"],
  ["sobre.html", "sobre.html", "text/html"],
  ["theme.js?v={token}", "theme.js", "text/javascript"],
  ["styles.css?v={token}", "styles.css", "text/css"],
  ["runtime-integrity.js?v={token}", "runtime-integrity.js", "text/javascript", true],
  ["operation-coordination.js?v={token}", "operation-coordination.js", "text/javascript"],
  ["pdf.js?v={token}", "pdf.js", "text/javascript"],
  ["sha256.js?v={token}", "sha256.js", "text/javascript"],
  ["c2pa-detector.js?v={token}", "c2pa-detector.js", "text/javascript"],
  ["crypto-worker.js?v={token}", "crypto-worker.js", "text/javascript"],
  ["crypto.js?v={token}", "crypto.js", "text/javascript"],
  ["file-analysis.js?v={token}", "file-analysis.js", "text/javascript"],
  ["file-analysis-worker.js?v={token}", "file-analysis-worker.js", "text/javascript"],
  ["pdf-metadata.js?v={token}", "pdf-metadata.js", "text/javascript"],
  ["mediainfo.min.js?v={token}", "mediainfo.min.js", "text/javascript"],
  ["mediainfo.wasm?v={token}", "mediainfo.wasm", "application/wasm"],
  ["MEDIAINFO_LICENSE.txt", "MEDIAINFO_LICENSE.txt", "text/plain"],
  ["temporal.js?v={token}", "temporal.js", "text/javascript"],
  ["guidance-content.js?v={token}", "guidance-content.js", "text/javascript"],
  ["guidance.js?v={token}", "guidance.js", "text/javascript"],
  ["validation.js?v={token}", "validation.js", "text/javascript"],
  ["app-core.js?v={token}", "app-core.js", "text/javascript"],
  ["app-ui.js?v={token}", "app-ui.js", "text/javascript"],
  ["app-file-io.js?v={token}", "app-file-io.js", "text/javascript"],
  ["app-lot.js?v={token}", "app-lot.js", "text/javascript"],
  ["app-sealing.js?v={token}", "app-sealing.js", "text/javascript"],
  ["app-audit.js?v={token}", "app-audit.js", "text/javascript"],
  ["app-offline.js?v={token}", "app-offline.js", "text/javascript"],
  ["app.js?v={token}", "app.js", "text/javascript"],
  ["icon.svg", "icon.svg", "image/svg+xml"],
  ["manifest.webmanifest", "manifest.webmanifest", "application/manifest+json"]
]);

function digest(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function releaseToken(root, forcedToken) {
  if (forcedToken !== undefined) {
    if (!/^(?:[a-z][a-z0-9-]*-)?(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(forcedToken)) {
      throw new Error("Token de release inválido.");
    }
    return forcedToken;
  }
  const readLine = (name, pattern) => {
    const bytes = fs.readFileSync(path.join(root, name));
    if (!bytes.length || bytes.at(-1) !== 10 || bytes.includes(13)
        || bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
      throw new Error(`${name} deve ser uma linha UTF-8 LF, sem BOM.`);
    }
    const value = bytes.toString("utf8").slice(0, -1);
    if (!pattern.test(value)) throw new Error(`${name} inválido.`);
    return value;
  };
  const version = readLine("VERSION", /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/);
  const channel = readLine("RELEASE_CHANNEL", /^[a-z][a-z0-9-]*$/);
  return channel === "stable" ? version : `${channel}-${version}`;
}

function replaceBlock(source, replacement) {
  const start = source.indexOf(BEGIN);
  const finish = source.indexOf(END, start + BEGIN.length);
  if (start < 0 || finish < 0 || source.indexOf(BEGIN, start + 1) >= 0 || source.indexOf(END, finish + 1) >= 0) {
    throw new Error("sw.js deve conter exatamente um bloco de integridade delimitado.");
  }
  return source.slice(0, start) + replacement + source.slice(finish + END.length);
}

function expectedSourceCommit(value) {
  if (value === undefined || value === "") return null;
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error("Commit da fonte inválido.");
  return value;
}

function verify(root, forcedToken, forcedSourceCommit) {
  const token = releaseToken(root, forcedToken);
  const worker = fs.readFileSync(path.join(root, "sw.js"), "utf8");
  const normalizedWorker = Buffer.from(replaceBlock(worker, PLACEHOLDER), "utf8");
  const stableAssets = DEFINITIONS.filter(item => !item[3]).map(([template, filename, contentType]) => {
    const bytes = fs.readFileSync(path.join(root, filename));
    return { url: template.replace("{token}", token), bytes: bytes.length, sha256: digest(bytes), contentType };
  });
  const inputs = stableAssets.map(({ url: path, bytes, sha256 }) => ({ path, bytes, sha256 }));
  inputs.push({ path: "@service-worker-logic", bytes: normalizedWorker.length, sha256: digest(normalizedWorker) });
  inputs.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const buildId = digest(Buffer.from(JSON.stringify(inputs)));
  const cacheName = `ldf-web-${token}-${buildId}`;
  const sourceCommit = expectedSourceCommit(forcedSourceCommit);
  const identityText = `(function () {\n  "use strict";\n  window.LDFRuntimeIdentity = Object.freeze(${JSON.stringify({ releaseToken: token, buildId, cacheName, sourceCommit })});\n})();\n`;
  if (fs.readFileSync(path.join(root, "runtime-integrity.js"), "utf8") !== identityText) {
    throw new Error("runtime-integrity.js diverge dos assets permitidos.");
  }
  const identityDefinition = DEFINITIONS.find(item => item[3]);
  const identityBytes = Buffer.from(identityText);
  const assets = [...stableAssets];
  assets.splice(DEFINITIONS.findIndex(item => item[3]), 0, {
    url: identityDefinition[0].replace("{token}", token),
    bytes: identityBytes.length,
    sha256: digest(identityBytes),
    contentType: identityDefinition[2]
  });
  const block = `${BEGIN}\nconst RELEASE_TOKEN = ${JSON.stringify(token)};\nconst BUILD_ID = ${JSON.stringify(buildId)};\nconst CACHE_NAME = ${JSON.stringify(cacheName)};\nconst SOURCE_COMMIT = ${JSON.stringify(sourceCommit)};\nconst RUNTIME_ASSETS = Object.freeze(${JSON.stringify(assets, null, 2)}.map(Object.freeze));\n${END}`;
  if (worker !== replaceBlock(worker, block)) throw new Error("O bloco de integridade de sw.js diverge dos assets permitidos.");
  return { token, buildId, cacheName, assetCount: assets.length };
}

try {
  const root = path.resolve(process.argv[2] || path.join(__dirname, ".."));
  const result = verify(root, process.argv[3], process.argv[4]);
  console.log(`Runtime integrity verification: PASS ${result.cacheName} (${result.assetCount} assets)`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
