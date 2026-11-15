@echo off
rem 鹈鹕 SenseVoice 常驻转写服务启动器（127.0.0.1:3098）。
rem  - 模型只加载一次、进程不回收（常驻）；fp32 / 8 线程，与 cordis.patch.yml 的插件设置同参数
rem  - 已经健康就直接跳过，重复调用安全（watchdog 可以放心地一直叫）
rem  - 日志：D:\dsh-assistant\asr-sensevoice\sensevoice.log（超过 20MB 自动转 .1）
setlocal
set "ROOT=D:\dsh-assistant\asr-sensevoice"
set "PY=C::\Users\<ACCOUNT>\.dsh\tihu\venv-sherpa\Scripts\python.exe"
set "LOG=D:\dsh-assistant\asr-sensevoice\sensevoice.log"

curl.exe -s -m 2 -o nul http://127.0.0.1:3098/health
if %errorlevel%==0 (
  echo [%date% %time%] start-sensevoice: already healthy, skip>>"%LOG%"
  exit /b 0
)

if exist "%LOG%" (
  for %%A in ("%LOG%") do if %%~zA GTR 20971520 move /y "%LOG%" "%LOG%.1" >nul 2>&1
)

cd /d "%ROOT%"
echo [%date% %time%] start-sensevoice: launching>>"%LOG%"
start "" /b "%PY%" "%ROOT%\sensevoice_server.py" >>"%LOG%" 2>&1
exit /b 0
