#!/usr/bin/env python3
"""Отчёт по DXF: слои, типы объектов, габариты. Ничего не рисует и не пишет.

По нему принимается решение «слой оставить или выбросить» и подбираются
координаты для --crop у dxf2svg.py.

  audit.py plan.dxf [--layer «Стены наружные»]
"""
from __future__ import annotations

import argparse
import json
import pathlib
from collections import Counter, defaultdict

import ezdxf

HERE = pathlib.Path(__file__).parent
MAX_DEPTH = 12


def flatten(container, depth=0):
    """Выгрузки Revit прячут геометрию внутри вставок: слои верхнего уровня пусты."""
    for e in container:
        if e.dxftype() == "INSERT" and depth < MAX_DEPTH:
            try:
                sub = list(e.virtual_entities())
            except Exception:
                sub = []
            if sub:
                yield from flatten(sub, depth + 1)
                continue
        yield e


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dxf")
    ap.add_argument("--layer", help="показать габарит и типы только этого слоя")
    args = ap.parse_args()

    doc = ezdxf.readfile(args.dxf)
    msp = doc.modelspace()
    raw = len(msp)
    ents = list(flatten(msp))

    print(f"версия {doc.dxfversion} {doc.acad_release}, единицы INSUNITS={doc.header.get('$INSUNITS')}")
    print(f"объектов: {raw} в модели, {len(ents)} после разворота вставок")
    print(f"листов: {', '.join(f'{n} ({len(doc.layouts.get(n))})' for n in doc.layouts.names())}")
    print()

    per = defaultdict(Counter)
    bb = {}
    for e in ents:
        l = e.dxf.get("layer", "")
        per[l][e.dxftype()] += 1
    from ezdxf.bbox import extents
    grouped = defaultdict(list)
    for e in ents:
        grouped[e.dxf.get("layer", "")].append(e)

    try:
        cfg = json.loads((HERE / "layers.json").read_text(encoding="utf-8"))
        decided = {**{k: "DROP" for k in cfg["drop"]}, **cfg["class"]}
    except Exception:
        decided = {}

    rows = []
    for l, es in grouped.items():
        try:
            b = extents(es, fast=True)
            box = (f"{b.extmin.x:.0f}..{b.extmax.x:.0f}", f"{b.extmin.y:.0f}..{b.extmax.y:.0f}",
                   f"{(b.extmax.x-b.extmin.x)/1000:.1f}×{(b.extmax.y-b.extmin.y)/1000:.1f}") \
                if b.has_data else ("", "", "")
        except Exception:
            box = ("", "", "")
        rows.append((len(es), l, decided.get(l, "— БЕЗ РЕШЕНИЯ —"), box, dict(per[l])))

    print(f'{"n":>6}  {"слой":<32} {"решение":<12} {"X, мм":<22} {"Y, мм":<22} размер, м')
    for n, l, dec, box, types in sorted(rows, key=lambda r: -r[0]):
        print(f"{n:>6}  {l:<32} {dec:<12} {box[0]:<22} {box[1]:<22} {box[2]}")
        if args.layer and l == args.layer:
            print(f"        типы: {types}")
    print()

    if args.layer:
        return
    print("габарит всего содержимого — годится как отправная точка для --crop:")
    try:
        b = extents(ents, fast=True)
        print(f"  --crop {b.extmin.x:.0f} {b.extmin.y:.0f} {b.extmax.x:.0f} {b.extmax.y:.0f}")
    except Exception:
        pass
    nod = [l for _, l, dec, _, _ in rows if dec == "— БЕЗ РЕШЕНИЯ —"]
    if nod:
        print("\nСЛОИ БЕЗ РЕШЕНИЯ — их надо вписать в layers.json, иначе они пропадут:")
        for l in nod:
            print(f"  {l}")


if __name__ == "__main__":
    main()
