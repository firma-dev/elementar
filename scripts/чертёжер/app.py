#!/usr/bin/env python3
"""Чертёжер: три кнопки. Загрузить DWG, выбрать стиль, скачать SVG.

Локальный сервер на стандартной библиотеке. Слушает только 127.0.0.1: чертёж
никуда не уезжает, вся обработка на этой машине.

  .venv/bin/python app.py                  и открыть http://127.0.0.1:8765
  .venv/bin/python app.py --no-open        то же, не открывая браузер сам
  .venv/bin/python app.py --port 8766      другой порт, если 8765 занят
"""
from __future__ import annotations

import json
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote

HERE = pathlib.Path(__file__).parent
PORT = 8765
MAX_BYTES = 200 * 1024 * 1024
# Версия снимается при старте и сверяется с записанной в requirements.txt.
# Расхождение — предупреждение: dwg2dxf заметно расходится по поведению между
# релизами на свежих DWG, и знать об этом надо до того, как чертёж уедет в макет.
DWG2DXF_ОЖИДАЕТСЯ = "dwg2dxf 0.14"
# Предел ожидания, секунды. Без него зависший dwg2dxf держит запрос вечно.
ТАЙМАУТ_DWG = 600
ТАЙМАУТ_РАЗБОРА = 1800


class Понятная(Exception):
    """Ошибка по вине файла или его размера: текст написан для человека, статус 422."""


class Unknown(Exception):
    """Слои без решения. Отдавать SVG в этом случае нельзя."""

    def __init__(self, layers, report, previews):
        super().__init__("слои без решения")
        self.layers = layers
        self.report = report
        self.previews = previews  # имя слоя → SVG, чтобы решать глазами


def кратко(отчёт: str) -> dict:
    """Из отчёта конвертора — то немногое, что меняет действия человека.

    Всё остальное (путь во временный каталог, разбор по классам, баланс объектов)
    нужно мне и гейту, а не тому, кто пришёл за чертежом."""
    из = {"warnings": []}
    m = re.search(r"лист (\d+) × (\d+) мм в масштабе 1:(\d+)", отчёт)
    if m:
        из["sheet"] = f"{m.group(1)} × {m.group(2)} мм, 1:{m.group(3)}"
    m = re.search(r"весь чертёж ([\d.]+) × ([\d.]+) м", отчёт)
    if m:
        из["real"] = f"{m.group(1)} × {m.group(2)} м"
    for строка in отчёт.splitlines():
        t = строка.strip()
        if t.startswith("ВНИМАНИЕ:"):
            из["warnings"].append(re.sub(r"\s*\(?~?/[^\s)]*\)?", "", t[len("ВНИМАНИЕ:"):]).strip())
    return из


# Сводка для человека: что убрано и сколько, что залито, сколько номеров
# перенесено. Разбирается текст отчёта dxf2svg (секция БАЛАНС, строки ПОМЕЩЕНИЯ
# и «цифры»), поэтому незнакомые строки пропускаются молча: отчёт растёт.
ГРУППЫ_ОФОРМЛЕНИЯ = (
    ("размеры", ("размер", "dimension")),
    ("штриховки", ("штрих", "hatch")),
    ("оси", ("оси", "ось", "grid")),
    ("облака правок", ("облак", "cloud")),
    ("текст и марки", ("аннотац", "марк", "отметк", "узл", "разрез", "стрелк",
                       "надпис", "annotation", "text", "tag")),
)
# Порядок показа: размеры, текст, оси, штриховки — то, что глаз ищет первым.
ПОРЯДОК_ПОКАЗА = ("размеры", "текст и марки", "оси", "штриховки", "облака правок",
                  "прочее оформление")
# Корзины, где геометрия действительно не дошла до результата. «Не дали
# геометрии» и пустые вставки — объекты, которым нечего рисовать, не потеря.
ПОТЕРИ = {
    "слой без решения": "слой без решения",
    "ошибка разбора геометрии": "не разобралась геометрия",
    "отсечено кадрированием": "отсечено рамкой",
    "вне габарита конструктива": "за пределами чертежа",
    "вставка блока: ошибка разворота": "блок не развернулся",
    "вставка блока: глубже предела вложенности": "блок слишком глубоко вложен",
}


def группа_оформления(слой: str) -> str:
    с = слой.lower()
    for имя, ключи in ГРУППЫ_ОФОРМЛЕНИЯ:
        if any(к in с for к in ключи):
            return имя
    return "прочее оформление"


def сводка(отчёт: str) -> dict:
    убрано, потери = {}, {}
    итог = {"removed": 0, "other_drawings": 0, "empty": 0}
    корзина = None
    for строка in отчёт.splitlines():
        m = re.match(r"^  (\S.*?): (\d+)$", строка)
        if m:
            корзина = m.group(1)
            n = int(m.group(2))
            if корзина.startswith("выброшено"):
                итог["removed"] += n
            elif корзина == "другой чертёж на листе":
                итог["other_drawings"] += n
            elif корзина == "не дали геометрии":
                итог["empty"] += n
            elif корзина in ПОТЕРИ:
                потери[ПОТЕРИ[корзина]] = потери.get(ПОТЕРИ[корзина], 0) + n
            continue
        m = re.match(r"^    (\S.*?)\s{2,}(\d+)$", строка)
        if m and корзина and корзина.startswith("выброшено"):
            г = (группа_оформления(m.group(1)) if "слою" in корзина
                 else ("размеры" if "размер" in m.group(1).lower() else "текст и марки"))
            убрано[г] = убрано.get(г, 0) + int(m.group(2))
            continue
        m = re.match(r"^    (вставка блока: [^:]+): .* — (\d+)$", строка)
        if m:
            if m.group(1) in ПОТЕРИ:
                потери[ПОТЕРИ[m.group(1)]] = потери.get(ПОТЕРИ[m.group(1)], 0) + int(m.group(2))
            else:
                итог["empty"] += int(m.group(2))
            continue
        if not строка.startswith(" "):
            корзина = None
    итог["removed_groups"] = [[г, убрано[г]] for г in ПОРЯДОК_ПОКАЗА if убрано.get(г)]
    итог["lost"] = sorted(([k, v] for k, v in потери.items()), key=lambda x: -x[1])
    m = re.search(r"БАЛАНС: нарисовано (\d+)", отчёт)
    итог["drawn"] = int(m.group(1)) if m else None
    m = re.search(r"проверка баланса: \d+ = (\d+) объектов", отчёт)
    итог["input"] = int(m.group(1)) if m else None
    m = re.search(r"ПОМЕЩЕНИЯ: марок (\d+), на заливке (\d+)", отчёт)
    итог["rooms"] = {"total": int(m.group(1)), "filled": int(m.group(2))} if m else None
    m = re.search(r"^цифры: (\d+) меток", отчёт, re.M)
    итог["numbers"] = int(m.group(1)) if m else None
    m = re.search(r"заливка пола: (\d+) м²", отчёт)
    итог["floor_m2"] = int(m.group(1)) if m else None
    m = re.search(r"на листе чертежей: (\d+)", отчёт)
    итог["drawings_on_sheet"] = int(m.group(1)) if m else 1
    return итог


def палитра(имя: str) -> dict:
    """Цвета стиля для образца на кнопке: пол, стены, двери, второстепенное."""
    try:
        cls = json.loads((HERE / "styles" / f"{имя}.json").read_text(encoding="utf-8"))["classes"]
    except Exception:
        return {}
    взять = lambda k, поле: (cls.get(k) or {}).get(поле)
    return {"floor": взять("floor", "fill"), "wall": взять("wall-fill", "fill") or взять("wall", "stroke"),
            "door": взять("door", "stroke"), "generic": взять("generic", "stroke"),
            "fixture": взять("fixture", "fill"), "numbers": взять("numbers", "fill")}


def styles():
    return sorted(p.stem for p in (HERE / "styles").glob("*.json"))


def без_путей(текст: str) -> str:
    """Путь временного каталога человеку ни к чему и только пугает."""
    return re.sub(r"/[^\s'\"]*чертёжер-[^/\s'\"]+/", "", текст)


# Отказы конвертора — человеческим языком: что случилось и что сделать.
# Исходный текст остаётся в окне терминала, где запущен app.py.
ПОНЯТНО = (
    ("файл не читается как DXF",
     "Файл не читается как чертёж: он повреждён, обрезан или это не DXF. "
     "Откройте его в AutoCAD и сохраните заново."),
    ("нет ни одного объекта",
     "В чертеже пусто: в модели нет ни одного объекта. Если план лежит только на "
     "листе, перенесите его в модель и сохраните заново."),
    ("не осталось конструктива",
     "В чертеже не нашлось стен, окон, дверей и лестниц — рисовать нечего. "
     "Проверьте, что это план этажа."),
    ("нет штриховок",
     "Пол не построился: у стен в этом чертеже нет штриховки. "
     "Нужен план, где тело стены заштриховано."),
    ("не сложились в область",
     "Пол не построился: стены не замыкаются в контур. Проверьте, нет ли разрывов в стенах."),
    ("баланс объектов не сошёлся",
     "Чертёж не собран: при разборе часть объектов не учлась, а отдавать неполный "
     "результат нельзя. Сообщите разработчику, приложив файл."),
)


def человечно(текст: str) -> str:
    for ключ, фраза in ПОНЯТНО:
        if ключ in текст:
            return фраза
    return ("Чертёж не собрался. Подробности записаны в окне терминала, где запущен "
            "чертёжер, — покажите их разработчику.")


def convert(raw: bytes, name: str, style: str, fragment: str = "0", overlay: bool = False,
            время: dict | None = None):
    """DWG или DXF на входе → SVG и текст отчёта. Всё во временном каталоге,
    который стирается сразу: чужой чертёж не остаётся на диске."""
    with tempfile.TemporaryDirectory(prefix="чертёжер-") as td:
        d = pathlib.Path(td)
        suffix = pathlib.Path(name).suffix.lower()
        if suffix not in (".dwg", ".dxf"):
            raise Понятная(f"«{name}» — не чертёж. Нужен файл DWG или DXF.")
        src = d / ("in" + suffix)
        src.write_bytes(raw)

        if src.suffix == ".dwg":
            if not shutil.which("dwg2dxf"):
                print("не установлен dwg2dxf. Поставьте: brew install libredwg", file=sys.stderr)
                raise Понятная("На этом компьютере не установлена программа чтения DWG. "
                               "Сохраните чертёж из AutoCAD как DXF и загрузите DXF.")
            dxf = d / "in.dxf"
            t0 = time.monotonic()
            try:
                r = subprocess.run(["dwg2dxf", "-o", str(dxf), str(src)],
                                   capture_output=True, text=True, errors="replace",
                                   timeout=ТАЙМАУТ_DWG)
            except subprocess.TimeoutExpired:
                raise Понятная(f"Чтение DWG заняло больше {ТАЙМАУТ_DWG // 60} минут и остановлено. "
                               "Сохраните чертёж из AutoCAD или Revit как DXF и загрузите DXF.")
            if время is not None:
                время["read"] = round(time.monotonic() - t0, 2)
            if not dxf.exists() or dxf.stat().st_size == 0:
                # Первая строка ошибки на мусоре печатает сами байты файла — их не показываем.
                tail = "\n".join(l for l in (r.stderr or "").strip().splitlines()[-4:]
                                 if l.isprintable() and "magic" not in l)
                if tail:
                    print(без_путей(tail), file=sys.stderr)
                raise Понятная("Файл не читается как DWG: он повреждён или сохранён не в AutoCAD. "
                               "Откройте его в AutoCAD и сохраните заново — как DWG или DXF.")
        else:
            dxf = src

        out = d / "out.svg"
        t0 = time.monotonic()
        try:
            r = subprocess.run([sys.executable, str(HERE / "dxf2svg.py"), str(dxf), str(out),
                                    "--style", style, "--fragment", fragment]
                               + (["--source-svg", str(d / "src.svg")] if overlay else []),
                               capture_output=True, text=True, errors="replace",
                               timeout=ТАЙМАУТ_РАЗБОРА)
        except subprocess.TimeoutExpired:
            raise Понятная(f"Разбор чертежа занял больше {ТАЙМАУТ_РАЗБОРА // 60} минут и остановлен. "
                           "Чертёж слишком большой: разрежьте лист на части и загрузите по одной.")
        if время is not None:
            время["parse"] = round(time.monotonic() - t0, 2)
        frags, unknown, lines, src_err = [], [], [], None
        for line in (r.stdout or "").splitlines():
            if line.startswith("SOURCE_ERROR "):
                src_err = line[13:]
            elif line.startswith("SOURCE "):
                continue
            elif line.startswith("FRAGMENTS "):
                frags = json.loads(line[10:])
            elif line.startswith("UNKNOWN "):
                unknown = json.loads(line[8:])
            else:
                lines.append(line)
        if not out.exists():
            # Слой без решения — не ошибка, а вопрос: приложение обязано его задать,
            # а не отдать SVG, из которого молча выпали стены.
            if unknown:
                # Второй прогон только ради картинок: решение по слою принимается
                # глазами, значит глазам надо показать, что в нём лежит.
                пр = d / "превью"
                r2 = subprocess.run(
                    [sys.executable, str(HERE / "dxf2svg.py"), str(dxf), str(out),
                     "--style", style, "--preview-unknown", str(пр)],
                    capture_output=True, text=True, errors="replace", timeout=1800)
                картинки = {}
                try:
                    for слой, путь in json.loads(r2.stdout.strip().splitlines()[-1]).items():
                        картинки[слой] = pathlib.Path(путь).read_text(encoding="utf-8")
                except Exception:
                    pass
                raise Unknown(unknown, "\n".join(lines), картинки)
            текст = (r.stderr or "").strip()
            if "Traceback (most recent call last)" in текст:
                # Сбой самой программы, а не файла: человеку — последняя строка,
                # полный текст остаётся в консоли, где запущен app.py.
                print(текст, file=sys.stderr)
                raise RuntimeError("внутренняя ошибка разбора: "
                                   + (текст.splitlines()[-1] if текст else "без текста")[:300])
            текст = без_путей((текст or (r.stdout or "").strip()
                               or "разбор остановился без объяснения")[-1500:])
            print(текст, file=sys.stderr)
            raise Понятная(человечно(текст))
        # Первая строка — путь во временный каталог: он ничего не значит для
        # человека и уходит вместе с каталогом сразу после ответа.
        отчёт = "\n".join(lines[1:] if lines else [])
        исх = None
        if overlay:
            f = d / "src.svg"
            if f.exists():
                исх = f.read_text(encoding="utf-8")
            else:
                src_err = src_err or "исходник не нарисовался"
        return (out.read_text(encoding="utf-8"), отчёт, frags, unknown,
                {"svg": исх, "error": src_err} if overlay else None)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body: bytes, ctype="application/json; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _свой(self) -> bool:
        """Запрос пришёл со своей страницы, а не из чужой вкладки браузера.

        Сервер слушает только 127.0.0.1, но любая открытая в браузере страница
        может послать запрос на этот адрес (CSRF) или подменить имя хоста (DNS
        rebinding). Поэтому имя хоста обязано быть 127.0.0.1 или localhost с нашим
        портом, а Origin, если он есть, — тем же адресом. curl и скрипты Origin не
        шлют, им это не мешает."""
        pt = self.server.server_address[1]
        ok = {f"127.0.0.1:{pt}", f"localhost:{pt}"}
        if (self.headers.get("Host") or "") not in ok:
            return False
        o = self.headers.get("Origin")
        return o is None or o in {f"http://{h}" for h in ok}

    def do_GET(self):
        if not self._свой():
            return self._send(403, b"{}")
        if self.path in ("/", "/index.html"):
            html = (HERE / "ui.html").read_bytes()
            return self._send(200, html, "text/html; charset=utf-8")
        if self.path == "/elementar.svg":
            f = HERE.parents[1] / "packages" / "brand" / "src" / "elementar.svg"
            if not f.exists():
                return self._send(404, b"", "image/svg+xml")
            return self._send(200, f.read_bytes(), "image/svg+xml")
        if self.path.startswith("/fonts/"):
            # OCR отдаётся из репозитория: язык прототипа держится на нём, и без
            # шрифта подача рассыпается. Файлы те же, что у elementaros.ru.
            имя = pathlib.PurePosixPath(self.path).name
            f = HERE.parents[1] / "apps" / "web" / "public" / "fonts" / имя
            if f.suffix != ".woff2" or not f.exists():
                return self._send(404, b"", "font/woff2")
            return self._send(200, f.read_bytes(), "font/woff2")
        if self.path == "/tokens.css":
            # Токены отдаются из репозитория, а не копируются: копия разъедется.
            f = HERE.parents[1] / "packages" / "ui" / "src" / "styles" / "tokens.css"
            if not f.exists():
                return self._send(404, "/* tokens.css не найден */".encode(), "text/css")
            return self._send(200, f.read_bytes(), "text/css; charset=utf-8")
        if self.path == "/styles":
            return self._send(200, json.dumps([{"name": n, "palette": палитра(n)} for n in styles()],
                                              ensure_ascii=False).encode("utf-8"))
        self._send(404, b"{}")

    def do_POST(self):
        if not self._свой():
            return self._send(403, json.dumps({"error": "запрос не со страницы чертёжера"}).encode())
        if self.path == "/decide":
            return self.решить()
        if self.path != "/convert":
            return self._send(404, b"{}")

        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > MAX_BYTES:
            return self._send(400, json.dumps(
                {"error": f"Файл пустой или больше {MAX_BYTES // 1024 // 1024} МБ. "
                          "Выберите другой файл."}, ensure_ascii=False).encode())
        name = unquote(self.headers.get("X-Name", "чертёж.dwg"))
        style = unquote(self.headers.get("X-Style", "бадаевский"))
        if style not in styles():
            return self._send(400, json.dumps({"error": f"Стиля «{style}» нет. Обновите страницу."},
                                              ensure_ascii=False).encode())
        fragment = unquote(self.headers.get("X-Fragment", "0"))
        raw = self.rfile.read(n)
        время = {}
        t0 = time.monotonic()
        try:
            svg, report, frags, unknown, source = convert(
                raw, name, style, fragment, self.headers.get("X-Overlay") == "1", время)
        except Unknown as u:
            return self._send(422, json.dumps(
                {"unknown": u.layers, "report": u.report, "previews": u.previews},
                ensure_ascii=False).encode("utf-8"))
        except Понятная as e:
            return self._send(422, json.dumps({"error": str(e)}, ensure_ascii=False).encode())
        except Exception as e:
            print(f"сбой: {e}", file=sys.stderr)
            return self._send(500, json.dumps(
                {"error": "Чертёж не собрался из-за сбоя в самой программе. Подробности — "
                          "в окне терминала, где запущен чертёжер; покажите их разработчику."},
                ensure_ascii=False).encode())
        время["total"] = round(time.monotonic() - t0, 2)
        self._send(200, json.dumps({"svg": svg, "report": report, "fragments": frags,
                                    "summary": кратко(report), "digest": сводка(report),
                                    "timing": время,
                                    "unknown": unknown, "fragment": fragment,
                                    "source": source},
                                   ensure_ascii=False).encode("utf-8"))

    РЕШЕНИЯ = {"стена": "wall", "второстепенное": "generic", "оформление": "drop"}

    def решить(self):
        """Ответ на вопрос о слое. Пишется в layers.json рядом с причиной,
        чтобы через месяц было видно, кто и почему так решил."""
        n = int(self.headers.get("Content-Length") or 0)
        try:
            d = json.loads(self.rfile.read(n))
            слой, что = d["layer"], d["decision"]
        except Exception:
            return self._send(400, json.dumps({"error": "жду {layer, decision}"}).encode())
        if что not in self.РЕШЕНИЯ:
            return self._send(400, json.dumps(
                {"error": f"решение «{что}» неизвестно, жду одно из: "
                          + ", ".join(self.РЕШЕНИЯ)}, ensure_ascii=False).encode())
        ф = HERE / "layers.json"
        cfg = json.loads(ф.read_text(encoding="utf-8"))
        cfg["drop"].pop(слой, None)
        cfg["class"].pop(слой, None)
        if что == "оформление":
            cfg["drop"][слой] = "оформление, решено в приложении"
        else:
            cfg["class"][слой] = self.РЕШЕНИЯ[что]
        ф.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return self._send(200, json.dumps({"ok": True, "layer": слой, "decision": что},
                                          ensure_ascii=False).encode())


def порт(argv) -> int:
    """Порт по умолчанию 8765; --port N меняет его (например, если 8765 уже занят
    другой копией чертёжера). Слушает по-прежнему только 127.0.0.1."""
    if "--port" not in argv:
        return PORT
    try:
        n = int(argv[argv.index("--port") + 1])
        if not 1024 <= n <= 65535:
            raise ValueError
        return n
    except (IndexError, ValueError):
        sys.exit("--port: нужен номер порта от 1024 до 65535, например --port 8766")


def main():
    open_browser = "--no-open" not in sys.argv
    pt = порт(sys.argv)
    missing = [m for m in ("ezdxf", "shapely") if not _has(m)]
    if missing:
        sys.exit(f"не хватает пакетов: {', '.join(missing)}\n"
                 f"  {sys.executable} -m pip install {' '.join(missing)}")
    if not shutil.which("dwg2dxf"):
        print("ВНИМАНИЕ: dwg2dxf не найден, DWG открыть будет нечем — "
              "поставьте brew install libredwg. DXF работает и без него.")
    else:
        have = subprocess.run(["dwg2dxf", "--version"], capture_output=True,
                              text=True, errors="replace").stdout.splitlines()
        have = (have or [""])[0].strip()
        if have and have != DWG2DXF_ОЖИДАЕТСЯ:
            print(f"ВНИМАНИЕ: dwg2dxf «{have}», а проверялось на "
                  f"«{DWG2DXF_ОЖИДАЕТСЯ}». Результат может отличаться.")
    try:
        srv = ThreadingHTTPServer(("127.0.0.1", pt), Handler)
    except OSError as e:
        sys.exit(f"порт {pt} не открылся: {e.strerror}. Возможно, чертёжер уже запущен "
                 f"(в другом окне терминала или из другой копии). Остановите его "
                 f"(Ctrl+C в том окне) или запустите с другим портом: "
                 f"app.py --port {pt + 1}")
    url = f"http://127.0.0.1:{pt}"
    print(f"чертёжер: {url}   (Ctrl+C чтобы остановить)")
    print(f"стили: {', '.join(styles())}")
    if open_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nостановлен")


def _has(mod):
    import importlib.util
    return importlib.util.find_spec(mod) is not None


if __name__ == "__main__":
    main()
