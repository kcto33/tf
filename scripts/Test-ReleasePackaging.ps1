$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$failures = New-Object System.Collections.Generic.List[string]

function Add-Failure {
    param([string]$Message)
    $failures.Add($Message) | Out-Null
}

function Require-File {
    param([string]$RelativePath)

    $path = Join-Path $repoRoot $RelativePath
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        Add-Failure "Missing file: $RelativePath"
        return $null
    }

    return Get-Content -LiteralPath $path -Raw
}

function Require-Text {
    param(
        [AllowNull()][string]$Content,
        [string]$Pattern,
        [string]$Message
    )

    if ($null -eq $Content) {
        return
    }

    if ($Content -notmatch $Pattern) {
        Add-Failure $Message
    }
}

$packageScript = Require-File "scripts\Build-Package.ps1"
$installerScript = Require-File "scripts\Build-Installer.ps1"
$innoScript = Require-File "installer\FileTransfer.iss"
$workflow = Require-File ".github\workflows\release.yml"

$checkedScripts = @{
    "scripts\Build-Package.ps1" = $packageScript
    "scripts\Build-Installer.ps1" = $installerScript
}

foreach ($entry in $checkedScripts.GetEnumerator()) {
    if ($null -eq $entry.Value) {
        continue
    }

    if ($entry.Value -match "Remove-Item\s+.*-Recurse") {
        Add-Failure "Forbidden recursive delete appears in $($entry.Key)"
    }
    if ($entry.Value -match "Clear-Content|Set-Content|Out-File") {
        Add-Failure "Forbidden clear/overwrite command appears in $($entry.Key)"
    }
}

Require-Text $packageScript "pyinstaller" "Build-Package.ps1 should invoke PyInstaller."
Require-Text $packageScript '"--name",\s*"FileTransferServer"' "Build-Package.ps1 should build FileTransferServer.exe."
Require-Text $packageScript '"--name",\s*"FileTransfer"' "Build-Package.ps1 should build FileTransfer.exe."
Require-Text $packageScript "--add-data" "Build-Package.ps1 should include the static web assets."
Require-Text $packageScript "--add-binary" "Build-Package.ps1 should embed the server executable in the launcher."
Require-Text $packageScript '"FileTransfer",\s*"win-x64"' "Build-Package.ps1 should use a win-x64 package name."
Require-Text $packageScript "GITHUB_OUTPUT" "Build-Package.ps1 should expose artifact paths to GitHub Actions."

Require-Text $installerScript "ISCC\.exe" "Build-Installer.ps1 should locate or accept ISCC.exe."
Require-Text $installerScript "FileTransfer\.iss" "Build-Installer.ps1 should compile installer\FileTransfer.iss."
Require-Text $installerScript "FileTransfer\.exe" "Build-Installer.ps1 should verify FileTransfer.exe exists."
Require-Text $installerScript "FileTransferServer\.exe" "Build-Installer.ps1 should verify FileTransferServer.exe exists."
Require-Text $installerScript "/DMyAppVersion" "Build-Installer.ps1 should pass the app version to Inno Setup."
Require-Text $installerScript "GITHUB_OUTPUT" "Build-Installer.ps1 should expose the installer path to GitHub Actions."

Require-Text $innoScript '#define MyAppName "FileTransfer"' "FileTransfer.iss should define the app name."
Require-Text $innoScript 'DefaultDirName=\{localappdata\}\\Programs\\\{#MyAppName\}' "FileTransfer.iss should install per user by default."
Require-Text $innoScript 'PrivilegesRequired=lowest' "FileTransfer.iss should not require admin by default."
Require-Text $innoScript 'Source: "\{#SourceDir\}\\FileTransfer\.exe"' "FileTransfer.iss should install FileTransfer.exe."
Require-Text $innoScript 'Source: "\{#SourceDir\}\\FileTransferServer\.exe"' "FileTransfer.iss should install FileTransferServer.exe."
Require-Text $innoScript '\[Run\]' "FileTransfer.iss should offer to launch after installation."

Require-Text $workflow 'on:\s*\r?\n\s*push:\s*\r?\n\s*tags:' "release.yml should trigger on pushed tags."
Require-Text $workflow '"v\*"' "release.yml should use v* release tags."
Require-Text $workflow "windows-latest" "release.yml should build on windows-latest."
Require-Text $workflow "actions/setup-python@v5" "release.yml should set up Python."
Require-Text $workflow "Build-Package\.ps1" "release.yml should run Build-Package.ps1."
Require-Text $workflow "choco install innosetup" "release.yml should install Inno Setup."
Require-Text $workflow "Build-Installer\.ps1" "release.yml should run Build-Installer.ps1."
Require-Text $workflow "gh release create" "release.yml should publish a GitHub release."

if ($failures.Count -gt 0) {
    Write-Host "Release packaging checks failed:"
    foreach ($failure in $failures) {
        Write-Host " - $failure"
    }
    exit 1
}

Write-Host "Release packaging checks passed."
