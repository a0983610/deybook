; ============================================================
; 安裝版自己加的步驟（見 開發筆記 D050、D114）：electron-builder 打包時自動把 build\installer.nsh 加進去
; （NsisTarget.js 的 getResource(options.include, "installer.nsh")；makensis 帶 -INPUTCHARSET UTF8，中文註解沒問題）
; ============================================================

; 解除安裝時：
; 1. 一起刪掉安裝程式的備份（D050）。
;    安裝時 electron-builder 會把安裝程式複製成 %LOCALAPPDATA%\daybook-updater\installer.exe（templates\nsis\include\installer.nsh），
;    它自己的解除安裝不刪（templates\nsis\uninstaller.nsh）。
; 2. 問要不要把設定與快取（%APPDATA%\daybook）一起丟到資源回收筒，預設「否」（D114）。
; 升級時舊版的解除安裝也會跑（帶 --updated）：那時都不做，新版的安裝程式馬上又要放一份備份進去，設定也要留給新版。
; 資料夾名稱跟著套件名稱（APP_PACKAGE_NAME＝package.json 的 name）：備份＝appInfo.updaterCacheDirName（名稱＋"-updater"）、
; 設定與快取＝Electron 的 userData（%APPDATA%\名稱）。改名打包的測試版才不會刪到正式版的（D114）
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ; 安裝時是放在目前使用者的 LOCALAPPDATA（SetShellVarContext current），這裡照做；Electron 的 userData 也一律在目前使用者底下
    ${if} $installMode == "all"
      SetShellVarContext current
    ${endif}
    RMDir /r "$LOCALAPPDATA\${APP_PACKAGE_NAME}-updater"

    ; 使用者自己帶 /S（安靜解除安裝）就不問、不刪。一鍵安裝的解除安裝走到這裡時一律已經是安靜模式（uninstaller.nsh 的 un.onInit），
    ; 所以照 un.onInit 的寫法看命令列有沒有 /S；MessageBox 不帶 /SD，安靜模式也照樣跳出來（實測，D114）
    ${GetParameters} $R0
    ClearErrors
    ${GetOptions} $R0 "/S" $R1
    ${if} ${Errors}
    ${andIf} ${FileExists} "$APPDATA\${APP_PACKAGE_NAME}\*.*"
      ${if} ${Cmd} `MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "要不要一起刪掉 ${PRODUCT_NAME} 的設定與快取？$\n$\n$APPDATA\${APP_PACKAGE_NAME}$\n$\n裡面有：設定（紀錄資料夾在哪、啟用的擴充與外觀包）、格式的擴充、外觀包、記事本還沒存的內容、快取。$\n$\n是：丟到資源回收筒。$\n否：留著，之後再裝回來會照舊。$\n$\n紀錄在你自己選的資料夾，只要不是選在上面那個資料夾裡面，就不會動。" IDYES`
        ; 丟資源回收筒：NSIS 沒有內建，借 PowerShell（electron-builder 檢查程式在不在跑也是叫它）
        nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('$APPDATA\${APP_PACKAGE_NAME}', 'OnlyErrorDialogs', 'SendToRecycleBin')"`
        Pop $R0
        ${if} ${FileExists} "$APPDATA\${APP_PACKAGE_NAME}\*.*"
          MessageBox MB_OK|MB_ICONEXCLAMATION "沒有丟成功，資料夾還在，要自己刪：$\n$\n$APPDATA\${APP_PACKAGE_NAME}"
        ${endif}
      ${endif}
    ${endif}

    ${if} $installMode == "all"
      SetShellVarContext all
    ${endif}
  ${endIf}
!macroend
