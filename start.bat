@echo off
rem 聖書 Bible - ローカルサーバーで起動
cd /d "%~dp0"
set PORT=8787
start "" "http://localhost:%PORT%/"
python -m http.server %PORT% --bind 127.0.0.1
