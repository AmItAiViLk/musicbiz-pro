# ============================================================
#  Tempo - set the webhook verify token (WEBHOOK_SECRET)
#  This is the value you paste into Meta's "Verify token" field.
#  It is only used for Meta's one-time handshake (the real security
#  is the X-Hub-Signature-256 check via META_APP_SECRET), so it is
#  fine for this value to be known.
#  Run with:  powershell -ExecutionPolicy Bypass -File set-webhook-secret.ps1
# ============================================================

$ErrorActionPreference = 'Stop'
$PROJECT_REF = 'tyckebaxdgqscxbpilqm'
$VERIFY_TOKEN = 'tempo-meta-verify-x7k2p9q'
Set-Location 'C:\Users\Lenovo\music-app'

Write-Host '  Paste your SUPABASE access token (sbp_...), then press Enter:' -ForegroundColor Yellow
$s1 = Read-Host -AsSecureString
$env:SUPABASE_ACCESS_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s1)).Trim()

Write-Host ''
Write-Host "  Setting WEBHOOK_SECRET = $VERIFY_TOKEN ..." -ForegroundColor DarkGray
npx --yes supabase@latest secrets set "WEBHOOK_SECRET=$VERIFY_TOKEN" --project-ref $PROJECT_REF
if ($LASTEXITCODE -ne 0) { Write-Host '  FAILED. Copy window to Claude.' -ForegroundColor Red; exit 1 }

Write-Host ''
Write-Host '  DONE.' -ForegroundColor Green
Write-Host ''
Write-Host '  ===========================================================' -ForegroundColor Cyan
Write-Host '   In Meta, use these TWO values for the webhook:' -ForegroundColor Cyan
Write-Host ''
Write-Host '   Callback URL:' -ForegroundColor Cyan
Write-Host '     https://tyckebaxdgqscxbpilqm.supabase.co/functions/v1/whatsapp-webhook' -ForegroundColor White
Write-Host ''
Write-Host '   Verify token:' -ForegroundColor Cyan
Write-Host "     $VERIFY_TOKEN" -ForegroundColor White
Write-Host '  ===========================================================' -ForegroundColor Cyan
