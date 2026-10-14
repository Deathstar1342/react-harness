!include nsDialogs.nsh
!include LogicLib.nsh
!ifndef BUILD_UNINSTALLER
Var DataFolder
Var DataInput
!endif
Var PackageMutex

!macro customCheckAppRunning
  !ifndef BUILD_UNINSTALLER
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
  CreateDirectory "$DataFolder"
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
  WriteINIStr "$INSTDIR\desktop-location.ini.new" "desktop" "path" "$DataFolder"
  Rename "$INSTDIR\desktop-location.ini.new" "$INSTDIR\desktop-location.ini"
  WriteRegStr HKCU "Software\abysSUS\Storage" "DataFolder" "$DataFolder"
!macroend
!endif
