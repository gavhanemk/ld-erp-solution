param([ValidateSet('Prepare','Start','Stop')][string]$Action='Start')
$ErrorActionPreference='Stop'
$repo = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $repo
$state = Join-Path $repo '.local-sampling'
$pgBin = if ($env:PG_BIN) { $env:PG_BIN } else { 'C:/Program Files/PostgreSQL/16/bin' }
$env:DATABASE_URL='postgresql://postgres@127.0.0.1:55439/lderp_sampling?schema=ld_erp'
$env:DIRECT_URL=$env:DATABASE_URL
$env:SAMPLING_ENABLED='true'
$env:NODE_ENV='development'
$env:JWT_SECRET='local-sampling-only-access-secret'
$env:JWT_REFRESH_SECRET='local-sampling-only-refresh-secret'
$env:PORT='5102'
$env:FRONTEND_URL='http://localhost:3302'
$env:NEXT_PUBLIC_API_URL='http://localhost:5102/api'
$env:NEXT_PUBLIC_SOCKET_URL='http://localhost:5102'
$env:NEXT_PUBLIC_SAMPLING_ENABLED='true'
$env:SAMPLING_WEB_DIST='.next-sampling'
$env:NEXT_TELEMETRY_DISABLED='1'
# Tech packs and other uploads stay on this PC under the pilot's state folder, never in shared storage.
$env:STORAGE_DRIVER='local'
$env:LOCAL_STORAGE_DIR="$state/files"
$env:LOCAL_STORAGE_BASE_URL='http://localhost:5102/api/local-files'
New-Item -ItemType Directory -Path $state -Force | Out-Null
function RunNode($argsForNode) { & node @argsForNode; if($LASTEXITCODE -ne 0){throw "Node command failed: $($argsForNode[0])"} }
if($Action -eq 'Stop') {
  # Stop only the process IDs saved by this launcher and still belonging to this project.
  if(Test-Path "$state/processes.json") {
    foreach ($entry in (Get-Content "$state/processes.json" -Raw | ConvertFrom-Json)) {
      $proc = Get-Process -Id $entry.Id -ErrorAction SilentlyContinue
      if($proc -and $proc.ProcessName -eq 'node' -and $proc.StartTime.ToUniversalTime().ToString('O') -eq $entry.StartedAtUtc) { Stop-Process -Id $proc.Id }
    }
  }
  if(Test-Path "$state/data/postmaster.pid") { & "$pgBin/pg_ctl.exe" -D "$state/data" -m fast -w stop }
  Remove-Item -LiteralPath "$state/processes.json" -ErrorAction SilentlyContinue
  exit
}
if(Test-Path "$state/processes.json") { throw 'A pilot session has already been started. Run -Action Stop before preparing or restarting.' }
# Signs the file links. Made once and kept, so links already handed out survive a restart; never printed.
$secretFile = Join-Path $state 'storage.secret'
if(!(Test-Path $secretFile) -or !([IO.File]::ReadAllText($secretFile).Trim())) {
  $secretBytes = New-Object byte[] 48
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($secretBytes) } finally { $rng.Dispose() }
  [IO.File]::WriteAllText($secretFile, [Convert]::ToBase64String($secretBytes))
}
$env:LOCAL_STORAGE_SECRET = [IO.File]::ReadAllText($secretFile).Trim()
New-Item -ItemType Directory -Path $env:LOCAL_STORAGE_DIR -Force | Out-Null
if(!(Test-Path "$pgBin/initdb.exe")){throw 'PostgreSQL tools were not found. Set PG_BIN to their bin directory.'}
if(!(Test-Path "$state/data/PG_VERSION")) {
  $init = Start-Process "$pgBin/initdb.exe" -ArgumentList @('-D',('"'+"$state/data"+'"'),'-U','postgres','-A','trust','--no-locale','-E','UTF8') -WindowStyle Hidden -RedirectStandardOutput "$state/init.log" -RedirectStandardError "$state/init.err.log" -Wait -PassThru
  if($init.ExitCode -ne 0){throw "initdb failed. Read $state/init.log and init.err.log"}
}
if(!(Test-Path "$state/data/postmaster.pid")) {
  $pgProcess = Start-Process "$pgBin/postgres.exe" -ArgumentList @('-D',('"'+"$state/data"+'"'),'-p','55439','-h','127.0.0.1') -WindowStyle Hidden -RedirectStandardOutput "$state/postgres.out.log" -RedirectStandardError "$state/postgres.err.log" -PassThru
}
for($attempt=0;$attempt -lt 30;$attempt++) { & "$pgBin/pg_isready.exe" -h 127.0.0.1 -p 55439 -q; if($LASTEXITCODE -eq 0){break}; Start-Sleep -Milliseconds 200 }
if($LASTEXITCODE -ne 0 -or !(Test-Path "$state/data/postmaster.pid")){throw 'The isolated PostgreSQL cluster did not start; check for a port conflict.'}
$dbExists = & "$pgBin/psql.exe" -h 127.0.0.1 -p 55439 -U postgres -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname='lderp_sampling'"
if($dbExists -ne '1'){ & "$pgBin/createdb.exe" -h 127.0.0.1 -p 55439 -U postgres lderp_sampling; if($LASTEXITCODE -ne 0){throw 'Could not create the local pilot database.'} }
RunNode @('node_modules/prisma/build/index.js','migrate','deploy','--schema','packages/database/prisma/schema.prisma')
RunNode @('node_modules/prisma/build/index.js','generate','--schema','packages/database/prisma/schema.prisma')
RunNode @('tools/sampling-fixtures.cjs')
if($Action -eq 'Prepare'){exit}
$api = Start-Process node -ArgumentList @('--require',('"'+"$repo/tools/register-ts.cjs"+'"'),('"'+"$repo/apps/api/src/index.ts"+'"')) -WorkingDirectory $repo -WindowStyle Hidden -RedirectStandardOutput "$state/api.out.log" -RedirectStandardError "$state/api.err.log" -PassThru
$web = Start-Process node -ArgumentList @(('"'+"$repo/tools/sampling-web.cjs"+'"')) -WorkingDirectory $repo -WindowStyle Hidden -RedirectStandardOutput "$state/web.out.log" -RedirectStandardError "$state/web.err.log" -PassThru
@($api,$web) | ForEach-Object { $_.Refresh(); [pscustomobject]@{Id=$_.Id;StartedAtUtc=$_.StartTime.ToUniversalTime().ToString('O')} } | ConvertTo-Json | Set-Content "$state/processes.json"
Write-Output 'Sampling pilot: http://localhost:3302/sampling (API :5102, database :55439). Logs: .local-sampling/'
