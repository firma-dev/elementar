#!/usr/bin/env bash
#
# Выкладка на elementaros.ru.
#
#   scripts/deploy.sh          — собрать и выложить всё (по SSH)
#   scripts/deploy.sh os       — только посадочную, в корень
#   scripts/deploy.sh finanser — только финансер, в /финансер/
#   scripts/deploy.sh ftp      — всё по FTP, пока нет SSH-ключа
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
#
# Куда и под кем ходить, скрипт не знает: репозиторий открытый, а логин на
# сервере вместе с адресом — половина пары «логин-пароль» и готовая мишень для
# перебора. Значения лежат рядом, в `deploy.env`, который не коммитится.
set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE="${ELEMENTAR_DEPLOY_ENV:-deploy.env}"
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  . "./$ENV_FILE"
fi

: "${DEPLOY_HOST:=}"
: "${DEPLOY_ROOT:=}"
: "${DEPLOY_FTP_HOST:=${DEPLOY_HOST#*@}}"
KEY="${DEPLOY_KEY:-$HOME/.ssh/elementar_regru}"

if [ -z "$DEPLOY_HOST" ] || [ -z "$DEPLOY_ROOT" ]; then
  cat >&2 <<'СПРАВКА'
Не задано, куда выкладывать. Создайте рядом со скриптом файл deploy.env:

  DEPLOY_HOST=пользователь@сервер.хостинга
  DEPLOY_ROOT=/абсолютный/путь/к/каталогу/сайта

Файл не коммитится: логин на сервере вместе с адресом — половина пары
«логин-пароль», и в открытом репозитории ему не место. Пароля здесь нет и
быть не должно: SSH ходит по ключу, FTP берёт пароль из ~/.netrc.
СПРАВКА
  exit 1
fi

HOST="$DEPLOY_HOST"
# Абсолютный путь берётся из файлового менеджера панели, а не угадывается: в
# README когда-то стояло «/www/elementaros.ru» — это путь, каким его показывает
# панель, а не каким его видит система.
ROOT="$DEPLOY_ROOT"
WHAT="${1:-всё}"

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

# ─────────────────────────── Выкладка по FTP ───────────────────────────
#
# Запасной путь, пока на хостинге не прописан SSH-ключ.
#
# Пароль скрипт не спрашивает и не получает: curl берёт его из ~/.netrc —
# файла, который читает только он и владелец. Пароль не попадает ни в командную
# строку, ни в список процессов, ни в историю оболочки.
#
# Один раз создайте ~/.netrc с правами 600:
#
#   machine сервер.хостинга
#   login пользователь
#   password ВАШ_ПАРОЛЬ_ОТ_ХОСТИНГА
#
#   chmod 600 ~/.netrc
#
# Запуск: scripts/deploy.sh ftp
#
# Почему это хуже SSH: файлы льются по одному и старые не удаляются, поэтому
# ассеты прошлых сборок остаются лежать. Вреда нет — имена с хешами, — но мусор
# копится. Как только ключ появится, вернитесь к обычному режиму.
upload_ftp() {
  local from="$1" to="$2" name="$3"
  echo "→ $name (FTP)"
  if [ ! -f "$HOME/.netrc" ]; then
    echo "Нет ~/.netrc — curl нечем представиться." >&2
    echo "См. комментарий в начале функции upload_ftp." >&2
    exit 1
  fi
  local count=0
  while IFS= read -r file; do
    local rel="${file#"$from"/}"
    curl -sS -n --ftp-create-dirs -T "$file" \
      "ftp://$DEPLOY_FTP_HOST/$to/$rel" || {
      echo "  не удалось залить $rel" >&2
      exit 1
    }
    count=$((count + 1))
  done < <(find "$from" -type f)
  echo "  залито файлов: $count"
}

if [ "$WHAT" = "ftp" ]; then
  pnpm --filter @elementar/elementaros build
  pnpm --filter @elementar/finanser build
  # Путь от корня FTP, а не от корня файловой системы: FTP пускает в домашний
  # каталог пользователя, и относительно него сайт лежит глубже. Хвост берётся
  # из DEPLOY_ROOT — это тот же путь, только без домашнего каталога впереди.
  ftp_root="${DEPLOY_FTP_ROOT:-${DEPLOY_ROOT#/var/www/*/}}"
  # FTP ничего не удаляет, поэтому подкаталог «финансер» здесь и так в
  # безопасности — но заливается только содержимое посадочной.
  upload_ftp apps/elementaros/dist "$ftp_root" "посадочная → elementaros.ru"
  upload_ftp apps/finanser/dist "$ftp_root/финансер" "финансер → /финансер/"
  echo
  echo "Проверка:"
  for url in "https://elementaros.ru/" "https://elementaros.ru/финансер/"; do
    printf '  %-40s ' "$url"
    curl -s -o /dev/null -m 20 -w '%{http_code}\n' "$url" || echo "нет ответа"
  done
  exit 0
fi

check_access

# Посадочная кладётся в корень НЕ подменой каталога, а синхронизацией на месте.
#
# Внутри корня лежит подкаталог «финансер» — отдельное приложение. Подмена
# каталога целиком снесла бы его: новая посадочная о нём не знает, а старый
# каталог после переименования удаляется. Финансер восстановился бы следующим
# шагом, но между шагами его бы не было, а запуск `deploy.sh os` в одиночку
# убил бы его насовсем.
#
# Поэтому здесь rsync --delete с исключением: лишние файлы посадочной убираются,
# чужой подкаталог не трогается.
if [ "$WHAT" = "всё" ] || [ "$WHAT" = "os" ]; then
  pnpm --filter @elementar/elementaros build
  echo "→ посадочная → elementaros.ru"
  rsync -az --delete --exclude='финансер/' -e "ssh -i $KEY -o BatchMode=yes" \
    apps/elementaros/dist/ "$HOST:$ROOT/"
  echo "  готово"
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
