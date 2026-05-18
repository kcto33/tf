#define MyAppName "FileTransfer"
#define MyAppPublisher "FileTransfer"
#define MyAppExeName "FileTransfer.exe"
#define MyServerExeName "FileTransferServer.exe"

#ifndef MyAppVersion
#define MyAppVersion "0.0.0"
#endif

#ifndef SourceDir
#define SourceDir "..\artifacts\packages\FileTransfer-win-x64-onefile-latest"
#endif

#ifndef OutputDir
#define OutputDir "..\artifacts\installers"
#endif

[Setup]
AppId={{B6EC1213-4E82-4565-ABCE-4CCBD1266CF2}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\Programs\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir={#OutputDir}
OutputBaseFilename=FileTransfer-{#MyAppVersion}-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
UninstallDisplayIcon={app}\{#MyAppExeName}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#SourceDir}\FileTransfer.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\FileTransferServer.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent
