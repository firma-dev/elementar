#!/usr/bin/env python3
"""Гейт чертёжера. Падение = чертежи собирать нельзя.

Три части. Синтетические чертежи порождаются кодом и проверяют алгоритмы —
работают у любого, кто склонировал репозиторий. Демо (демо/сделать-демо.py)
собираются заново и сверяются с демо/эталон-*.svg побайтно. Настоящие чертежи
лежат рядом, в репозиторий не попадают (NDA), их пути берутся из
эталоны-пути.json рядом со скриптом или из файла, на который указывает переменная
окружения CHERTEZHER_ETALONY, а ожидаемые числа — из эталоны.json.

  .venv/bin/python check.py
  CHERTEZHER_ETALONY=пути.json .venv/bin/python check.py

Каждая синтетическая проверка закрывает найденную ошибку, а не проверяет
абстрактную правильность. Комментарий у каждой говорит, что именно ломалось.
"""
from __future__ import annotations

import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).parent
DXF2SVG = HERE / "dxf2svg.py"


def прогон(dxf, out, *flags):
    r = subprocess.run([sys.executable, str(DXF2SVG), str(dxf), str(out), *flags],
                       capture_output=True, text=True, errors="replace", timeout=600)
    return r.returncode, r.stdout, r.stderr


def группа(svg, имя):
    m = re.search(rf'<g class="c-{имя}"[^>]*>(.*?)</g>', svg, re.S)
    return m.group(1) if m else ""


# ─────────────────────────── синтетические чертежи ───────────────────────────

def чертёж(td, имя):
    import ezdxf
    d = ezdxf.new(setup=False)
    for l in ("Стены наружные", "Сантехника", "Линии"):
        d.layers.add(l)
    return d, td / f"{имя}.dxf"


def стена(msp, x0, y0, x1, y1, t=200):
    """Тело стены штриховкой — так они и приходят из Revit."""
    h = msp.add_hatch(color=7, dxfattribs={"layer": "Стены наружные"})
    h.paths.add_polyline_path([(x0, y0), (x1, y0), (x1, y1), (x0, y1)], is_closed=True)
    msp.add_lwpolyline([(x0, y0), (x1, y0), (x1, y1), (x0, y1)],
                       close=True, dxfattribs={"layer": "Стены наружные"})


def коробка(msp, x, y, w, h, t=200, проём=0):
    """Проём в нижней стене нужен, чтобы проверять мостик: без него тела стен
    смыкаются сами и заливка получается при любом --bridge."""
    if проём:
        c = x + w / 2
        стена(msp, x, y, c - проём / 2, y + t)
        стена(msp, c + проём / 2, y, x + w, y + t)
    else:
        стена(msp, x, y, x + w, y + t)
    стена(msp, x, y + h - t, x + w, y + h)
    стена(msp, x, y, x + t, y + h)
    стена(msp, x + w - t, y, x + w, y + h)


def баланс(o, где):
    """Баланс объектов виден снаружи, в отчёте. Пропала строка или разошлись
    числа — значит сверку сняли или она перестала сходиться."""
    m = re.search(r"проверка баланса: (\d+) = (\d+) объектов", o)
    if not m:
        return [f"{где}: в отчёте нет строки о балансе объектов"]
    if m.group(1) != m.group(2):
        return [f"{где}: баланс не сошёлся — {m.group(1)} против {m.group(2)}"]
    return []


def вызовы_на_месте():
    """Снятый вызов проверки ниоткуда не виден: на верном чертеже она молчит,
    и её отсутствие тоже. Поэтому смотрим исходник — как тест стилей финансера
    смотрит в css. Проверка того, что проверки подключены."""
    src = (HERE / "dxf2svg.py").read_text(encoding="utf-8")
    из = []
    for кусок, зачем in (
        ("for reason in verify(", "проверка выдачи перед записью"),
        ("if balance != len(ents):", "сверка баланса объектов"),
        ("if unknown and not args.allow_unknown:", "остановка на слоях без решения"),
        ("if unknown and args.preview_unknown:", "картинки по нерешённым слоям"),
    ):
        if кусок not in src:
            из.append(f"из dxf2svg.py пропал вызов: {зачем} ({кусок})")
    return из


def проверка_проверки():
    """verify() — гейт внутри гейта. Перестанет ловить она — молча развалится
    всё остальное, поэтому её проверяем напрямую."""
    sys.path.insert(0, str(HERE))
    from dxf2svg import verify
    из = []
    хор = ('<svg viewBox="0 0 100 100">'
           '<g class="c-wall" fill="none" stroke="#000" stroke-width="2">'
           '<path d="M 10,10 L 90,90"/></g></svg>')
    плохо = verify(хор, 0, 0, 100, 100, set())
    if плохо:
        из.append(f"verify забраковала верную выдачу: {плохо}")
    for имя, битый in (
        ("текст", хор.replace("</svg>", "<text>x</text></svg>")),
        ("вылет за лист", хор.replace("L 90,90", "L 900,900")),
        ("группа без stroke", хор.replace(' stroke="#000"', "")),
        ("группа без fill", хор.replace(' fill="none"', "")),
        ("нет viewBox", хор.replace('viewBox="0 0 100 100"', "")),
    ):
        if not verify(битый, 0, 0, 100, 100, set()):
            из.append(f"verify пропустила «{имя}» — проверка выдачи не работает")
    return из


def синтетика(td):
    import ezdxf
    из = []

    # 1. Эллипс-дуга не должна замыкаться хордой.
    # Ломалось: тип ELLIPSE считался замкнутым безусловно, и все 15 дуг чертежа
    # получали Z — 2035 мм линий, которых в чертеже нет.
    d, f = чертёж(td, "эллипс")
    m = d.modelspace()
    коробка(m, 0, 0, 10000, 8000)
    m.add_ellipse((5000, 4000), major_axis=(1000, 0), ratio=0.5,
                  start_param=0, end_param=1.6, dxfattribs={"layer": "Линии"})
    d.saveas(f)
    c, o, e = прогон(f, td / "эллипс.svg")
    из += баланс(o, "эллипс-дуга")
    if c:
        из.append(f"эллипс-дуга: прогон упал — {e.strip()[:120]}")
    else:
        g = группа((td / "эллипс.svg").read_text(), "generic")
        if " Z" in g:
            из.append("эллипс-дуга замкнулась хордой: в c-generic есть Z, "
                      "а дорисовывать геометрию нельзя")

    # 2. Штриховка с островом даёт дырку, а не залитое пятно.
    d, f = чертёж(td, "остров")
    m = d.modelspace()
    коробка(m, 0, 0, 10000, 8000)
    h = m.add_hatch(color=7, dxfattribs={"layer": "Стены наружные"})
    h.paths.add_polyline_path([(3000, 3000), (7000, 3000), (7000, 5000), (3000, 5000)],
                              is_closed=True)
    h.paths.add_polyline_path([(4000, 3500), (6000, 3500), (6000, 4500), (4000, 4500)],
                              is_closed=True)
    d.saveas(f)
    c, o, e = прогон(f, td / "остров.svg")
    из += баланс(o, "остров в штриховке")
    if c:
        из.append(f"остров в штриховке: прогон упал — {e.strip()[:120]}")
    else:
        g = группа((td / "остров.svg").read_text(), "wall-fill")
        если = [p for p in re.findall(r'd="([^"]+)"', g) if p.count("M ") >= 2]
        if not если:
            из.append("остров в штриховке потерян: ни одного пути с двумя контурами "
                      "в c-wall-fill, дырка зальётся")

    # 3. Незамкнутый контур не заливается.
    # Ломалось: у сантехники была объявлена белая заливка, а из 1994 путей
    # замкнуто 16 — SVG замыкал остальные хордой, и дуги становились линзами.
    d, f = чертёж(td, "открытый")
    m = d.modelspace()
    коробка(m, 0, 0, 10000, 8000)
    m.add_arc((5000, 4000), radius=800, start_angle=0, end_angle=140,
              dxfattribs={"layer": "Сантехника"})
    d.saveas(f)
    c, o, e = прогон(f, td / "открытый.svg")
    if c:
        из.append(f"незамкнутый контур: прогон упал — {e.strip()[:120]}")
    else:
        svg = (td / "открытый.svg").read_text()
        if 'class="c-fixture"' in svg:
            из.append("незамкнутая дуга попала в заливаемую группу c-fixture — "
                      "станет белой линзой")
        g = re.search(r'<g class="c-fixture-open"([^>]*)>', svg)
        if not g:
            из.append("незамкнутая дуга не попала в c-fixture-open — потеряна")
        elif 'fill="none"' not in g.group(1):
            из.append("c-fixture-open заливается, хотя контуры в ней открыты")

    # 4. Два чертежа на листе разделяются, один — нет.
    d, f = чертёж(td, "один")
    коробка(d.modelspace(), 0, 0, 10000, 8000)
    d.saveas(f)
    c, o, e = прогон(f, td / "один.svg", "--fragments")
    if c or len(json.loads(o)) != 1:
        из.append(f"один чертёж на листе разделён на части: {o.strip()[:120]}")

    d, f = чертёж(td, "два")
    m = d.modelspace()
    коробка(m, 0, 0, 10000, 8000)
    коробка(m, 40000, 0, 6000, 5000)
    d.saveas(f)
    c, o, e = прогон(f, td / "два.svg", "--fragments")
    if c or len(json.loads(o)) != 2:
        из.append(f"два чертежа на листе не разделены: {o.strip()[:120]}")

    # 5. Слой без решения останавливает прогон и не пишет файл.
    # Ломалось: «Стены перегородки» — 911 объектов — молча не попали в SVG.
    d, f = чертёж(td, "неизвестный")
    d.layers.add("Выдуманный слой")
    m = d.modelspace()
    коробка(m, 0, 0, 10000, 8000)
    m.add_line((1000, 1000), (9000, 7000), dxfattribs={"layer": "Выдуманный слой"})
    d.saveas(f)
    цель = td / "неизвестный.svg"
    c, o, e = прогон(f, цель)
    if c == 0:
        из.append("слой без решения не остановил прогон")
    if цель.exists():
        из.append("слой без решения: файл всё равно записан")
    if "Выдуманный слой" not in (e + o):
        из.append("слой без решения: в сообщении не назван сам слой")

    # Картинка по нерешённому слою: по ней человек и принимает решение.
    прев = td / "прев"
    c, o, e = прогон(f, td / "неизвестный2.svg", "--preview-unknown", str(прев))
    if c:
        из.append(f"картинка нерешённого слоя: прогон упал — {e.strip()[:120]}")
    else:
        try:
            карта = json.loads(o.strip().splitlines()[-1])
        except Exception:
            карта = {}
        if "Выдуманный слой" not in карта:
            из.append("картинка нерешённого слоя не построена")
        else:
            svg = pathlib.Path(карта["Выдуманный слой"]).read_text(encoding="utf-8")
            if svg.count("<path") < 2:
                из.append("на картинке слоя нет двух слоёв: сам слой и бледный фон стен")
            if "viewBox" not in svg:
                из.append("у картинки слоя нет viewBox — не отмасштабируется в карточке")

    # 6. Заливка пола на одной комнате совпадает с её площадью.
    # Проём 900 мм — то самое место, ради которого существует мостик: тела стен
    # в выгрузке Revit в проёмах разорваны.
    d, f = чертёж(td, "пол")
    коробка(d.modelspace(), 0, 0, 10000, 8000, проём=900)
    d.saveas(f)
    c, o, e = прогон(f, td / "пол.svg")
    из += баланс(o, "заливка пола")
    if c:
        из.append(f"заливка пола: прогон упал — {e.strip()[:120]}")
    else:
        m = re.search(r"заливка пола: (\d+) м²", o)
        if not m:
            из.append("заливка пола не построена на простой комнате")
        else:
            было, надо = int(m.group(1)), 10.0 * 8.0
            if abs(было - надо) / надо > 0.05:
                из.append(f"заливка пола {было} м² против {надо:.0f} м² по габариту "
                          f"комнаты — расхождение больше 5 %")

    из += синтетика_заливки_и_цифр(td)
    return из


def зал(msp, стеклом=True):
    """Зал 12×10 м: три стены телами-штриховками, четвёртая (нижняя) — как на л.3.
    стеклом=True: два пилона по краям и окно на 8 м между ними (слой «Окна»).
    стеклом=False: стена нарисована только контуром, без штриховки."""
    стена(msp, 0, 9700, 12000, 10000, t=300)
    стена(msp, 0, 0, 300, 10000, t=300)
    стена(msp, 11700, 0, 12000, 10000, t=300)
    if стеклом:
        стена(msp, 300, 0, 2000, 300)
        стена(msp, 10000, 0, 11700, 300)
        for y in (0, 150, 300):
            msp.add_line((2000, y), (10000, y), dxfattribs={"layer": "Окна"})
    else:
        msp.add_lwpolyline([(300, 0), (11700, 0), (11700, 300), (300, 300)], close=True,
                           dxfattribs={"layer": "Стены наружные"})


def синтетика_заливки_и_цифр(td):
    import ezdxf
    из = []

    def пол_и_марки(o):
        m = re.search(r"заливка пола: (\d+) м²", o)
        k = re.search(r"ПОМЕЩЕНИЯ: марок (\d+), на заливке (\d+)", o)
        return (int(m.group(1)) if m else None,
                (int(k.group(1)), int(k.group(2))) if k else None)

    # 7. Зал со стеклянной стеной заливается целиком.
    # Ломалось (замечание Виктора 06.10, л.3): у трёх залов наружная стена —
    # окна между пилонами и витраж, зазор 3–8 м; мостик 1500 мм его не
    # перекрывал, внешний контур пола уходил внутрь, и зал оставался белым.
    # Заодно цифры: марка помещения кусками, как в Revit, и площадь в атрибуте
    # блока — обе должны доехать кривыми, подпись без цифр — нет.
    for стеклом, имя in ((True, "витраж"), (False, "контур")):
        d, f = чертёж(td, имя)
        for l in ("Окна", "Марки помещений"):
            d.layers.add(l)
        m = d.modelspace()
        зал(m, стеклом)
        for x, t in ((5000, "1. 2."), (5530, "\\U+041A"), (5710, ".5")):
            m.add_mtext(t, dxfattribs={"layer": "Марки помещений", "char_height": 250,
                                       "insert": (x, 6000), "attachment_point": 1})
        m.add_text("ЗАЛ", dxfattribs={"layer": "Марки помещений", "height": 250,
                                      "insert": (5000, 7000)})
        b = d.blocks.new("МАРКА")
        b.add_attdef("ПЛОЩАДЬ", (0, 0), dxfattribs={"height": 200, "layer": "Марки помещений"})
        v = m.add_blockref("МАРКА", (5000, 4500), dxfattribs={"layer": "Марки помещений"})
        v.add_auto_attribs({"ПЛОЩАДЬ": "116,4 м2"})
        d.saveas(f)
        c, o, e = прогон(f, td / f"{имя}.svg")
        из += баланс(o, f"зал ({имя})")
        if c:
            из.append(f"зал ({имя}): прогон упал — {e.strip()[:160]}")
            continue
        пл, марки = пол_и_марки(o)
        if пл is None or abs(пл - 120) / 120 > 0.05:
            из.append(f"зал ({имя}): заливка {пл} м² вместо 120 — зал остался белым "
                      "(стена окнами/контуром не замкнула пол)")
        if марки != (2, 2):
            из.append(f"зал ({имя}): марки помещений {марки}, ждём (2 марки, 2 на заливке)")
        svg = (td / f"{имя}.svg").read_text(encoding="utf-8")
        g = группа(svg, "numbers")
        if g.count("<path") != 2:
            из.append(f"зал ({имя}): в c-numbers {g.count('<path')} меток вместо 2 "
                      "(номер кусками и площадь из атрибута блока)")
        if "<text" in svg:
            из.append(f"зал ({имя}): цифры доехали текстом, а не кривыми")

    # 8. --numbers нет: цифр нет, файл тот же, что раньше.
    c, o, e = прогон(td / "витраж.dxf", td / "без-цифр.svg", "--numbers", "нет")
    из += баланс(o, "зал без цифр")
    if c:
        из.append(f"зал без цифр: прогон упал — {e.strip()[:160]}")
    elif 'class="c-numbers"' in (td / "без-цифр.svg").read_text(encoding="utf-8"):
        из.append("--numbers нет: цифры всё равно нарисованы")

    # 9. Площадь, размеры, отметки — по видам; легенда за планом и марка — нет.
    # Слово Виктора 06.10: «чтобы переносились цифры площадей и длины высоты».
    # Размер с override-текстом даёт свой текст, без него — измерение; отметка
    # ±0,000 и высота h=1200 — отметки; «EI60» и легенда в 15 м под планом — нет.
    d, f = чертёж(td, "виды")
    for l in ("Окна", "Марки помещений", "Размеры", "Отметки", "Аннотация"):
        d.layers.add(l)
    d.dimstyles.new("М", dxfattribs={"dimtxt": 250, "dimasz": 100, "dimdec": 0})
    m = d.modelspace()
    зал(m)
    m.add_mtext("24,5 м²", dxfattribs={"layer": "Марки помещений", "char_height": 250,
                                       "insert": (3000, 5000)})
    m.add_linear_dim(base=(0, -1500), p1=(0, 0), p2=(12000, 0), dimstyle="М",
                     dxfattribs={"layer": "Размеры"}).render()
    m.add_linear_dim(base=(-1500, 0), p1=(0, 0), p2=(0, 10000), angle=90, dimstyle="М",
                     text="<> мм", dxfattribs={"layer": "Размеры"}).render()
    m.add_text("%%p0,000", dxfattribs={"layer": "Отметки", "height": 250,
                                       "insert": (6000, 3000)})
    m.add_text("h=1200", dxfattribs={"layer": "Аннотация", "height": 200,
                                     "insert": (6000, 8000)})
    m.add_text("EI60", dxfattribs={"layer": "Аннотация", "height": 200,
                                   "insert": (8000, 8000)})
    m.add_text("77,77 м²", dxfattribs={"layer": "Аннотация", "height": 250,
                                       "insert": (2000, -15000)})
    d.saveas(f)
    c, o, e = прогон(f, td / "виды.svg")
    из += баланс(o, "виды цифр")
    if c:
        из.append(f"виды цифр: прогон упал — {e.strip()[:160]}")
    else:
        m_ = re.search(r"цифры: (\d+) меток[^\n]*", o)
        строка = m_.group(0) if m_ else ""
        ждём = {"площади": 1, "размеры": 2, "отметки": 2}
        for вид, n in ждём.items():
            if not re.search(rf"{вид} {n}\b", строка):
                из.append(f"виды цифр: ждём {вид} {n}, в отчёте «{строка[:160]}»")
        if not m_ or int(m_.group(1)) != 5:
            из.append(f"виды цифр: ждём 5 меток (площадь, 2 размера, 2 отметки), "
                      f"в отчёте «{строка[:160]}» — марка или легенда доехали, "
                      "или число потерялось")
        svg = (td / "виды.svg").read_text(encoding="utf-8")
        if группа(svg, "numbers").count("<path") != 5:
            из.append("виды цифр: в c-numbers не 5 меток")
        if 'class="c-dims"' in svg:
            из.append("виды цифр: размерные линии нарисованы без --dim-lines")
        c, o, e = прогон(f, td / "виды-линии.svg", "--dim-lines")
        if c or 'class="c-dims"' not in (td / "виды-линии.svg").read_text(encoding="utf-8"):
            из.append(f"--dim-lines: размерные линии не нарисованы {e.strip()[:120]}")
        c, o, e = прогон(f, td / "виды-пом.svg", "--numbers", "помещения,площади")
        m_ = re.search(r"цифры: (\d+) меток", o)
        if c or not m_ or int(m_.group(1)) != 1:
            из.append("--numbers помещения,площади: размеры и отметки не отключились")
    return из


# ──────────────────────────────── демо ───────────────────────────────────────

def демо():
    """Демо для показа собираются кодом и сверяются с эталоном побайтно. Разошлось —
    сменилась версия ezdxf/shapely, шрифт цифр на машине или поведение конвертора;
    это надо заметить до показа, а не на нём. Эталоны пересобирает
    «демо/сделать-демо.py --эталоны» — осознанно, с объяснением в коммите."""
    из = []
    генератор = HERE / "демо" / "сделать-демо.py"
    if not генератор.exists():
        return [f"нет генератора демо: {генератор}"]
    with tempfile.TemporaryDirectory(prefix="чертёжер-демо-") as td:
        r = subprocess.run([sys.executable, str(генератор), td], capture_output=True,
                           text=True, errors="replace", timeout=300)
        if r.returncode:
            return [f"генератор демо упал — {(r.stderr or r.stdout).strip()[-200:]}"]
        for эталон in sorted((HERE / "демо").glob("эталон-*.svg")):
            имя = эталон.stem[len("эталон-"):]
            dxf = pathlib.Path(td) / f"{имя}.dxf"
            if not dxf.exists():
                из.append(f"демо «{имя}»: генератор не собрал {dxf.name}")
                continue
            c, o, e = прогон(dxf, pathlib.Path(td) / f"{имя}.svg")
            if c:
                из.append(f"демо «{имя}»: прогон упал — {(e or o).strip()[-200:]}")
                continue
            if (pathlib.Path(td) / f"{имя}.svg").read_bytes() != эталон.read_bytes():
                из.append(f"демо «{имя}»: SVG разошёлся с {эталон.name}")
    return из


# ──────────────────────────── настоящие чертежи ──────────────────────────────

def эталоны():
    из = []
    # По образцу scripts/deploy.sh: файл лежит рядом и не коммитится, переменная
    # окружения только переопределяет путь. Имя переменной латиницей — кириллицу
    # в имени zsh не принимает, и запустить это было бы нельзя.
    числа = json.loads((HERE / "эталоны.json").read_text(encoding="utf-8"))
    файл = pathlib.Path(os.environ.get("CHERTEZHER_ETALONY") or HERE / "эталоны-пути.json")
    if not файл.exists():
        print(f"настоящие чертежи не проверялись: нет {файл.name}.\n"
              f"  Положите рядом со скриптом файл эталоны-пути.json:\n"
              f'    {{"К2_2": "/путь/к/К2_2.dxf", "К2_1": "…", "АР4.1": "…"}}\n'
              f"  В репозиторий он не попадёт, чертежи под NDA.\n"
              f"  Ожидаемые числа записаны для: {', '.join(sorted(числа))}")
        return из
    пути = json.loads(файл.read_text(encoding="utf-8"))
    with tempfile.TemporaryDirectory() as td:
        for имя, ждём in sorted(числа.items()):
            if имя not in пути:
                из.append(f"эталон «{имя}» описан числами, но пути к нему нет в {файл.name}")
                continue
            путь = pathlib.Path(пути[имя])
            if not путь.exists():
                из.append(f"эталон «{имя}»: файла нет — {путь}")
                continue
            c, o, e = прогон(путь, pathlib.Path(td) / f"{имя}.svg")
            if c:
                из.append(f"эталон «{имя}»: прогон упал — {(e or o).strip()[-200:]}")
                continue
            есть = снять(o)
            for k, v in ждём.items():
                if есть.get(k) != v:
                    из.append(f"эталон «{имя}»: {k} было {v}, стало {есть.get(k)}")
    return из


def снять(o):
    """Числа прогона из отчёта. Проверяем то, что видит человек, а не внутренности."""
    d = {}
    m = re.search(r"БАЛАНС: нарисовано (\d+)", o)
    if m:
        d["нарисовано"] = int(m.group(1))
    m = re.search(r"проверка баланса: (\d+) = (\d+)", o)
    if m:
        d["объектов"] = int(m.group(2))
        d["баланс сошёлся"] = m.group(1) == m.group(2)
    m = re.search(r"заливка пола: (\d+) м²", o)
    if m:
        d["пол, м²"] = int(m.group(1))
    m = re.search(r"цифры: (\d+) меток", o)
    if m:
        d["цифр"] = int(m.group(1))
    m = re.search(r"ПОМЕЩЕНИЯ: марок (\d+), на заливке (\d+)", o)
    if m:
        d["марок помещений"] = int(m.group(1))
        d["марок на заливке"] = int(m.group(2))
    m = re.search(r"весь чертёж ([\d.]+) × ([\d.]+) м", o)
    if m:
        d["ширина, м"] = float(m.group(1))
        d["высота, м"] = float(m.group(2))
    for cls in ("wall", "wall-fill", "door", "window", "stair", "fixture", "generic"):
        m = re.search(rf"^\s+{re.escape(cls)}\s+(\d+) контуров", o, re.M)
        if m:
            d[cls] = int(m.group(1))
    return d


def main():
    try:
        import ezdxf  # noqa: F401
        import shapely  # noqa: F401
    except ImportError as e:
        print(f"нет зависимостей: {e}\n  .venv/bin/pip install -r requirements.txt",
              file=sys.stderr)
        return 1

    with tempfile.TemporaryDirectory(prefix="чертёжер-гейт-") as td:
        ошибки = вызовы_на_месте() + проверка_проверки() + синтетика(pathlib.Path(td))
    ошибки += демо()
    ошибки += эталоны()

    if ошибки:
        print("Чертёжер сломан:\n" + "\n".join("  · " + o for o in ошибки),
              file=sys.stderr)
        return 1
    print("Чертёжер в порядке.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
