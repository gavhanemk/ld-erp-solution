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

# ── Is it already running, or is something else on our port? ─
#
# Other projects on this machine also use port 3000. Assuming a busy port meant
# "the ERP is already running" opened somebody else's website instead of ours.
# So the port is checked for *whose* it is, not merely whether it is taken.
function PortOwner($port) {
    $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
         Select-Object -First 1
    if (-not $c) { return $null }
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)" -ErrorAction SilentlyContinue
    return $p.CommandLine
}

function IsOurs($commandLine) {
    if (-not $commandLine) { return $false }
    return $commandLine -like "*$PSScriptRoot*"
}

$apiOwner = PortOwner $API_PORT
$webOwner = PortOwner $WEB_PORT

if ((IsOurs $apiOwner) -or (IsOurs $webOwner)) {
    Say 'The ERP is already running.' 'Yellow'
    Say "Opening http://localhost:$WEB_PORT" 'Yellow'
    Start-Process "http://localhost:$WEB_PORT"
    Write-Host ''
    Read-Host '  Press Enter to close'
    exit 0
}

if ($apiOwner) {
    Say "Port $API_PORT is being used by another program, and the ERP server needs it." 'Red'
    Say 'Close that program and try again.' 'Yellow'
    Write-Host ''
    Read-Host '  Press Enter to close'
    exit 1
}

# The website can move to another port; Next picks the next free one itself.
if ($webOwner) {
    Say "Port $WEB_PORT is being used by another program, so the website will" 'Yellow'
    Say 'open on the next free port instead. The link below will be correct.' 'Yellow'
    Write-Host ''
    for ($p = $WEB_PORT + 1; $p -le $WEB_PORT + 20; $p++) {
        if (-not (PortOwner $p)) { $WEB_PORT = $p; break }
    }
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
    "Set-Location '$PSScriptRoot'; Write-Host 'LD ERP - WEBSITE. Closing this window stops the ERP.' -ForegroundColor Cyan; `$env:PORT='$WEB_PORT'; pnpm dev:web"
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
