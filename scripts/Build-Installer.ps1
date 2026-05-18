param(
    [Parameter(Mandatory = $true)]
    [string]$Version,
    [string]$PublishDir = "",
    [string]$OutputDir = "",
    [string]$InnoSetupCompiler = ""
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$installerScript = Join-Path $repoRoot "installer\FileTransfer.iss"

if (-not $PublishDir) {
    $packageRoot = Join-Path $repoRoot "artifacts\packages"
    if (-not (Test-Path -LiteralPath $packageRoot -PathType Container)) {
        throw "Package directory was not found. Run scripts\Build-Package.ps1 first or pass -PublishDir."
    }

    $latestPackage = Get-ChildItem -LiteralPath $packageRoot -Directory |
        Where-Object { $_.Name -like "FileTransfer-win-x64-onefile*" } |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1

    if (-not $latestPackage) {
        throw "No FileTransfer package was found. Run scripts\Build-Package.ps1 first or pass -PublishDir."
    }

    $PublishDir = $latestPackage.FullName
}

if (-not $OutputDir) {
    $OutputDir = Join-Path $repoRoot "artifacts\installers"
}

$launcherExe = Join-Path $PublishDir "FileTransfer.exe"
$serverExe = Join-Path $PublishDir "FileTransferServer.exe"

if (-not (Test-Path -LiteralPath $launcherExe -PathType Leaf)) {
    throw "Published executable was not found at $launcherExe."
}
if (-not (Test-Path -LiteralPath $serverExe -PathType Leaf)) {
    throw "Published server executable was not found at $serverExe."
}
if (-not (Test-Path -LiteralPath $installerScript -PathType Leaf)) {
    throw "Inno Setup script was not found at $installerScript."
}

if (-not $InnoSetupCompiler) {
    $command = Get-Command "ISCC.exe" -ErrorAction SilentlyContinue
    if ($command) {
        $InnoSetupCompiler = $command.Source
    }
}

if (-not $InnoSetupCompiler) {
    $defaultCompiler = "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe"
    if (Test-Path -LiteralPath $defaultCompiler -PathType Leaf) {
        $InnoSetupCompiler = $defaultCompiler
    }
}

if (-not $InnoSetupCompiler -or -not (Test-Path -LiteralPath $InnoSetupCompiler -PathType Leaf)) {
    throw "Inno Setup compiler was not found. Install Inno Setup 6 or pass -InnoSetupCompiler."
}

New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null

$installerPath = Join-Path $OutputDir "FileTransfer-$Version-setup.exe"
if (Test-Path -LiteralPath $installerPath) {
    throw "Installer already exists: $installerPath"
}

$compilerArgs = @(
    "/DMyAppVersion=$Version",
    "/DSourceDir=$PublishDir",
    "/DOutputDir=$OutputDir",
    $installerScript
)

& $InnoSetupCompiler @compilerArgs
if ($LASTEXITCODE -ne 0) {
    throw "Inno Setup compiler failed with exit code $LASTEXITCODE."
}

if (-not (Test-Path -LiteralPath $installerPath -PathType Leaf)) {
    throw "Installer build completed but setup exe was not found at $installerPath."
}

if ($env:GITHUB_OUTPUT) {
    Add-Content -LiteralPath $env:GITHUB_OUTPUT -Value "installer_path=$installerPath"
    Add-Content -LiteralPath $env:GITHUB_OUTPUT -Value "installer_name=$(Split-Path -Leaf $installerPath)"
}

Write-Host "INSTALLER: $installerPath"
