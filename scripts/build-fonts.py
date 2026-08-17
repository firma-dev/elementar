#!/usr/bin/env python3
"""Сборка веб-шрифтов Элементара: ttf/otf → woff2, разрезанные на два сабсета.

Разовый инструмент, а не шаг сборки: шрифты меняются раз в несколько лет,
результат лежит в репозитории. Держать fontTools в зависимостях проекта ради
этого не нужно — см. DECISIONS.md, Д-004.

    python3 -m venv .venv && .venv/bin/pip install fonttools brotli
    .venv/bin/python scripts/build-fonts.py

Источник — fonts/, выход — apps/web/public/fonts/.
Диапазоны совпадают с unicode-range в packages/ui/src/styles/tokens.css:
разъезжаться им нельзя, иначе браузер скачает файл и не найдёт в нём глифов.
"""

import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "fonts"
OUT = ROOT / "apps/web/public/fonts"

# Держать синхронно с unicode-range в tokens.css, раздел 4 «Типографика».
SUBSETS = {
    "cyrillic": "U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116",
    "latin": "U+0000-00FF,U+2000-206F,U+2190-21BB,U+2212",
}

# Канон §6: текст — Basis Grotesque Pro (Regular / Medium / Bold),
# цифры и единицы измерения — OCR A Becker RUS-LAT.
# Начертаний в поставке больше (Light, Black, курсивы) — канон их не называет,
# поэтому в сборку они не идут.
FACES = [
    ("BasisGrotesquePro-Regular.ttf", "basis-400"),
    ("BasisGrotesquePro-Medium.ttf", "basis-500"),
    ("BasisGrotesquePro-Bold.ttf", "basis-700"),
    ("ocrabeckerrus_lat.otf", "ocr-400"),
]


def build(src: pathlib.Path, stem: str, name: str, ranges: str) -> pathlib.Path:
    dst = OUT / f"{stem}.{name}.woff2"
    subprocess.run(
        [
            sys.executable, "-m", "fontTools.subset", str(src),
            f"--unicodes={ranges}",
            "--layout-features=kern,liga,tnum,lnum,zero,locl,ccmp,mark,mkmk",
            "--flavor=woff2",
            "--desubroutinize",
            "--drop-tables+=DSIG",
            "--name-IDs=1,2,3,4,6",
            f"--output-file={dst}",
        ],
        check=True,
    )
    return dst


def main() -> int:
    if not SRC.is_dir():
        print(f"нет каталога с исходниками: {SRC}", file=sys.stderr)
        return 1
    OUT.mkdir(parents=True, exist_ok=True)

    total = 0
    for filename, stem in FACES:
        src = SRC / filename
        if not src.exists():
            print(f"пропущен, нет файла: {src}", file=sys.stderr)
            return 1
        for name, ranges in SUBSETS.items():
            dst = build(src, stem, name, ranges)
            size = dst.stat().st_size
            total += size
            print(f"{dst.relative_to(ROOT)}  {size / 1024:.1f} КБ")

    print(f"\nвсего {total / 1024:.1f} КБ в {len(FACES) * len(SUBSETS)} файлах")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
