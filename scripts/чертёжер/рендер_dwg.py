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
import json
import pathlib
import re
import sys
import unicodedata

PX_НА_ММ = 96 / 25.4


def рендер(путь_dxf: str, масштаб: float = 100.0):
    """→ (svg с весами в пикселях для страницы, рамка, сведения о листе или None).

    Модель пустая, а всё нарисовано на листе (paper space: «Содержание тома»,
    ведомости) — рисуется этот лист, в своих миллиметрах бумаги. Тогда третьим
    значением приходит {"layout", "title", "svg"}: "svg" — тот же лист отдельным
    файлом с весами линий в миллиметрах, для «Скачать SVG"."""
    import ezdxf
    from ezdxf import bbox
    from ezdxf.addons.drawing import Frontend, RenderContext, config, layout, svg
    from ezdxf.math import BoundingBox2d

    doc = ezdxf.readfile(путь_dxf)
    раскодировать(doc)
    узкий_запасной_шрифт(doc)
    где = doc.modelspace()
    ext = bbox.extents(где, fast=True)
    лист = None
    if not ext.has_data:
        # самый наполненный лист; модель и пустые листы пропускаются
        листы = [l for l in doc.layouts if l.name != "Model" and len(l)]
        if not листы:
            raise ValueError("в модели и на листах пусто")
        где = max(листы, key=len)
        ext = bbox.extents(где, fast=True)
        if not ext.has_data:
            raise ValueError("на листе пусто")
        лист = {"layout": где.name, "title": название_листа(где)}
        масштаб = 1.0  # единицы листа — уже миллиметры бумаги
    x0, y0, x1, y1 = ext.extmin.x, ext.extmin.y, ext.extmax.x, ext.extmax.y
    w, h = max(x1 - x0, 1.0), max(y1 - y0, 1.0)

    cfg = config.Configuration(
        color_policy=config.ColorPolicy.COLOR,          # цвета из файла
        background_policy=config.BackgroundPolicy.WHITE,  # белый лист: ACI 7 чёрный
        line_policy=config.LinePolicy.ACCURATE,          # типы линий как есть
        lineweight_policy=config.LineweightPolicy.ABSOLUTE,  # веса из файла, мм бумаги
    )
    backend = svg.SVGBackend()
    Frontend(RenderContext(doc), backend, config=cfg).draw_layout(где, finalize=True)
    # Страница — лист в масштабе чертежа: веса линий получаются в миллиметрах
    # бумаги с точностью до тысячных, а не округляются до нуля.
    стр = layout.Page(w / масштаб, h / масштаб, layout.Units.mm)
    наст = layout.Settings(fit_page=False, scale=1 / масштаб)
    текст = backend.get_string(стр, settings=наст, xml_declaration=False,
                               render_box=BoundingBox2d([(x0, y0), (x1, y1)]))
    if лист:
        лист["svg"] = в_миллиметрах(текст, w, h)
    return веса_в_пиксели(текст, w / масштаб), (x0, y0, x1, y1), лист


def название_листа(где) -> str:
    """Имя листа для человека. Revit называет блок штампа «…Основная надпись…-<имя
    листа>» — оттуда; иначе имя вкладки листа в файле."""
    for e in где.query("INSERT"):
        имя = e.dxf.name
        if "надпись" in имя.lower() and "-" in имя:
            хвост = имя.rsplit("-", 1)[1].strip()
            if хвост and not хвост.isdigit():
                return хвост
    return где.name


def в_миллиметрах(текст: str, w: float, h: float) -> str:
    """Лист как есть отдельным файлом: viewBox в миллиметрах листа (как у
    результата dxf2svg), размеры в мм, веса линий — миллиметрами бумаги."""
    m = re.search(r'^<svg[^>]*viewBox="0 0 ([\d.]+) ([\d.]+)"[^>]*>', текст)
    k = w / float(m.group(1))
    # Белая подложка ezdxf файлу не нужна: лист и так на белом, а в «Оба» она
    # закрыла бы исходник и считалась бы «добавленным».
    текст = re.sub(r'<rect fill="#ffffff"[^>]*/>', "", текст, count=1)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{w:.2f}mm" height="{h:.2f}mm" '
            f'viewBox="0 0 {w:.3f} {h:.3f}" role="img" aria-label="Лист">\n'
            f'<g transform="scale({k:.9g})">' + текст[m.end():].replace("</svg>", "</g></svg>", 1)
            + ("\n" if not текст.endswith("\n") else ""))


def раскодировать(doc) -> int:
    """Кириллица, экранированная \\U+XXXX (так её оставляет dwg2dxf) или \\M+NXXXX,
    — обратно в буквы, иначе на рисунке вместо «комната» стоят коды.

    Меняется документ в памяти, файл на диске не трогается. Проходят все объекты
    базы — модель, листы и блоки (вставки, размерные блоки): TEXT, MTEXT,
    ATTRIB/ATTDEF, переопределённый текст размера, MTEXT выноски. Тот же
    раскодировщик ezdxf, что в цифры.строка. Возвращает число исправленных строк."""
    from ezdxf.lldxf.encoding import (decode_dxf_unicode, decode_mif_to_unicode,
                                      has_dxf_unicode, has_mif_encoding)

    def буквы(t):
        if not isinstance(t, str) or "\\" not in t:
            return t
        if has_dxf_unicode(t):
            t = decode_dxf_unicode(t)
        if has_mif_encoding(t):
            t = decode_mif_to_unicode(t)
        # Невидимые служебные знаки (U+200C, U+200E, U+202A… — Revit прячет ими
        # данные в штампе): AutoCAD их не рисует, а шрифт ezdxf рисует квадратами.
        return "".join(c for c in t if unicodedata.category(c) != "Cf")

    n = 0
    for e in list(doc.entitydb.values()):
        тип = e.dxftype()
        try:
            if тип == "MTEXT":
                новый = доли_в_кодах(буквы(e.text))
                if новый != e.text:
                    e.text, n = новый, n + 1
            elif тип in ("TEXT", "ATTRIB", "ATTDEF", "DIMENSION", "ARC_DIMENSION",
                         "LARGE_RADIAL_DIMENSION"):
                старый = e.dxf.get("text")
                if старый:
                    новый = буквы(старый)
                    if новый != старый:
                        e.dxf.text, n = новый, n + 1
                if тип in ("ATTRIB", "ATTDEF") and getattr(e, "has_embedded_mtext_entity", False):
                    m = e.virtual_mtext_entity()
                    новый = буквы(m.text)
                    if новый != m.text:
                        m.text = новый
                        e.embed_mtext(m)
                        n += 1
            elif тип == "MULTILEADER":
                ctx = e.context
                if ctx.mtext is not None:
                    новый = буквы(ctx.mtext.default_content)
                    if новый != ctx.mtext.default_content:
                        ctx.mtext.default_content, n = новый, n + 1
        except Exception:
            continue  # один странный объект не должен оставлять без рисунка весь лист
    return n


# Коды MTEXT с дробным числом без нуля: «\\W.9;» (ширина 0,9), «\\H.5x;», «\\T.1;».
# AutoCAD их понимает, а разборщик ezdxf — нет: рисует «.9;» буквами. Revit так
# пишет каждый пробел между словами отдельным MTEXT «\\f…;\\W.9; », и «.9;»
# ложился на первую букву следующего слова («Кирпична;ладка»). Ноль дописывается.
# Перед кодом не должно стоять экранирующей «\\» (литеральный обратный слеш).
_ДОЛЯ = re.compile(r"(?<!\\)((?:\\\\)*)\\([WHTQwhtq])(-?)\.(?=\d)")


def доли_в_кодах(t: str) -> str:
    return _ДОЛЯ.sub(lambda m: f"{m.group(1)}\\{m.group(2)}{m.group(3)}0.", t) if isinstance(t, str) else t


ЗАПАСНОЙ_УЗКИЙ = "Arial Narrow"


def узкий_запасной_шрифт(doc) -> int:
    """Чертёжного шрифта файла (GOST Common, ISOCPEUR…) на машине нет — ezdxf
    берёт вместо него широкий Arial Unicode, и слова, которые Revit расставил
    каждое отдельным MTEXT по ширине узкого шрифта, наезжают друг на друга
    («Кирпичнаякладка»). Чертёжные шрифты узкие, поэтому недостающий заменяется
    узким Arial Narrow — и в стилях текста, и в кодах «\\fСемейство|» внутри
    MTEXT. Только в памяти; установленные шрифты не трогаются. Нет и Arial
    Narrow — ничего не меняется. Возвращает число замен."""
    from ezdxf.fonts import fonts
    if not fonts.find_best_match(family=ЗАПАСНОЙ_УЗКИЙ):
        return 0
    есть = {}

    def установлен(семейство: str) -> bool:
        if семейство not in есть:
            ff = fonts.find_best_match(family=семейство)
            есть[семейство] = bool(ff and ff.family.lower() == семейство.lower())
        return есть[семейство]

    n = 0
    for st in doc.styles:
        файл = (st.dxf.get("font") or "").strip()
        if not файл.lower().endswith((".ttf", ".otf", ".ttc")):
            continue  # SHX ezdxf рисует своим запасным, его не трогаем
        ff = fonts.find_font_face(файл)
        if ff and ff.filename.lower() == pathlib.Path(файл).name.lower():
            continue
        try:
            семейство = st.get_extended_font_data()[0]
        except Exception:
            семейство = ""
        if семейство and установлен(семейство):
            continue
        st.dxf.font = "Arial Narrow.ttf"
        if hasattr(st, "set_extended_font_data"):
            st.set_extended_font_data(ЗАПАСНОЙ_УЗКИЙ)
        n += 1

    def код(m):
        nonlocal n
        if установлен(m.group(2)):
            return m.group(0)
        n += 1
        return f"{m.group(1)}\\f{ЗАПАСНОЙ_УЗКИЙ}|"
    for e in doc.entitydb.values():
        if e.dxftype() == "MTEXT" and "\\f" in e.text:
            e.text = _ШРИФТ_В_MTEXT.sub(код, e.text)
    return n


_ШРИФТ_В_MTEXT = re.compile(r"(?<!\\)((?:\\\\)*)\\[fF]([^|;]+)\|")


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
    ap.add_argument("--sheet-out", metavar="ФАЙЛ",
                    help="если модель пуста и нарисован лист: сюда — лист как есть, в мм")
    a = ap.parse_args()
    try:
        svg, (x0, y0, x1, y1), лист = рендер(a.dxf, a.scale)
    except Exception as e:
        sys.exit(f"исходник не нарисовался: {type(e).__name__}: {e}"[:300])
    pathlib.Path(a.out).write_text(svg, encoding="utf-8")
    print(f"RENDER_BOX {x0:.3f} {y0:.3f} {x1:.3f} {y1:.3f}")
    if лист:
        if a.sheet_out:
            pathlib.Path(a.sheet_out).write_text(лист["svg"], encoding="utf-8")
        print("SHEET " + json.dumps({"layout": лист["layout"], "title": лист["title"]},
                                    ensure_ascii=False))


if __name__ == "__main__":
    main()
