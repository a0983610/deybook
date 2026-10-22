@echo off
chcp 65001 >nul
rem ============================================================
rem 打包成單一可攜 exe：dist\daybook-版本號.exe（見 開發筆記 D040）
rem 點兩下這個檔、或在命令列打 pack 都可以（pack nopause：做完不停下來等按鍵）。每次先清掉舊的 dist\。
rem 第一次打包要上網下載打包工具（之後用快取）。
rem ============================================================
setlocal
cd /d "%~dp0"

if not exist node_modules\electron-builder (
  echo 還沒裝套件，先跑 npm install
  call npm install || goto :fail
)

if exist dist (
  echo 清掉舊的 dist\
  rmdir /s /q dist || goto :fail
)

echo 打包中……
call npm run dist || goto :fail

echo.
echo 打包完成：
dir /b dist\*.exe
echo 位置：%CD%\dist
if /i not "%~1"=="nopause" pause
exit /b 0

:fail
echo.
echo 打包失敗，看上面的訊息
if /i not "%~1"=="nopause" pause
exit /b 1
