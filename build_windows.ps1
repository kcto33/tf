$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path ".venv\\Scripts\\python.exe")) {
    throw "Virtual environment not found. Run: python -m venv .venv"
}

& .\.venv\Scripts\python.exe -m pip install -r requirements.txt
& .\.venv\Scripts\python.exe -m pip install pyinstaller

if (Test-Path "build") {
    Remove-Item "build" -Recurse -Force
}
if (Test-Path "dist\\FileTransfer") {
    Remove-Item "dist\\FileTransfer" -Recurse -Force
}
if (Test-Path "dist\\FileTransfer-win.zip") {
    Remove-Item "dist\\FileTransfer-win.zip" -Force
}

New-Item -ItemType Directory -Path "dist\\FileTransfer" | Out-Null
$payloadDist = Join-Path $PSScriptRoot "build\\payload-dist"
New-Item -ItemType Directory -Path $payloadDist -Force | Out-Null

& .\.venv\Scripts\pyinstaller.exe `
    --noconfirm `
    --clean `
    --name FileTransferServer `
    --onefile `
    --add-data "$PSScriptRoot\\static;static" `
    --collect-all websockets `
    --collect-all uvicorn `
    --distpath $payloadDist `
    --workpath "build\\server" `
    --specpath "build" `
    server_entry.py

$embeddedServer = Join-Path $payloadDist "FileTransferServer.exe"

& .\.venv\Scripts\pyinstaller.exe `
    --noconfirm `
    --clean `
    --name FileTransfer `
    --onefile `
    --windowed `
    --add-binary "$embeddedServer;." `
    --collect-all pystray `
    --collect-all PIL `
    --distpath "dist\\FileTransfer" `
    --workpath "build\\launcher" `
    --specpath "build" `
    launcher.py

Copy-Item $embeddedServer "dist\\FileTransfer\\FileTransferServer.exe" -Force

Compress-Archive -Path "dist\\FileTransfer\\*" -DestinationPath "dist\\FileTransfer-win.zip" -Force

Write-Host "Built dist\\FileTransfer and dist\\FileTransfer-win.zip"
