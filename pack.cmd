@echo off
chcp 65001 >nul
rem ============================================================
rem 打包成兩個 exe（見 開發筆記 D040、D043）：
rem   dist\daybook-版本號-portable.exe  可攜版：點兩下就跑，每次開要先解壓
rem   dist\daybook-版本號-setup.exe     安裝檔：裝一次，有開始選單、桌面捷徑，開得快
rem 點兩下這個檔、或在命令列打 pack 都可以（pack nopause：做完不停下來等按鍵）。
rem 每次先清掉 dist\ 裡「打包產生的東西」；dist\ 裡其他檔案、資料夾不動（見 開發筆記 D043：
rem 使用者曾把紀錄資料夾選在 dist\data，整個 dist\ 刪掉就會連紀錄一起不見，而且不進資源回收筒）。
rem 第一次打包要上網下載打包工具（之後用快取）。
rem ============================================================
setlocal
cd /d "%~dp0"

if not exist node_modules\electron-builder (
  echo 還沒裝套件，先跑 npm install
  call npm install || goto :fail
)

if exist dist (
  echo 清掉上次打包產生的東西（dist\ 裡其他的不動）
  if exist dist\win-unpacked rmdir /s /q dist\win-unpacked || goto :fail
  for %%f in (dist\daybook-*.exe dist\daybook-*.blockmap dist\builder-*.yml dist\latest*.yml) do del /q "%%f" || goto :fail
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
