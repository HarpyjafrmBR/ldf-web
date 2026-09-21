param(
    [Parameter(Mandatory = $true)]
    [string]$Root,
    [Parameter(Mandatory = $true)]
    [string]$ExpectedVersion,
    [Parameter(Mandatory = $true)]
    [string]$ExpectedReleaseChannel,
    [Parameter(Mandatory = $true)]
    [string]$ExpectedExportSourceCommit,
    [Parameter(Mandatory = $true)]
    [string]$ExpectedReleaseSourceCommit,
    [string]$SourceRepository = ""
)

$ErrorActionPreference = "Stop"

$sourceFiles = @(
    ".gitattributes", ".gitignore", ".github/workflows/ci.yml",
    "LICENSE.md", "README.md", "RELEASE_CHANNEL", "SECURITY.md", "VERSION",
    "tools/verify-public-export.ps1", "tools/verify-public-git-change.ps1",
    "tools/verify-release.ps1", "tools/verify-runtime-integrity.cjs"
)
$releaseFiles = @(
    "SHA256SUMS.txt", "_headers", "app-audit.js", "app-core.js", "app-file-io.js",
    "app-lot.js", "app-offline.js", "app-sealing.js", "app-ui.js", "app.js", "c2pa-detector.js",
    "crypto-worker.js", "crypto.js", "file-analysis-worker.js", "file-analysis.js", "pdf-metadata.js",
    "guidance-content.js", "guidance.js", "icon.svg", "index.html", "manifest.webmanifest",
    "pdf.js", "provenance.intoto.jsonl", "release-manifest.json", "sbom.spdx.json",
    "sha256.js", "sobre.html", "styles.css", "sw.js", "temporal.js", "theme.js", "runtime-integrity.js", "operation-coordination.js", "validation.js",
    "mediainfo.min.js", "mediainfo.wasm", "MEDIAINFO_LICENSE.txt", "LICENSE.md",
    "sitemap.xml", "robots.txt"
)
$renamedSources = @{
    ".gitattributes" = "PUBLIC_GITATTRIBUTES"
    ".gitignore" = "PUBLIC_GITIGNORE"
    "README.md" = "PUBLIC_README.md"
    ".github/workflows/ci.yml" = "deployment/github/public-ci.yml"
}

function Get-ReservedPublicMarkers {
    return @(
        [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("RU5HSU5FRVJJTkdfUFJBQ1RJQ0VTLm1k")),
        [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("UExBTk9fU0VHVVJBTkNBX1BBUkFfSUEubWQ=")),
        [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("bGRmLXNwZWMtZHJpdmVu")),
        [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("dG9vbHMvZW5naW5lZXJpbmctcHJhY3RpY2VzLXZhbGlkYXRpb24udGVzdC5wczE=")),
        [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("R2VvcmdlZnJtQlI="))
    )
}

function Get-OrdinalSortedNames {
    param([string[]]$Names)
    $copy = [string[]]$Names.Clone()
    [Array]::Sort($copy, [StringComparer]::Ordinal)
    return $copy
}

function Assert-ExactOrderedNames {
    param([string[]]$Actual, [string[]]$Expected, [string]$Label)
    if ($Actual.Count -ne $Expected.Count) { throw "$Label differs from the fixed allowlist." }
    for ($index = 0; $index -lt $Expected.Count; $index += 1) {
        if ($Actual[$index] -cne $Expected[$index]) { throw "$Label differs from the fixed allowlist." }
    }
}

function Assert-ExactProperties {
    param($Object, [string[]]$Expected, [string]$Label)
    if ($null -eq $Object -or $Object -isnot [System.Management.Automation.PSCustomObject]) { throw "$Label is not a JSON object." }
    $actual = [string[]]@($Object.PSObject.Properties.Name)
    if ($actual.Count -ne $Expected.Count) { throw "$Label has unexpected properties." }
    for ($index = 0; $index -lt $Expected.Count; $index += 1) {
        if ($actual[$index] -cne $Expected[$index]) { throw "$Label has unexpected or reordered properties." }
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
        throw "$Label is not valid JSON."
    }
}

function Invoke-GitOneLine {
    param([string]$Repository, [string[]]$Arguments, [string]$Label)
    $output = @(& git -C $Repository @Arguments 2>&1)
    if ($LASTEXITCODE -ne 0 -or $output.Count -ne 1) { throw "Git failed while reading $Label." }
    return ([string]$output[0]).Trim()
}

function Read-CanonicalJsonLine {
    param([string]$Path, [string]$Label)
    $bytes = [IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -lt 2 -or
        ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) -or
        $bytes[-1] -ne 0x0A -or $bytes -contains 0x0D -or
        @($bytes | Where-Object { $_ -eq 0x0A }).Count -ne 1) { throw "$Label must be one canonical UTF-8 JSON line with final LF." }
    try { $text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes) }
    catch { throw "$Label is not valid UTF-8." }
    $object = ConvertFrom-CanonicalJson $text.Substring(0, $text.Length - 1) $Label
    $canonical = (($object | ConvertTo-Json -Compress -Depth 30) + "`n")
    if ($text -cne $canonical) { throw "$Label is not canonical or contains ambiguous properties." }
    return $object
}

function Get-PublicTree {
    param([string]$TreeRoot)
    $files = [System.Collections.Generic.List[string]]::new()
    $directories = [System.Collections.Generic.List[string]]::new()
    $stack = [System.Collections.Generic.Stack[IO.DirectoryInfo]]::new()
    $stack.Push((Get-Item -LiteralPath $TreeRoot -Force))
    while ($stack.Count -gt 0) {
        $directory = $stack.Pop()
        foreach ($item in @(Get-ChildItem -LiteralPath $directory.FullName -Force)) {
            if ($directory.FullName -eq $TreeRoot -and $item.PSIsContainer -and $item.Name -ceq ".git") { continue }
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Public tree contains a link or reparse point: $($item.FullName)" }
            $relative = $item.FullName.Substring($TreeRoot.TrimEnd('\').Length + 1).Replace('\', '/')
            if ($item.PSIsContainer) {
                $directories.Add($relative)
                $stack.Push($item)
            } else {
                $files.Add($relative)
            }
        }
    }
    return [pscustomobject]@{ Files = [string[]]$files.ToArray(); Directories = [string[]]$directories.ToArray() }
}

function Get-ExpectedDirectories {
    param([string[]]$Files)
    $set = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($name in $Files) {
        $parts = $name -split '/'
        for ($count = 1; $count -lt $parts.Count; $count += 1) { [void]$set.Add(($parts[0..($count - 1)] -join '/')) }
    }
    return Get-OrdinalSortedNames ([string[]]$set)
}

function Invoke-PublicExportVerification {
if ($ExpectedVersion -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') { throw "ExpectedVersion is invalid." }
if ($ExpectedReleaseChannel -notmatch '^[a-z][a-z0-9-]*$') { throw "ExpectedReleaseChannel is invalid." }
if ($ExpectedExportSourceCommit -notmatch '^[0-9a-f]{40}$' -or $ExpectedReleaseSourceCommit -notmatch '^[0-9a-f]{40}$') { throw "Expected commit anchors are invalid." }
$publicRoot = [IO.Path]::GetFullPath($Root)
if (-not (Test-Path -LiteralPath $publicRoot -PathType Container)) { throw "Public export root does not exist." }
$rootItem = Get-Item -LiteralPath $publicRoot -Force
if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Public export root cannot be a reparse point." }

$expectedFiles = Get-OrdinalSortedNames ([string[]]@($sourceFiles + ($releaseFiles | ForEach-Object { "public/$_" }) + "PUBLIC_EXPORT_MANIFEST.json"))
$expectedDirectories = Get-ExpectedDirectories $expectedFiles
$tree = Get-PublicTree $publicRoot
Assert-ExactOrderedNames (Get-OrdinalSortedNames $tree.Files) $expectedFiles "Public files"
Assert-ExactOrderedNames (Get-OrdinalSortedNames $tree.Directories) $expectedDirectories "Public directories"

$reservedMarkers = Get-ReservedPublicMarkers
foreach ($name in $tree.Files) {
    foreach ($marker in $reservedMarkers) {
        if ($name.IndexOf($marker, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            throw "Private development marker found in public path: $name"
        }
    }
}

function Assert-LocalMarkdownLinks {
    param([string]$TreeRoot, [string[]]$Files)
    $rootPrefix = $TreeRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    foreach ($name in @($Files | Where-Object { [IO.Path]::GetExtension($_) -ceq ".md" })) {
        $sourcePath = Join-Path $TreeRoot $name.Replace('/', '\')
        $sourceDirectory = Split-Path -Parent $sourcePath
        $text = [IO.File]::ReadAllText($sourcePath)
        foreach ($match in [regex]::Matches($text, '\[[^\]]+\]\((?<target>[^)\s]+)(?:\s+"[^"]*")?\)')) {
            $target = $match.Groups["target"].Value.Trim('<', '>')
            if (-not $target -or $target.StartsWith('#') -or $target -match '^[A-Za-z][A-Za-z0-9+.-]*:') { continue }
            $pathPart = ($target -split '[?#]', 2)[0]
            if (-not $pathPart) { continue }
            try { $resolved = [IO.Path]::GetFullPath((Join-Path $sourceDirectory ([Uri]::UnescapeDataString($pathPart).Replace('/', '\')))) }
            catch { throw "Invalid local Markdown link in ${name}: $target" }
            if (($resolved -cne $TreeRoot -and -not $resolved.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) -or
                -not (Test-Path -LiteralPath $resolved)) { throw "Broken or escaping local Markdown link in ${name}: $target" }
        }
    }
}

$forbiddenExtensions = @(".pdf", ".ldf", ".bin", ".jpg", ".jpeg", ".png", ".mp3", ".mp4", ".wav", ".pfx", ".p12", ".pem", ".key", ".env")
foreach ($name in $tree.Files) {
    if ($forbiddenExtensions -contains [IO.Path]::GetExtension($name).ToLowerInvariant()) { throw "Forbidden file type in public export: $name" }
}

$manifest = Read-CanonicalJsonLine (Join-Path $publicRoot "PUBLIC_EXPORT_MANIFEST.json") "PUBLIC_EXPORT_MANIFEST.json"
Assert-ExactProperties $manifest @("schema", "application", "version", "releaseChannel", "exportSourceCommit", "releaseSourceCommit", "files") "Public export manifest"
foreach ($property in @("schema", "application", "version", "releaseChannel", "exportSourceCommit", "releaseSourceCommit")) {
    if ($manifest.$property -isnot [string]) { throw "Public export manifest.$property must be a string." }
}
if ($manifest.schema -cne "LDF-PUBLIC-EXPORT-1" -or
    $manifest.application -cne "LDF Web - Lacre Digital Forense" -or
    $manifest.version -cne $ExpectedVersion -or
    $manifest.releaseChannel -cne $ExpectedReleaseChannel -or
    $manifest.exportSourceCommit -cne $ExpectedExportSourceCommit -or
    $manifest.releaseSourceCommit -cne $ExpectedReleaseSourceCommit) { throw "Public export manifest differs from external anchors." }
if ($manifest.files -isnot [System.Array]) { throw "Public export manifest files must be an array." }
$manifestExpectedNames = Get-OrdinalSortedNames ([string[]]@($expectedFiles | Where-Object { $_ -cne "PUBLIC_EXPORT_MANIFEST.json" }))
$manifestNames = [System.Collections.Generic.List[string]]::new()
foreach ($descriptor in @($manifest.files)) {
    Assert-ExactProperties $descriptor @("path", "bytes", "sha256") "Public file descriptor"
    if ($descriptor.path -isnot [string] -or $descriptor.sha256 -isnot [string] -or
        ($descriptor.bytes -isnot [int] -and $descriptor.bytes -isnot [long]) -or
        [long]$descriptor.bytes -lt 0 -or $descriptor.sha256 -notmatch '^[0-9a-f]{64}$') { throw "Invalid public file descriptor." }
    $name = [string]$descriptor.path
    $manifestNames.Add($name)
    $path = Join-Path $publicRoot $name.Replace('/', '\')
    $item = Get-Item -LiteralPath $path
    if ([long]$item.Length -ne [long]$descriptor.bytes) { throw "Public manifest size mismatch: $name" }
    $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -cne [string]$descriptor.sha256) { throw "Public manifest hash mismatch: $name" }
}
Assert-ExactOrderedNames ([string[]]$manifestNames.ToArray()) $manifestExpectedNames "Public manifest file list"

$textExtensions = @(".cjs", ".css", ".html", ".js", ".json", ".jsonl", ".md", ".ps1", ".svg", ".txt", ".webmanifest", ".xml", ".yml", "")
foreach ($name in $tree.Files) {
    $extension = [IO.Path]::GetExtension($name).ToLowerInvariant()
    if ($textExtensions -contains $extension) {
        $text = [IO.File]::ReadAllText((Join-Path $publicRoot $name.Replace('/', '\')))
        foreach ($marker in $reservedMarkers) {
            if ($text.IndexOf($marker, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
                throw "Private development marker found in public file: $name"
            }
        }
        if ($text -match '(?i)[a-z]:\\Users\\[^\\]+\\' -or
            $text -match '-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----' -or
            $text -match '(?i)github_pat_[A-Za-z0-9_]+' -or
            $text -match '(?i)ghp_[A-Za-z0-9]{20,}' -or
            $text -match '(?i)sk-proj-[A-Za-z0-9_-]{16,}') { throw "Sensitive or local-only marker found in public file: $name" }
    }
}
Assert-LocalMarkdownLinks $publicRoot $tree.Files

$verifyArguments = @{
    ReleasePath = (Join-Path $publicRoot "public")
    ExpectedVersion = $ExpectedVersion
    ExpectedReleaseChannel = $ExpectedReleaseChannel
    ExpectedSourceCommit = $ExpectedReleaseSourceCommit
    ExpectedReleaseMode = "final"
    ExpectedDirectoryName = "public"
}
if ($SourceRepository) {
    $verifyArguments.SourceRepository = [IO.Path]::GetFullPath($SourceRepository)
    $resolvedExportCommit = Invoke-GitOneLine $verifyArguments.SourceRepository @("rev-parse", "$ExpectedExportSourceCommit^{commit}") "export source commit"
    if ($resolvedExportCommit -cne $ExpectedExportSourceCommit) { throw "ExpectedExportSourceCommit is not present in SourceRepository." }
    foreach ($destinationName in $sourceFiles) {
        $repoPath = if ($renamedSources.ContainsKey($destinationName)) { [string]$renamedSources[$destinationName] } else { $destinationName }
        $expectedBlob = Invoke-GitOneLine $verifyArguments.SourceRepository @("rev-parse", "${ExpectedExportSourceCommit}:$repoPath") "export source blob $repoPath"
        if ((Invoke-GitOneLine $verifyArguments.SourceRepository @("cat-file", "-t", $expectedBlob) "export source type $repoPath") -cne "blob") { throw "Export source is not a blob: $repoPath" }
        $actualBlob = Invoke-GitOneLine $verifyArguments.SourceRepository @("hash-object", "--path=$repoPath", "--", (Join-Path $publicRoot $destinationName.Replace('/', '\'))) "public source file $destinationName"
        if ($actualBlob -cne $expectedBlob) { throw "Public source differs byte-for-byte from ExpectedExportSourceCommit: $destinationName" }
    }
    & git -C $verifyArguments.SourceRepository merge-base --is-ancestor $ExpectedReleaseSourceCommit $ExpectedExportSourceCommit
    if ($LASTEXITCODE -ne 0) { throw "Release commit is not an ancestor of export commit." }
} else {
    Write-Warning "SourceRepository was not supplied: only internal consistency is verified; correspondence or authenticity of the private source commit is not established."
}
& (Join-Path $publicRoot "tools\verify-release.ps1") @verifyArguments

Write-Host "Public export verified: controlled inventory, release, source copies, privacy filters, links, and hashes match."
Write-Host "No license or external authenticity was inferred."
}

Invoke-PublicExportVerification
