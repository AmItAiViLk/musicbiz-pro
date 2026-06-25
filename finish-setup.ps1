# ============================================================
#  Tempo - finish WhatsApp webhook setup
#  One command does it all:
#    1. Asks for your Supabase access token (hidden, safe) -> fixes login
#    2. Asks for your Meta App Secret (hidden, safe)
#    3. Saves the secret to Supabase
#    4. Deploys all Edge Functions
#  Run with:   powershell -ExecutionPolicy Bypass -File finish-setup.ps1
# ============================================================

$ErrorActionPreference = 'Stop'
$PROJECT_REF = 'tyckebaxdgqscxbpilqm'
Set-Location 'C:\Users\Lenovo\music-app'

function Read-Hidden($label) {
    Write-Host "  $label" -ForegroundColor Yellow
    $secure = Read-Host -AsSecureString
    return [Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}

Write-Host ''
Write-Host '  Tempo - finishing webhook setup' -ForegroundColor Cyan
Write-Host '  ================================' -ForegroundColor Cyan
Write-Host ''
Write-Host '  You will be asked for 2 things. Nothing you paste will show on screen.' -ForegroundColor DarkGray
Write-Host '  Get the access token at: https://supabase.com/dashboard/account/tokens' -ForegroundColor DarkGray
Write-Host ''

# --- Step 1: Supabase access token (fixes the "Unauthorized" problem) ---------
$token = Read-Hidden 'Paste your SUPABASE access token (starts with sbp_), then press Enter:'
if ([string]::IsNullOrWhiteSpace($token)) {
    Write-Host '  No token entered. Stopping.' -ForegroundColor Red
    exit 1
}
$env:SUPABASE_ACCESS_TOKEN = $token.Trim()

# --- Step 2: Meta App Secret --------------------------------------------------
$secret = Read-Hidden 'Paste your META App Secret, then press Enter:'
if ([string]::IsNullOrWhiteSpace($secret)) {
    Write-Host '  No secret entered. Stopping.' -ForegroundColor Red
    exit 1
}

# --- Step 3: verify auth works before doing anything --------------------------
Write-Host ''
Write-Host '  [1/3] Checking access to your Supabase project...' -ForegroundColor DarkGray
npx --yes supabase@latest projects list | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host ''
    Write-Host '  Token did not work. Make a fresh one and run again:' -ForegroundColor Red
    Write-Host '  https://supabase.com/dashboard/account/tokens' -ForegroundColor Red
    exit 1
}
Write-Host '  Access OK.' -ForegroundColor Green

# --- Step 4: save the secret to Supabase --------------------------------------
Write-Host ''
Write-Host '  [2/3] Saving the Meta secret to Supabase...' -ForegroundColor DarkGray
npx --yes supabase@latest secrets set "META_APP_SECRET=$($secret.Trim())" --project-ref $PROJECT_REF
if ($LASTEXITCODE -ne 0) {
    Write-Host '  FAILED to save the secret. Copy this whole window to Claude.' -ForegroundColor Red
    exit 1
}
Write-Host '  Secret saved.' -ForegroundColor Green

# --- Step 5: deploy the functions ---------------------------------------------
Write-Host ''
Write-Host '  [3/3] Deploying Edge Functions (this takes a minute)...' -ForegroundColor DarkGray
bash deploy-functions.sh
if ($LASTEXITCODE -ne 0) {
    Write-Host '  Deploy hit a problem. Copy this whole window to Claude.' -ForegroundColor Red
    exit 1
}

Write-Host ''
Write-Host '  ALL DONE. Secret saved + functions deployed.' -ForegroundColor Green
Write-Host '  Tell Claude: done' -ForegroundColor Cyan
Write-Host ''
