# 开发版桌面图标的启动脚本：后端（3001）与 Web 开发服务器（5173）没在跑就先在后台启动，再打开桌面端开发模式。
# 已在运行的服务直接复用；关闭窗口只结束桌面端，后端与 Web 开发服务器继续在后台运行。
# 日志写在 %APPDATA%\Gor Dev\logs。
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$logs = Join-Path $env:APPDATA 'Gor Dev\logs'
New-Item -ItemType Directory -Force $logs | Out-Null

function Test-Port([int]$port) {
  [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

if (-not (Test-Port 3001)) {
  Start-Process -FilePath (Join-Path $root 'Server\venv\Scripts\python.exe') -ArgumentList '-X', 'utf8', 'main.py' `
    -WorkingDirectory (Join-Path $root 'Server') -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logs 'server.log') -RedirectStandardError (Join-Path $logs 'server.err.log')
}

if (-not (Test-Port 5173)) {
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'npm run dev' `
    -WorkingDirectory (Join-Path $root 'Web') -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logs 'web.log') -RedirectStandardError (Join-Path $logs 'web.err.log')
}

# dev.mjs 会等 Web 开发服务器就绪再开窗口，主进程代码改动后自动重启窗口
Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'npm run dev' `
  -WorkingDirectory (Join-Path $root 'Desktop') -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $logs 'desktop.log') -RedirectStandardError (Join-Path $logs 'desktop.err.log')
