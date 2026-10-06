#!/usr/bin/env python3
"""DXF → чистый SVG. Геометрия берётся из чертежа как есть, ничего не достраивается.

Оформление выбрасывается по layers.json и по типу объекта. Вид задаётся отдельным
style.json — геометрия от него не зависит.

  dxf2svg.py plan.dxf out/plan.svg [--crop X0 Y0 X1 Y1] [--no-floor]

Координаты для --crop берутся из audit.py.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys
from collections import Counter, defaultdict

import ezdxf
from ezdxf import path as ezpath

HERE = pathlib.Path(__file__).parent
sys.path.insert(0, str(HERE))
import цифры  # noqa: E402

# Оформление выбрасывается независимо от слоя: подписи попадаются и в конструктивных слоях.
DROP_TYPES = {
    "MTEXT", "TEXT", "ATTRIB", "ATTDEF",
    "DIMENSION", "LEADER", "MULTILEADER", "TOLERANCE",
}

# Точность спрямления дуг и сплайнов, мм.
FLATTEN_MM = 5.0
MAX_DEPTH = 12
# Линия стены ближе этого к телу стены (штриховке) — контур тела или слой
# отделки, а не самостоятельная стена; в контур пола не прошивается, мм.
РЯДОМ_С_ТЕЛОМ = 250.0
# Полоса, которую не считать полом, если она появилась только от линий стен:
# фасадные тяги, руст, отделка снаружи стены, мм. См. build_floor.
КАЙМА = 400.0
# Насколько марки осей и отметки (не помещений) могут расширить лист за
# габарит чертежа, мм. Марки помещений стоят внутри и лист не расширяют.
ЦИФРЫ_ЗА_ЛИСТОМ = 10000.0
# Насколько далеко за габаритом конструктива может стоять цифра каждого вида, мм.
# Номера и площади помещений стоят внутри. Отметки — внутри и у входов снаружи.
# Размерные цепочки — в нескольких метрах от фасада, марки осей — дальше всех.
# Легенда и таблицы листа лежат за планом дальше этих полей (на АР4.1 — в 11 м
# под планом) и так отсекаются: по положению, а не по содержанию — в легенде те
# же числа, что и на плане.
ЗАПАС_ЦИФР = {"помещения": 0.0, "площади": 0.0, "отметки": 3000.0, "прочие": 1000.0,
              "размеры": 8000.0, "оси": ЦИФРЫ_ЗА_ЛИСТОМ}
# Метка, перекрытая уже поставленной более важной больше чем на эту долю своей
# площади, не рисуется.
НАЛОЖЕНИЕ = 0.15
# Цифры ниже этой высоты (мм чертежа; 0,2 мм на листе 1:100) не переносятся.
МИН_ВЫСОТА_ЦИФР = 20.0


class Losses:
    """Считает всё, что не доехало до выдачи. Молчаливых потерь быть не должно.

    Корзины разделены на две группы. Вставки блоков разворачиваются в свои
    объекты и сами до выдачи не доходят — их потери считаются отдельно, иначе
    баланс по объектам не сойдётся."""

    # Корзины объектов: каждый объект после разворота попадает ровно в одну.
    ENTITY = ("by_layer", "by_type", "unknown", "no_geometry", "geometry_error",
              "cropped", "outside", "by_fragment", "hidden")
    # Корзины вставок: эти вставки развёрнуты не были и объектов не дали.
    INSERT = ("insert_error", "insert_empty", "insert_deep")

    TITLES = {
        "by_layer": "выброшено по слою (оформление)",
        "by_type": "выброшено по типу (подписи, размеры)",
        "unknown": "слой без решения",
        "no_geometry": "не дали геометрии",
        "geometry_error": "ошибка разбора геометрии",
        "cropped": "отсечено кадрированием",
        "outside": "вне габарита конструктива",
        "by_fragment": "другой чертёж на листе",
        "hidden": "цифры: скрыты наложением на более важную",
        "insert_error": "вставка блока: ошибка разворота",
        "insert_empty": "вставка блока: внутри пусто",
        "insert_deep": "вставка блока: глубже предела вложенности",
    }

    def __init__(self):
        for k in self.ENTITY + self.INSERT:
            setattr(self, k, Counter())

    def total(self, group):
        return sum(sum(getattr(self, k).values()) for k in group)

    def report(self, drawn):
        out = [f"БАЛАНС: нарисовано {drawn}"]
        for k in self.ENTITY:
            c = getattr(self, k)
            if not c:
                continue
            out.append(f"  {self.TITLES[k]}: {sum(c.values())}")
            for l, m in c.most_common():
                out.append(f"    {l:<34} {m}")
        ins = self.total(self.INSERT)
        if ins:
            out.append(f"  вставок блоков без геометрии: {ins}")
            for k in self.INSERT:
                for l, m in getattr(self, k).most_common():
                    out.append(f"    {self.TITLES[k]}: {l} — {m}")
        return out


def flatten(container, losses, depth=0):
    """Разворачивает вставки блоков. Геометрия Revit лежит внутри них."""
    for e in container:
        if e.dxftype() == "INSERT":
            # Атрибуты вставки — номер и площадь в блоке-марке помещения —
            # virtual_entities не отдаёт, они висят на самой вставке.
            yield from e.attribs
            if depth >= MAX_DEPTH:
                losses.insert_deep[e.dxf.get("layer", "")] += 1
                continue
            try:
                sub = list(e.virtual_entities())
            except Exception:
                losses.insert_error[e.dxf.get("layer", "")] += 1
                continue
            if sub:
                yield from flatten(sub, losses, depth + 1)
            else:
                # Пустая вставка: собственной геометрии у INSERT нет, рисовать нечего.
                losses.insert_empty[e.dxf.get("layer", "")] += 1
            continue
        yield e


def geometry(e, losses):
    """Объект DXF → список (точки, замкнут ли). Замкнутость берётся у самого пути,
    а не угадывается по типу: у эллипса-дуги её нет, и дорисовывать хорду нельзя."""
    layer = e.dxf.get("layer", "")
    t = e.dxftype()
    try:
        if t == "HATCH":
            # Границы штриховки замкнуты по определению — это контур тела.
            paths = list(ezpath.from_hatch(e))
            forced = True
        else:
            paths = [ezpath.make_path(e)]
            forced = False
    except Exception:
        losses.geometry_error[layer] += 1
        return []
    out = []
    for p in paths:
        for sp in p.sub_paths() or [p]:
            pts = list(sp.flattening(FLATTEN_MM))
            if len(pts) < 2:
                continue
            out.append((pts, True if forced else bool(sp.is_closed)))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dxf")
    ap.add_argument("out")
    ap.add_argument("--crop", nargs=4, type=float, metavar=("X0", "Y0", "X1", "Y1"))
    ap.add_argument("--margin", type=float, default=300.0, help="поле вокруг чертежа, мм")
    ap.add_argument("--scale", type=float, default=100.0,
                    help="знаменатель масштаба листа, 100 = 1:100")
    ap.add_argument("--report", action="store_true", help="сверка по слоям")
    ap.add_argument("--no-floor", action="store_true", help="не считать заливку пола")
    ap.add_argument("--bridge", type=float, default=1500.0,
                    help="мостик для замыкания проёмов при поиске пятна застройки, мм")
    ap.add_argument("--seam", type=float, default=60.0,
                    help="толщина шва по линиям окон, витражей и колонн (contour_layers), "
                         "которым замыкается контур пола, мм")
    ap.add_argument("--opening", type=float, default=700.0,
                    help="размыкание пятна застройки, мм: срезает тонкие языки")
    ap.add_argument("--fragment", default="0",
                    help="какой чертёж брать, если на листе их несколько: номер "
                         "из --fragments (0 — самый крупный) или all")
    ap.add_argument("--preview-unknown", metavar="КАТАЛОГ",
                    help="нарисовать каждый нерешённый слой отдельной картинкой "
                         "поверх бледного контура стен и напечатать JSON с путями")
    ap.add_argument("--allow-unknown", action="store_true",
                    help="не останавливаться на слоях без решения. Только для "
                         "разведки: нерешённый слой в SVG не попадёт")
    ap.add_argument("--source-svg", metavar="ФАЙЛ",
                    help="кроме результата записать исходник «как есть» в тех же "
                         "координатах и с тем же viewBox (для наложения в режиме «Проверка»)")
    ap.add_argument("--fragments", action="store_true",
                    help="только перечислить чертежи на листе, в JSON, и выйти")
    ap.add_argument("--gap", type=float, default=5000.0,
                    help="зазор, по которому лист делится на отдельные чертежи, мм")
    ap.add_argument("--numbers", default="помещения,площади,размеры,отметки,прочие",
                    help="какие цифры оставить на чертеже, через запятую: помещения, "
                         "площади, размеры, отметки, оси, прочие — или «нет»")
    ap.add_argument("--dim-lines", action="store_true",
                    help="кроме чисел размеров рисовать и сами размерные линии, тонко")
    ap.add_argument("--style", default="бадаевский",
                    help="имя файла в styles/ без расширения")
    ap.add_argument("--floor-min", type=float, default=50.0,
                    help="кусок стен меньше этой площади (м²) полом не заливается "
                         "и в предупреждение не идёт: это обрывок, а не корпус")
    ap.add_argument("--keep-holes", action="store_true",
                    help="сохранять дыры в пятне пола. Нужно чертежу с внутренним "
                         "двором или атриумом; на обычном плане вырежет комнаты")
    args = ap.parse_args()

    # Аргументы проверяются до разбора DXF: он занимает секунды, а падать в конце
    # из-за отрицательного числа — значит потерять их зря.
    if args.scale <= 0:
        sys.exit("--scale должен быть больше нуля")
    if args.margin < 0:
        sys.exit("--margin не может быть отрицательным")
    if args.bridge < 0 or args.opening < 0:
        sys.exit("--bridge и --opening не могут быть отрицательными")
    if args.crop:
        cx0, cy0, cx1, cy1 = args.crop
        if cx0 >= cx1 or cy0 >= cy1:
            sys.exit("--crop: сначала левый нижний угол, потом правый верхний "
                     f"(получено X {cx0}..{cx1}, Y {cy0}..{cy1})")

    cfg = json.loads((HERE / "layers.json").read_text(encoding="utf-8"))
    sf = HERE / "styles" / f"{args.style}.json"
    if not sf.exists():
        have = ", ".join(sorted(p.stem for p in (HERE / "styles").glob("*.json"))) or "ни одного"
        sys.exit(f"стиль «{args.style}» не найден. Есть: {have}")
    стиль = json.loads(sf.read_text(encoding="utf-8"))
    sty = стиль["classes"]
    # Цифры — своим классом; стиль без него получает тёмно-серый по умолчанию.
    sty.setdefault("numbers", {"fill": "#575756", "stroke": None, "width": 0})
    sty.setdefault("dims", {"fill": None, "stroke": "#9D9D9C", "width": 5})
    drop_layers = set(cfg["drop"])
    class_of = cfg["class"]
    fill_classes = set(cfg["fill_classes"])
    bbox_classes = set(cfg["bbox_classes"])

    # Класс без записи в style.json даёт группу без fill и stroke, а по умолчанию
    # в SVG заливка чёрная — такая группа закрасит чертёж. Ловим до разбора файла.
    missing = sorted({c for c in class_of.values() if c not in sty}
                     | {f"{c}-fill" for c in fill_classes if f"{c}-fill" not in sty})
    if missing:
        sys.exit("в style.json нет классов, а без них группа зальётся чёрным: "
                 + ", ".join(missing))

    виды = [] if args.numbers.strip().lower() in ("нет", "none", "") else \
        [v.strip() for v in args.numbers.split(",") if v.strip()]
    нет_вида = [v for v in виды if v not in цифры.ВИДЫ]
    if нет_вида:
        sys.exit(f"--numbers: нет вида {', '.join(нет_вида)}. Есть: "
                 + ", ".join(цифры.ВИДЫ) + " или «нет»")
    слои_вида = {v: set(cfg.get("numbers", {}).get(v, [])) for v in цифры.ВИДЫ}
    источники = set().union(*слои_вида.values())

    losses = Losses()
    try:
        doc = ezdxf.readfile(args.dxf)
    except (ezdxf.DXFError, UnicodeDecodeError, OSError) as e:
        sys.exit(f"файл не читается как DXF (повреждён, обрезан или не DXF): {e}")
    ents = list(flatten(doc.modelspace(), losses))
    if not ents:
        листы = [f"{n} ({len(doc.layouts.get(n))})" for n in doc.layouts.names()
                 if n != "Model" and len(doc.layouts.get(n))]
        sys.exit("в модели чертежа нет ни одного объекта, рисовать нечего."
                 + (f" Содержимое лежит только на листах: {', '.join(листы)} — "
                    "чертёжер читает пространство модели, листы (paper space) не берёт."
                    if листы else ""))

    strict_check = []
    kept, stat_in = [], Counter()
    unknown = Counter()
    кандидаты = []
    for e in ents:
        layer = e.dxf.get("layer", "")
        stat_in[layer] += 1
        # Цифры берутся раньше отсева по слою: марки помещений лежат на слое
        # оформления, а нужны из него только они.
        if виды and ((e.dxftype() in цифры.ТИПЫ and layer in источники)
                     or e.dxftype() == "DIMENSION"):
            кандидаты.append((e, layer))
            continue
        if layer in drop_layers:
            losses.by_layer[layer] += 1
            continue
        if e.dxftype() in DROP_TYPES:
            losses.by_type[layer] += 1
            continue
        cls = class_of.get(layer)
        if cls is None:
            unknown[layer] += 1
            losses.unknown[layer] += 1
            continue
        kept.append((cls, e))

    if unknown and args.preview_unknown:
        print(json.dumps(превью(ents, unknown, class_of, sty,
                                pathlib.Path(args.preview_unknown)),
                         ensure_ascii=False))
        return
    if unknown and not args.allow_unknown:
        print("UNKNOWN " + json.dumps(
            [{"layer": l, "objects": n} for l, n in unknown.most_common()],
            ensure_ascii=False))
        sys.exit("слои без решения — их геометрия потеряется:\n"
                 + "\n".join(f"  · {l} — {n} объектов"
                              for l, n in unknown.most_common())
                 + "\nвпишите их в layers.json (посмотреть, что в них: "
                   f"audit.py {args.dxf} --layer «имя») или снимите --allow-unknown")

    stat_out = Counter()
    xs, ys, prepared = [], [], []
    for cls, e in kept:
        layer = e.dxf.get("layer", "")
        loops = geometry(e, losses)
        if not loops:
            losses.no_geometry[layer] += 1
            continue
        if args.crop:
            cx0, cy0, cx1, cy1 = args.crop
            if not any(cx0 <= v.x <= cx1 and cy0 <= v.y <= cy1
                       for pts, _ in loops for v in pts):
                losses.cropped[layer] += 1
                continue
        # Габарит листа считается по конструктиву. Иначе его задаёт случайная
        # выноска или рамка таблицы, зацепившаяся за окно кадрирования.
        if cls in bbox_classes:
            for pts, _ in loops:
                for v in pts:
                    xs.append(v.x)
                    ys.append(v.y)
        prepared.append((cls, e, loops))
        stat_out[layer] += 1

    if not xs:
        sys.exit("после фильтрации не осталось конструктива (стен, окон, дверей, лестниц): "
                 "все слои чертежа выброшены как оформление или отсечены --crop. "
                 "Проверьте layers.json и bbox_classes")

    # На одном листе часто лежит несколько чертежей: план и узел, два этажа, план
    # и фрагмент. Оформление от них отсеять нельзя — это настоящая геометрия.
    # Поэтому конструктив разбивается на острова по зазору между ними.
    frags = fragments(prepared, bbox_classes, args.gap)
    if args.fragments:
        print(json.dumps([{"n": i, "w": round(f["w"]), "h": round(f["h"]),
                           "objects": f["n"]} for i, f in enumerate(frags)],
                         ensure_ascii=False))
        return
    fbox = None
    if args.fragment != "all" and len(frags) > 1:
        try:
            pick = frags[int(args.fragment)]
        except (ValueError, IndexError):
            sys.exit(f"нет чертежа №{args.fragment}: на листе их {len(frags)}")
        fx0, fy0, fx1, fy1 = fbox = pick["box"]
        keep = []
        for c, e, ls in prepared:
            if any(fx0 <= v.x <= fx1 and fy0 <= v.y <= fy1
                   for pts, _ in ls for v in pts):
                keep.append((c, e, ls))
            else:
                losses.by_fragment[e.dxf.get("layer", "")] += 1
                stat_out[e.dxf.get("layer", "")] -= 1
        prepared = keep
        xs = [v.x for c, e, ls in prepared if c in bbox_classes
              for pts, _ in ls for v in pts]
        ys = [v.y for c, e, ls in prepared if c in bbox_classes
              for pts, _ in ls for v in pts]

    m = args.margin
    minx, maxx, miny, maxy = min(xs) - m, max(xs) + m, min(ys) - m, max(ys) + m
    x0, y0 = minx, maxy  # начало координат и переворот оси Y

    # Лист считается по конструктиву, поэтому всё, что целиком лежит за его
    # пределами, — это оформление рядом с планом: рамки таблиц, выноски, обрезки
    # соседнего чертежа. Оно отбрасывается, иначе торчало бы за монтажной областью.
    inside = []
    for cls, e, loops in prepared:
        if any(minx <= v.x <= maxx and miny <= v.y <= maxy
               for pts, _ in loops for v in pts):
            inside.append((cls, e, loops))
        else:
            losses.outside[e.dxf.get("layer", "")] += 1
            stat_out[e.dxf.get("layer", "")] -= 1
    prepared = inside

    # Лист — по всему, что осталось. Оформление рядом с планом уже отсеяно выше,
    # так что раздуть лист может только графика, привязанная к самому зданию.
    ax = [v.x for _, _, ls in prepared for pts, _ in ls for v in pts]
    ay = [v.y for _, _, ls in prepared for pts, _ in ls for v in pts]
    build_w, build_h = maxx - minx, maxy - miny
    minx, maxx, miny, maxy = min(ax) - m, max(ax) + m, min(ay) - m, max(ay) + m

    # Цифры (номера и площади помещений и что ещё выбрано --numbers). Отбор — до
    # окончательного листа: марки осей и отметки стоят за контуром здания, и
    # если их заказали, лист расширяется под них, но не дальше ЦИФРЫ_ЗА_ЛИСТОМ.
    взяты, шрифт_прим, шрифт = [], "", None
    найдено = Counter()
    размерные_линии = []
    if кандидаты:
        шрифт, шрифт_прим = цифры.шрифт_стиля(стиль)
    for м in цифры.собрать(кандидаты):
        def в(корзина):
            for e in м.куски:
                getattr(losses, корзина)[м.layer] += 1
        # Подпись ниже МИН_ВЫСОТА_ЦИФР не видна и в исходнике: так выходят
        # размеры со стилем в метрах на чертеже в миллиметрах (0,25 мм высоты).
        текст = цифры.чистить(м.текст) if м.h >= МИН_ВЫСОТА_ЦИФР else None
        вид = цифры.вид(м, текст, слои_вида) if текст else None
        if вид:
            найдено[вид] += 1
        if not вид or вид not in виды or шрифт is None:
            в("by_type")
            continue
        if args.crop and not (args.crop[0] <= м.x <= args.crop[2]
                              and args.crop[1] <= м.y <= args.crop[3]):
            в("cropped")
            continue
        запас = ЗАПАС_ЦИФР[вид]
        if fbox and not (fbox[0] - запас <= м.x <= fbox[2] + запас
                         and fbox[1] - запас <= м.y <= fbox[3] + запас):
            в("by_fragment")
            continue
        try:
            _, bb, рамка = шрифт.контур(м, текст, 0.0, 0.0)
        except Exception:
            bb = None
        if bb is None:
            в("geometry_error")
            continue
        if not (minx - запас <= bb[0] and bb[2] <= maxx + запас
                and miny - запас <= bb[1] and bb[3] <= maxy + запас):
            в("outside")
            continue
        взяты.append((вид, м, текст, bb, рамка))

    # Наложения. Метки ставятся по важности (помещения, площади, отметки,
    # размеры, прочие, оси); метка, которую уже поставленная перекрывает больше
    # чем на НАЛОЖЕНИЕ своей площади, не рисуется и идёт в отчёт. Двигать метки
    # не стали: цифра на чужом месте врёт о том, к чему относится.
    взяты = снять_наложения(взяты, losses)

    if args.dim_lines:
        for вид, м, текст, bb, рамка in взяты:
            if м.размер:
                размерные_линии += линии_размера(м.куски[0])
    for вид, м, текст, bb, рамка in взяты:
        minx, miny = min(minx, bb[0] - m), min(miny, bb[1] - m)
        maxx, maxy = max(maxx, bb[2] + m), max(maxy, bb[3] + m)
    for pts, _ in размерные_линии:
        for v in pts:
            minx, miny = min(minx, v.x - m), min(miny, v.y - m)
            maxx, maxy = max(maxx, v.x + m), max(maxy, v.y + m)
    x0, y0 = minx, maxy

    def d_attr(loops):
        parts = []
        for pts, closed in loops:
            seg = [f"M {round(pts[0].x - x0)},{round(y0 - pts[0].y)}"]
            prev = None
            for v in pts[1:]:
                xy = (round(v.x - x0), round(y0 - v.y))
                if xy != prev:
                    seg.append(f"L {xy[0]},{xy[1]}")
                prev = xy
            if len(seg) < 2:
                continue
            if closed:
                seg.append("Z")
            parts.append(" ".join(seg))
        return " ".join(parts)

    floor_d, floor_note, пол = [], "", None
    if not args.no_floor:
        # GEOS на вырожденных обрезках (отрезок нулевой длины в шве) шлёт numpy
        # предупреждение «divide by zero» — результат при этом верный, проверяется
        # is_valid внутри. Предупреждение глушится, чтобы не пугать в консоли.
        import numpy as np
        with np.errstate(divide="ignore", invalid="ignore"):
            try:
                floor_d, floor_note, пол = build_floor(cfg, prepared, args, xs, ys, x0, y0)
            except Exception as e:  # noqa: BLE001
                # Пол — вычисленная подложка, а не геометрия чертежа: сбой GEOS на
                # нём не должен отнимать весь результат. Чертёж выходит без пола,
                # и отчёт говорит об этом прямо.
                floor_d, пол = [], None
                floor_note = (f"заливка пола: не построена — {type(e).__name__}: {e}"[:300]
                              + "\n  ВНИМАНИЕ: чертёж без заливки пола")

    # Цифры кривыми — в координатах уже окончательного листа.
    метки_d, метки, нарисовано_цифр = [], [], 0
    for вид, м, текст, bb, _ in взяты:
        try:
            d, _, _ = шрифт.контур(м, текст, x0, y0)
        except Exception:
            d = ""
        if not d:
            for e in м.куски:
                losses.geometry_error[м.layer] += 1
            continue
        метки_d.append(d)
        метки.append((вид, текст, (bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2))
        нарисовано_цифр += len(м.куски)

    groups = defaultdict(list)
    if floor_d:
        groups["floor"] = floor_d
    if метки_d:
        groups["numbers"] = метки_d
    if размерные_линии:
        groups["dims"] = [d_attr(размерные_линии)]
    for cls, e, loops in prepared:
        if cls in fill_classes and e.dxftype() == "HATCH":
            groups[f"{cls}-fill"].append(d_attr(loops))
            continue
        # Заливка кладётся только на замкнутые контуры. Открытый путь SVG
        # замыкает хордой при заливке — из дуги унитаза получается белая линза.
        if sty[cls]["fill"]:
            closed = [l for l in loops if l[1]]
            opened = [l for l in loops if not l[1]]
            if closed:
                groups[cls].append(d_attr(closed))
            if opened:
                groups[f"{cls}-open"].append(d_attr(opened))
        else:
            groups[cls].append(d_attr(loops))

    def attrs(name):
        base = name[:-5] if name.endswith("-open") else name
        st = sty[base]
        a = ['fill="none"' if name.endswith("-open") or not st["fill"]
             else f'fill="{st["fill"]}"']
        if st["stroke"]:
            a += [f'stroke="{st["stroke"]}"', f'stroke-width="{st["width"]}"',
                  'stroke-linecap="round"', 'stroke-linejoin="round"']
        else:
            a.append('stroke="none"')
        return " " + " ".join(a)

    order = ["floor", "slab-fill", "slab", "generic", "stair", "fixture", "fixture-open",
             "window", "door", "wall-fill", "wall", "dims", "numbers"]
    body = []
    for name in order + [k for k in groups if k not in order]:
        ds = [d for d in groups.get(name, []) if d]
        if not ds:
            continue
        body.append(f'  <g class="c-{name}"{attrs(name)}>')
        body += [f'    <path d="{d}"/>' for d in ds]
        body.append("  </g>")

    w, h = maxx - minx, maxy - miny
    # Физический размер листа. Без него Illustrator берёт артборд по умолчанию
    # и кладёт геометрию по сырым координатам чертежа, мимо листа.
    pw, ph = w / args.scale, h / args.scale
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" '
        f'width="{pw:.2f}mm" height="{ph:.2f}mm" '
        f'viewBox="0 0 {round(w)} {round(h)}" role="img" aria-label="План">\n'
        f'<g id="plan">\n' + "\n".join(body) + "\n</g>\n</svg>\n"
    )
    # Баланс: каждый объект после разворота вставок обязан попасть ровно в одну
    # корзину. Не сошлось — ошибка самой программы, и файл отдавать нельзя.
    drawn = len(prepared) + нарисовано_цифр
    balance = drawn + losses.total(Losses.ENTITY)
    if balance != len(ents):
        sys.exit(f"баланс объектов не сошёлся: на входе {len(ents)}, "
                 f"разложено {balance} (нарисовано {drawn}, "
                 f"в корзинах {losses.total(Losses.ENTITY)}). Это ошибка программы, "
                 "а не чертежа — файл не записан")

    for reason in verify(svg, minx, miny, maxx, maxy, drop_layers):
        sys.exit(f"выдача не прошла проверку: {reason}\nфайл не записан")

    out = pathlib.Path(args.out)
    if out.resolve() == pathlib.Path(args.dxf).resolve():
        sys.exit("выход совпадает с входом — это уничтожило бы исходный чертёж")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(svg, encoding="utf-8")
    if args.source_svg:
        # Наложение — вспомогательный режим: сбой в нём не должен отнимать результат.
        try:
            n_src = исходник(ents, x0, y0, w, h, pathlib.Path(args.source_svg))
            print(f"SOURCE {n_src}")
        except Exception as e:
            print(f"SOURCE_ERROR {type(e).__name__}: {e}"[:300])

    print(f"{out}  {len(svg)/1024:.0f} КБ")
    print("FRAGMENTS " + json.dumps(
        [{"n": i, "w": round(f["w"]), "h": round(f["h"]), "objects": f["n"]}
         for i, f in enumerate(frags)], ensure_ascii=False))
    if len(frags) > 1:
        which = "все" if args.fragment == "all" else f"№{args.fragment}"
        sizes = ", ".join("{:.0f}×{:.0f} м".format(f["w"] / 1000, f["h"] / 1000)
                          for f in frags)
        print(f"на листе чертежей: {len(frags)} ({sizes}), взят {which}. "
              f"Другой — флагом --fragment")
    print(f"конструктив {build_w/1000:.2f} × {build_h/1000:.2f} м, "
          f"весь чертёж {w/1000:.2f} × {h/1000:.2f} м, "
          f"лист {pw:.0f} × {ph:.0f} мм в масштабе 1:{args.scale:.0f}")
    if floor_note:
        print(floor_note)
    if кандидаты:
        скрыто = sum(losses.hidden.values())
        print(f"цифры: {len(метки)} меток"
              + (f", шрифт {шрифт.имя}" if шрифт else "")
              + "".join(f", {v} {sum(1 for m in метки if m[0] == v)}" for v in виды)
              + (f"; скрыто наложением {скрыто}" if скрыто else "")
              + "\n  найдено в чертеже: "
              + (", ".join(f"{v} {найдено[v]}" for v in цифры.ВИДЫ if найдено[v]) or "ничего")
              + (f"\n  ВНИМАНИЕ: {шрифт_прим}" if шрифт_прим else ""))
    # Сверка заливки по маркам помещений: марка стоит внутри помещения, значит
    # помещение без заливки видно по марке вне пола. Это и есть «залито / всего».
    if пол is not None and any(m[0] == "помещения" for m in метки):
        from shapely.geometry import Point
        from shapely.prepared import prep
        пп = prep(пол)
        комн = [m for m in метки if m[0] == "помещения"]
        мимо = [m for m in комн if not пп.contains(Point(m[2], m[3]))]
        print(f"ПОМЕЩЕНИЯ: марок {len(комн)}, на заливке {len(комн) - len(мимо)}")
        for _, т, x, y in мимо:
            print(f"  без заливки: {т} ({x:.0f}, {y:.0f})")
    for name in sorted(groups):
        print(f"  {name:<14} {len(groups[name]):>6} контуров")
    print("\n".join(losses.report(drawn)))
    print(f"  проверка баланса: {balance} = {len(ents)} объектов на входе")
    if unknown:
        print("UNKNOWN " + json.dumps(
            [{"layer": l, "objects": n} for l, n in unknown.most_common()],
            ensure_ascii=False))
        print("СЛОИ БЕЗ РЕШЕНИЯ (не попали в SVG):")
        for l, n in unknown.most_common():
            print(f"  {l:<34} {n}")
    if args.report:
        print("\nсверка по слоям (в модели → нарисовано):")
        for l in sorted(stat_in, key=lambda k: -stat_in[k]):
            print(f"  {l:<34} {stat_in[l]:>6} → {stat_out.get(l, 0):>6}")


ОФОРМЛЕНИЕ_РАМКОЙ = DROP_TYPES  # текст и размеры исходника показываются рамкой


def исходник(ents, x0, y0, w, h, путь):
    """Исходный чертёж без чистки: все слои, все типы, в координатах результата.

    Нужен режиму «Проверка»: исходник и результат рисуются друг на друге, и видно,
    что осталось, что убрано и не появилось ли лишнего. Преобразование то же, что в
    d_attr результата: x − x0, y0 − y, округление до целого мм. Текст и размеры
    рисовать как буквы нечем, они показаны рамкой по своему габариту."""
    from ezdxf.bbox import extents
    losses = Losses()
    линии, рамки = [], []

    def d_of(loops):
        parts = []
        for pts, closed in loops:
            seg, prev = [f"M {round(pts[0].x - x0)},{round(y0 - pts[0].y)}"], None
            for v in pts[1:]:
                xy = (round(v.x - x0), round(y0 - v.y))
                if xy != prev:
                    seg.append(f"L {xy[0]},{xy[1]}")
                prev = xy
            if len(seg) < 2:
                continue
            if closed:
                seg.append("Z")
            parts.append(" ".join(seg))
        return " ".join(parts)

    for e in ents:
        if e.dxftype() in ОФОРМЛЕНИЕ_РАМКОЙ:
            try:
                b = extents([e], fast=True)
            except Exception:
                continue
            if not b.has_data:
                continue
            pts = [(b.extmin.x, b.extmin.y), (b.extmax.x, b.extmin.y),
                   (b.extmax.x, b.extmax.y), (b.extmin.x, b.extmax.y)]
            from ezdxf.math import Vec3
            рамки.append(d_of([([Vec3(x, y) for x, y in pts], True)]))
            continue
        d = d_of(geometry(e, losses))
        if d:
            линии.append(d)
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {round(w)} {round(h)}" '
           f'role="img" aria-label="Исходник">\n'
           f'<g class="src" fill="none" stroke="#000" stroke-width="1">\n'
           + "\n".join(f'  <path d="{d}"/>' for d in линии)
           + '\n</g>\n<g class="src-txt" fill="none" stroke="#000" stroke-width="1">\n'
           + "\n".join(f'  <path d="{d}"/>' for d in рамки) + "\n</g>\n</svg>\n")
    путь.parent.mkdir(parents=True, exist_ok=True)
    путь.write_text(svg, encoding="utf-8")
    return len(линии) + len(рамки)


def контуры(ents, losses, layers):
    """Геометрия объектов перечисленных слоёв. Без классификации: слой нерешённый,
    класса у него ещё нет."""
    out = []
    for e in ents:
        if e.dxf.get("layer", "") in layers:
            out += geometry(e, losses)
    return out


def превью(ents, unknown, class_of, sty, каталог):
    """По картинке на каждый нерешённый слой: сам слой поверх бледных стен.

    Это то, что я делал руками через matplotlib, разбирая «Стены перегородки» и
    «Фундамент». Решение по слою принимается глазами, значит глазам надо показать."""
    каталог.mkdir(parents=True, exist_ok=True)
    losses = Losses()
    стены = {l for l, c in class_of.items() if c == "wall"}
    фон = контуры(ents, losses, стены)
    # Кадр — по основному чертежу, а не по всей геометрии: иначе одинокий элемент
    # в углу листа сжимает план в точку, и разглядеть слой невозможно.
    # каждый контур отдельным объектом: иначе разбиение видит один общий
    # габарит и возвращает один фрагмент на весь лист
    фрагменты = fragments([("wall", None, [l]) for l in фон], {"wall"}, 5000.0)
    fx0, fy0, fx1, fy1 = фрагменты[0]["box"] if фрагменты else (
        min(v.x for pts, _ in фон for v in pts), min(v.y for pts, _ in фон for v in pts),
        max(v.x for pts, _ in фон for v in pts), max(v.y for pts, _ in фон for v in pts))
    m = 500.0
    minx, maxx, miny, maxy = fx0 - m, fx1 + m, fy0 - m, fy1 + m
    w, h = maxx - minx, maxy - miny
    толщина = max(w, h) / 400  # линия видна на любом габарите
    шаг = max(w, h) / 1500     # картинка для глаза, миллиметры ей не нужны

    def d(loops):
        out = []
        for pts, closed in loops:
            if not any(minx <= v.x <= maxx and miny <= v.y <= maxy for v in pts):
                continue
            seg, prev = [], None
            for v in pts:
                xy = (round((v.x - minx) / шаг), round((maxy - v.y) / шаг))
                if xy != prev:
                    seg.append(f"{'M' if prev is None else 'L'} {xy[0]},{xy[1]}")
                prev = xy
            if len(seg) < 2:
                continue
            if closed:
                seg.append("Z")
            out.append(" ".join(seg))
        return " ".join(out)

    фон_d = d(фон)
    из = {}
    for слой in unknown:
        цель = контуры(ents, losses, {слой})
        цель_d = d(цель)
        if not цель_d:
            continue

        svg = (
            f'<svg xmlns="http://www.w3.org/2000/svg" '
            f'viewBox="0 0 {round(w / шаг)} {round(h / шаг)}" '
            f'role="img" aria-label="{слой}">\n'
            f'<g fill="none" stroke="{sty["wall"]["stroke"]}" '
            f'stroke-width="{толщина / шаг:.2f}" opacity="0.18">'
            f'<path d="{фон_d}"/></g>\n'
            f'<g fill="none" stroke="{sty["wall"]["stroke"]}" '
            f'stroke-width="{толщина * 2.5 / шаг:.2f}"><path d="{цель_d}"/></g>\n</svg>\n'
        )
        ф = каталог / (re.sub(r"[^\w-]+", "_", слой) + ".svg")
        ф.write_text(svg, encoding="utf-8")
        из[слой] = str(ф)
    return из


def снять_наложения(взяты, losses):
    """Оставляет метки без наложений, по важности вида. См. НАЛОЖЕНИЕ."""
    from shapely.geometry import Polygon
    порядок = {v: i for i, v in enumerate(цифры.ВИДЫ)}
    шаг = 3000.0
    сетка, out = defaultdict(list), []
    for вид, м, текст, bb, рамка in sorted(взяты, key=lambda t: порядок[t[0]]):
        p = Polygon(рамка)
        if not p.is_valid or p.area <= 0:
            p = p.buffer(0) if p.area > 0 else Polygon(
                [(bb[0], bb[1]), (bb[2], bb[1]), (bb[2], bb[3]), (bb[0], bb[3])])
        клетки = [(i, j) for i in range(int(bb[0] // шаг), int(bb[2] // шаг) + 1)
                  for j in range(int(bb[1] // шаг), int(bb[3] // шаг) + 1)]
        соседи = {id(q): q for к in клетки for q in сетка[к]}
        # Номера помещений не снимаются никогда: они главное, и если в исходнике
        # две марки налезают друг на друга, так и есть в чертеже.
        if вид != "помещения" and any(
                p.intersection(q).area > НАЛОЖЕНИЕ * min(p.area, q.area)
                for q in соседи.values()):
            for e in м.куски:
                losses.hidden[м.layer] += 1
            continue
        for к in клетки:
            сетка[к].append(p)
        out.append((вид, м, текст, bb, рамка))
    return out


def линии_размера(dim):
    """Размерная линия, выносные и засечки — без текста, для --dim-lines."""
    losses = Losses()
    out = []
    try:
        for v in dim.virtual_entities():
            if v.dxftype() in ("MTEXT", "TEXT"):
                continue
            out += geometry(v, losses)
    except Exception:
        return []
    return out


def verify(svg, minx, miny, maxx, maxy, drop_layers):
    """Проверяет выдачу перед записью. Возвращает список причин отказа.

    Ловит ровно то, что раньше приходилось проверять руками после каждого прогона."""
    bad = []
    for tag in ("<text", "<tspan", "font"):
        if tag in svg:
            bad.append(f"в SVG есть «{tag}» — оформление не должно доезжать до выдачи")
    m = re.search(r'viewBox="0 0 (\d+) (\d+)"', svg)
    if not m:
        bad.append("нет viewBox или он не в нуле")
    else:
        vw, vh = int(m.group(1)), int(m.group(2))
        xs, ys = [], []
        for a, b in re.findall(r"(-?\d+),(-?\d+)", svg):
            xs.append(int(a)); ys.append(int(b))
        if xs and (min(xs) < 0 or min(ys) < 0 or max(xs) > vw or max(ys) > vh):
            bad.append(f"геометрия вылезает за лист: X {min(xs)}..{max(xs)} "
                       f"при 0..{vw}, Y {min(ys)}..{max(ys)} при 0..{vh}")
    for g in re.findall(r"<g class=\"c-[^\"]+\"[^>]*>", svg):
        if 'fill="' not in g or 'stroke="' not in g:
            bad.append(f"у группы нет fill или stroke, Illustrator покажет пустой лист: {g[:70]}")
    return bad


def fragments(prepared, bbox_classes, gap):
    """Делит конструктив на отдельные чертежи по пустоте между ними.

    Считается по сетке с ячейкой gap: объекты попадают в ячейки, связные области
    ячеек — это отдельные чертежи. Сетка нужна, чтобы не сравнивать каждый
    объект с каждым: их пятнадцать тысяч."""
    cells = {}
    for cls, e, loops in prepared:
        if cls not in bbox_classes:
            continue
        vs = [v for pts, _ in loops for v in pts]
        bx0, bx1 = min(v.x for v in vs), max(v.x for v in vs)
        by0, by1 = min(v.y for v in vs), max(v.y for v in vs)
        for cx in range(int(bx0 // gap), int(bx1 // gap) + 1):
            for cy in range(int(by0 // gap), int(by1 // gap) + 1):
                b = cells.setdefault((cx, cy), [bx0, by0, bx1, by1, 0])
                b[0] = min(b[0], bx0); b[1] = min(b[1], by0)
                b[2] = max(b[2], bx1); b[3] = max(b[3], by1); b[4] += 1

    seen, out = set(), []
    for start in cells:
        if start in seen:
            continue
        stack, comp = [start], []
        seen.add(start)
        while stack:
            cx, cy = stack.pop()
            comp.append((cx, cy))
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    nb = (cx + dx, cy + dy)
                    if nb in cells and nb not in seen:
                        seen.add(nb)
                        stack.append(nb)
        bx0 = min(cells[c][0] for c in comp); by0 = min(cells[c][1] for c in comp)
        bx1 = max(cells[c][2] for c in comp); by1 = max(cells[c][3] for c in comp)
        out.append({"box": (bx0, by0, bx1, by1), "w": bx1 - bx0, "h": by1 - by0,
                    "n": sum(cells[c][4] for c in comp)})
    out.sort(key=lambda f: -(f["w"] * f["h"]))
    return out


def build_floor(cfg, prepared, args, xs, ys, x0, y0):
    """Заливка пола по телам стен. Единственное место, где геометрия вычисляется,
    а не берётся из чертежа: заливок помещений в выгрузках Revit нет (проверено на
    К2_1, К2_2, АР4.1 л.1–3 — ни одной сплошной штриховки помещения)."""
    try:
        from shapely.geometry import LineString, Polygon, box
        from shapely.ops import unary_union
    except ImportError:
        sys.exit("для заливки пола нужна shapely: .venv/bin/pip install shapely\n"
                 "либо запустите с --no-floor")

    foot_layers = cfg.get("footprint_layers")
    if not foot_layers:
        sys.exit("в layers.json нет footprint_layers — по чему считать пятно пола")
    foot_layers = set(foot_layers)
    шов_слои = set(cfg.get("contour_layers", []))

    тела, швы_окон, швы_стен = [], [], []
    for cls, e, loops in prepared:
        layer = e.dxf.get("layer", "")
        if e.dxftype() == "HATCH":
            if layer not in foot_layers:
                continue
            for pts, _ in loops:
                if len(pts) < 4:
                    continue
                g = Polygon([(v.x, v.y) for v in pts])
                if not g.is_valid:
                    g = g.buffer(0)
                if g.geom_type == "Polygon" and g.area > 1e4:
                    тела.append(g)
            continue
        # Контур наружной стены прерывается не только дверными проёмами. Окна,
        # витражи и простенки между пилонами — тоже граница помещения, но тела
        # стены там нет, и мостик зазор шире двух мостиков не перекрывает: внешний
        # контур уходил внутрь зала, и зал оставался белым (л.3: верхний правый
        # зал и комната справа — окна между пилонами, нижний правый зал — витраж).
        # Поэтому линии окон прошиваются в контур тонким швом — по самой линии окна.
        # Линии самих стен — отдельно: часть стен нарисована только контуром, без
        # штриховки (л.3, нижний правый зал: лёгкая стена под витражом).
        if layer in шов_слои:
            куда = швы_окон
        elif layer in foot_layers:
            куда = швы_стен
        else:
            continue
        for pts, closed in loops:
            xy = [(v.x, v.y) for v in pts]
            if closed and xy[0] != xy[-1]:
                xy.append(xy[0])
            if len(xy) >= 2:
                куда.append(LineString(xy))

    def шов(линии):
        """Линии → тонкие полосы. Каждая раздувается отдельно, одним вызовом над
        массивом: объединять тысячи линий до раздувания в разы дольше (узлы на
        каждом пересечении), а результат тот же."""
        if not линии or args.seam <= 0:
            return []
        import shapely
        return [unary_union(shapely.buffer(линии, args.seam, cap_style="flat",
                                           join_style="mitre"))]

    if not тела and not швы_окон:
        sys.exit(f"на слоях {sorted(foot_layers)} нет штриховок — пятно пола не по чему "
                 "строить. Проверьте footprint_layers или запустите с --no-floor")

    b, op = args.bridge, args.opening
    J = dict(join_style=2, mitre_limit=2.0)

    def polys(g):
        """Любой результат shapely → только полигоны. intersection и buffer умеют
        возвращать GeometryCollection и линии, у которых нет exterior."""
        if g.is_empty:
            return []
        if g.geom_type == "Polygon":
            return [g]
        return [p for p in getattr(g, "geoms", []) if p.geom_type == "Polygon"
                and not p.is_empty]

    кэш = {}

    def раздуть(g):
        """Мостик на одном куске. Запоминается: маска с линиями стен — это та же
        маска плюс швы, и раздувать тысячи штриховок дважды незачем."""
        k = id(g)
        if k not in кэш:
            кэш[k] = (g, g.buffer(b, **J))
        return кэш[k][1]

    def замкнуть(маска):
        """Маска стен → пятно пола. Возвращает (пятно, куски, взятые, брошенные)."""
        м = unary_union(маска)
        # Раздувается каждый кусок отдельно, а не объединение: у объединения
        # тысяч штриховок бывают вырожденные острые вершины, и острый угол
        # (mitre) на них выбрасывал наружу клин в несколько метров (К2_1, низ).
        u = unary_union([раздуть(g) for g in маска]) if b > 0 else м
        parts = sorted(polys(u), key=lambda g: -g.area)
        if not parts:
            sys.exit(f"тела стен не сложились в область при --bridge {b:.0f}")
        # Заливаются все связные куски стен, а не только крупнейший: здание бывает
        # из нескольких корпусов. Совсем мелкие куски — одинокая колонна, обрывок
        # стены — пропускаются, иначе в пустоте появляется серое пятно.
        порог = max(args.floor_min * 1e6, parts[0].area * 0.02)
        берём = [q for q in parts if q.area >= порог] or parts[:1]
        брошено = [q for q in parts if q not in берём]
        # Берётся только внешний контур. Дыры раздутого объединения — это комнаты,
        # а не дворы: отличить внутренний двор от большого зала по геометрии нечем.
        куски = []
        for q in берём:
            f = (Polygon(q.exterior, list(q.interiors)) if args.keep_holes
                 else Polygon(q.exterior))
            куски.append(f.buffer(-b, **J) if b > 0 else f)
        foot = unary_union([x for x in куски if not x.is_empty])
        # Острые углы (mitre) держат прямые наружные углы здания точно, но на
        # дугах и стыках дуг сжатие обратно залезает внутрь комнаты выемкой.
        # Комнаты добираются отдельно: дыры раздутой маски — это помещения,
        # замкнутые стенами, ужатые на мостик; раздутые обратно, они ложатся
        # по стенам изнутри. Но раздутая дыра переваливает и через тонкую стену
        # на улицу клином (ротонда л.3), поэтому от неё берётся только та часть,
        # что связана с самой дырой, не пересекая стен.
        if b > 0 and not args.keep_holes:
            import shapely
            комнаты = []
            for q in берём:
                for r in q.interiors:
                    д = Polygon(r)
                    к = д.buffer(b, **J)
                    try:
                        стены = shapely.clip_by_rect(м, *к.bounds)
                        if not стены.is_valid:
                            стены = shapely.make_valid(стены)
                        куски_к = polys(к.difference(стены))
                    except shapely.errors.GEOSException:
                        continue  # выемку не добрали — пол без неё, но не падаем
                    for кусок in куски_к:
                        if кусок.intersects(д):
                            комнаты.append(кусок)
            if комнаты:
                foot = unary_union([foot] + комнаты)
        return foot, parts, берём, брошено

    # Линии стен, целиком лежащие у тел стен, — это контуры самих штриховок и
    # наружный слой отделки (линия в 100–200 мм от тела). Первые ничего не
    # добавляют, вторые выводят пол за стену серой каймой (ротонда л.3). Нужны
    # только линии стен, у которых тела нет: лёгкая стена под витражом.
    if швы_стен and тела:
        from shapely.prepared import prep
        у_тел = prep(unary_union(тела).buffer(РЯДОМ_С_ТЕЛОМ, join_style=2))
        швы_стен = [л for л in швы_стен if not у_тел.contains(л)]
    окна = шов(швы_окон)
    foot, parts, берём, брошено = замкнуть(тела + окна)
    if швы_стен:
        # И оставшиеся линии стен дают лишнее: фасадные тяги и руст идут линиями
        # снаружи стены, и пол по ним выходит за стену каймой (К2_2). Поэтому из
        # пятна по линиям стен берётся только то, что шире каймы: целый зал за
        # лёгкой стеной проходит, полоса вдоль фасада — нет.
        с_линиями, *_ = замкнуть(тела + окна + шов(швы_стен))
        прибавка = с_линиями.difference(foot)
        if not прибавка.is_empty:
            прибавка = прибавка.buffer(-КАЙМА, **J).buffer(КАЙМА, **J)
            foot = unary_union([foot] + polys(прибавка))
    if op > 0:
        foot = unary_union([p.buffer(-op, **J).buffer(op, **J) for p in polys(foot)]) \
            if polys(foot) else foot
    foot = unary_union(polys(foot))
    if not foot.is_valid:
        foot = foot.buffer(0)
    foot = foot.intersection(box(min(xs), min(ys), max(xs), max(ys)))

    d = []
    for g in polys(foot):
        seg = []
        for r in [g.exterior] + list(g.interiors):
            seg.append("M " + " L ".join(
                f"{round(x - x0)},{round(y0 - y)}" for x, y in r.coords) + " Z")
        d.append(" ".join(seg))
    area = sum(g.area for g in polys(foot)) / 1e6
    note = (f"заливка пола: {area:.0f} м², мостик {b:.0f} мм, размыкание {op:.0f} мм, "
            f"кусков стен {len(parts)}, залито {len(берём)}")
    # Предупреждение только о том, что заметно: мелкие обрывки замалчивать не надо,
    # но и кричать о них незачем — пол по ним и не нужен.
    # Смотрим на крупнейший брошенный кусок, а не на их сумму: шесть обрывков
    # по 17 м² — это не корпус без пола, а мусор, и кричать о нём незачем.
    крупный = max((q.area / 1e6 for q in брошено), default=0.0)
    if крупный >= args.floor_min:
        note += (f"\n  ВНИМАНИЕ: кусок стен на {крупный:.0f} м² остался без пола. "
                 f"Если это отдельный корпус, поднимите --bridge")
    return d, note, foot


if __name__ == "__main__":
    main()
