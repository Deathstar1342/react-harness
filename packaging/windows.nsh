!include nsDialogs.nsh
!include LogicLib.nsh
!ifndef BUILD_UNINSTALLER
Var DataFolder
Var DataInput
!endif
Var PackageMutex

!macro customCheckAppRunning
  !ifndef BUILD_UNINSTALLER
    ReadRegStr $2 HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation"
    ${If} $2 != ""
      MessageBox MB_OK "An abysSUS installation is already registered. Close it and uninstall its application files first. Setup will not invoke an old uninstaller or replace a different installation path." /SD IDOK
      SetErrorLevel 74
      Quit
    ${EndIf}
    IfFileExists "$INSTDIR\abysSUS.exe" 0 +4
      MessageBox MB_OK "Close abysSUS, uninstall application files, then install this version. Your saved data is preserved." /SD IDOK
      SetErrorLevel 74
      Quit
    ${If} ${Silent}
      ReadRegStr $DataFolder HKCU "Software\abysSUS\Storage" "DataFolder"
      ${If} $DataFolder == ""
        SetErrorLevel 75
        Quit
      ${EndIf}
    ${EndIf}
  !endif
  ${If} $PackageMutex == ""
    System::Call 'kernel32::CreateMutexW(p 0, i 1, w "Global\abysSUS-package-maintenance-v1") p.r0 ?e'
    Pop $1
    ${If} $0 == 0
    ${OrIf} $1 == 183
      MessageBox MB_OK "Close abysSUS and wait for its backend cleanup before installing or removing it. No process will be stopped." /SD IDOK
      SetErrorLevel 73
      Quit
    ${EndIf}
    StrCpy $PackageMutex $0
  ${EndIf}
  !ifndef BUILD_UNINSTALLER
    InitPluginsDir
    File /oname=$PLUGINSDIR\windows-preflight.ps1 "${PROJECT_DIR}\packaging\windows-preflight.ps1"
    ReadRegStr $2 HKCU "Software\abysSUS\Storage" "DataFolder"
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\windows-preflight.ps1" -DataFolder "$DataFolder" -InstallFolder "$INSTDIR" -PreviousFolder "$2"'
    Pop $0
    Pop $1
    ${If} $0 != 0
      MessageBox MB_OK "$1" /SD IDOK
      SetErrorLevel 76
      Quit
    ${EndIf}
  !endif
!macroend

!ifndef BUILD_UNINSTALLER
!macro customPageAfterChangeDir
  Page custom DataPage DataLeave
!macroend
Function DataPage
  IfFileExists "$INSTDIR\abysSUS.exe" 0 +4
    MessageBox MB_OK "For this release, close abysSUS, uninstall its application files, then run Setup again. Your saved desktop data, Linux profiles and projects are preserved. In-place replacement is disabled."
    SetErrorLevel 74
    Quit
  ReadRegStr $DataFolder HKCU "Software\abysSUS\Storage" "DataFolder"
  ${If} $DataFolder == ""
    StrCpy $DataFolder "$LOCALAPPDATA\abysSUS-data"
  ${EndIf}
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 42u "Choose a separate desktop data folder (settings and caches). Select a D: folder to keep these off C:. Linux profiles and projects stay in your selected WSL disk. Existing data is never moved."
  Pop $0
  ${NSD_CreateDirRequest} 0 50u 80% 14u "$DataFolder"
  Pop $DataInput
  ${NSD_CreateBrowseButton} 82% 50u 18% 14u "Browse"
  Pop $0
  ${NSD_OnClick} $0 DataBrowse
  nsDialogs::Show
FunctionEnd
Function DataBrowse
  nsDialogs::SelectFolderDialog "Desktop data folder" "$DataFolder"
  Pop $0
  ${If} $0 != error
    ${NSD_SetText} $DataInput $0
  ${EndIf}
FunctionEnd
Function DataLeave
  ${NSD_GetText} $DataInput $DataFolder
  ReadRegStr $0 HKCU "Software\abysSUS\Storage" "DataFolder"
  ${If} $0 != ""
  ${AndIf} $0 != $DataFolder
    MessageBox MB_OK "Keep the saved data location for this installation. Data migration is a separate administrator operation."
    Abort
  ${EndIf}
  StrCpy $1 $DataFolder 2 1
  ${If} $1 != ":\"
    MessageBox MB_OK "Choose an absolute local drive folder, for example D:\abysSUS-data."
    Abort
  ${EndIf}
  ${If} $0 != ""
    IfFileExists "$DataFolder\*.*" +3 0
      MessageBox MB_OK "The saved data folder is missing. Reconnect its drive before continuing; Setup will not create an empty replacement."
      Abort
  ${EndIf}
FunctionEnd
!macro customInstall
  ${If} $DataFolder == ""
    ReadRegStr $DataFolder HKCU "Software\abysSUS\Storage" "DataFolder"
    ${If} $DataFolder == ""
      MessageBox MB_OK "Run the assisted installer to choose a desktop data folder first."
      SetErrorLevel 75
      Quit
    ${EndIf}
  ${EndIf}
  ClearErrors
  FileOpen $3 "$INSTDIR\desktop-location.ini.new" w
  IfErrors location_failed
  FileWriteByte $3 255
  FileWriteByte $3 254
  FileClose $3
  IfErrors location_failed
  WriteINIStr "$INSTDIR\desktop-location.ini.new" "desktop" "path" "$DataFolder"
  IfErrors location_failed
  Rename "$INSTDIR\desktop-location.ini.new" "$INSTDIR\desktop-location.ini"
  IfErrors location_failed
  WriteRegStr HKCU "Software\abysSUS\Storage" "DataFolder" "$DataFolder"
  IfErrors location_failed
  Goto location_done
  location_failed:
    MessageBox MB_OK "Saving the data location failed. Setup is incomplete; inspect the application folder and retry. No profile data was moved." /SD IDOK
    SetErrorLevel 77
    Quit
  location_done:
!macroend
!endif
