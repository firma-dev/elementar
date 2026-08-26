#!/usr/bin/env bash
#
# Выкладка на elementaros.ru.
#
#   scripts/deploy.sh          — собрать и выложить всё
#   scripts/deploy.sh os       — только посадочную, в корень
#   scripts/deploy.sh finanser — только финансер, в /финансер/
#
# Что куда:
#   apps/elementaros/dist → /www/elementaros.ru/
#   apps/finanser/dist    → /www/elementaros.ru/финансер/
#
# Доступ — по ключу. Пароли скрипт не спрашивает и не хранит: если ключ не
# прописан на хостинге, выкладка честно падает, а не просит ввести пароль в
# терминал, откуда он попадёт в историю команд.
#
# Ключ прописывается один раз в панели Рег.ру: SSH → Ключи → добавить
# содержимое ~/.ssh/elementar_regru.pub
set -euo pipefail

HOST="u3602414@server68.hosting.reg.ru"
KEY="$HOME/.ssh/elementar_regru"
ROOT="/www/elementaros.ru"
WHAT="${1:-всё}"

cd "$(dirname "$0")/.."

check_access() {
  if ! ssh -i "$KEY" -o BatchMode=yes -o ConnectTimeout=10 "$HOST" true 2>/dev/null; then
    echo "Хостинг не пускает по ключу." >&2
    echo >&2
    echo "Добавьте этот ключ в панели Рег.ру (SSH → Ключи):" >&2
    echo >&2
    cat "$KEY.pub" >&2
    echo >&2
    echo "Пароль скрипт не спрашивает намеренно: введённый в терминал, он" >&2
    echo "останется в истории команд." >&2
    exit 1
  fi
}

# Сначала «выложить рядом, потом переставить». Заливка поверх живого каталога
# оставляет сайт нерабочим ровно на время закачки: index.html уже новый, а
# ассеты с новыми именами ещё не доехали. Здесь новая версия собирается в
# соседнем каталоге и подменяет старую одним движением.
upload() {
  local from="$1" to="$2" name="$3"
  echo "→ $name"
  rsync -az --delete -e "ssh -i $KEY -o BatchMode=yes" \
    "$from/" "$HOST:$to.новое/"
  ssh -i "$KEY" -o BatchMode=yes "$HOST" \
    "rm -rf '$to.старое' && { [ -d '$to' ] && mv '$to' '$to.старое' || true; } && mv '$to.новое' '$to' && rm -rf '$to.старое'"
  echo "  готово"
}

check_access

if [ "$WHAT" = "всё" ] || [ "$WHAT" = "os" ]; then
  pnpm --filter @elementar/elementaros build
  upload apps/elementaros/dist "$ROOT" "посадочная → elementaros.ru"
fi

if [ "$WHAT" = "всё" ] || [ "$WHAT" = "finanser" ]; then
  pnpm --filter @elementar/finanser build
  upload apps/finanser/dist "$ROOT/финансер" "финансер → elementaros.ru/финансер/"
fi

echo
echo "Проверка:"
for url in "https://elementaros.ru/" "https://elementaros.ru/финансер/"; do
  printf '  %-40s ' "$url"
  curl -s -o /dev/null -m 20 -w '%{http_code}\n' "$url" || echo "нет ответа"
done
