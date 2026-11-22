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

[Code]
// 安装后自动放行防火墙：管理员安装时立即生效；
// 非管理员安装时 netsh 会静默失败，由 Windows 首次监听时的"允许访问"弹窗兜底。
procedure AddFirewallRules();
var
  ResultCode: Integer;
  ServerPath: string;
begin
  ServerPath := ExpandConstant('{app}\{#MyServerExeName}');
  Exec('netsh.exe', 'advfirewall firewall delete rule name="FileTransfer-Server-TCP"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('netsh.exe', 'advfirewall firewall delete rule name="FileTransfer-Server-Program"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  // 端口规则：覆盖默认端口 8000 的信令通道
  Exec('netsh.exe', 'advfirewall firewall add rule name="FileTransfer-Server-TCP" dir=in action=allow protocol=TCP localport=8000', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  // 程序规则：覆盖自定义端口（WEB_TRANSFER_PORT）下的任意监听
  Exec('netsh.exe', 'advfirewall firewall add rule name="FileTransfer-Server-Program" dir=in action=allow program="' + ServerPath + '" profile=any', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    AddFirewallRules();
end;

procedure RemoveFirewallRules();
var
  ResultCode: Integer;
begin
  Exec('netsh.exe', 'advfirewall firewall delete rule name="FileTransfer-Server-TCP"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('netsh.exe', 'advfirewall firewall delete rule name="FileTransfer-Server-Program"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
    RemoveFirewallRules();
end;
