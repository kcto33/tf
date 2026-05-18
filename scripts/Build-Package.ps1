param(
    [string]$Python = "",
    [string]$Version = "",
    [string]$VersionSuffix = "",
    [string]$PackageRoot = "",
    [switch]$NoZip,
    [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot

if (-not $PackageRoot) {
    $PackageRoot = Join-Path $repoRoot "artifacts\packages"
}

if (-not $Python) {
    $venvPython = Join-Path $repoRoot ".venv\Scripts\python.exe"
    if (Test-Path -LiteralPath $venvPython -PathType Leaf) {
        $Python = $venvPython
    }
    else {
        $pythonCommand = Get-Command "python" -ErrorAction SilentlyContinue
        if (-not $pythonCommand) {
            throw "Python was not found. Install Python or pass -Python."
        }

        $Python = $pythonCommand.Source
    }
}

$requirementsPath = Join-Path $repoRoot "requirements.txt"
$serverEntryPath = Join-Path $repoRoot "server_entry.py"
$launcherPath = Join-Path $repoRoot "launcher.py"
$staticPath = Join-Path $repoRoot "static"

foreach ($requiredPath in @($requirementsPath, $serverEntryPath, $launcherPath, $staticPath)) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
        throw "Required packaging input was not found: $requiredPath"
    }
}

if (-not $SkipInstall) {
    & $Python -m pip install -r $requirementsPath
    if ($LASTEXITCODE -ne 0) {
        throw "pip install requirements failed with exit code $LASTEXITCODE."
    }

    & $Python -m pip install pyinstaller
    if ($LASTEXITCODE -ne 0) {
        throw "pip install pyinstaller failed with exit code $LASTEXITCODE."
    }
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$safeSuffix = ""
if ($VersionSuffix) {
    $safeSuffix = $VersionSuffix -replace "[^A-Za-z0-9._-]", "-"
}

$nameParts = @("FileTransfer", "win-x64", "onefile")
if ($Version) {
    $nameParts += $Version
}
if ($safeSuffix) {
    $nameParts += $safeSuffix
}
$nameParts += $stamp

$packageName = ($nameParts | Where-Object { $_ }) -join "-"
$packageDir = Join-Path $PackageRoot $packageName
$buildRoot = Join-Path $repoRoot "artifacts\build\$packageName"
$payloadDist = Join-Path $buildRoot "payload-dist"
$serverWork = Join-Path $buildRoot "server"
$launcherWork = Join-Path $buildRoot "launcher"
$specDir = Join-Path $buildRoot "spec"

if (Test-Path -LiteralPath $packageDir) {
    throw "Package directory already exists: $packageDir"
}
if (Test-Path -LiteralPath $buildRoot) {
    throw "Build directory already exists: $buildRoot"
}

New-Item -ItemType Directory -Path $packageDir -Force | Out-Null
New-Item -ItemType Directory -Path $payloadDist -Force | Out-Null
New-Item -ItemType Directory -Path $serverWork -Force | Out-Null
New-Item -ItemType Directory -Path $launcherWork -Force | Out-Null
New-Item -ItemType Directory -Path $specDir -Force | Out-Null

$serverArgs = @(
    "-m", "PyInstaller",
    "--noconfirm",
    "--name", "FileTransferServer",
    "--onefile",
    "--add-data", "$staticPath;static",
    "--collect-all", "websockets",
    "--collect-all", "uvicorn",
    "--distpath", $payloadDist,
    "--workpath", $serverWork,
    "--specpath", $specDir,
    $serverEntryPath
)

& $Python @serverArgs
if ($LASTEXITCODE -ne 0) {
    throw "PyInstaller server build failed with exit code $LASTEXITCODE."
}

$embeddedServer = Join-Path $payloadDist "FileTransferServer.exe"
if (-not (Test-Path -LiteralPath $embeddedServer -PathType Leaf)) {
    throw "Server build succeeded but FileTransferServer.exe was not found at $embeddedServer."
}

$launcherArgs = @(
    "-m", "PyInstaller",
    "--noconfirm",
    "--name", "FileTransfer",
    "--onefile",
    "--windowed",
    "--add-binary", "$embeddedServer;.",
    "--collect-all", "pystray",
    "--collect-all", "PIL",
    "--distpath", $packageDir,
    "--workpath", $launcherWork,
    "--specpath", $specDir,
    $launcherPath
)

& $Python @launcherArgs
if ($LASTEXITCODE -ne 0) {
    throw "PyInstaller launcher build failed with exit code $LASTEXITCODE."
}

$launcherExe = Join-Path $packageDir "FileTransfer.exe"
if (-not (Test-Path -LiteralPath $launcherExe -PathType Leaf)) {
    throw "Launcher build succeeded but FileTransfer.exe was not found at $launcherExe."
}

$serverExe = Join-Path $packageDir "FileTransferServer.exe"
Copy-Item -LiteralPath $embeddedServer -Destination $serverExe
if (-not (Test-Path -LiteralPath $serverExe -PathType Leaf)) {
    throw "FileTransferServer.exe was not copied to $serverExe."
}

$zipPath = ""
if (-not $NoZip) {
    $zipPath = "$packageDir.zip"
    if (Test-Path -LiteralPath $zipPath) {
        throw "Zip package already exists: $zipPath"
    }

    Compress-Archive -Path (Join-Path $packageDir "*") -DestinationPath $zipPath
}

if ($env:GITHUB_OUTPUT) {
    Add-Content -LiteralPath $env:GITHUB_OUTPUT -Value "package_dir=$packageDir"
    if ($zipPath) {
        Add-Content -LiteralPath $env:GITHUB_OUTPUT -Value "zip_path=$zipPath"
    }
}

Write-Host "PACKAGE_DIR: $packageDir"
if ($zipPath) {
    Write-Host "ZIP: $zipPath"
}
