# ============================================================
#  Tempo - set Meta WhatsApp config secrets
#    WHATSAPP_PHONE_NUMBER_ID = 1186701471184495  (test number, not secret)
#    WHAPI_TOKEN              = <your Meta access token>  (hidden prompt)
#  Run with:  powershell -ExecutionPolicy Bypass -File set-meta-config.ps1
# ============================================================

$ErrorActionPreference = 'Stop'
$PROJECT_REF = 'tyckebaxdgqscxbpilqm'
$PHONE_NUMBER_ID = '1186701471184495'
Set-Location 'C:\Users\Lenovo\music-app'

Write-Host '  Paste your SUPABASE access token (sbp_...), then press Enter:' -ForegroundColor Yellow
$s1 = Read-Host -AsSecureString
$env:SUPABASE_ACCESS_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s1)).Trim()

Write-Host '  Paste your META access token (starts with EAA...), then press Enter:' -ForegroundColor Yellow
$s2 = Read-Host -AsSecureString
$metaToken = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s2)).Trim()
if ([string]::IsNullOrWhiteSpace($metaToken)) {
    Write-Host '  No Meta token entered. Stopping.' -ForegroundColor Red
    exit 1
}

Write-Host ''
Write-Host "  [1/2] Setting WHATSAPP_PHONE_NUMBER_ID = $PHONE_NUMBER_ID ..." -ForegroundColor DarkGray
npx --yes supabase@latest secrets set "WHATSAPP_PHONE_NUMBER_ID=$PHONE_NUMBER_ID" --project-ref $PROJECT_REF
if ($LASTEXITCODE -ne 0) { Write-Host '  FAILED. Copy window to Claude.' -ForegroundColor Red; exit 1 }

Write-Host ''
Write-Host '  [2/2] Updating WHAPI_TOKEN (Meta access token)...' -ForegroundColor DarkGray
npx --yes supabase@latest secrets set "WHAPI_TOKEN=$metaToken" --project-ref $PROJECT_REF
if ($LASTEXITCODE -ne 0) { Write-Host '  FAILED. Copy window to Claude.' -ForegroundColor Red; exit 1 }

Write-Host ''
Write-Host '  DONE. Phone Number ID + Meta token saved.' -ForegroundColor Green
Write-Host '  Tell Claude: meta config set' -ForegroundColor Cyan
