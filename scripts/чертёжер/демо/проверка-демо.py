#!/usr/bin/env python3
"""Проверка демо без браузера: три DXF собираются кодом, конвертор и audit.py
гоняются на них, выдача сверяется с эталонами в этой папке.

  .venv/bin/python демо/проверка-демо.py

Сверка побайтная: эталон-*.svg против того, что выдал dxf2svg.py, и
эталон-audit-*.txt против вывода audit.py. Разошлось — сменилась версия ezdxf или
shapely, либо поведение конвертора. Если конвертор изменён намеренно, эталоны
пересобираются командой `демо/сделать-демо.py --эталоны` и смотрятся глазами
до коммита. Код возврата 0 — чисто, 1 — разошлось.

Чертежи настоящих комплектов тут не нужны: это проверка «поднимается ли установка
и даёт ли она ту же картинку», она работает у любого, кто склонировал репозиторий.
"""
from __future__ import annotations

import difflib
import importlib.util
import pathlib
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).parent
ROOT = HERE.parent


def генератор():
    spec = importlib.util.spec_from_file_location("сделать_демо", HERE / "сделать-демо.py")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def первое_расхождение(а: str, б: str) -> str:
    for i, (x, y) in enumerate(zip(а.splitlines(), б.splitlines()), 1):
        if x != y:
            return f"строка {i}: было «{x[:80]}», стало «{y[:80]}»"
    return f"длина: было {len(а)} знаков, стало {len(б)}"


def главное() -> int:
    g = генератор()
    ошибки = []
    with tempfile.TemporaryDirectory(prefix="чертёжер-демо-") as td:
        пути = g.собрать(pathlib.Path(td))
        for имя in g.ИМЕНА:
            dxf, svg = пути[имя], pathlib.Path(td) / f"{имя}.svg"
            r = subprocess.run([sys.executable, str(ROOT / "dxf2svg.py"), str(dxf), str(svg)],
                               capture_output=True, text=True)
            if r.returncode or not svg.exists():
                ошибки.append(f"{имя}: конвертор упал: {(r.stderr or r.stdout).strip()[-200:]}")
                continue
            эт = HERE / f"эталон-{имя}.svg"
            if not эт.exists():
                ошибки.append(f"{имя}: нет эталона {эт.name}")
            elif svg.read_bytes() != эт.read_bytes():
                ошибки.append(f"{имя}: SVG не совпал с {эт.name} — "
                              + первое_расхождение(эт.read_text(encoding="utf-8"),
                                                    svg.read_text(encoding="utf-8")))
            a = subprocess.run([sys.executable, str(ROOT / "audit.py"), str(dxf)],
                               capture_output=True, text=True)
            if a.returncode:
                ошибки.append(f"{имя}: audit.py вернул код {a.returncode}: {a.stderr.strip()[-200:]}")
                continue
            эта = HERE / f"эталон-audit-{имя}.txt"
            if not эта.exists():
                ошибки.append(f"{имя}: нет эталона {эта.name}")
            elif a.stdout != эта.read_text(encoding="utf-8"):
                ошибки.append(f"{имя}: вывод audit.py не совпал с {эта.name} — "
                              + первое_расхождение(эта.read_text(encoding="utf-8"), a.stdout))
    if ошибки:
        print("Демо разошлось с эталонами:\n" + "\n".join("  · " + e for e in ошибки),
              file=sys.stderr)
        return 1
    print(f"Демо в порядке: {len(g.ИМЕНА)} чертежа, SVG и audit.py совпали с эталонами.")
    return 0


if __name__ == "__main__":
    raise SystemExit(главное())
