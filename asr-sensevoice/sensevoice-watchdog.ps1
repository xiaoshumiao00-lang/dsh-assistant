# 鹈鹕 SenseVoice 常驻转写服务看门狗：/health 不通就（先清掉僵死进程再）重启。
# 只碰 sensevoice_server.py 这一份进程，绝不动 whisper 的 asr_server.py（3097 那条兜底腿）。
# 建议挂计划任务 TihuSenseVoiceWatchdog（每 20 分钟），日志：D:\dsh-assistant\asr-sensevoice\sensevoice-watchdog.log

$ErrorActionPreference = 'Continue'
$root = 'D:\dsh-assistant\asr-sensevoice'
$log = Join-Path $root 'sensevoice-watchdog.log'
function Log($m) { Add-Content -Path $log -Value ("[{0}] {1}" -f (Get-Date -Format 'o'), $m) }

# 单实例：两个触发器同时到点也不许两边一起拉进程
$mutex = New-Object System.Threading.Mutex($false, 'Global\TihuSenseVoiceWatchdog')
if (-not $mutex.WaitOne(0)) { exit 0 }
try {
  $healthy = $false
  try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:3098/health' -TimeoutSec 8 -ErrorAction Stop
    $healthy = [bool]$health.ok
  } catch { $healthy = $false }

  # 常驻服务：模型加载要 1–2 秒，健康判定只看 /health，不看空闲时长（本来就不该退出）
  if ($healthy) { exit 0 }

  $stale = Get-CimInstance Win32_Process -Filter "name='python.exe'" |
    Where-Object { $_.CommandLine -match 'sensevoice_server\.py' }
  foreach ($proc in $stale) {
    Log ("stale pid={0} kill" -f $proc.ProcessId)
    Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', (Join-Path $root 'start-sensevoice.cmd') -WindowStyle Hidden
  Log 'restarted (health was down)'
} finally {
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}
