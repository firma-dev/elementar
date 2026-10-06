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

# Оформление выбрасывается независимо от слоя: подписи попадаются и в конструктивных слоях.
DROP_TYPES = {
    "MTEXT", "TEXT", "ATTRIB", "ATTDEF",
    "DIMENSION", "LEADER", "MULTILEADER", "TOLERANCE",
}

# Точность спрямления дуг и сплайнов, мм.
FLATTEN_MM = 5.0
MAX_DEPTH = 12


class Losses:
    """Считает всё, что не доехало до выдачи. Молчаливых потерь быть не должно.

    Корзины разделены на две группы. Вставки блоков разворачиваются в свои
    объекты и сами до выдачи не доходят — их потери считаются отдельно, иначе
    баланс по объектам не сойдётся."""

    # Корзины объектов: каждый объект после разворота попадает ровно в одну.
    ENTITY = ("by_layer", "by_type", "unknown", "no_geometry", "geometry_error",
              "cropped", "outside", "by_fragment")
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
    sty = json.loads(sf.read_text(encoding="utf-8"))["classes"]
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
    for e in ents:
        layer = e.dxf.get("layer", "")
        stat_in[layer] += 1
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
    if args.fragment != "all" and len(frags) > 1:
        try:
            pick = frags[int(args.fragment)]
        except (ValueError, IndexError):
            sys.exit(f"нет чертежа №{args.fragment}: на листе их {len(frags)}")
        fx0, fy0, fx1, fy1 = pick["box"]
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

    floor_d, floor_note = [], ""
    if not args.no_floor:
        floor_d, floor_note = build_floor(cfg, prepared, args, xs, ys, x0, y0)

    groups = defaultdict(list)
    if floor_d:
        groups["floor"] = floor_d
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
             "window", "door", "wall-fill", "wall"]
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
    drawn = len(prepared)
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
    """Пятно застройки по телам стен. Единственное место, где геометрия
    вычисляется, а не берётся из чертежа."""
    try:
        from shapely.geometry import Polygon, box
        from shapely.ops import unary_union
    except ImportError:
        sys.exit("для заливки пола нужна shapely: .venv/bin/pip install shapely\n"
                 "либо запустите с --no-floor")

    foot_layers = cfg.get("footprint_layers")
    if not foot_layers:
        sys.exit("в layers.json нет footprint_layers — по чему считать пятно пола")
    foot_layers = set(foot_layers)

    wp = []
    for cls, e, loops in prepared:
        if e.dxf.get("layer", "") not in foot_layers or e.dxftype() != "HATCH":
            continue
        for pts, _ in loops:
            if len(pts) < 4:
                continue
            g = Polygon([(v.x, v.y) for v in pts])
            if not g.is_valid:
                g = g.buffer(0)
            if g.geom_type == "Polygon" and g.area > 1e4:
                wp.append(g)
    if not wp:
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

    u = unary_union([g.buffer(b, **J) for g in wp]) if b > 0 else unary_union(wp)
    parts = sorted(polys(u), key=lambda g: -g.area)
    if not parts:
        sys.exit(f"тела стен не сложились в область при --bridge {b:.0f}")

    # Заливаются все связные куски стен, а не только крупнейший: здание бывает
    # из нескольких корпусов, и раньше второй оставался белым. Совсем мелкие
    # куски — одинокая колонна, обрывок стены — пропускаются, иначе в пустоте
    # появляется серое пятно на ровном месте.
    порог = max(args.floor_min * 1e6, parts[0].area * 0.02)
    берём = [q for q in parts if q.area >= порог] or parts[:1]
    брошено = [q for q in parts if q not in берём]

    # Берётся только внешний контур. Дыры раздутого объединения — это комнаты,
    # а не дворы: отличить внутренний двор от большого зала по геометрии нечем.
    # Поэтому здание с атриумом или световым колодцем получит пол и там —
    # такой двор вырезается вручную или флагом --keep-holes, если дыры настоящие.
    куски = []
    for q in берём:
        f = (Polygon(q.exterior, list(q.interiors)) if args.keep_holes
             else Polygon(q.exterior))
        куски.append(f.buffer(-b, **J) if b > 0 else f)
    foot = unary_union([x for x in куски if not x.is_empty])
    if op > 0:
        foot = unary_union([p.buffer(-op, **J).buffer(op, **J) for p in polys(foot)]) \
            if polys(foot) else foot
    foot = unary_union(polys(foot)).intersection(box(min(xs), min(ys), max(xs), max(ys)))

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
    return d, note


if __name__ == "__main__":
    main()
