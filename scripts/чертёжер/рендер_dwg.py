#!/usr/bin/env python3
"""Исходник «как в AutoCAD» для режима «Проверка»: DXF → SVG без нашей чистки.

    .venv/bin/python рендер_dwg.py чертёж.dxf исходник.svg [--scale 100]

Рисует модельное пространство целиком библиотекой ezdxf (addons.drawing):
цвета слоёв и объектов из файла (ACI и True Color, ПОСЛОЮ/ПОБЛОКУ), типы линий
(пунктир, штрихпунктир — геометрией, с LTSCALE файла), веса линий, штриховки
(заливки и узоры), текст и размеры. Фон белый, поэтому ACI 7 — чёрный, как
AutoCAD печатает на белом листе. Ничего не перекрашивается и не выбрасывается.

Координаты. Рамка рендера — габарит всего модельного пространства; она
печатается строкой `RENDER_BOX x0 y0 x1 y1` (мм чертежа). Страница знает
начало координат результата (строка `ORIGIN` от dxf2svg) и кладёт картинку
в ту же систему координат — так «Рядом» и «Оба» совпадают с результатом.

Веса линий. Вес из файла — это миллиметры на бумаге; на экране AutoCAD
показывает его пикселями, не завися от зума. Здесь вес переводится в пиксели
экрана (1 мм = 3,78 px, не тоньше 1 px) и пишется в классах `<defs>` как
`stroke-width: N px`; страница пересчитывает их в единицы рисунка под текущий
масштаб (ui.html, «толщины DWG»). vector-effect: non-scaling-stroke внутри
картинки не годится: WebKit рисует такую картинку до 20 секунд.

Запускается рядом с dxf2svg, параллельно ему (app.py): время рендера не
складывается со временем разбора.
"""
from __future__ import annotations

import argparse
import pathlib
import re
import sys

PX_НА_ММ = 96 / 25.4


def рендер(путь_dxf: str, масштаб: float = 100.0) -> tuple[str, tuple[float, float, float, float]]:
    import ezdxf
    from ezdxf import bbox
    from ezdxf.addons.drawing import Frontend, RenderContext, config, layout, svg
    from ezdxf.math import BoundingBox2d

    doc = ezdxf.readfile(путь_dxf)
    msp = doc.modelspace()
    ext = bbox.extents(msp, fast=True)
    if not ext.has_data:
        raise ValueError("в модели пусто")
    x0, y0, x1, y1 = ext.extmin.x, ext.extmin.y, ext.extmax.x, ext.extmax.y
    w, h = max(x1 - x0, 1.0), max(y1 - y0, 1.0)

    cfg = config.Configuration(
        color_policy=config.ColorPolicy.COLOR,          # цвета из файла
        background_policy=config.BackgroundPolicy.WHITE,  # белый лист: ACI 7 чёрный
        line_policy=config.LinePolicy.ACCURATE,          # типы линий как есть
        lineweight_policy=config.LineweightPolicy.ABSOLUTE,  # веса из файла, мм бумаги
    )
    backend = svg.SVGBackend()
    Frontend(RenderContext(doc), backend, config=cfg).draw_layout(msp, finalize=True)
    # Страница — лист в масштабе чертежа: веса линий получаются в миллиметрах
    # бумаги с точностью до тысячных, а не округляются до нуля.
    стр = layout.Page(w / масштаб, h / масштаб, layout.Units.mm)
    наст = layout.Settings(fit_page=False, scale=1 / масштаб)
    текст = backend.get_string(стр, settings=наст, xml_declaration=False,
                               render_box=BoundingBox2d([(x0, y0), (x1, y1)]))
    return веса_в_пиксели(текст, w / масштаб), (x0, y0, x1, y1)


def веса_в_пиксели(текст: str, ширина_мм: float) -> str:
    m = re.search(r'viewBox="0 0 ([\d.]+) ([\d.]+)"', текст)
    ед_на_мм = float(m.group(1)) / ширина_мм

    def класс(mm):
        n = mm.group(1)
        if n == "none":
            return mm.group(0)
        px = max(1.0, float(n) / ед_на_мм * PX_НА_ММ)
        return f"stroke-width: {px:.2f}px"

    текст = re.sub(r"stroke-width: ([\d.]+|none)", класс, текст)
    # Скруглённые концы и стыки при толщине больше волосяной WebKit рисует в
    # картинке до 20 секунд; при толщине 1–3 пикселя разницы глазом не видно.
    текст = текст.replace('stroke-linecap="round" stroke-linejoin="round"', "")
    # размер задаёт страница (картинка растягивается под вид), не файл
    текст = re.sub(r'^<svg([^>]*?) width="[^"]*" height="[^"]*"',
                   r'<svg\1 preserveAspectRatio="none"', текст, count=1)
    return текст


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("dxf")
    ap.add_argument("out")
    ap.add_argument("--scale", type=float, default=100.0)
    a = ap.parse_args()
    try:
        svg, (x0, y0, x1, y1) = рендер(a.dxf, a.scale)
    except Exception as e:
        sys.exit(f"исходник не нарисовался: {type(e).__name__}: {e}"[:300])
    pathlib.Path(a.out).write_text(svg, encoding="utf-8")
    print(f"RENDER_BOX {x0:.3f} {y0:.3f} {x1:.3f} {y1:.3f}")


if __name__ == "__main__":
    main()
