@echo off
chcp 65001 >nul
rem ============================================================
rem 點兩下就開 daybook：跟 npm start 一樣，用設定檔裡的紀錄資料夾（見 開發筆記 D016、D041）。
rem 直接叫 Electron 起來就結束，這個黑色視窗不會一直開著（npm start 會一直開著等 app 關掉）。
rem 已經開著的話不會開第二個，會把開著的叫到前面（見 開發筆記 D030）。
rem ============================================================
setlocal
cd /d "%~dp0"

if not exist node_modules\electron (
  echo 還沒裝套件，先跑 npm install
  call npm install || goto :fail
)

rem Electron 執行檔第一次啟動時才下載（npm start 也是這樣），這裡先補下載
if not exist node_modules\electron\dist\electron.exe (
  echo 第一次開，先下載 Electron 執行檔
  call node node_modules\electron\install.js || goto :fail
)

start "" node_modules\electron\dist\electron.exe .
exit /b 0

:fail
echo.
echo 開不起來，看上面的訊息
pause
exit /b 1
