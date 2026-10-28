param(
  [string]$Archive = 'D:\DSH Desktop\resources\app.asar',
  [string]$Patched = 'D:\DSH Desktop\resources\app.asar.patched-host-auth-cookies-20261028',
  [string]$ExpectedHash = '58A3709A4A96DB293703D7BB8859EA151F7FD473777260E1C5018667CF671B74',
  [string]$LogPath = 'D:\dsh-assistant\scripts\app-asar-patch.log'
)
$ErrorActionPreference = 'Stop'
function Write-PatchLog([string]$Message) {
  $line = '{0:o} {1}' -f (Get-Date), $Message
  Add-Content -LiteralPath $LogPath -Value $line -Encoding utf8
}
function Test-AppRunning {
  return [bool](Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
}
Write-PatchLog "watcher started; waiting for DSH to exit"
$deadline = (Get-Date).AddHours(24)
while ((Test-AppRunning) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 2 }
if (Test-AppRunning) { Write-PatchLog 'timeout: DSH still running; patch not applied'; exit 2 }
if (-not (Test-Path -LiteralPath $Patched)) { Write-PatchLog "patched archive missing: $Patched"; exit 3 }
$actual = (Get-FileHash -LiteralPath $Patched -Algorithm SHA256).Hash
if ($actual -ne $ExpectedHash) { Write-PatchLog "patched hash mismatch: $actual"; exit 4 }
# Let the old process release file handles before replacing the archive.
Start-Sleep -Seconds 2
if (Test-AppRunning) {
  Write-PatchLog 'DSH restarted before replacement; waiting for the next exit'
  while ((Test-AppRunning) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 2 }
  if (Test-AppRunning) { Write-PatchLog 'timeout after restart; patch not applied'; exit 2 }
  Start-Sleep -Seconds 2
}
$archiveFull = [System.IO.Path]::GetFullPath($Archive)
$patchedFull = [System.IO.Path]::GetFullPath($Patched)
if (-not $archiveFull.StartsWith('D:\DSH Desktop\resources\') -or -not $patchedFull.StartsWith('D:\DSH Desktop\resources\')) {
  Write-PatchLog "unexpected path: $archiveFull / $patchedFull"; exit 6
}
Copy-Item -LiteralPath $Patched -Destination $Archive -Force
$installed = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash
if ($installed -ne $ExpectedHash) { Write-PatchLog "install hash mismatch: $installed"; exit 7 }
Remove-Item -LiteralPath $Patched -Force
Write-PatchLog "installed host-auth-cookie fix: $installed"
exit 0
