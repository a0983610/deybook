@echo off
chcp 65001 >nul
rem ============================================================
rem 改版本號（見 開發筆記 D039、D123）：做事的是 bump.cjs，這個檔是點兩下、命令列打的入口。
rem   tools\bump minor   加功能（1.0.0 → 1.1.0）
rem   tools\bump patch   只修錯、改文件、小調整（1.0.0 → 1.0.1）
rem   tools\bump major   資料格式改到舊紀錄不能直接用（1.0.0 → 2.0.0）
rem 點兩下（不帶參數）：先印目前版本，再問跳哪一碼，做完停下來等按鍵。
rem ============================================================
setlocal
cd /d "%~dp0.."

if "%~1"=="" goto :ask
node tools\bump.cjs %1
exit /b %ERRORLEVEL%

:ask
node tools\bump.cjs
echo.
echo 跳哪一碼？
echo   1  minor  加功能
echo   2  patch  只修錯、改文件、小調整
echo   3  major  資料格式改到舊紀錄不能直接用
set "PICK="
set /p "PICK=輸入 1、2、3（直接 Enter 不改）："
set "LEVEL="
if "%PICK%"=="1" set "LEVEL=minor"
if "%PICK%"=="2" set "LEVEL=patch"
if "%PICK%"=="3" set "LEVEL=major"
if not defined LEVEL (
  echo 沒改
  pause
  exit /b 1
)
node tools\bump.cjs %LEVEL%
set "RC=%ERRORLEVEL%"
pause
exit /b %RC%
