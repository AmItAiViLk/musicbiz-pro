# ============================================================
#  Tempo - deploy Edge Functions (pure PowerShell, no bash needed)
#  The Meta secret is already saved; this just deploys the functions.
#  Run with:  powershell -ExecutionPolicy Bypass -File deploy-tempo.ps1
#
#  JWT policy:
#    gcal-oauth       -> JWT ON  (called from frontend with user JWT)
#    send-reminders   -> JWT OFF (auth via AUTOMATION_SECRET bearer)
#    whatsapp-webhook -> JWT OFF (auth via WEBHOOK_SECRET + Meta signature)
# ============================================================

$ErrorActionPreference = 'Stop'
$PROJECT_REF = 'tyckebaxdgqscxbpilqm'
Set-Location 'C:\Users\Lenovo\music-app'

# --- Supabase access token (hidden) -------------------------------------------
Write-Host '  Paste your SUPABASE access token (sbp_...), then press Enter:' -ForegroundColor Yellow
$secure = Read-Host -AsSecureString
$token = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)).Trim()
if ([string]::IsNullOrWhiteSpace($token)) {
    Write-Host '  No token entered. Stopping.' -ForegroundColor Red
    exit 1
}
$env:SUPABASE_ACCESS_TOKEN = $token

# --- Verify access ------------------------------------------------------------
Write-Host ''
Write-Host '  Checking access...' -ForegroundColor DarkGray
npx --yes supabase@latest projects list | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host '  Token did not work. Make a fresh one at:' -ForegroundColor Red
    Write-Host '  https://supabase.com/dashboard/account/tokens' -ForegroundColor Red
    exit 1
}
Write-Host '  Access OK.' -ForegroundColor Green

# --- Link project (idempotent) ------------------------------------------------
Write-Host ''
Write-Host '  Linking project...' -ForegroundColor DarkGray
npx --yes supabase@latest link --project-ref $PROJECT_REF

# --- Deploy each function -----------------------------------------------------
Write-Host ''
Write-Host '  Deploying gcal-oauth (JWT ON)...' -ForegroundColor DarkGray
npx --yes supabase@latest functions deploy gcal-oauth --project-ref $PROJECT_REF
if ($LASTEXITCODE -ne 0) { Write-Host '  gcal-oauth FAILED. Copy window to Claude.' -ForegroundColor Red; exit 1 }

Write-Host ''
Write-Host '  Deploying send-reminders (JWT OFF)...' -ForegroundColor DarkGray
npx --yes supabase@latest functions deploy send-reminders --no-verify-jwt --project-ref $PROJECT_REF
if ($LASTEXITCODE -ne 0) { Write-Host '  send-reminders FAILED. Copy window to Claude.' -ForegroundColor Red; exit 1 }

Write-Host ''
Write-Host '  Deploying whatsapp-webhook (JWT OFF)...' -ForegroundColor DarkGray
npx --yes supabase@latest functions deploy whatsapp-webhook --no-verify-jwt --project-ref $PROJECT_REF
if ($LASTEXITCODE -ne 0) { Write-Host '  whatsapp-webhook FAILED. Copy window to Claude.' -ForegroundColor Red; exit 1 }

Write-Host ''
Write-Host '  ALL DEPLOYED. Functions are live.' -ForegroundColor Green
Write-Host '  Tell Claude: deployed' -ForegroundColor Cyan
Write-Host ''
