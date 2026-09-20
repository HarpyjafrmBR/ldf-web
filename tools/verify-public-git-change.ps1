param(
    [string]$Repository = ""
)

$ErrorActionPreference = "Stop"

if (-not $Repository) {
    $Repository = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
}
$root = [IO.Path]::GetFullPath($Repository)
if (-not (Test-Path -LiteralPath $root -PathType Container)) {
    throw "REPOSITORY: public repository does not exist."
}

$historyOutput = @(& git -C $root rev-list --parents -n 1 HEAD 2>&1)
if ($LASTEXITCODE -ne 0 -or $historyOutput.Count -ne 1) {
    throw "HISTORY: public HEAD could not be resolved."
}
$history = ([string]$historyOutput[0]).Trim()
if ($history -notmatch '^[0-9a-f]{40}(?: [0-9a-f]{40})*$') {
    throw "HISTORY: public HEAD has an invalid parent record."
}
$parts = [string[]]($history -split ' ')

if ($parts.Count -eq 1) {
    Write-Host "Public Git change verification: PASS (root commit; full public gates remain required)."
    return
}
if ($parts.Count -ne 2) {
    throw "HISTORY: public branch must remain linear."
}

$diffOutput = @(& git -C $root diff --check $parts[1] $parts[0] -- 2>&1)
if ($LASTEXITCODE -ne 0) {
    $detail = if ($diffOutput.Count) { ([string]$diffOutput[0]).Trim() } else { "git diff --check failed" }
    throw "WHITESPACE: $detail"
}

Write-Host "Public Git change verification: PASS (one linear change, whitespace clean)."
