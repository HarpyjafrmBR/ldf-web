param(
    [Parameter(Mandatory = $true)]
    [string]$ReleasePath,
    [Parameter(Mandatory = $true)]
    [string]$ExpectedVersion,
    [Parameter(Mandatory = $true)]
    [string]$ExpectedReleaseChannel,
    [Parameter(Mandatory = $true)]
    [string]$ExpectedSourceCommit,
    [ValidateSet("final", "validation")]
    [string]$ExpectedReleaseMode = "final",
    [string]$ExpectedDirectoryName = "",
    [string]$SourceRepository = "",
    [switch]$AllowDirtySource
)

$ErrorActionPreference = "Stop"
$spdxLicenseName = [string]::Concat("Licen", [char]0x00E7, "a do Projeto LDF Web 1.0")

$applicationFiles = @(
    "index.html", "sobre.html", "theme.js", "styles.css", "runtime-integrity.js", "operation-coordination.js", "app-core.js", "app-ui.js",
    "app-file-io.js", "app-lot.js", "app-sealing.js", "app-audit.js", "app-offline.js",
    "app.js", "guidance-content.js",
    "guidance.js", "pdf.js", "sha256.js", "c2pa-detector.js", "crypto.js",
    "file-analysis.js", "file-analysis-worker.js", "pdf-metadata.js", "mediainfo.min.js", "mediainfo.wasm",
    "MEDIAINFO_LICENSE.txt", "LICENSE.md", "validation.js", "temporal.js", "crypto-worker.js", "sw.js",
    "manifest.webmanifest", "icon.svg"
)
$metadataNames = @("release-manifest.json", "sbom.spdx.json", "provenance.intoto.jsonl")

function Get-OrdinalSortedNames {
    param([string[]]$Names)
    $copy = [string[]]$Names.Clone()
    [Array]::Sort($copy, [StringComparer]::Ordinal)
    return $copy
}

$payloadNames = Get-OrdinalSortedNames ([string[]](@($applicationFiles) + "_headers"))
$checksumNamesExpected = Get-OrdinalSortedNames ([string[]](@($payloadNames) + $metadataNames))
$packageNamesExpected = Get-OrdinalSortedNames ([string[]](@($checksumNamesExpected) + "SHA256SUMS.txt"))

function Assert-NoReparseInPath {
    param([string]$Path, [string]$Label)
    $current = [IO.Path]::GetFullPath($Path)
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "$Label contains a link or reparse point: $current" }
        }
        $parentInfo = [IO.Directory]::GetParent($current)
        if ($null -eq $parentInfo -or $parentInfo.FullName -eq $current) { break }
        $current = $parentInfo.FullName
    }
}

function Read-StrictUtf8Lf {
    param([string]$Path, [switch]$SingleLine)
    $bytes = [IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -lt 1 -or
        ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)) {
        throw "UTF-8 BOM or empty file is not allowed: $(Split-Path -Leaf $Path)"
    }
    try { $text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes) }
    catch { throw "Invalid UTF-8: $(Split-Path -Leaf $Path)" }
    if ($text.Contains("`r") -or -not $text.EndsWith("`n")) { throw "File must use LF and end with LF: $(Split-Path -Leaf $Path)" }
    if ($SingleLine -and $text.Substring(0, $text.Length - 1).Contains("`n")) { throw "File must contain exactly one line: $(Split-Path -Leaf $Path)" }
    return $text
}

function Assert-ExactProperties {
    param($Object, [string[]]$Expected, [string]$Label)
    if ($null -eq $Object -or $Object -isnot [System.Management.Automation.PSCustomObject]) { throw "$Label is missing or is not a JSON object." }
    $actual = [string[]]@($Object.PSObject.Properties.Name)
    if ($actual.Count -ne $Expected.Count) { throw "$Label has unexpected, missing, or reordered properties." }
    for ($index = 0; $index -lt $actual.Count; $index += 1) {
        if ($actual[$index] -cne $Expected[$index]) { throw "$Label has unexpected, missing, or reordered properties." }
    }
}

function ConvertFrom-CanonicalJson {
    param([string]$Text, [string]$Label)
    try {
        $parameters = @{}
        if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey("DateKind")) {
            $parameters.DateKind = "String"
        }
        return $Text | ConvertFrom-Json @parameters
    } catch {
        throw "$Label does not contain valid JSON."
    }
}

function Invoke-GitOneLine {
    param([string]$Repository, [string[]]$Arguments, [string]$Label)
    $output = @(& git -C $Repository @Arguments 2>&1)
    if ($LASTEXITCODE -ne 0 -or $output.Count -ne 1) { throw "Git failed while reading $Label." }
    return ([string]$output[0]).Trim()
}

function Assert-PayloadMatchesCommit {
    param([string]$Repository, [string]$Commit, [string]$PackageRoot)
    $repoRoot = [IO.Path]::GetFullPath($Repository)
    if (-not (Test-Path -LiteralPath $repoRoot -PathType Container)) { throw "SourceRepository does not exist." }
    Assert-NoReparseInPath $repoRoot "Source repository"
    $resolvedCommit = Invoke-GitOneLine $repoRoot @("rev-parse", "$Commit^{commit}") "source commit"
    if ($resolvedCommit -cne $Commit) { throw "ExpectedSourceCommit is not present in SourceRepository." }
    foreach ($name in $payloadNames) {
        $repoPath = if ($name -ceq "_headers") { "deployment/_headers" } else { $name }
        $expectedBlob = Invoke-GitOneLine $repoRoot @("rev-parse", "${Commit}:$repoPath") "source blob $repoPath"
        if ((Invoke-GitOneLine $repoRoot @("cat-file", "-t", $expectedBlob) "source object $repoPath") -cne "blob") { throw "Source object is not a blob: $repoPath" }
        $actualBlob = Invoke-GitOneLine $repoRoot @("hash-object", "--no-filters", "--", (Join-Path $PackageRoot $name)) "package blob $name"
        if ($actualBlob -cne $expectedBlob) { throw "Package payload differs byte-for-byte from ExpectedSourceCommit: $name" }
    }
}

function Assert-ExactOrderedNames {
    param([string[]]$Actual, [string[]]$Expected, [string]$Label)
    if ($Actual.Count -ne $Expected.Count) { throw "$Label differs from the fixed allowlist." }
    for ($index = 0; $index -lt $Expected.Count; $index += 1) {
        if ($Actual[$index] -cne $Expected[$index]) { throw "$Label differs from the fixed allowlist." }
    }
}

function Assert-String {
    param($Value, [string]$Label)
    if ($Value -isnot [string]) { throw "$Label must be a JSON string." }
}

function Assert-Boolean {
    param($Value, [string]$Label)
    if ($Value -isnot [bool]) { throw "$Label must be a JSON boolean." }
}

function Assert-JsonInteger {
    param($Value, [string]$Label)
    if ($Value -isnot [int] -and $Value -isnot [long]) { throw "$Label must be a JSON integer." }
}

function Read-CanonicalJsonLine {
    param([string]$Path, [string]$Label)
    $text = Read-StrictUtf8Lf $Path -SingleLine
    $body = $text.Substring(0, $text.Length - 1)
    $object = ConvertFrom-CanonicalJson $body $Label
    $canonical = (($object | ConvertTo-Json -Compress -Depth 30) + "`n")
    if ($text -cne $canonical) { throw "$Label is not canonical JSON or contains ambiguous properties." }
    return $object
}

function Invoke-ReleaseVerification {
if ($ExpectedVersion -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') { throw "ExpectedVersion must use strict ASCII MAJOR.MINOR.PATCH." }
if ($ExpectedReleaseChannel -notmatch '^[a-z][a-z0-9-]*$') { throw "ExpectedReleaseChannel is invalid." }
$releaseToken = if ($ExpectedReleaseChannel -ceq "stable") { $ExpectedVersion } else { "$ExpectedReleaseChannel-$ExpectedVersion" }
$artifactName = "ldf-web-$releaseToken"
$displayVersion = if ($ExpectedReleaseChannel -ceq "stable") { $ExpectedVersion } else { "$($ExpectedReleaseChannel.Substring(0, 1).ToUpperInvariant())$($ExpectedReleaseChannel.Substring(1)) $ExpectedVersion" }
if ($ExpectedSourceCommit -notmatch '^[0-9a-f]{40}$') { throw "ExpectedSourceCommit must be a 40-character lowercase Git SHA-1 identifier." }
if ($ExpectedReleaseMode -ceq "final" -and $AllowDirtySource) { throw "AllowDirtySource cannot be used for a final release." }
if (-not $ExpectedDirectoryName) { $ExpectedDirectoryName = $artifactName }
if ($ExpectedDirectoryName -notmatch '^[A-Za-z0-9_][A-Za-z0-9._-]*$') { throw "ExpectedDirectoryName is invalid." }

$releaseRoot = [IO.Path]::GetFullPath($ReleasePath)
if (-not (Test-Path -LiteralPath $releaseRoot -PathType Container)) { throw "Release directory does not exist." }
& node (Join-Path $PSScriptRoot "verify-runtime-integrity.cjs") $releaseRoot $releaseToken
if ($LASTEXITCODE -ne 0) { throw "Runtime integrity verification failed for release." }
Assert-NoReparseInPath $releaseRoot "Release path"
$rootItem = Get-Item -LiteralPath $releaseRoot -Force
if ($rootItem.Name -cne $ExpectedDirectoryName) { throw "Release directory name differs from ExpectedDirectoryName." }

$actualItems = @(Get-ChildItem -LiteralPath $releaseRoot -Force)
foreach ($item in $actualItems) {
    if ($item.PSIsContainer) { throw "Unexpected directory in release: $($item.Name)" }
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Unexpected link or reparse point: $($item.Name)" }
}
$actualNames = Get-OrdinalSortedNames ([string[]]@($actualItems.Name))
Assert-ExactOrderedNames $actualNames $packageNamesExpected "Actual release files"

$sumPath = Join-Path $releaseRoot "SHA256SUMS.txt"
$sumText = Read-StrictUtf8Lf $sumPath
$sumBody = $sumText.Substring(0, $sumText.Length - 1)
if (-not $sumBody -or $sumBody.Contains("`n`n")) { throw "SHA256SUMS.txt contains an empty line." }
$sumLines = [string[]]@($sumBody -split "`n")
$checksumNames = [System.Collections.Generic.List[string]]::new()
$expectedHashes = @{}
$ordinalSet = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
$caseFoldSet = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($line in $sumLines) {
    if ($line -notmatch '^([0-9a-f]{64})  ([A-Za-z0-9_][A-Za-z0-9._-]*)$') { throw "Invalid SHA256SUMS.txt line: $line" }
    $hash = $Matches[1]
    $name = $Matches[2]
    if ($name -ceq "SHA256SUMS.txt") { throw "SHA256SUMS.txt cannot reference itself." }
    if (-not $ordinalSet.Add($name) -or -not $caseFoldSet.Add($name)) { throw "Duplicate or ambiguous checksum name: $name" }
    $checksumNames.Add($name)
    $expectedHashes[$name] = $hash
}
Assert-ExactOrderedNames ([string[]]$checksumNames.ToArray()) $checksumNamesExpected "SHA256SUMS.txt names"
foreach ($name in $checksumNamesExpected) {
    $actualHash = (Get-FileHash -LiteralPath (Join-Path $releaseRoot $name) -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -cne $expectedHashes[$name]) { throw "Hash mismatch: $name" }
}

$manifestPath = Join-Path $releaseRoot "release-manifest.json"
$manifest = Read-CanonicalJsonLine $manifestPath "release-manifest.json"
Assert-ExactProperties $manifest @("schema", "application", "version", "releaseChannel", "containerFormat", "sourceCommit", "files") "release-manifest.json"
foreach ($property in @("schema", "application", "version", "releaseChannel", "containerFormat", "sourceCommit")) { Assert-String $manifest.$property "release-manifest.json.$property" }
if ($manifest.schema -cne "LDF-RELEASE-1" -or
    $manifest.application -cne "LDF Web - Lacre Digital Forense" -or
    $manifest.version -cne $ExpectedVersion -or
    $manifest.releaseChannel -cne $ExpectedReleaseChannel -or
    $manifest.containerFormat -cne "LDF-WEB-1" -or
    $manifest.sourceCommit -cne $ExpectedSourceCommit) {
    throw "release-manifest.json identity differs from the external anchors."
}
if ($manifest.files -isnot [System.Array]) { throw "release-manifest.json.files must be a JSON array." }
$manifestFiles = @($manifest.files)
$manifestNames = [System.Collections.Generic.List[string]]::new()
foreach ($descriptor in $manifestFiles) {
    Assert-ExactProperties $descriptor @("path", "bytes", "sha256") "Manifest descriptor"
    Assert-String $descriptor.path "Manifest path"
    Assert-String $descriptor.sha256 "Manifest hash"
    Assert-JsonInteger $descriptor.bytes "Manifest byte length"
    $name = [string]$descriptor.path
    if ($name -notmatch '^[A-Za-z0-9_][A-Za-z0-9._-]*$' -or $descriptor.sha256 -notmatch '^[0-9a-f]{64}$' -or [long]$descriptor.bytes -lt 0) {
        throw "Invalid manifest descriptor: $name"
    }
    $manifestNames.Add($name)
    $item = Get-Item -LiteralPath (Join-Path $releaseRoot $name)
    if ([long]$item.Length -ne [long]$descriptor.bytes) { throw "Manifest size mismatch: $name" }
    $hash = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -cne [string]$descriptor.sha256) { throw "Manifest hash mismatch: $name" }
}
Assert-ExactOrderedNames ([string[]]$manifestNames.ToArray()) $payloadNames "Manifest payload"

if ($SourceRepository) {
    Assert-PayloadMatchesCommit $SourceRepository $ExpectedSourceCommit $releaseRoot
} else {
    Write-Warning "SourceRepository was not supplied; byte correspondence with ExpectedSourceCommit was not checked."
}

$sbom = Read-CanonicalJsonLine (Join-Path $releaseRoot "sbom.spdx.json") "sbom.spdx.json"
Assert-ExactProperties $sbom @("spdxVersion", "dataLicense", "SPDXID", "name", "documentNamespace", "creationInfo", "hasExtractedLicensingInfos", "packages", "relationships") "SBOM"
foreach ($property in @("spdxVersion", "dataLicense", "SPDXID", "name", "documentNamespace")) { Assert-String $sbom.$property "SBOM.$property" }
if ($sbom.spdxVersion -cne "SPDX-2.3" -or $sbom.dataLicense -cne "CC0-1.0" -or
    $sbom.SPDXID -cne "SPDXRef-DOCUMENT" -or $sbom.name -cne $artifactName -or
    $sbom.documentNamespace -cne "https://lacredigitalforense.seg.br/spdx/$artifactName/$ExpectedSourceCommit") {
    throw "SBOM identity differs from the release anchors."
}
Assert-ExactProperties $sbom.creationInfo @("created", "creators") "SBOM creationInfo"
Assert-String $sbom.creationInfo.created "SBOM creationInfo.created"
if ($sbom.creationInfo.created -notmatch '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$') { throw "SBOM logical timestamp is invalid." }
if ($sbom.creationInfo.creators -isnot [System.Array] -or @($sbom.creationInfo.creators).Count -ne 1 -or $sbom.creationInfo.creators[0] -cne "Tool: ldf-build-release-2") {
    throw "SBOM creators are invalid."
}
if ($sbom.hasExtractedLicensingInfos -isnot [System.Array] -or @($sbom.hasExtractedLicensingInfos).Count -ne 1) { throw "SBOM must include the custom application license." }
$applicationLicense = $sbom.hasExtractedLicensingInfos[0]
Assert-ExactProperties $applicationLicense @("licenseId", "extractedText", "name", "comment") "SBOM extracted license"
foreach ($property in @("licenseId", "extractedText", "name", "comment")) { Assert-String $applicationLicense.$property "SBOM extracted license.$property" }
$packagedLicenseText = Read-StrictUtf8Lf (Join-Path $releaseRoot "LICENSE.md")
if ($applicationLicense.licenseId -cne "LicenseRef-LDF-Web-1.0" -or
    $applicationLicense.extractedText -cne $packagedLicenseText -or
    $applicationLicense.name -cne $spdxLicenseName -or
    $applicationLicense.comment -cne "Custom source-available license; not OSI-approved.") { throw "SBOM extracted license is invalid." }
if ($sbom.packages -isnot [System.Array] -or @($sbom.packages).Count -ne 2) { throw "SBOM must describe the application and MediaInfo dependency." }
$applicationPackage = $sbom.packages[0]
$mediaInfoPackage = $sbom.packages[1]
foreach ($package in @($applicationPackage, $mediaInfoPackage)) {
    Assert-ExactProperties $package @("SPDXID", "name", "versionInfo", "downloadLocation", "filesAnalyzed", "licenseConcluded", "licenseDeclared", "copyrightText", "comment") "SBOM package"
    foreach ($property in @("SPDXID", "name", "versionInfo", "downloadLocation", "licenseConcluded", "licenseDeclared", "copyrightText", "comment")) { Assert-String $package.$property "SBOM package.$property" }
    Assert-Boolean $package.filesAnalyzed "SBOM package.filesAnalyzed"
}
if ($applicationPackage.SPDXID -cne "SPDXRef-Package-LDF-Web" -or $applicationPackage.name -cne "LDF Web - Lacre Digital Forense" -or
    $applicationPackage.versionInfo -cne $displayVersion -or $applicationPackage.downloadLocation -cne "NOASSERTION" -or
    $applicationPackage.filesAnalyzed -ne $false -or $applicationPackage.licenseConcluded -cne "LicenseRef-LDF-Web-1.0" -or
    $applicationPackage.licenseDeclared -cne "LicenseRef-LDF-Web-1.0" -or $applicationPackage.copyrightText -cne "Copyright 2026 Projeto LDF Web" -or
    $applicationPackage.comment -cne "LicenseRef-LDF-Web-1.0 is provided in LICENSE.md; the application bundles the separately identified MediaInfo runtime dependency.") { throw "SBOM application package is invalid." }
if ($mediaInfoPackage.SPDXID -cne "SPDXRef-Package-mediainfo-js" -or $mediaInfoPackage.name -cne "mediainfo.js" -or
    $mediaInfoPackage.versionInfo -cne "0.3.7" -or $mediaInfoPackage.downloadLocation -cne "https://registry.npmjs.org/mediainfo.js/-/mediainfo.js-0.3.7.tgz" -or
    $mediaInfoPackage.filesAnalyzed -ne $false -or $mediaInfoPackage.licenseConcluded -cne "BSD-2-Clause" -or
    $mediaInfoPackage.licenseDeclared -cne "BSD-2-Clause" -or $mediaInfoPackage.copyrightText -cne "NOASSERTION" -or
    $mediaInfoPackage.comment -cne "Vendored UMD wrapper with MediaInfoLib 25.10 WebAssembly; license text is MEDIAINFO_LICENSE.txt.") { throw "SBOM MediaInfo package is invalid." }
if ($sbom.relationships -isnot [System.Array] -or @($sbom.relationships).Count -ne 2) { throw "SBOM must contain DESCRIBES and DEPENDS_ON relationships." }
$describes = $sbom.relationships[0]
$dependsOn = $sbom.relationships[1]
foreach ($relationship in @($describes, $dependsOn)) {
    Assert-ExactProperties $relationship @("spdxElementId", "relationshipType", "relatedSpdxElement") "SBOM relationship"
}
if ($describes.spdxElementId -cne "SPDXRef-DOCUMENT" -or $describes.relationshipType -cne "DESCRIBES" -or $describes.relatedSpdxElement -cne "SPDXRef-Package-LDF-Web" -or
    $dependsOn.spdxElementId -cne "SPDXRef-Package-LDF-Web" -or $dependsOn.relationshipType -cne "DEPENDS_ON" -or $dependsOn.relatedSpdxElement -cne "SPDXRef-Package-mediainfo-js") {
    throw "SBOM relationships are invalid."
}

$provenance = Read-CanonicalJsonLine (Join-Path $releaseRoot "provenance.intoto.jsonl") "provenance.intoto.jsonl"
Assert-ExactProperties $provenance @("_type", "subject", "predicateType", "predicate") "Provenance"
Assert-String $provenance._type "Provenance._type"
Assert-String $provenance.predicateType "Provenance.predicateType"
if ($provenance._type -cne "https://in-toto.io/Statement/v1" -or $provenance.predicateType -cne "https://slsa.dev/provenance/v1") { throw "Provenance statement identity is invalid." }
if ($provenance.subject -isnot [System.Array] -or @($provenance.subject).Count -ne 1) { throw "Provenance must have one subject." }
$subject = $provenance.subject[0]
Assert-ExactProperties $subject @("name", "digest") "Provenance subject"
Assert-ExactProperties $subject.digest @("sha256") "Provenance subject digest"
Assert-String $subject.name "Provenance subject name"
Assert-String $subject.digest.sha256 "Provenance subject digest"
$manifestHash = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($subject.name -cne "release-manifest.json" -or $subject.digest.sha256 -cne $manifestHash) { throw "Provenance subject does not match the manifest." }

Assert-ExactProperties $provenance.predicate @("buildDefinition", "runDetails") "Provenance predicate"
$buildDefinition = $provenance.predicate.buildDefinition
Assert-ExactProperties $buildDefinition @("buildType", "externalParameters", "internalParameters", "resolvedDependencies") "Provenance buildDefinition"
Assert-String $buildDefinition.buildType "Provenance buildType"
if ($buildDefinition.buildType -cne "urn:ldf-web:build-type:static-release-v2") { throw "Provenance buildType is invalid." }

$external = $buildDefinition.externalParameters
Assert-ExactProperties $external @("version", "releaseChannel", "containerFormat", "releaseMode") "Provenance externalParameters"
foreach ($property in @("version", "releaseChannel", "containerFormat", "releaseMode")) { Assert-String $external.$property "Provenance externalParameters.$property" }
if ($external.version -cne $ExpectedVersion -or $external.releaseChannel -cne $ExpectedReleaseChannel -or $external.containerFormat -cne "LDF-WEB-1" -or $external.releaseMode -cne $ExpectedReleaseMode) {
    throw "Provenance external parameters differ from the external anchors."
}

$internal = $buildDefinition.internalParameters
Assert-ExactProperties $internal @("script", "sourceDirty", "sourceMaterialization", "powershellVersion", "buildScriptSha256", "verifyScriptSha256") "Provenance internalParameters"
Assert-String $internal.script "Provenance internalParameters.script"
Assert-Boolean $internal.sourceDirty "Provenance internalParameters.sourceDirty"
Assert-String $internal.sourceMaterialization "Provenance internalParameters.sourceMaterialization"
Assert-String $internal.powershellVersion "Provenance internalParameters.powershellVersion"
Assert-String $internal.buildScriptSha256 "Provenance internalParameters.buildScriptSha256"
Assert-String $internal.verifyScriptSha256 "Provenance internalParameters.verifyScriptSha256"
if ($internal.script -cne "tools/build-release.ps1" -or
    $internal.powershellVersion -notmatch '^[0-9]+\.[0-9]+(?:\.[0-9]+){0,2}$' -or
    $internal.buildScriptSha256 -notmatch '^[0-9a-f]{64}$' -or
    $internal.verifyScriptSha256 -notmatch '^[0-9a-f]{64}$') { throw "Provenance internal parameters are invalid." }
$expectedMaterialization = if ($ExpectedReleaseMode -ceq "final") { "git-archive" } else { $internal.sourceMaterialization }
if ($ExpectedReleaseMode -ceq "final" -and $internal.sourceMaterialization -cne $expectedMaterialization) { throw "Final provenance must use the captured Git archive." }
if ($ExpectedReleaseMode -ceq "validation" -and $internal.sourceMaterialization -notin @("working-tree", "git-archive")) { throw "Validation provenance has an invalid materialization mode." }
if ($internal.sourceDirty -and -not $AllowDirtySource) { throw "Provenance reports a dirty source tree." }
if ($ExpectedReleaseMode -ceq "final" -and $internal.sourceDirty) { throw "Final provenance cannot report a dirty source tree." }

if ($buildDefinition.resolvedDependencies -isnot [System.Array] -or @($buildDefinition.resolvedDependencies).Count -ne 1) { throw "Provenance must contain one resolved dependency." }
$dependency = $buildDefinition.resolvedDependencies[0]
Assert-ExactProperties $dependency @("uri", "digest") "Provenance dependency"
Assert-ExactProperties $dependency.digest @("sha1") "Provenance dependency digest"
Assert-String $dependency.uri "Provenance dependency URI"
Assert-String $dependency.digest.sha1 "Provenance dependency digest"
if ($dependency.uri -cne "urn:ldf-web:source" -or $dependency.digest.sha1 -cne $ExpectedSourceCommit) { throw "Provenance dependency differs from ExpectedSourceCommit." }

Assert-ExactProperties $provenance.predicate.runDetails @("builder") "Provenance runDetails"
Assert-ExactProperties $provenance.predicate.runDetails.builder @("id") "Provenance builder"
Assert-String $provenance.predicate.runDetails.builder.id "Provenance builder id"
if ($provenance.predicate.runDetails.builder.id -cne "urn:ldf-web:builder:powershell-local-v2") { throw "Provenance builder is invalid." }

Write-Host "Internal consistency confirmed: fixed allowlist, external anchors, manifest, SBOM, provenance, and hashes match."
Write-Host "External authenticity was not verified."
}

Invoke-ReleaseVerification
