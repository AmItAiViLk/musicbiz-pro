@echo off
:: Open the app in the default browser
start "" http://localhost:5173

:: Open Git Bash in the project folder and run claude (stays open after)
"C:\Program Files\Git\git-bash.exe" --cd="C:\Users\Lenovo\music-app" -c "claude; exec bash"
