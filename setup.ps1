# LD ERP Solution — first-time setup
#
# Run this from the project folder after a restart:
#   powershell -ExecutionPolicy Bypass -File .\setup.ps1
#
# It installs dependencies, generates the Prisma client, creates the tables in
# the ld_erp schema on Supabase, and seeds the company, roles and admin users.

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

function Step($n, $text) { Write-Host "`n[$n] $text" -ForegroundColor Cyan }
function Ok($text)       { Write-Host "    OK  $text" -ForegroundColor Green }
function Fail($text)     { Write-Host "    !!  $text" -ForegroundColor Red }

# ── Preflight: memory ────────────────────────────────────────
Step 1 'Checking available memory'
$c = Get-Counter '\Memory\Committed Bytes','\Memory\Commit Limit' -ErrorAction SilentlyContinue
$committed = ($c.CounterSamples | Where-Object { $_.Path -like '*committed bytes' }).CookedValue
$limit     = ($c.CounterSamples | Where-Object { $_.Path -like '*commit limit' }).CookedValue
$headroomGB = [math]::Round(($limit - $committed)/1GB, 1)

if ($headroomGB -lt 2.5) {
    Fail "Only $headroomGB GB of memory headroom. The install needs about 3 GB."
    Fail 'Close some applications or restart the PC, then run this again.'
    exit 1
}
Ok "$headroomGB GB headroom"

# ── Preflight: database password ─────────────────────────────
Step 2 'Checking the database connection string'
$envFile = 'packages\database\.env'
if (-not (Test-Path $envFile)) {
    Fail "$envFile is missing."
    exit 1
}
if ((Get-Content $envFile -Raw) -match '\[YOUR-DB-PASSWORD\]') {
    Fail 'The database password is still a placeholder.'
    Write-Host ''
    Write-Host '    Get it from the Supabase dashboard:' -ForegroundColor Yellow
    Write-Host '      LD COTTON APPS -> Project Settings -> Database -> Connection string' -ForegroundColor Yellow
    Write-Host '    Then replace [YOUR-DB-PASSWORD] in BOTH of these files:' -ForegroundColor Yellow
    Write-Host '      packages\database\.env' -ForegroundColor Yellow
    Write-Host '      apps\api\.env' -ForegroundColor Yellow
    exit 1
}
Ok 'Connection string looks filled in'

# ── Install ──────────────────────────────────────────────────
Step 3 'Installing dependencies (this takes a few minutes)'
pnpm install
if ($LASTEXITCODE -ne 0) { Fail 'pnpm install failed.'; exit 1 }
Ok 'Dependencies installed'

# ── Prisma client ────────────────────────────────────────────
Step 4 'Generating the database client'
pnpm db:generate
if ($LASTEXITCODE -ne 0) { Fail 'prisma generate failed.'; exit 1 }
Ok 'Client generated'

# ── Migrate ──────────────────────────────────────────────────
Step 5 'Creating the tables in the ld_erp schema'
pnpm --filter @ld-erp/database exec prisma migrate dev --name init
if ($LASTEXITCODE -ne 0) { Fail 'Migration failed. Check the connection string.'; exit 1 }
Ok 'Tables created'

# ── Seed ─────────────────────────────────────────────────────
Step 6 'Seeding company, roles, permissions and users'
pnpm db:seed
if ($LASTEXITCODE -ne 0) { Fail 'Seeding failed.'; exit 1 }
Ok 'Seed data loaded'

Write-Host "`nSetup complete." -ForegroundColor Green
Write-Host ''
Write-Host '  Start the API:  pnpm dev:api    (http://localhost:5000)'
Write-Host '  Start the web:  pnpm dev:web    (http://localhost:3000)'
Write-Host ''
Write-Host '  Sign in with:'
Write-Host '    admin@ldcottonmills.com / Admin@123'
Write-Host '    md@ldcottonmills.com    / MD@12345'
Write-Host ''
