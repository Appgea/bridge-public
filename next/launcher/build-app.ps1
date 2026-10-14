# Build Appgea Panel for Windows and install it, with a Desktop shortcut.
#
#   powershell -ExecutionPolicy Bypass -File launcher\build-app.ps1
#
# The Windows twin of build-app.sh. Installs to %LOCALAPPDATA%\Programs\Appgea Panel (the exe
# plus the staged host\ tree it reads as its resource dir) and points a Desktop shortcut at it.
# Needs Git for Windows (for bash), Rust with `cargo tauri`, Node, and Python.
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Dest = Join-Path $env:LOCALAPPDATA 'Programs\Appgea Panel'

# The shared staging scripts are bash; igncr tolerates a CRLF checkout. Git's own bash, found
# next to git.exe — a bare `bash` is WSL's, or nothing at all.
$Git = (Get-Command git -ErrorAction Stop).Source
$Bash = Join-Path (Split-Path -Parent (Split-Path -Parent $Git)) 'bin\bash.exe'
& $Bash -o igncr "$Root/launcher/stage-resources.sh"; if ($LASTEXITCODE) { exit $LASTEXITCODE }
& $Bash -o igncr "$Root/launcher/prepare-ui.sh"; if ($LASTEXITCODE) { exit $LASTEXITCODE }

Push-Location "$Root\apps\desktop\src-tauri"
try {
    # .cargo/config.toml names a Homebrew sccache that does not exist here; build without one.
    & cargo tauri build --no-bundle -- --locked --config "build.rustc-wrapper=''"
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
} finally { Pop-Location }

# A running copy holds the exe open.
Get-Process -Name 'Appgea Panel' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500

New-Item -ItemType Directory -Force $Dest | Out-Null
Copy-Item "$Root\target\release\appgea-panel-desktop.exe" "$Dest\Appgea Panel.exe" -Force
if (Test-Path "$Dest\host") { Remove-Item -Recurse -Force "$Dest\host" }
Copy-Item -Recurse "$Root\target\package\host" "$Dest\host"

$Desktop = [Environment]::GetFolderPath('Desktop')
$Shell = New-Object -ComObject WScript.Shell
$Link = $Shell.CreateShortcut("$Desktop\Appgea Panel.lnk")
$Link.TargetPath = "$Dest\Appgea Panel.exe"
$Link.WorkingDirectory = $env:USERPROFILE
$Link.Save()

Write-Host "installed: $Dest\Appgea Panel.exe"
Write-Host "shortcut:  $Desktop\Appgea Panel.lnk"
