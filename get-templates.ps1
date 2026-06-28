# ============================================================
#  Tempo - fetch the real structure of approved WhatsApp templates
#  Shows each template's name, language, status, and BODY text
#  (with {{n}} variables) so we can align the code exactly.
#  Run with:  powershell -ExecutionPolicy Bypass -File get-templates.ps1
# ============================================================

$ErrorActionPreference = 'Stop'
$WABA_ID = '1696649648141612'
$GRAPH = 'https://graph.facebook.com/v21.0'

Write-Host '  Paste your META access token (EAA...), then press Enter:' -ForegroundColor Yellow
$secure = Read-Host -AsSecureString
$token = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)).Trim()
if ([string]::IsNullOrWhiteSpace($token)) { Write-Host '  No token. Stopping.' -ForegroundColor Red; exit 1 }

try {
    $r = Invoke-RestMethod -Method Get -Headers @{ Authorization = "Bearer $token" } `
        -Uri "$GRAPH/$WABA_ID/message_templates?fields=name,language,status,components&limit=50"
} catch {
    Write-Host '  FAILED:' -ForegroundColor Red
    if ($_.ErrorDetails.Message) { Write-Host $_.ErrorDetails.Message -ForegroundColor Red }
    else { Write-Host $_.Exception.Message -ForegroundColor Red }
    exit 1
}

foreach ($t in $r.data) {
    Write-Host ''
    Write-Host ("  === {0}  [{1}]  status={2} ===" -f $t.name, $t.language, $t.status) -ForegroundColor Cyan
    foreach ($c in $t.components) {
        Write-Host ("    {0}: {1}" -f $c.type, $c.text)
    }
}
Write-Host ''
Write-Host '  Copy everything above to Claude.' -ForegroundColor Green
