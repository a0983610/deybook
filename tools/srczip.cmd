@echo off
chcp 65001 >nul
rem ============================================================
rem 把會上 git 的部分壓成一個 zip，帶回去推上 GitHub 用（見 開發筆記 D128）：做事的是 srczip.cjs，這個檔是點兩下、命令列打的入口。
rem   產出 dist\daybook-版本號-src.zip：檔案（照硬碟上現在的樣子）＋ daybook.bundle（全部的 git 歷史）
rem   回去怎麼推上 GitHub 見 開發.md〈推上 GitHub〉。
rem   後面加 nopause：做完不停下來等按鍵（跟 pack 一樣）。
rem ============================================================
setlocal
cd /d "%~dp0.."

node tools\srczip.cjs
set "RC=%ERRORLEVEL%"
if /i not "%~1"=="nopause" pause
exit /b %RC%
