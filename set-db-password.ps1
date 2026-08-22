# LD ERP Solution — put the Supabase database password into the .env files
#
# Run it from this folder:
#   powershell -ExecutionPolicy Bypass -File .\set-db-password.ps1
#
# It asks for the password without showing it on screen, URL-encodes it, writes
# both .env files, and then checks that the database actually answers.

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

$PROJECT_REF = 'cpogaadkcefpeanxbqkb'
$POOLER_HOST = 'aws-0-ap-southeast-1.pooler.supabase.com'
$SCHEMA      = 'ld_erp'

Write-Host ''
Write-Host '  LD ERP Solution - database password setup' -ForegroundColor Cyan
Write-Host '  -----------------------------------------' -ForegroundColor Cyan
Write-Host ''
Write-Host '  Supabase project : LD COTTON APPS'
Write-Host "  Database schema  : $SCHEMA"
Write-Host ''
Write-Host '  Your typing will be hidden. Paste with Ctrl+V or right-click, then press Enter.'
Write-Host ''

$secure = Read-Host '  Database password' -AsSecureString
$plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
)

if ([string]::IsNullOrWhiteSpace($plain)) {
    Write-Host ''
    Write-Host '  Nothing entered. Run the script again when you have the password.' -ForegroundColor Red
    exit 1
}

if ($plain -match '^\[.*\]$') {
    Write-Host ''
    Write-Host '  That looks like the [YOUR-PASSWORD] placeholder, not a real password.' -ForegroundColor Red
    Write-Host '  Use Reset database password in the Supabase dashboard to get a real one.' -ForegroundColor Red
    exit 1
}

# A password with @ : / ? # or & would otherwise be misread as part of the URL.
$encoded = [System.Uri]::EscapeDataString($plain)

$pooled = "postgresql://postgres.$PROJECT_REF`:$encoded@$POOLER_HOST`:6543/postgres?pgbouncer=true&schema=$SCHEMA"
$direct = "postgresql://postgres.$PROJECT_REF`:$encoded@$POOLER_HOST`:5432/postgres?schema=$SCHEMA"

# ── packages/database/.env — used by the Prisma command line ──
$dbEnv = @"
# Supabase project: LD COTTON APPS ($PROJECT_REF), region ap-southeast-1
# ERP tables live in the dedicated `$SCHEMA` schema, alongside vhagar_fabric
# and vhagar_kandy. Written by set-db-password.ps1 — never commit this file.

# Pooled connection (port 6543) - what the running app uses.
DATABASE_URL="$pooled"

# Session connection (port 5432) - needed for schema migrations.
DIRECT_URL="$direct"
"@
Set-Content -Path 'packages\database\.env' -Value $dbEnv -Encoding utf8
Write-Host ''
Write-Host '  Written: packages\database\.env' -ForegroundColor Green

# ── apps/api/.env — keep every other setting, replace only the two URLs ──
$apiEnvPath = 'apps\api\.env'
if (-not (Test-Path $apiEnvPath)) {
    Copy-Item 'apps\api\.env.example' $apiEnvPath
}

$lines = Get-Content $apiEnvPath
$out = New-Object System.Collections.Generic.List[string]
$seenDatabase = $false
$seenDirect = $false

foreach ($line in $lines) {
    if ($line -match '^\s*DATABASE_URL\s*=') {
        $out.Add("DATABASE_URL=`"$pooled`""); $seenDatabase = $true
    } elseif ($line -match '^\s*DIRECT_URL\s*=') {
        $out.Add("DIRECT_URL=`"$direct`""); $seenDirect = $true
    } else {
        $out.Add($line)
    }
}
if (-not $seenDatabase) { $out.Add("DATABASE_URL=`"$pooled`"") }
if (-not $seenDirect)   { $out.Add("DIRECT_URL=`"$direct`"") }

Set-Content -Path $apiEnvPath -Value $out -Encoding utf8
Write-Host '  Written: apps\api\.env' -ForegroundColor Green

# ── Prove the database actually answers ──
Write-Host ''
Write-Host '  Checking the connection...' -ForegroundColor Cyan

$check = @'
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()
prisma.$queryRaw`select current_user, current_schema()`
  .then(async () => {
    const users = await prisma.user.count()
    const roles = await prisma.role.count()
    console.log(`OK|${users}|${roles}`)
  })
  .catch((e) => console.log('FAIL|' + e.message.split('\n').find(Boolean)))
  .finally(() => prisma.$disconnect())
'@

$checkFile = Join-Path $env:TEMP 'ld-erp-db-check.js'
Set-Content -Path $checkFile -Value $check -Encoding utf8

Push-Location 'packages\database'
$result = node $checkFile 2>&1 | Select-String -Pattern '^(OK|FAIL)\|' | Select-Object -First 1
Pop-Location
Remove-Item $checkFile -ErrorAction SilentlyContinue

Write-Host ''
if ($result -and $result.ToString().StartsWith('OK|')) {
    $parts = $result.ToString().Split('|')
    Write-Host '  Connected successfully.' -ForegroundColor Green
    Write-Host "  Found $($parts[1]) users and $($parts[2]) roles in the database." -ForegroundColor Green
    Write-Host ''
    Write-Host '  You are ready. Start the ERP with:' -ForegroundColor Cyan
    Write-Host '    pnpm dev:api     (leave this window open)'
    Write-Host '    pnpm dev:web     (in a second window)'
    Write-Host ''
    Write-Host '  Then open http://localhost:3000 and sign in as:'
    Write-Host '    admin@ldcottonmills.com / Admin@123'
    Write-Host ''
} else {
    Write-Host '  Could not connect.' -ForegroundColor Red
    if ($result) { Write-Host "  $($result.ToString().Substring(5))" -ForegroundColor Red }
    Write-Host ''
    Write-Host '  Most likely the password was wrong. Run this script again,' -ForegroundColor Yellow
    Write-Host '  or reset the password in the Supabase dashboard and use the new one.' -ForegroundColor Yellow
    Write-Host ''
    exit 1
}
