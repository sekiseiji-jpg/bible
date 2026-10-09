#!/bin/bash
# 聖書 Bible — ローカルサーバーで起動（ダブルクリックで実行）
cd "$(dirname "$0")" || exit 1
PORT=8787
while lsof -i ":$PORT" >/dev/null 2>&1; do PORT=$((PORT + 1)); done
echo "聖書 Bible を http://localhost:$PORT で起動します（終了する時はこのウインドウを閉じてください）"
( sleep 1; open "http://localhost:$PORT/" ) &
python3 -m http.server "$PORT" --bind 127.0.0.1
