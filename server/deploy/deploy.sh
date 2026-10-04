#!/usr/bin/env bash
# Обновление сервера на VPS: забрать свежий код, поставить зависимости, перезапустить,
# убедиться, что отвечает. Запускать от пользователя с sudo: bash /opt/sedim/server/deploy/deploy.sh
set -euo pipefail
cd /opt/sedim
git pull --ff-only
cd server
npm ci --omit=dev
sudo systemctl restart sedim
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS http://127.0.0.1:3000/health >/dev/null; then echo "OK: сервер отвечает"; exit 0; fi
  sleep 1
done
echo "ОШИБКА: /health не отвечает — смотрите: journalctl -u sedim -n 50" >&2
exit 1
