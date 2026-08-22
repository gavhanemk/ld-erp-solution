# LD ERP Solution — start the whole system
#
# Right-click this file and choose "Run with PowerShell", or run:
#   powershell -ExecutionPolicy Bypass -File ".\START ERP.ps1"
#
# It starts the API and the web app in their own windows, waits until both are
# actually answering, then opens the browser.

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

$API_PORT = 5000
$WEB_PORT = 3000

function Say($text, $colour = 'White') { Write-Host "  $text" -ForegroundColor $colour }

Write-Host ''
Write-Host '  LD ERP Solution' -ForegroundColor Cyan
Write-Host '  ---------------' -ForegroundColor Cyan
Write-Host ''

# ── Check setup has been done ────────────────────────────────
if (-not (Test-Path 'node_modules')) {
    Say 'The project has not been installed yet.' 'Red'
    Say 'Run this first:  pnpm install' 'Yellow'
    Write-Host ''
    Read-Host '  Press Enter to close'
    exit 1
}

if (-not (Test-Path 'apps\api\.env')) {
    Say 'The database password has not been set.' 'Red'
    Say 'Run this first:  powershell -ExecutionPolicy Bypass -File .\set-db-password.ps1' 'Yellow'
    Write-Host ''
    Read-Host '  Press Enter to close'
    exit 1
}

if ((Get-Content 'apps\api\.env' -Raw) -match '\[YOUR-PASSWORD\]') {
    Say 'The database password is still a placeholder.' 'Red'
    Say 'Run this first:  powershell -ExecutionPolicy Bypass -File .\set-db-password.ps1' 'Yellow'
    Write-Host ''
    Read-Host '  Press Enter to close'
    exit 1
}

# ── Is it already running? ───────────────────────────────────
function PortBusy($port) {
    $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    return [bool]$c
}

if ((PortBusy $API_PORT) -or (PortBusy $WEB_PORT)) {
    Say 'The ERP already seems to be running.' 'Yellow'
    Say "Opening http://localhost:$WEB_PORT" 'Yellow'
    Start-Process "http://localhost:$WEB_PORT"
    Write-Host ''
    Read-Host '  Press Enter to close'
    exit 0
}

# ── Start both halves in their own windows ───────────────────
Say 'Starting the server...' 'Cyan'
Start-Process powershell -ArgumentList @(
    '-NoExit', '-Command',
    "Set-Location '$PSScriptRoot'; Write-Host 'LD ERP - SERVER. Closing this window stops the ERP.' -ForegroundColor Cyan; pnpm dev:api"
)

Say 'Starting the website...' 'Cyan'
Start-Process powershell -ArgumentList @(
    '-NoExit', '-Command',
    "Set-Location '$PSScriptRoot'; Write-Host 'LD ERP - WEBSITE. Closing this window stops the ERP.' -ForegroundColor Cyan; pnpm dev:web"
)

# ── Wait until they actually answer ──────────────────────────
# The first start compiles the whole site, so this can take a couple of minutes.
Write-Host ''
Say 'Waiting for the ERP to be ready. The first start takes a minute or two.' 'Cyan'

function WaitFor($url, $label, $timeoutSeconds) {
    $deadline = (Get-Date).AddSeconds($timeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $r = Invoke-WebRequest -Uri $url -TimeoutSec 5 -UseBasicParsing
            if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500) {
                Say "$label is ready." 'Green'
                return $true
            }
        } catch {
            # Not up yet; keep waiting.
        }
        Write-Host '.' -NoNewline
        Start-Sleep -Seconds 3
    }
    Write-Host ''
    Say "$label did not start in time. Check its window for a red error." 'Red'
    return $false
}

Write-Host '  ' -NoNewline
$apiOk = WaitFor "http://localhost:$API_PORT/health" 'Server' 90

Write-Host '  ' -NoNewline
$webOk = WaitFor "http://localhost:$WEB_PORT/login" 'Website' 180

Write-Host ''
if ($apiOk -and $webOk) {
    Say 'The ERP is running.' 'Green'
    Write-Host ''
    Say 'Sign in with:'
    Say '  admin@ldcottonmills.com  /  Admin@123' 'Cyan'
    Write-Host ''
    Say 'To stop the ERP, close the two windows named LD ERP.' 'Yellow'
    Write-Host ''
    Start-Process "http://localhost:$WEB_PORT"
} else {
    Say 'Something did not start. Look at the two LD ERP windows for the error.' 'Red'
    Write-Host ''
}

Read-Host '  Press Enter to close this window'
