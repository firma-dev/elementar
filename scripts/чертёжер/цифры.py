"""Цифры на чертеже: номера и площади помещений, переведённые в кривые.

Текст в выдаче запрещён (verify: ни <text>, ни шрифтов), поэтому цифры рисуются
контурами глифов. Так SVG открывается где угодно — в Illustrator, InDesign,
браузере — без шрифта на машине и без лицензионного вопроса о встраивании: в файл
попадают только очертания нужных знаков, сам шрифт не попадает.

Метка помещения в выгрузке Revit приходит кусками: «3. 2.» + «К» + «.8» — три
MTEXT подряд на одной строке (буква — отдельным куском со сменой шрифта). Куски
склеиваются по строке и расстоянию, из текста остаются только слова с цифрами
и единица площади при них. Подписи без цифр («САНУЗЕЛ») — оформление.
"""
from __future__ import annotations

import math
import os
import pathlib
import re

ТИПЫ = {"TEXT", "MTEXT", "ATTRIB"}

# Если в стиле шрифта нет или файла нет на этой машине — первый найденный из этих.
# Не нашлось ни одного — цифры не рисуются, и прогон говорит об этом строкой.
ЗАПАСНЫЕ = (
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/Library/Fonts/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans.ttf",
    "C:/Windows/Fonts/arial.ttf",
)

ЕДИНИЦЫ = {"м²": "м²", "м2": "м²", "m²": "м²", "m2": "м²", "кв.м": "м²", "кв.м.": "м²"}


def строка(e) -> str:
    from ezdxf.lldxf.encoding import decode_dxf_unicode
    t = e.plain_text() if e.dxftype() == "MTEXT" else (e.dxf.get("text", "") or "")
    # dwg2dxf оставляет кириллицу экранированной: \U+041A вместо «К».
    return decode_dxf_unicode(t)


def высота(e) -> float:
    return float(e.dxf.get("char_height" if e.dxftype() == "MTEXT" else "height", 0) or 0)


def поворот(e) -> float:
    if e.dxftype() == "MTEXT":
        try:
            return float(e.get_rotation())
        except Exception:
            return float(e.dxf.get("rotation", 0) or 0)
    return float(e.dxf.get("rotation", 0) or 0)


def якорь(e):
    """(x, y, по горизонтали 0/0.5/1, по вертикали «top»/«middle»/«base»)."""
    if e.dxftype() == "MTEXT":
        p = e.dxf.insert
        ap = int(e.dxf.get("attachment_point", 1) or 1)
        гор = ((ap - 1) % 3) / 2
        верт = ("top", "middle", "base")[min((ap - 1) // 3, 2)]
        return p.x, p.y, гор, верт
    h = int(e.dxf.get("halign", 0) or 0)
    v = int(e.dxf.get("valign", 0) or 0)
    p = e.dxf.insert
    if (h or v) and e.dxf.hasattr("align_point"):
        p = e.dxf.align_point
    if h == 4:  # middle: середина и по горизонтали, и по вертикали
        return p.x, p.y, 0.5, "middle"
    гор = {1: 0.5, 2: 1.0}.get(h, 0.0)
    верт = {2: "middle", 3: "top"}.get(v, "base")
    return p.x, p.y, гор, верт


def чистить(s: str) -> str | None:
    """Оставляет слова с цифрами и единицу площади при них. «3. 2.К.8» → «3.2.К.8»."""
    s = re.sub(r"\s+", " ", s).strip()
    s = re.sub(r"(\d\.) (?=\d)", r"\1", s)
    out = []
    слова = s.split(" ")
    for i, w in enumerate(слова):
        if re.search(r"\d", w):
            out.append(w)
        elif w.lower() in ЕДИНИЦЫ and i and out and out[-1] == слова[i - 1]:
            out.append(ЕДИНИЦЫ[w.lower()])
    m = re.fullmatch(r"(.*\d)(м2|m2)", out[-1]) if out else None
    if m:
        out[-1] = m.group(1) + " м²"
    return " ".join(out) or None


class Метка:
    def __init__(self, e, layer):
        self.куски = [e]
        self.layer = layer
        self.текст = строка(e)
        self.h = высота(e)
        self.рот = поворот(e)
        self.x, self.y, self.гор, self.верт = якорь(e)


def собрать(ents_with_layers):
    """Склеивает куски одной метки: та же строка, тот же размер и поворот, следующий
    кусок начинается не дальше, чем мог кончиться предыдущий."""
    метки = []
    for e, layer in ents_with_layers:
        if e.dxftype() == "ATTRIB" and (int(e.dxf.get("flags", 0) or 0) & 1):
            continue  # невидимый атрибут
        метки.append(Метка(e, layer))
    # Склейка только по горизонтальным строкам: в повёрнутых метках Revit не режет.
    по_строке = {}
    for м in метки:
        if м.h > 0 and abs(м.рот) < 0.5:
            по_строке.setdefault((м.layer, round(м.h, 1)), []).append(м)
    убрать = set()
    for (_, h), ms in по_строке.items():
        ms.sort(key=lambda m: (round(m.y / (0.3 * h)), m.x))
        prev = None
        for м in ms:
            # Конец куска оценивается щедро, 0,75 высоты на знак: в GOST Common
            # «3. 2.» шириной 0,42 высоты на знак, буква со сменой шрифта — 0,71.
            if (prev is not None and abs(м.y - prev.y) < 0.3 * h
                    and м.гор == prev.гор == 0
                    and prev.x < м.x <= prev.x_конец + 0.3 * h):
                prev.текст += м.текст
                prev.куски += м.куски
                prev.x_конец = м.x + len(м.текст) * 0.75 * h
                убрать.add(id(м))
                continue
            м.x_конец = м.x + len(м.текст) * 0.75 * h
            prev = м
    return [м for м in метки if id(м) not in убрать]


class Шрифт:
    def __init__(self, путь: pathlib.Path):
        from fontTools.ttLib import TTFont
        self.путь = путь
        self.f = TTFont(str(путь), lazy=True, fontNumber=0)
        self.gs = self.f.getGlyphSet()
        self.cmap = self.f.getBestCmap()
        self.upm = self.f["head"].unitsPerEm
        os2 = self.f["OS/2"] if "OS/2" in self.f else None
        cap = getattr(os2, "sCapHeight", 0) if os2 is not None else 0
        self.cap = cap or 0.7 * self.upm
        self.имя = self.f["name"].getDebugName(4) or путь.stem

    def глиф(self, ch):
        g = self.cmap.get(ord(ch))
        return g if g in self.gs else None

    def ширина(self, s, k):
        w = 0.0
        for ch in s:
            g = self.глиф(ch) or self.глиф(" ")
            w += (self.gs[g].width if g else 0.5 * self.upm) * k
        return w

    def контур(self, м: Метка, текст: str, x0, y0):
        """Метка → (d для <path>, габарит в координатах чертежа). Масштаб — по
        высоте прописной: высота текста в CAD — это высота заглавных."""
        from fontTools.pens.basePen import BasePen
        k = м.h / self.cap
        w = self.ширина(текст, k)
        dx = -м.гор * w
        dy = {"top": -м.h, "middle": -м.h / 2, "base": 0.0}[м.верт]
        c, s = math.cos(math.radians(м.рот)), math.sin(math.radians(м.рот))
        xs, ys = [], []

        def t(px, py, ox):
            lx, ly = (px + ox) * k + dx, py * k + dy
            X, Y = м.x + lx * c - ly * s, м.y + lx * s + ly * c
            xs.append(X); ys.append(Y)
            return f"{round(X - x0)},{round(y0 - Y)}"

        out = []

        class Перо(BasePen):
            def __init__(p, ox):
                super().__init__(self.gs)
                p.ox = ox

            def _moveTo(p, pt):
                out.append("M " + t(*pt, p.ox))

            def _lineTo(p, pt):
                out.append("L " + t(*pt, p.ox))

            def _curveToOne(p, a, b, e):
                out.append("C " + " ".join(t(*q, p.ox) for q in (a, b, e)))

            def _qCurveToOne(p, a, e):
                out.append("Q " + " ".join(t(*q, p.ox) for q in (a, e)))

            def _closePath(p):
                out.append("Z")

        ox = 0.0
        for ch in текст:
            g = self.глиф(ch)
            if g:
                self.gs[g].draw(Перо(ox))
            ox += (self.gs[g].width if g else 0.5 * self.upm)
        if not xs:
            return "", None
        return " ".join(out), (min(xs), min(ys), max(xs), max(ys))


def шрифт_стиля(стиль: dict):
    """Шрифт цифр из стиля, иначе запасной. → (Шрифт | None, примечание)."""
    заказан = стиль.get("шрифт_цифр")
    пути = []
    if заказан:
        пути.append(pathlib.Path(os.path.expanduser(заказан)))
    пути += [pathlib.Path(p) for p in ЗАПАСНЫЕ]
    for п in пути:
        if п.is_file():
            try:
                ш = Шрифт(п)
            except Exception:
                continue
            прим = "" if (заказан and п == пути[0]) else (
                f"шрифт стиля не найден ({заказан}), взят запасной {п.name}" if заказан
                else "")
            return ш, прим
    return None, ("шрифт для цифр не найден ни в стиле, ни среди запасных — "
                  "цифры не нарисованы")
