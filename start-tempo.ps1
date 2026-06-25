# ============================================================
#  Tempo - launcher
#  One click to start a tidy work session:
#    1. Starts the Vite dev server (reuses one if already running)
#    2. Opens the project in VS Code (Claude Code extension lives here)
#    3. Opens the running app in your browser
# ============================================================

$ErrorActionPreference = 'SilentlyContinue'
$proj = 'C:\Users\Lenovo\music-app'
Set-Location $proj

# Thorium browser - open all Tempo links here instead of the default browser.
$thorium = "$env:LOCALAPPDATA\Thorium\Application\thorium.exe"

function Open-InThorium($url) {
    if (Test-Path $thorium) {
        Start-Process $thorium -ArgumentList $url
    } else {
        Start-Process $url   # fallback: system default browser
    }
}

Write-Host ''
Write-Host '  Tempo - starting your workspace...' -ForegroundColor Cyan
Write-Host ''

# --- Helper: find a Tempo dev server already responding on the usual ports ---
function Find-DevPort {
    foreach ($port in 5173..5180) {
        try {
            $r = Invoke-WebRequest "http://localhost:$port/" -UseBasicParsing -TimeoutSec 1
            if ($r.StatusCode -eq 200) { return $port }
        } catch { }
    }
    return $null
}

# 1. Start the dev server only if one isn't already up (avoids duplicates).
$port = Find-DevPort
if ($port) {
    Write-Host "  Dev server already running on port $port - reusing it." -ForegroundColor DarkGray
} else {
    Write-Host '  Starting the dev server (new window)...' -ForegroundColor DarkGray
    Start-Process 'cmd.exe' -ArgumentList '/k', 'title Tempo Dev Server && npm run dev' -WorkingDirectory $proj
}

# 2. Open the project in VS Code (Claude Code extension + visual diffs).
Start-Process 'code.cmd' -ArgumentList '.' -WorkingDirectory $proj

# 3. Wait for the server to be ready, then open the browser on the real port.
if (-not $port) {
    Write-Host '  Waiting for the dev server to come up...' -ForegroundColor DarkGray
    foreach ($attempt in 1..40) {
        Start-Sleep -Milliseconds 750
        $port = Find-DevPort
        if ($port) { break }
    }
}

if ($port) {
    Open-InThorium "http://localhost:$port/"
    Write-Host "  App is live: http://localhost:$port/" -ForegroundColor Green
} else {
    Write-Host '  Dev server not detected - check the "Tempo Dev Server" window for the URL.' -ForegroundColor Yellow
}

Write-Host ''
Write-Host '  VS Code is open. Start Claude in its integrated terminal (type: claude)' -ForegroundColor Cyan
Write-Host '  or use the Claude panel (Ctrl+Esc).' -ForegroundColor Cyan
Start-Sleep -Seconds 3
