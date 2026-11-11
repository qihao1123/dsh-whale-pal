param(
  [int]$DelaySeconds = 6,
  [switch]$DryRun,
  [string]$LogPath = (Join-Path $env:TEMP 'whale-pal-restart.log')
)
# Restart the DSH host process that serves the Web GUI (port 57682) and log
# what happens: when it dies, whether it comes back by itself, and whether the
# new whale-pal kernel answers afterwards. ASCII only: PS 5.1 reads UTF-8
# without BOM as ANSI, and non-ASCII text breaks parsing here.
$ErrorActionPreference = 'SilentlyContinue'
$log = $LogPath
$port = 57682
$hostPid = 12064
if ($DryRun) { $DelaySeconds = 0 }

function Write-Log($text) {
  $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $text
  Add-Content -Path $log -Value $line -Encoding utf8
}

Set-Content -Path $log -Value ('restart-watch started at ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) -Encoding utf8

Start-Sleep -Seconds $DelaySeconds

if ($DryRun) {
  Write-Log ('DRY RUN ok, host pid=' + $hostPid + ' left alive')
  exit 0
}

$before = Get-Process -Id $hostPid
if (-not $before) {
  Write-Log ('host pid=' + $hostPid + ' not found, nothing to kill')
  exit 0
}
Write-Log ('killing host pid=' + $hostPid + ' started ' + $before.StartTime.ToString('HH:mm:ss'))
Stop-Process -Id $hostPid -Force
Start-Sleep -Seconds 2
if (Get-Process -Id $hostPid) { Write-Log 'FAIL host still alive' } else { Write-Log 'OK host exited' }

$back = 0
for ($i = 1; $i -le 90; $i++) {
  Start-Sleep -Seconds 1
  $conn = Get-NetTCPConnection -LocalPort $port -State Listen
  if ($conn) { $back = $i; break }
}
if ($back -eq 0) {
  Write-Log ('port ' + $port + ' did not come back in 90s: reopen DeepSeek Harness manually')
  exit 0
}
$newPid = ($conn | Select-Object -First 1).OwningProcess
Write-Log ('port back after ' + $back + 's, new pid=' + $newPid)

Start-Sleep -Seconds 10
$ping = $null
for ($i = 1; $i -le 10; $i++) {
  try {
    $ping = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $port + '/dsh-whale-pal-7a1f/ping') -TimeoutSec 3
    break
  } catch {
    Start-Sleep -Seconds 3
  }
}
if ($ping) {
  Write-Log ('OK new kernel answers: name=' + $ping.name + ' root=' + $ping.paths.root)
} else {
  Write-Log 'FAIL new kernel did not answer /ping'
}

try {
  $state = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $port + '/dsh-whale-pal-7a1f/state') -TimeoutSec 5
  Write-Log ('OK state revision=' + $state.state.revision + ' longMemory=' + $state.state.longMemory.Count + ' traits=' + $state.state.traits.Count)
} catch {
  Write-Log 'FAIL /state not readable'
}

try {
  Invoke-RestMethod -Uri ('http://127.0.0.1:' + $port + '/dsh-persona-framework-8f3a/ping') -TimeoutSec 3 | Out-Null
  Write-Log 'FAIL old kernel route still answers'
} catch {
  Write-Log 'OK old kernel route gone'
}
