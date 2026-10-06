#!/usr/bin/env python3
"""Демо-чертежи для показа: три DXF, собранные кодом (ezdxf), ничьи не настоящие.

  .venv/bin/python демо/сделать-демо.py                 DXF → демо/ (в git не попадают: *.dxf в .gitignore)
  .venv/bin/python демо/сделать-демо.py КАТАЛОГ         DXF → КАТАЛОГ
  .venv/bin/python демо/сделать-демо.py --эталоны       пересобрать демо/эталон-*.svg и эталон-audit-*.txt

Слои взяты из layers.json, поэтому приложение не задаёт вопросов «этот слой — что?»
и показ идёт без остановок. Каждый чертёж, кроме геометрии, несёт оформление
(текст, размеры, оси, выноски): конвертор должен его выбросить, и по отчёту это видно.

Эталон — это то, что конвертор выдаёт на этих чертежах сегодня. check.py сверяет
выдачу с эталоном побайтно: если разошлось, сменилась версия ezdxf/shapely или
поведение конвертора, и это надо заметить до показа, а не на нём.
"""
from __future__ import annotations

import pathlib
import subprocess
import sys

import ezdxf
from ezdxf import units
from ezdxf.math import Vec2
from ezdxf.render import mleader

HERE = pathlib.Path(__file__).parent
ROOT = HERE.parent

ИМЕНА = ("план-комнаты", "деталь-узла", "слои-штриховка")

СЛОИ = ("Стены наружные", "Стены внутренние", "Стены", "Перекрытие", "Окна", "Двери",
        "Лестницы", "Ограждение", "Сантехника", "Оборудование", "Линии", "Колонны",
        "Крыша штриховка",
        "Размеры", "Оси", "Аннотация", "Марки помещений", "Отметки")


def новый():
    d = ezdxf.new("R2010", setup=True)
    d.units = units.MM
    for л in СЛОИ:
        if л not in d.layers:
            d.layers.add(л)
    return d, d.modelspace()


def тело(m, слой, x0, y0, x1, y1):
    """Тело стены — штриховка со сплошной заливкой и контур поверх, как в выгрузках Revit."""
    h = m.add_hatch(color=7, dxfattribs={"layer": слой})
    h.paths.add_polyline_path([(x0, y0), (x1, y0), (x1, y1), (x0, y1)], is_closed=True)
    m.add_lwpolyline([(x0, y0), (x1, y0), (x1, y1), (x0, y1)], close=True,
                     dxfattribs={"layer": слой})


def прямоугольник(m, слой, x, y, w, h):
    m.add_lwpolyline([(x, y), (x + w, y), (x + w, y + h), (x, y + h)], close=True,
                     dxfattribs={"layer": слой})


def дверь_горизонтальная(m, x0, x1, y, вверх=True):
    """Полотно и дуга открывания. Дуга — открытый контур, как в настоящих чертежах."""
    w = x1 - x0
    s = 1 if вверх else -1
    m.add_line((x0, y), (x0, y + s * w), dxfattribs={"layer": "Двери"})
    if вверх:
        m.add_arc((x0, y), w, 0, 90, dxfattribs={"layer": "Двери"})
    else:
        m.add_arc((x0, y), w, 270, 360, dxfattribs={"layer": "Двери"})


def план_комнаты():
    """Две комнаты 6 × 4,5 м: жилая и санузел. Стены, проёмы, окно, двери, приборы."""
    d, m = новый()
    t = 200
    # наружные стены; в южной — окно (1200..2600) и входная дверь (4300..5200)
    for x0, x1 in ((0, 1200), (2600, 4300), (5200, 6000)):
        тело(m, "Стены наружные", x0, 0, x1, t)
    тело(m, "Стены наружные", 0, 4500 - t, 6000, 4500)
    тело(m, "Стены наружные", 0, t, t, 4500 - t)
    тело(m, "Стены наружные", 6000 - t, t, 6000, 4500 - t)
    # перегородка с дверью (1500..2400)
    тело(m, "Стены внутренние", 3700, t, 3900, 1500)
    тело(m, "Стены внутренние", 3700, 2400, 3900, 4500 - t)
    # окно: рама и стекло
    прямоугольник(m, "Окна", 1200, 0, 1400, t)
    m.add_line((1200, 100), (2600, 100), dxfattribs={"layer": "Окна"})
    # двери
    дверь_горизонтальная(m, 4300, 5200, t, вверх=True)
    m.add_line((3800, 1500), (3800 + 900, 1500), dxfattribs={"layer": "Двери"})
    m.add_arc((3800, 1500), 900, 0, 90, dxfattribs={"layer": "Двери"})
    # санузел: унитаз (бачок + чаша), раковина, ванна
    прямоугольник(m, "Сантехника", 4900, 3700, 380, 200)
    m.add_circle((5090, 3500), 200, dxfattribs={"layer": "Сантехника"})
    прямоугольник(m, "Сантехника", 4100, 3750, 550, 450)
    m.add_circle((4375, 3975), 120, dxfattribs={"layer": "Сантехника"})
    прямоугольник(m, "Сантехника", 4100, 400, 700, 1000)  # поддон
    m.add_arc((5400, 1000), 400, 90, 200, dxfattribs={"layer": "Сантехника"})  # открытая дуга
    # мебель в жилой комнате — слой «Оборудование»
    прямоугольник(m, "Оборудование", 400, 3300, 1800, 800)
    прямоугольник(m, "Оборудование", 2300, 3300, 1000, 800)

    # оформление: всё это конвертор обязан выбросить
    m.add_mtext("ЖИЛАЯ 16,2 м²", dxfattribs={"layer": "Марки помещений", "char_height": 150,
                                             "insert": (1500, 2000)})
    m.add_text("САНУЗЕЛ", dxfattribs={"layer": "Марки помещений", "height": 120,
                                      "insert": (4400, 2400)})
    m.add_linear_dim(base=(0, -600), p1=(0, 0), p2=(6000, 0),
                     dimstyle="EZDXF", dxfattribs={"layer": "Размеры"}).render()
    m.add_linear_dim(base=(-600, 0), p1=(0, 0), p2=(0, 4500), angle=90,
                     dimstyle="EZDXF", dxfattribs={"layer": "Размеры"}).render()
    for i, x in enumerate((0, 3800, 6000)):
        m.add_line((x, -900), (x, 5200), dxfattribs={"layer": "Оси", "linetype": "CONTINUOUS"})
        m.add_circle((x, 5400), 250, dxfattribs={"layer": "Оси"})
        m.add_text(str(i + 1), dxfattribs={"layer": "Оси", "height": 200,
                                           "insert": (x - 60, 5330)})
    return d


def деталь_узла():
    """Узел «стена и перекрытие» в разрезе, с размерами. Деталь, а не план: одна
    конструкция крупно, оформления больше, чем геометрии."""
    d, m = новый()
    # стена в разрезе 300 × 1800, плита перекрытия 200 × 1500 примыкает слева
    m.add_hatch(color=7, dxfattribs={"layer": "Стены"}).paths.add_polyline_path(
        [(0, 0), (300, 0), (300, 1800), (0, 1800)], is_closed=True)
    m.add_lwpolyline([(0, 0), (300, 0), (300, 1800), (0, 1800)], close=True,
                     dxfattribs={"layer": "Стены"})
    m.add_hatch(color=7, dxfattribs={"layer": "Перекрытие"}).paths.add_polyline_path(
        [(-1500, 1000), (0, 1000), (0, 1200), (-1500, 1200)], is_closed=True)
    m.add_lwpolyline([(-1500, 1000), (0, 1000), (0, 1200), (-1500, 1200)], close=True,
                     dxfattribs={"layer": "Перекрытие"})
    # утеплитель снаружи: лента из линий, крепёж
    прямоугольник(m, "Линии", 300, 0, 120, 1800)
    for y in (200, 600, 1000, 1400):
        m.add_circle((360, y), 18, dxfattribs={"layer": "Линии"})
        m.add_line((300, y), (420, y), dxfattribs={"layer": "Линии"})
    # арматура выпуском в стену
    for y in (1040, 1160):
        m.add_line((-1400, y), (200, y), dxfattribs={"layer": "Линии"})

    # оформление: размеры, выноска, подпись, отметка
    m.add_linear_dim(base=(700, 0), p1=(300, 0), p2=(300, 1800), angle=90,
                     dimstyle="EZDXF", dxfattribs={"layer": "Размеры"}).render()
    m.add_linear_dim(base=(0, -300), p1=(0, 0), p2=(300, 0),
                     dimstyle="EZDXF", dxfattribs={"layer": "Размеры"}).render()
    m.add_linear_dim(base=(-1700, 0), p1=(-1500, 1000), p2=(-1500, 1200), angle=90,
                     dimstyle="EZDXF", dxfattribs={"layer": "Размеры"}).render()
    ml = m.add_multileader_mtext("Standard", dxfattribs={"layer": "Аннотация"})
    ml.set_content("УТЕПЛИТЕЛЬ 120", char_height=80)
    ml.add_leader_line(mleader.ConnectionSide.right, [Vec2(360, 900)])
    ml.build(insert=Vec2(900, 1500))
    m.add_text("УЗЕЛ 1  М 1:10", dxfattribs={"layer": "Аннотация", "height": 100,
                                            "insert": (-800, -500)})
    m.add_text("ОТМ. +3,000", dxfattribs={"layer": "Отметки", "height": 80,
                                          "insert": (-1500, 1250)})
    # текст на конструктивном слое: выбрасывается по типу, а не по слою
    m.add_text("ПЛИТА", dxfattribs={"layer": "Перекрытие", "height": 80,
                                    "insert": (-1200, 1050)})
    return d


def слои_штриховка():
    """Плита перекрытия 14 × 9 м с проёмом под лестницу, колонны блоком и вставками,
    лестница, крыша со штриховкой узором. Рядом, в 20 м, второй чертёж на том же листе."""
    d, m = новый()
    # блок «колонна»: бетонное тело и контур — разворачивается из вставок
    b = d.blocks.new("КОЛОННА")
    h = b.add_hatch(color=7, dxfattribs={"layer": "Колонны"})
    h.paths.add_polyline_path([(-200, -200), (200, -200), (200, 200), (-200, 200)],
                              is_closed=True)
    b.add_lwpolyline([(-200, -200), (200, -200), (200, 200), (-200, 200)], close=True,
                     dxfattribs={"layer": "Колонны"})
    # плита: внешний контур и остров-проём (штриховка с дыркой)
    h = m.add_hatch(color=9, dxfattribs={"layer": "Перекрытие"})
    h.paths.add_polyline_path([(0, 0), (14000, 0), (14000, 9000), (0, 9000)], is_closed=True)
    h.paths.add_polyline_path([(9500, 2000), (12500, 2000), (12500, 5600), (9500, 5600)],
                              is_closed=True)
    m.add_lwpolyline([(0, 0), (14000, 0), (14000, 9000), (0, 9000)], close=True,
                     dxfattribs={"layer": "Перекрытие"})
    m.add_lwpolyline([(9500, 2000), (12500, 2000), (12500, 5600), (9500, 5600)], close=True,
                     dxfattribs={"layer": "Перекрытие"})
    # стены ядра с островом: шахта внутри стенового тела
    h = m.add_hatch(color=7, dxfattribs={"layer": "Стены"})
    h.paths.add_polyline_path([(5600, 3200), (8200, 3200), (8200, 6200), (5600, 6200)],
                              is_closed=True)
    h.paths.add_polyline_path([(5900, 3500), (7900, 3500), (7900, 5900), (5900, 5900)],
                              is_closed=True)
    # колонны сеткой 7 × 4,5 м — вставки блока
    for x in (0, 7000, 14000):
        for y in (0, 4500, 9000):
            m.add_blockref("КОЛОННА", (x, y), dxfattribs={"layer": "Колонны"})
    # лестница в проёме: марш ступенями и ограждение
    for i in range(12):
        y = 2000 + i * 300
        m.add_line((9500, y), (12500, y), dxfattribs={"layer": "Лестницы"})
    m.add_lwpolyline([(9500, 2000), (9500, 5600)], dxfattribs={"layer": "Ограждение"})
    m.add_lwpolyline([(12500, 2000), (12500, 5600)], dxfattribs={"layer": "Ограждение"})
    # крыша: штриховка узором (контур остаётся, узор — оформление)
    h = m.add_hatch(color=3, dxfattribs={"layer": "Крыша штриховка"})
    h.set_pattern_fill("ANSI31", scale=50)
    h.paths.add_polyline_path([(600, 600), (4800, 600), (4800, 2800), (600, 2800)],
                              is_closed=True)
    # оформление
    m.add_text("ПЛИТА НА ОТМ. +6,000", dxfattribs={"layer": "Аннотация", "height": 250,
                                                  "insert": (400, 9400)})
    m.add_linear_dim(base=(0, -900), p1=(0, 0), p2=(14000, 0),
                     dimstyle="EZDXF", dxfattribs={"layer": "Размеры"}).render()
    # второй чертёж на листе: фрагмент 3 × 2 м, в 20 м от первого
    тело(m, "Стены", 34000, 0, 37000, 200)
    тело(m, "Стены", 34000, 1800, 37000, 2000)
    тело(m, "Стены", 34000, 200, 34200, 1800)
    тело(m, "Стены", 36800, 200, 37000, 1800)
    m.add_text("ФРАГМЕНТ", dxfattribs={"layer": "Аннотация", "height": 150,
                                       "insert": (34200, 2300)})
    return d


СБОРЩИКИ = {"план-комнаты": план_комнаты, "деталь-узла": деталь_узла,
            "слои-штриховка": слои_штриховка}


def собрать(каталог: pathlib.Path) -> dict:
    """Пишет три DXF в каталог, возвращает имя → путь."""
    каталог.mkdir(parents=True, exist_ok=True)
    out = {}
    for имя in ИМЕНА:
        p = каталог / f"{имя}.dxf"
        СБОРЩИКИ[имя]().saveas(p)
        out[имя] = p
    return out


def главное(argv):
    эталоны = "--эталоны" in argv
    арг = [a for a in argv if not a.startswith("--")]
    куда = pathlib.Path(арг[0]) if арг else HERE
    пути = собрать(куда)
    for имя, p in пути.items():
        print(f"{p}  {p.stat().st_size / 1024:.0f} КБ")
    if эталоны:
        for имя, p in пути.items():
            svg = HERE / f"эталон-{имя}.svg"
            r = subprocess.run([sys.executable, str(ROOT / "dxf2svg.py"), str(p), str(svg)],
                               capture_output=True, text=True)
            if r.returncode:
                sys.exit(f"{имя}: конвертор упал\n{r.stderr or r.stdout}")
            a = subprocess.run([sys.executable, str(ROOT / "audit.py"), str(p)],
                               capture_output=True, text=True)
            if a.returncode:
                sys.exit(f"{имя}: audit упал\n{a.stderr}")
            (HERE / f"эталон-audit-{имя}.txt").write_text(a.stdout, encoding="utf-8")
            print(f"эталон: {svg.name}, эталон-audit-{имя}.txt")


if __name__ == "__main__":
    главное(sys.argv[1:])
