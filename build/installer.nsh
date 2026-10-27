; ============================================================
; 安裝版自己加的步驟（見 開發筆記 D050）：electron-builder 打包時自動把 build\installer.nsh 加進去
; （NsisTarget.js 的 getResource(options.include, "installer.nsh")；makensis 帶 -INPUTCHARSET UTF8，中文註解沒問題）
; ============================================================

; 解除安裝時，一起刪掉安裝程式的備份。
; 安裝時 electron-builder 會把安裝程式複製成 %LOCALAPPDATA%\daybook-updater\installer.exe（templates\nsis\include\installer.nsh），
; 它自己的解除安裝不刪（templates\nsis\uninstaller.nsh）。
; 升級時舊版的解除安裝也會跑（帶 --updated）：那時不刪，新版的安裝程式馬上又要放一份進去。
; 資料夾名稱「daybook-updater」＝ appInfo.updaterCacheDirName（套件名稱＋"-updater"）
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ; 安裝時是放在目前使用者的 LOCALAPPDATA（SetShellVarContext current），這裡照做
    ${if} $installMode == "all"
      SetShellVarContext current
    ${endif}
    RMDir /r "$LOCALAPPDATA\daybook-updater"
    ${if} $installMode == "all"
      SetShellVarContext all
    ${endif}
  ${endIf}
!macroend
