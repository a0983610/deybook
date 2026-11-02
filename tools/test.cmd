@echo off
chcp 65001 >nul
rem ============================================================
rem 跑測試（見 開發筆記 D052、D123）：做事的是 test.cjs，這個檔是點兩下、命令列打的入口。
rem   tools\test           parser ＋ e2e 安靜跑（視窗在螢幕外、不搶焦點）
rem   tools\test --full    parser ＋ e2e 完整跑（真的開出視窗，跑的時候別打字）
rem   後面加 nopause：做完不停下來等按鍵（跟 pack 一樣）。
rem ============================================================
setlocal
cd /d "%~dp0.."

set "PAUSE=1"
set "ARGS="
:args
if "%~1"=="" goto :run
if /i "%~1"=="nopause" (set "PAUSE=") else (set "ARGS=%ARGS% %1")
shift
goto :args

:run
node tools\test.cjs%ARGS%
set "RC=%ERRORLEVEL%"
if defined PAUSE pause
exit /b %RC%
