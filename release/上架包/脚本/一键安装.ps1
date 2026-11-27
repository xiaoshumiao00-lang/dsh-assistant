#Requires -Version 5.1
<#
一键安装.ps1 · 个人助手（dsh-assistant）上架包

这个脚本不假设任何作者本机路径：只用当前用户的环境变量与 PATH 做判断。
它做的事：检查前提（Node 22 / 网络 / DSH 宿主）、打印正确的第三方源安装口令、
在 -Execute 时替你跑 `dsh plugin --profile web add github:xiaoshumiao00-lang/dsh-assistant`。
它不写注册表、不下载、不删任何文件，也不打印任何密钥或 token。

用法：
  powershell -NoProfile -ExecutionPolicy Bypass -File .\一键安装.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File .\一键安装.ps1 -Profile web -Execute
#>

[CmdletBinding()]
param(
  [string]$Profile = 'web',
  [switch]$Execute
)

$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new() } catch { }

$SourceLine = 'github:xiaoshumiao00-lang/dsh-assistant'

Write-Host ''
Write-Host '=== 个人助手（dsh-assistant）一键安装 ==='

# ---- 1) Node 22 ----
$nodeOk = $false
$nodeVer = ''
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) {
  $nodeVer = (& node -v) 2>$null
  if ($nodeVer) {
    $nodeVer = ([string]$nodeVer).Trim()
    $major = 0
    if ($nodeVer -match '^v?(\d+)') { $major = [int]$Matches[1] }
    if ($major -ge 22) { $nodeOk = $true }
  }
}
if ($nodeOk) { Write-Host ('[OK]  Node：' + $nodeVer + '（需要 >= 22）') }
else { Write-Host ('[必要] Node：' + $(if ($nodeVer) { $nodeVer + ' 低于 22' } else { '没找到 node（装 Node.js 22 或让 DSH 自带运行时顶上）' })) }

# ---- 2) DSH 宿主 ----
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$hostFound = Test-Path -LiteralPath $dshHome -PathType Container
if ($hostFound) { Write-Host '[OK]  找到宿主数据目录（DSH 已装过；<DSH_HOME> 解析为 用户目录\.dsh 或环境变量）' }
else { Write-Host ('[必要] 没找到宿主数据目录 <DSH_HOME>（=' + $dshHome + '）：先装 DeepSeek Harness 桌面版（>= 0.1.5）') }

# ---- 3) GitHub 可达 ----
$netOk = $false
try {
  $resp = Invoke-WebRequest -Uri 'https://github.com' -UseBasicParsing -Method Head -TimeoutSec 8 -ErrorAction Stop
  if ($resp.StatusCode) { $netOk = $true }
} catch { $netOk = $false }
if ($netOk) { Write-Host '[OK]  能访问 github.com' } else { Write-Host '[必要] 现在连不上 github.com：换网络或先配好代理再装' }

# ---- 4) 安装口令本身 ----
Write-Host ''
Write-Host '--- 安装（二选一）---'
Write-Host ('第三方源（认准这一行，别只填 dsh-assistant）：' + $SourceLine)
Write-Host '警告：公开 npm 上的 dsh-assistant 是别人的同名包（不是本插件）。上架与安装一律走第三方源 github:xiaoshumiao00-lang/dsh-assistant。'
Write-Host ''
Write-Host 'A. 桌面版（推荐）：打开 DSH → 插件 → 添加插件 → 粘贴上面那一行 → 回车 → 完全退出并重启 DSH Desktop'
Write-Host '   （桌面版不能用命令行：--profile desktop 由 Electron 独占）'
Write-Host 'B. 命令行（dsh web / 服务器 profile）：'
Write-Host ('   dsh plugin --profile ' + $Profile + ' add ' + $SourceLine)

$dshCmd = Get-Command dsh -ErrorAction SilentlyContinue
if ($Execute) {
  if (-not $dshCmd) {
    Write-Host ''
    Write-Host '[没执行] PATH 里找不到 dsh 命令。桌面版请用上面 A 那条（在 DSH 界面里粘贴）。'
  } else {
    Write-Host ''
    Write-Host ('[执行] dsh plugin --profile ' + $Profile + ' add ' + $SourceLine)
    & dsh plugin --profile $Profile add $SourceLine
    Write-Host '[完成] 拉包与装依赖的退出码如上；纯客户端改动刷新页面即可，宿主改动必须重启宿主。'
  }
} else {
  Write-Host ''
  Write-Host '（这次只打印指引，没有替你执行任何安装。要替你执行就加 -Execute。）'
}

# ---- 5) 下一步 ----
Write-Host ''
Write-Host '--- 下一步（都在你自己电脑上做）---'
Write-Host '1. 重启 DSH Desktop → 左侧应多出「个人助手」，右下角应出现悬浮球。'
Write-Host '2. 悬浮球：Ctrl+Alt+A / 单击 = 个人秘书；长按 600ms = 控制室。'
Write-Host '3. 开手机访问入口：设置 → 个人助手 → 手机访问（默认端口 3081，局域网默认关闭；'
Write-Host '   局域网要密码；公网需要你自己的域名或 VPS）。入口地址与访问密码只在你这台电脑的设置页看。'
Write-Host '4. 手机装安装包里的 APK（1.4.8），打开后填你自己电脑的入口地址；升级 APK 必须用同一把签名密钥。'
Write-Host '5. 本机个人化配置：设置 → 个人助手 → 本机配置（空白模板见 配置模板\）。'
Write-Host '6. 跑同目录的 自检.ps1 看四项目是否就绪。'
Write-Host ''
