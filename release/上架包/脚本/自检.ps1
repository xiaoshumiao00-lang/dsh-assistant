#Requires -Version 5.1
<#
自检.ps1 · 个人助手（dsh-assistant）上架包自检
打印 4 项：插件版本 / 悬浮球快捷键 / 个人秘书会话是否就绪 / 手机访问入口状态。

安全口径（硬性）：本脚本绝不打印会话 id、访问密码（PIN）、逃生口令、任何 token 或密钥值；
本机路径在输出里一律改写成 <DSH_HOME>、<用户目录>，方便对比且不给别人看你的家目录。

不假设作者本机路径：所有查找都从「脚本自己所在的位置」与「当前用户的环境变量」出发。
用法：
  powershell -NoProfile -ExecutionPolicy Bypass -File .\自检.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File .\自检.ps1 -PluginDir C:\你的\插件目录
#>

[CmdletBinding()]
param(
  [string]$PluginDir = '',
  [string]$DshHome = ''
)

$ErrorActionPreference = 'SilentlyContinue'
# 控制台输出走 UTF-8，中文标签不乱码
try { $OutputEncoding = [System.Text.UTF8Encoding]::new() } catch { }
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new() } catch { }

function Hide-Home([string]$path) {
  if (-not $path) { return '(未找到)' }
  $homeDir = $env:USERPROFILE
  if ($homeDir) { $path = $path.Replace($homeDir, '<用户目录>') }
  $dshHome = $DshHome
  if (-not $dshHome) { $dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $homeDir '.dsh' } }
  if ($dshHome) { $path = $path.Replace($dshHome, '<DSH_HOME>') }
  return $path
}

function Read-TextUtf8([string]$path) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return '' }
  try { return [System.IO.File]::ReadAllText($path, [System.Text.UTF8Encoding]::new()) } catch { return '' }
}

# 本机 .dsh 根：DSH_HOME 有就用它，否则 USERPROFILE\.dsh
if (-not $DshHome) { $DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' } }

Write-Host ''
Write-Host '=== 个人助手（dsh-assistant）自检 ==='
Write-Host ('宿主数据根：<DSH_HOME>（本次解析来源：' + $(if ($env:DSH_HOME) { '环境变量 DSH_HOME' } else { '默认 用户目录\.dsh' }) + '）')

# ---------------------------------------------------------------- 1) 插件版本
Write-Host ''
Write-Host '[1] 插件版本'
$candidates = New-Object System.Collections.Generic.List[string]
if ($PluginDir) { $candidates.Add((Join-Path $PluginDir 'package.json')) }
# 上架包里跑：脚本在 <仓库根>\release\上架包\脚本\ → 往上三级就是仓库根
try {
  $root = $PSScriptRoot
  foreach ($i in 1..3) { $root = Split-Path $root -Parent }
  $candidates.Add((Join-Path $root 'package.json'))
} catch { }
# 已安装进 profile 的插件
foreach ($profilePath in (Get-ChildItem -Path $DshHome -Directory -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })) {
  $candidates.Add((Join-Path (Join-Path (Join-Path $profilePath 'node_modules') 'dsh-assistant') 'package.json'))
}
foreach ($p in @('desktop','web','default')) { $candidates.Add((Join-Path (Join-Path (Join-Path $DshHome 'profiles') $p) (Join-Path 'node_modules' (Join-Path 'dsh-assistant' 'package.json')))) }

$pkgFile = ''; $version = ''
foreach ($c in $candidates) {
  if (Test-Path -LiteralPath $c -PathType Leaf) {
    $text = Read-TextUtf8 $c
    if ($text -match '"version"\s*:\s*"([^"]+)"') {
      $version = $Matches[1]
      if ($text -match '"name"\s*:\s*"([^"]+)"') {
        if ($Matches[1] -ne 'dsh-assistant') { continue }
      }
      $pkgFile = $c
      break
    }
  }
}
if ($version) {
  Write-Host ('  插件版本：' + $version + '（package.json 来源：' + (Hide-Home $pkgFile) + '）')
  if ($version -ne '0.2.41') { Write-Host '  注意：与上架包口径 0.2.41 不一致，请以《交付清单》为准核对。' }
} else {
  Write-Host '  插件版本：未找到 package.json（请用 -PluginDir 指到插件目录）'
}

# ---------------------------------------------------------------- 2) 悬浮球快捷键
Write-Host ''
Write-Host '[2] 悬浮球快捷键（实测口径）'
Write-Host '  Ctrl+Alt+A      = 个人秘书（全局热键，页面不在前台也能唤起）'
Write-Host '  单击悬浮球      = 个人秘书'
Write-Host '  长按 600 毫秒   = 控制室（项目卡片 / 会话 / 模板 / 新建会话）'
Write-Host '  网页地址加 ?assistant=chat 直达个人秘书；?assistant=console 直达控制室'
Write-Host '  按住拖动只挪球，不会触发点击'

# ---------------------------------------------------------------- 3) 个人秘书会话是否就绪
Write-Host ''
Write-Host '[3] 个人秘书会话是否就绪'
$secretaryHit = ''
$probeDirs = @($DshHome, (Join-Path $DshHome 'profiles'), $env:DSH_ASSISTANT_HOME)
foreach ($d in $probeDirs) {
  if (-not $d) { continue }
  if (-not (Test-Path -LiteralPath $d -PathType Container)) { continue }
  $found = Get-ChildItem -LiteralPath $d -Recurse -Filter 'dsh-assistant-secretary.json' -File -ErrorAction SilentlyContinue | Select-Object -First 5
  foreach ($f in $found) {
    $text = Read-TextUtf8 $f.FullName
    if (-not $text) { continue }
    $parsed = $null
    try { $parsed = $text | ConvertFrom-Json } catch { $parsed = $null }
    if ($parsed -and $parsed.sessionId -and ([string]$parsed.sessionId).Length -gt 0) { $secretaryHit = $f.FullName; break }
  }
  if ($secretaryHit) { break }
}
if ($secretaryHit) {
  Write-Host '  个人秘书：已就绪（会话名「个人秘书」，固定会话绑定已写入宿主）'
  Write-Host ('  状态文件：' + (Hide-Home $secretaryHit) + '（会话 id 不打印）')
} else {
  Write-Host '  个人秘书：未就绪（还没找到绑定记录 dsh-assistant-secretary.json）'
  Write-Host '  怎么办：在电脑上打开 DSH，按 Ctrl+Alt+A 或单击悬浮球一次；插件会新建固定会话并把绑定写到宿主 profile。'
  Write-Host '  仍然未就绪就看《报错对照表》第 6 节（秘书会话打不开 / unknown session）。'
}
Write-Host '  说明：本行不打印会话 id（隐私口径），只报状态与会话名。'

# ---------------------------------------------------------------- 4) 手机访问入口状态
Write-Host ''
Write-Host '[4] 手机访问入口状态'
$settingsFile = Join-Path (Join-Path $DshHome 'dsh-pocket') 'settings.json'
$port = 3081
$lanEnabled = $null
$tunnelMode = 'quick'
$hasTunnelToken = $false
$hasSshHost = $false
if (Test-Path -LiteralPath $settingsFile -PathType Leaf) {
  $parsed = $null
  try { $parsed = Read-TextUtf8 $settingsFile | ConvertFrom-Json } catch { $parsed = $null }
  if ($parsed) {
    if ($parsed.proxyPort -and ([int]$parsed.proxyPort) -gt 0) { $port = [int]$parsed.proxyPort }
    if ($null -ne $parsed.lanEnabled) { $lanEnabled = [bool]$parsed.lanEnabled }
    if ($parsed.tunnelMode) { $tunnelMode = [string]$parsed.tunnelMode }
    $hasTunnelToken = -not [string]::IsNullOrEmpty([string]$parsed.tunnelToken)
    $sshHost = ''
    if ($parsed.sshTunnel) { $sshHost = [string]$parsed.sshTunnel.host }
    $hasSshHost = -not [string]::IsNullOrEmpty($sshHost)
  }
  Write-Host ('  设置文件：' + (Hide-Home $settingsFile))
} else {
  Write-Host ('  设置文件：无（首启默认 = 局域网关闭 + 局域网要密码）→ ' + (Hide-Home $settingsFile))
}

$listening = $false
$conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($conns) { $listening = $true }
if (-not $listening) {
  $net = (& netstat -ano) 2>$null
  if ($net) {
    $needle = ':' + $port + ' '
    foreach ($line in $net) {
      if ($line -match 'LISTENING' -and $line -match [regex]::Escape($needle)) { $listening = $true; break }
    }
  }
}
Write-Host ('  监听端口：' + $port + ' → ' + $(if ($listening) { '正在监听（本机入口已起来）' } else { '未监听（入口没起来或宿主没重启）' }))

$httpStatus = ''
if ($listening) {
  try {
    $resp = Invoke-WebRequest -Uri ('http://127.0.0.1:' + $port + '/') -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
    $httpStatus = [string]$resp.StatusCode
  } catch {
    if ($_.Exception.Response) {
      $code = 0
      try { $code = [int]$_.Exception.Response.StatusCode } catch { }
      if ($code) { $httpStatus = [string]$code } else { $httpStatus = '有响应（状态码没读到）' }
    } else {
      $httpStatus = '连不上'
    }
  }
  if ($httpStatus) {
    if ($httpStatus -eq '401') {
      Write-Host '  本机可访问：是（HTTP 401 = 需要登录，属正常；手机第一次连要输一次访问密码）'
    } elseif ($httpStatus -eq '连不上') {
      Write-Host '  本机可访问：否（端口在监听但 HTTP 连不上：先重启 DSH 宿主再看这条）'
    } else {
      Write-Host ('  本机可访问：是（HTTP ' + $httpStatus + '）')
    }
  }
} else {
  Write-Host '  本机可访问：否（端口没监听）'
}

$lanText = if ($null -eq $lanEnabled) { '未记录（按首启默认：关闭）' } elseif ($lanEnabled) { '开' } else { '关' }
Write-Host ('  局域网访问开关：' + $lanText)
Write-Host ('  公网隧道模式：' + $tunnelMode)
Write-Host ('  Cloudflare Token：' + $(if ($hasTunnelToken) { '已配置（值不打印）' } else { '未配置' }))
Write-Host ('  SSH 反向隧道主机：' + $(if ($hasSshHost) { '已配置（地址不打印）' } else { '未配置' }))
Write-Host '  入口地址与 8 位访问密码：只在你自己电脑上看 → DSH 设置 → 个人助手 → 手机访问（本脚本不打印密码）'

Write-Host ''
Write-Host '=== 自检结束（未打印任何会话 id / 密码 / token / 一次性口令）==='
Write-Host ''
