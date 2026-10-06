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
            из["warnings"].append(t[len("ВНИМАНИЕ:"):].strip())
    return из


def styles():
    return sorted(p.stem for p in (HERE / "styles").glob("*.json"))


def без_путей(текст: str) -> str:
    """Путь временного каталога человеку ни к чему и только пугает."""
    return re.sub(r"/[^\s'\"]*чертёжер-[^/\s'\"]+/", "", текст)


def convert(raw: bytes, name: str, style: str, fragment: str = "0"):
    """DWG или DXF на входе → SVG и текст отчёта. Всё во временном каталоге,
    который стирается сразу: чужой чертёж не остаётся на диске."""
    with tempfile.TemporaryDirectory(prefix="чертёжер-") as td:
        d = pathlib.Path(td)
        suffix = pathlib.Path(name).suffix.lower()
        if suffix not in (".dwg", ".dxf"):
            raise Понятная(f"«{name}»: нужен файл DWG или DXF, а не «{suffix or 'без расширения'}»")
        src = d / ("in" + suffix)
        src.write_bytes(raw)

        if src.suffix == ".dwg":
            if not shutil.which("dwg2dxf"):
                raise RuntimeError("не установлен dwg2dxf. Поставьте: brew install libredwg")
            dxf = d / "in.dxf"
            try:
                r = subprocess.run(["dwg2dxf", "-o", str(dxf), str(src)],
                                   capture_output=True, text=True, errors="replace",
                                   timeout=ТАЙМАУТ_DWG)
            except subprocess.TimeoutExpired:
                raise Понятная(f"dwg2dxf не уложился в {ТАЙМАУТ_DWG // 60} мин и остановлен. "
                               "Файл слишком тяжёлый для этого режима: сохраните его из "
                               "AutoCAD/Revit как DXF и загрузите DXF.")
            if not dxf.exists() or dxf.stat().st_size == 0:
                # Первая строка ошибки на мусоре печатает сами байты файла — их не показываем.
                tail = "\n".join(l for l in (r.stderr or "").strip().splitlines()[-4:]
                                 if l.isprintable() and "magic" not in l)
                raise Понятная("Это не похоже на DWG: dwg2dxf не смог его прочитать."
                               + (f"\n{без_путей(tail)}" if tail else ""))
        else:
            dxf = src

        out = d / "out.svg"
        try:
            r = subprocess.run([sys.executable, str(HERE / "dxf2svg.py"), str(dxf), str(out),
                                "--style", style, "--fragment", fragment],
                               capture_output=True, text=True, errors="replace",
                               timeout=ТАЙМАУТ_РАЗБОРА)
        except subprocess.TimeoutExpired:
            raise Понятная(f"разбор чертежа не уложился в {ТАЙМАУТ_РАЗБОРА // 60} мин и остановлен. "
                           "Чертёж слишком большой для этого режима.")
        frags, unknown, lines = [], [], []
        for line in (r.stdout or "").splitlines():
            if line.startswith("FRAGMENTS "):
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
            raise Понятная(без_путей((текст or (r.stdout or "").strip()
                                       or "разбор остановился без объяснения")[-1500:]))
        # Первая строка — путь во временный каталог: он ничего не значит для
        # человека и уходит вместе с каталогом сразу после ответа.
        отчёт = "\n".join(lines[1:] if lines else [])
        return out.read_text(encoding="utf-8"), отчёт, frags, unknown


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body: bytes, ctype="application/json; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
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
            return self._send(200, json.dumps(styles()).encode())
        self._send(404, b"{}")

    def do_POST(self):
        if self.path == "/decide":
            return self.решить()
        if self.path != "/convert":
            return self._send(404, b"{}")

        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > MAX_BYTES:
            return self._send(400, json.dumps(
                {"error": f"файл пуст или больше {MAX_BYTES // 1024 // 1024} МБ"}).encode())
        name = unquote(self.headers.get("X-Name", "чертёж.dwg"))
        style = unquote(self.headers.get("X-Style", "бадаевский"))
        if style not in styles():
            return self._send(400, json.dumps({"error": f"нет стиля «{style}»"}).encode())
        fragment = unquote(self.headers.get("X-Fragment", "0"))
        raw = self.rfile.read(n)
        try:
            svg, report, frags, unknown = convert(raw, name, style, fragment)
        except Unknown as u:
            return self._send(422, json.dumps(
                {"unknown": u.layers, "report": u.report, "previews": u.previews},
                ensure_ascii=False).encode("utf-8"))
        except Понятная as e:
            return self._send(422, json.dumps({"error": str(e)}, ensure_ascii=False).encode())
        except Exception as e:
            return self._send(500, json.dumps({"error": str(e)}, ensure_ascii=False).encode())
        self._send(200, json.dumps({"svg": svg, "report": report, "fragments": frags,
                                    "summary": кратко(report),
                                    "unknown": unknown, "fragment": fragment},
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
