# ============================================================
#  Tempo - status check
#  Shows which secrets are set and which functions are deployed,
#  so we know what's left to configure. Read-only, changes nothing.
#  Run with:  powershell -ExecutionPolicy Bypass -File check-status.ps1
# ============================================================

$ErrorActionPreference = 'Stop'
$PROJECT_REF = 'tyckebaxdgqscxbpilqm'
Set-Location 'C:\Users\Lenovo\music-app'

Write-Host '  Paste your SUPABASE access token (sbp_...), then press Enter:' -ForegroundColor Yellow
$secure = Read-Host -AsSecureString
$env:SUPABASE_ACCESS_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)).Trim()

Write-Host ''
Write-Host '  === SECRETS (names only, values are hidden by Supabase) ===' -ForegroundColor Cyan
npx --yes supabase@latest secrets list --project-ref $PROJECT_REF

Write-Host ''
Write-Host '  === DEPLOYED FUNCTIONS ===' -ForegroundColor Cyan
npx --yes supabase@latest functions list --project-ref $PROJECT_REF

Write-Host ''
Write-Host '  Done. Copy everything above to Claude.' -ForegroundColor Green
