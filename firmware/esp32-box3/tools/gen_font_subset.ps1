# Generate the two CJK LVGL fonts used by the tihu firmware.
#
# Requirements:
#   - Node.js 18+ (npx is used to run lv_font_conv; no global install needed)
#   - A CJK TTF on this machine. Default: C:\Windows\Fonts\simhei.ttf
#
# Usage (from anywhere):
#   pwsh -File tools\gen_font_subset.ps1
#   pwsh -File tools\gen_font_subset.ps1 -FontPath "C:\Windows\Fonts\msyh.ttc"
#
# The script is intentionally ASCII-only: Windows PowerShell 5.1 decodes
# UTF-8 scripts without a BOM as GBK, and non-ASCII comments would break parsing.
[CmdletBinding()]
param(
    [string]$FontPath = "C:\Windows\Fonts\simhei.ttf",
    [string]$OutDir = "",
    [int[]]$Sizes = @(20, 15),
    [string]$LvInclude = "lvgl.h"
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($OutDir)) {
    $OutDir = Join-Path $root "main\font"
}
$charsPath = Join-Path $PSScriptRoot "chars.txt"

if (-not (Test-Path -LiteralPath $FontPath)) {
    throw "Font not found: $FontPath"
}
if (-not (Test-Path -LiteralPath $charsPath)) {
    throw "chars.txt not found: $charsPath"
}
if (-not (Get-Command npx -ErrorAction SilentlyContinue)) {
    throw "npx not found. Install Node.js 18+ and reopen the terminal."
}

# Important: do NOT pass Chinese to npx.cmd directly. The .cmd shim goes through
# cmd.exe, which re-encodes arguments with the active ANSI code page and turns the
# --symbols string into mojibake. Bootstrap the package with ASCII args, then call
# the CLI JavaScript with node.exe so argv stays UTF-8.
& npx --yes lv_font_conv --version | Out-Null
$npmCache = (& npm config get cache 2>$null | Select-Object -First 1)
if ([string]::IsNullOrWhiteSpace($npmCache)) {
    $npmCache = Join-Path $env:LOCALAPPDATA "npm-cache"
}
$npxRoot = Join-Path $npmCache "_npx"
$cli = Get-ChildItem -LiteralPath $npxRoot -Recurse -Filter "lv_font_conv.js" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
if ($null -eq $cli) {
    throw "lv_font_conv CLI not found under $npxRoot after npx bootstrap."
}
$node = (Get-Command node -ErrorAction Stop).Source
if (-not (Test-Path -LiteralPath $OutDir)) {
    New-Item -ItemType Directory -Path $OutDir | Out-Null
}

# Keep only content lines, then strip whitespace. Duplicate characters are fine;
# lv_font_conv would complain about them, so de-duplicate before passing symbols.
$lines = Get-Content -LiteralPath $charsPath -Encoding UTF8
$body = ($lines | Where-Object { $_ -notmatch '^\s*#' }) -join ''
$body = $body -replace '\s', ''
$symbols = -join ($body.ToCharArray() | Sort-Object -Unique)

if ($symbols.Length -lt 100) {
    throw "Only $($symbols.Length) unique symbols found; check chars.txt encoding."
}

Write-Host "Font   : $FontPath"
Write-Host "Chars  : $charsPath"
Write-Host "Symbols: $($symbols.Length) unique non-ASCII characters"
Write-Host "Output : $OutDir"

# The Node helper reads chars.txt itself (UTF-8). Do not pass $symbols as a
# command-line argument: PowerShell/npx on Windows would re-encode it.
$env:LV_FONT_CONV_CLI = $cli.FullName
$nodeScript = Join-Path $PSScriptRoot "gen_font_subset.cjs"
$sizeList = ($Sizes -join ",")
& $node $nodeScript $FontPath $OutDir $sizeList
if ($LASTEXITCODE -ne 0) {
    throw "Font generation failed (exit $LASTEXITCODE)."
}

Write-Host ""
Write-Host "Done. Rebuild with: idf.py build"
Write-Host "If a project/task name still shows boxes, add its characters to chars.txt and rerun."
