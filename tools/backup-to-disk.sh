#!/usr/bin/env bash
clear
# =====================================================================
# DV Cloud: копия библиотеки на внешний диск (интерактивный скрипт)
#
# Запускается на компьютере, к которому подключён диск (например, WSL на
# Windows). Данные тянутся с сервера облака по SSH (или берутся из локальной
# папки). Сервер скрипт ничего не меняет, на диске пишет только в выбранную вами папку.
#
# Порядок: выбор диска -> выбор папки -> подтверждение -> выгрузка базы ->
# копирование с прогрессом и оставшимся временем -> сверка.
# Прервать: Ctrl-C. Запуск после остановки продолжает с места остановки.
# Описание: docs/BACKUP.md, раздел «Копия на внешний диск скриптом».
# =====================================================================
set -u

CONF="${XDG_CONFIG_HOME:-$HOME/.config}/dvcloud/backup-to-disk.conf"
STAMP="$(date +%Y%m%d-%H%M)"

say()  { echo; echo "=== $* ==="; }
stop() { echo; echo "$*"; read -r -p "Enter для выхода..." _; exit 1; }
yes_no() { local a; read -r -p "$1 [да/Enter=нет]: " a; [ "$a" = "да" ]; }
trap 'echo; echo "Остановлено вами. Уже скопированное осталось, повторный запуск продолжит."; exit 130' INT

# ---------------------------------------------------------------------
# 0. Настройки: откуда брать данные. Спрашиваем один раз и запоминаем.
# ---------------------------------------------------------------------
SRC_HOST=""; SRC_DIR=""
# shellcheck disable=SC1090
[ -f "$CONF" ] && . "$CONF"
if [ -z "$SRC_DIR" ]; then
  say "Первый запуск: откуда брать данные"
  echo "Адрес сервера облака для SSH (как в «ssh <адрес>», можно псевдоним из ~/.ssh/config)."
  echo "Пусто — если данные лежат в папке на этом же компьютере."
  read -r -p "Адрес сервера: " SRC_HOST
  echo "Папка с данными облака на сервере (где лежат библиотека и корзина)."
  read -r -p "Папка данных: " SRC_DIR
  [ -n "$SRC_DIR" ] || stop "Папка данных не указана."
  mkdir -p "$(dirname "$CONF")"
  printf 'SRC_HOST=%q\nSRC_DIR=%q\n' "$SRC_HOST" "$SRC_DIR" > "$CONF"
  echo "Запомнено в $CONF (файл только у вас, в репозиторий не попадает)."
fi
SRC_DIR="${SRC_DIR%/}"

# выполнить команду на источнике (по SSH или локально)
run_src() { if [ -n "$SRC_HOST" ]; then ssh -o BatchMode=yes -o ConnectTimeout=10 "$SRC_HOST" "$@"; else bash -c "$*"; fi; }
rsync_src() { if [ -n "$SRC_HOST" ]; then echo "$SRC_HOST:$SRC_DIR/"; else echo "$SRC_DIR/"; fi; }

command -v rsync >/dev/null || stop "Не найден rsync. Установите: sudo apt install -y rsync"

# ---------------------------------------------------------------------
# 1. Какие диски есть
# ---------------------------------------------------------------------
say "1. Выберите диск"
DISK_MNT=(); DISK_TXT=(); DISK_LET=()
PS=/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe
if grep -qi microsoft /proc/version 2>/dev/null && [ -x "$PS" ]; then
  # WSL: список букв дисков берём у Windows (диск C — системный, его не предлагаем)
  while IFS='|' read -r let label fs size free; do
    [ -n "$let" ] || continue
    [ "$let" = "C" ] && continue
    l=$(echo "$let" | tr 'A-Z' 'a-z')
    if [ -z "$size" ] || [ "$size" = "0" ]; then
      txt="$let:  $label  ($fs)  недоступен — возможно, заблокирован (BitLocker) или не готов"
    else
      txt="$let:  ${label:-без названия}  ($fs)  всего ${size} ГБ, свободно ${free} ГБ"
    fi
    DISK_MNT+=("/mnt/$l"); DISK_TXT+=("$txt"); DISK_LET+=("$let:")
  done < <("$PS" -NoProfile -Command '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Volume | Where-Object { $_.DriveLetter } | ForEach-Object { "$($_.DriveLetter)|$($_.FileSystemLabel)|$($_.FileSystem)|$([int]($_.Size/1GB))|$([int]($_.SizeRemaining/1GB))" }' 2>/dev/null | tr -d '\r')
else
  # обычный Linux: подключённые диски в /media, /run/media, /mnt
  while read -r target size avail fs; do
    DISK_MNT+=("$target"); DISK_LET+=(""); DISK_TXT+=("$target  ($fs)  всего $size, свободно $avail")
  done < <(findmnt -rn -o TARGET,SIZE,AVAIL,FSTYPE 2>/dev/null | awk '$1 ~ /^\/(media|run\/media|mnt)\// && $4 !~ /^(squashfs|tmpfs|overlay|fuse.*|proc|sysfs)$/')
fi
[ "${#DISK_MNT[@]}" -gt 0 ] || stop "Внешних дисков не найдено. Подключите диск и запустите снова."

for i in "${!DISK_MNT[@]}"; do printf '  %d) %s\n' "$((i+1))" "${DISK_TXT[$i]}"; done
read -r -p "Номер диска (Enter — выйти): " n
[ -n "$n" ] || exit 0
[[ "$n" =~ ^[0-9]+$ ]] && [ "$n" -ge 1 ] && [ "$n" -le "${#DISK_MNT[@]}" ] || stop "Нет такого номера."
MNT="${DISK_MNT[$((n-1))]}"; LET="${DISK_LET[$((n-1))]}"

if ! mountpoint -q "$MNT"; then
  [ -n "$LET" ] || stop "Диск не смонтирован."
  echo "Диск ещё не подключён к WSL. Сейчас попросят пароль sudo (ввод не виден — это нормально)."
  sudo mkdir -p "$MNT" && sudo mount -t drvfs "$LET" "$MNT" -o "uid=$(id -u),gid=$(id -g),metadata" || stop "Не удалось подключить $LET."
fi
# диск мог быть подключён раньше от имени root: тогда rsync не сможет выставить время файлов
if [ -n "$LET" ] && [ "$(stat -c %u "$MNT")" != "$(id -u)" ]; then
  echo "Диск подключён с другим владельцем. Переподключаю под вашим пользователем (нужен пароль sudo, ввод не виден)."
  sudo umount "$MNT" && sudo mount -t drvfs "$LET" "$MNT" -o "uid=$(id -u),gid=$(id -g),metadata" || stop "Не удалось переподключить $LET (закройте окна, использующие диск)."
fi
FREE_KB=$(df -Pk "$MNT" | awk 'NR==2{print $4}')
[ "${FREE_KB:-0}" -gt 0 ] || stop "На диске нет свободного места или он не читается."

# ---------------------------------------------------------------------
# 2. Какая папка на диске
# ---------------------------------------------------------------------
say "2. Выберите папку для копии"
echo "Номер — зайти в папку, 0 — выбрать ТЕКУЩУЮ папку, + — создать новую, .. — выше, Enter — выйти."
CUR="$MNT"
while true; do
  echo; echo "Сейчас: $CUR"
  mapfile -t SUBS < <(find "$CUR" -mindepth 1 -maxdepth 1 -type d ! -name '$RECYCLE.BIN' ! -name 'System Volume Information' ! -name 'RECYCLER' -printf '%f\n' 2>/dev/null | sort)
  for i in "${!SUBS[@]}"; do printf '  %d) %s\n' "$((i+1))" "${SUBS[$i]}"; done
  [ "${#SUBS[@]}" -eq 0 ] && echo "  (подпапок нет)"
  read -r -p "Выбор: " c
  case "$c" in
    "") exit 0 ;;
    0)  break ;;
    "+") read -r -p "Название новой папки: " nm
         case "$nm" in ""|*/*|.|..) echo "Недопустимое имя."; continue ;; esac
         mkdir -p "$CUR/$nm" && CUR="$CUR/$nm" ;;
    "..") [ "$CUR" != "$MNT" ] && CUR="$(dirname "$CUR")" ;;
    *)  if [[ "$c" =~ ^[0-9]+$ ]] && [ "$c" -ge 1 ] && [ "$c" -le "${#SUBS[@]}" ]; then
          CUR="$CUR/${SUBS[$((c-1))]}"
        else echo "Нет такого номера."; fi ;;
  esac
done
DEST="$CUR"
# ---------------------------------------------------------------------
# 3. Проверки и подтверждение
# ---------------------------------------------------------------------
say "3. Проверка"
run_src true || stop "Нет связи с источником ($SRC_HOST). Проверьте ssh."
run_src "test -d '$SRC_DIR'" || stop "На источнике нет папки $SRC_DIR."
echo "Считаю размер данных (может занять пару минут)..."
SRC_KB=$(run_src "du -sk '$SRC_DIR' 2>/dev/null | cut -f1")
HAVE_KB=$(du -sk "$DEST/data" 2>/dev/null | cut -f1); HAVE_KB=${HAVE_KB:-0}
NEED_KB=$(( SRC_KB - HAVE_KB )); [ "$NEED_KB" -lt 0 ] && NEED_KB=0
gb() { echo $(( $1 / 1024 / 1024 )); }
echo "Данных у облака:        $(gb "$SRC_KB") ГБ"
echo "Уже есть в этой копии:  $(gb "$HAVE_KB") ГБ"
echo "Нужно докопировать:     ~$(gb "$NEED_KB") ГБ"
echo "Свободно на диске:      $(gb "$FREE_KB") ГБ"
[ "$NEED_KB" -lt "$FREE_KB" ] || stop "НА ДИСКЕ НЕ ХВАТАЕТ МЕСТА."

echo
echo "Откуда:  $(rsync_src)"
echo "Куда:    $DEST/data/  (библиотека и корзина)"
echo "         $DEST/db/    (дамп базы данных)"
echo "Ничего не удаляется ни на диске, ни на сервере. Остановить: Ctrl-C."
yes_no "Начать копирование?" || { echo "Отменено."; exit 0; }

mkdir -p "$DEST/data" "$DEST/db" || stop "Не удалось создать папки в $DEST."

# ---------------------------------------------------------------------
# 4. Дамп базы данных
# ---------------------------------------------------------------------
say "4. Выгрузка базы данных"
DB_C=$(run_src "docker ps --format '{{.Names}} {{.Image}}' | grep -i postgres | awk '{print \$1}' | head -1" 2>/dev/null)
if [ -z "$DB_C" ]; then
  echo "Контейнер базы не найден (docker недоступен?). Дамп пропущен, библиотека скопируется."
else
  OUT="$DEST/db/dvcloud-$STAMP.dump"
  echo "Контейнер базы: $DB_C"
  if run_src "docker exec $DB_C sh -c 'pg_dump -Fc -U \"\$POSTGRES_USER\" \"\$POSTGRES_DB\"'" > "$OUT.part" && [ -s "$OUT.part" ]; then
    mv "$OUT.part" "$OUT"; echo "Готово: $(du -h "$OUT" | cut -f1)  $OUT"
  else
    rm -f "$OUT.part"; echo "ВНИМАНИЕ: дамп базы не получился. Библиотека копируется дальше."
  fi
fi

# ---------------------------------------------------------------------
# 5. Копирование с прогрессом и оставшимся временем
# ---------------------------------------------------------------------
say "5. Копирование (Ctrl-C — остановить)"
LOG="$DEST/backup-errors-$STAMP.txt"; : > "$LOG"

# «0:12:34» -> «≈ 12 мин, закончится около 19:40»
eta_text() {
  local h m s secs
  IFS=: read -r h m s <<< "$1"
  secs=$(( 10#${h:-0} * 3600 + 10#${m:-0} * 60 + 10#${s:-0} ))
  local txt
  if [ "$secs" -ge 3600 ]; then txt="$((secs/3600)) ч $(( (secs%3600)/60 )) мин"
  elif [ "$secs" -ge 60 ]; then txt="$((secs/60)) мин"; else txt="меньше минуты"; fi
  echo "осталось ≈ $txt, закончится около $(date -d "+${secs} seconds" +%H:%M)"
}
bar() { local p=$1 w=30 f i s=""; f=$(( p * w / 100 )); for ((i=0;i<w;i++)); do [ $i -lt $f ] && s+="█" || s+="░"; done; echo "$s"; }

# -rt: без прав и владельцев (на NTFS их нет); modify-window: NTFS округляет время
# no-inc-recursive: сначала полный список файлов, чтобы проценты и время были честными
rsync -rt --partial --modify-window=2 --no-inc-recursive --info=progress2 -h \
  -e "ssh -o BatchMode=yes" "$(rsync_src)" "$DEST/data/" 2>&1 | tr '\r' '\n' | \
while IFS= read -r line; do
  if [[ "$line" =~ ^[[:space:]]*([0-9.,]+[KMGTP]?)[[:space:]]+([0-9]+)%[[:space:]]+([0-9.,]+[kKMGTP]?B/s)[[:space:]]+([0-9:]+) ]]; then
    printf '\r\033[K%s %3s%%  %s  %s  %s' "$(bar "${BASH_REMATCH[2]}")" "${BASH_REMATCH[2]}" "${BASH_REMATCH[1]}" "${BASH_REMATCH[3]}" "$(eta_text "${BASH_REMATCH[4]}")"
  elif [[ "$line" == rsync:* || "$line" == *error* || "$line" == *failed* ]]; then
    echo "$line" >> "$LOG"
  fi
done
RC=${PIPESTATUS[0]}
echo

# ---------------------------------------------------------------------
# 6. Итог и сверка
# ---------------------------------------------------------------------
say "6. Итог"
case $RC in
  0)  echo "Копирование завершено без ошибок." ;;
  23|24) echo "Завершено с предупреждениями (код $RC): часть файлов не скопирована."
         echo "Частая причина: в имени файла символы, запрещённые в Windows (: ? * \" < > |)."
         echo "Список в файле: $LOG" ;;
  *)  echo "Прервано или ошибка (код $RC). Запустите скрипт снова — продолжит с места остановки." ;;
esac
[ -s "$LOG" ] && { echo "Первые ошибки:"; head -5 "$LOG"; } || rm -f "$LOG"

if [ "$RC" -eq 0 ]; then
  echo "Сверяю копию с источником (только список и размеры)..."
  DIFF=$(rsync -rtn --modify-window=2 --no-inc-recursive --out-format='%n' -e "ssh -o BatchMode=yes" "$(rsync_src)" "$DEST/data/" 2>/dev/null | grep -vc '/$' )
  if [ "${DIFF:-0}" -eq 0 ]; then echo "Сверка: копия полностью совпадает с источником."
  else echo "Сверка: различается файлов — $DIFF. Запустите скрипт ещё раз."; fi
fi
echo "Размер копии: $(du -sh "$DEST" 2>/dev/null | cut -f1)"
read -r -p "Enter для завершения..." _
