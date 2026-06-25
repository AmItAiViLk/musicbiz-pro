# ============================================================
#  Tempo - subscribe the app to the WhatsApp Business Account (WABA)
#  This is the step that makes Meta actually DELIVER inbound messages
#  to your webhook. Setting the callback URL alone is not enough.
#  Run with:  powershell -ExecutionPolicy Bypass -File subscribe-waba.ps1
# ============================================================

$ErrorActionPreference = 'Stop'
$WABA_ID = '1696649648141612'
$GRAPH = 'https://graph.facebook.com/v21.0'

Write-Host '  Paste your META access token (EAA...), then press Enter:' -ForegroundColor Yellow
$secure = Read-Host -AsSecureString
$token = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)).Trim()
if ([string]::IsNullOrWhiteSpace($token)) { Write-Host '  No token. Stopping.' -ForegroundColor Red; exit 1 }

$headers = @{ Authorization = "Bearer $token" }

function Show-Subscribed($label) {
    Write-Host ''
    Write-Host "  $label" -ForegroundColor Cyan
    try {
        $r = Invoke-RestMethod -Method Get -Uri "$GRAPH/$WABA_ID/subscribed_apps" -Headers $headers
        ($r | ConvertTo-Json -Depth 6)
    } catch {
        Write-Host '  (could not read subscribed apps)' -ForegroundColor Red
        if ($_.ErrorDetails.Message) { Write-Host $_.ErrorDetails.Message -ForegroundColor Red }
    }
}

# 1. Show current state
Show-Subscribed 'BEFORE - apps currently subscribed to this WABA:'

# 2. Subscribe this app
Write-Host ''
Write-Host '  Subscribing the app to the WABA...' -ForegroundColor DarkGray
try {
    $resp = Invoke-RestMethod -Method Post -Uri "$GRAPH/$WABA_ID/subscribed_apps" -Headers $headers
    Write-Host "  Subscribe response: $($resp | ConvertTo-Json -Compress)" -ForegroundColor Green
} catch {
    Write-Host '  SUBSCRIBE FAILED:' -ForegroundColor Red
    if ($_.ErrorDetails.Message) { Write-Host $_.ErrorDetails.Message -ForegroundColor Red }
    else { Write-Host $_.Exception.Message -ForegroundColor Red }
    Write-Host '  Copy this whole window to Claude.' -ForegroundColor Red
    exit 1
}

# 3. Confirm
Show-Subscribed 'AFTER - apps now subscribed to this WABA:'

Write-Host ''
Write-Host '  Done. If AFTER shows your app, messages should now be delivered.' -ForegroundColor Green
Write-Host '  Send a WhatsApp to the test number and check for the auto-reply.' -ForegroundColor Cyan
