# ============================================================
#  Tempo - set the Anthropic API key secret (for AI intent classification)
#  Get a key at https://console.anthropic.com (API Keys). Starts with sk-ant-.
#  Run with:  powershell -ExecutionPolicy Bypass -File set-anthropic-key.ps1
# ============================================================

$ErrorActionPreference = 'Stop'
$PROJECT_REF = 'tyckebaxdgqscxbpilqm'
Set-Location 'C:\Users\Lenovo\music-app'

Write-Host '  Paste your SUPABASE access token (sbp_...), then press Enter:' -ForegroundColor Yellow
$s1 = Read-Host -AsSecureString
$env:SUPABASE_ACCESS_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s1)).Trim()

Write-Host '  Paste your ANTHROPIC API key (sk-ant-...), then press Enter:' -ForegroundColor Yellow
$s2 = Read-Host -AsSecureString
$key = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s2)).Trim()
if ([string]::IsNullOrWhiteSpace($key)) {
    Write-Host '  No key entered. Stopping.' -ForegroundColor Red
    exit 1
}

Write-Host ''
Write-Host '  Setting ANTHROPIC_API_KEY ...' -ForegroundColor DarkGray
npx --yes supabase@latest secrets set "ANTHROPIC_API_KEY=$key" --project-ref $PROJECT_REF
if ($LASTEXITCODE -ne 0) { Write-Host '  FAILED. Copy window to Claude.' -ForegroundColor Red; exit 1 }

Write-Host ''
Write-Host '  DONE. The classifier will use it immediately (no redeploy needed).' -ForegroundColor Green
Write-Host '  Send a WhatsApp test message and check for the right reply.' -ForegroundColor Cyan
