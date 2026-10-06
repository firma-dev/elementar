// Проверка страницы ui.html в headless Chromium и WebKit — окон нет, звука нет.
// Путь человека: файл → стадии → результат → «Скачать SVG» → «Проверка».
// Три демо сверяются с демо/эталон-*.svg (то, что отдаёт кнопка «Скачать»);
// дополнительные файлы (настоящие DWG) — только проходят путь, без эталона.
// На двух размерах окна (1440×900 и 1000×650) страница обязана помещаться в
// экран: scrollHeight == innerHeight. Перечисляются адреса, к которым страница
// обращалась (должны быть только 127.0.0.1).
//
//   node демо/проверка-браузером.mjs <http://127.0.0.1:ПОРТ> <каталог с демо .dxf> [каталог снимков] [доп. файл ...]
//
// Нужен playwright-core: путь к нему в переменной PLAYWRIGHT_CORE
// (например /private/tmp/zv-od/node_modules/playwright-core) — в проект он не входит,
// это инструмент проверки, а не зависимость чертёжера.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ЗДЕСЬ = path.dirname(fileURLToPath(import.meta.url));
const [база, каталог, снимки, ...доп] = process.argv.slice(2);
if (!база || !каталог || !process.env.PLAYWRIGHT_CORE) {
  console.error('нужно: <адрес> <каталог демо> [снимки] [доп. файлы] и PLAYWRIGHT_CORE=путь/к/playwright-core');
  process.exit(2);
}
const { chromium, webkit } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_CORE);
const ДЕМО = ['план-комнаты', 'деталь-узла', 'слои-штриховка'];
const ОКНА = [[1440, 900], [1000, 650]];
// Слова, которых человек на экране видеть не должен.
const ТЕХНИКА = /dxf2svg|dwg2dxf|ezdxf|Traceback|stdout|stderr|--[a-z]|\/Users\/|\/tmp\/|undefined|NaN|null/;
let провалы = 0;
const ошибка = (м) => { провалы++; console.log('  ПРОВАЛ: ' + м); };
const снимок = async (стр, имя) => {
  if (!снимки) return;
  fs.mkdirSync(снимки, { recursive: true });
  await стр.screenshot({ path: path.join(снимки, `ui-${имя}.png`) });
};
const вЭкран = async (стр, где) => {
  const [sh, ih, sw, iw] = await стр.evaluate(() => [document.documentElement.scrollHeight, innerHeight,
    document.documentElement.scrollWidth, innerWidth]);
  if (sh !== ih || sw > iw) ошибка(`${где}: страница не в один экран (scrollHeight ${sh}, innerHeight ${ih}, ширина ${sw}/${iw})`);
  return sh === ih;
};
const плохоеСлово = async (стр, где) => {
  const т = await стр.evaluate(() => document.body.innerText);
  const м = т.match(ТЕХНИКА);
  if (м) ошибка(`${где}: на экране техническое «${м[0]}»`);
};

const мусор = path.join(os.tmpdir(), 'чертёжер-не-чертёж.txt');
fs.writeFileSync(мусор, 'это не чертёж');

for (const [имя, движок] of [['chromium', chromium], ['webkit', webkit]]) {
  console.log(`== ${имя}`);
  const браузер = await движок.launch({ headless: true, args: имя === 'chromium' ? ['--mute-audio'] : [] });
  const хосты = new Set();
  const файлы = [...ДЕМО.map((д) => [д, path.join(каталог, д + '.dxf'), true]),
                 ...доп.map((ф) => [path.basename(ф).replace(/\.[^.]+$/, ''), ф, false])];
  for (const [w, h] of ОКНА) {
    for (const [демо, файл, сверять] of файлы) {
      const тег = `${имя}-${w}x${h}-${демо}`;
      const ctx = await браузер.newContext({ viewport: { width: w, height: h }, acceptDownloads: true });
      const стр = await ctx.newPage();
      стр.on('request', (r) => { try { хосты.add(new URL(r.url()).host || r.url().slice(0, 12)); } catch { хосты.add(r.url().slice(0, 12)); } });
      const консоль = [];
      стр.on('pageerror', (e) => консоль.push(String(e)));
      стр.on('console', (m) => { if (m.type() === 'error') консоль.push(m.text()); });
      await стр.goto(база + '/');
      await стр.waitForSelector('#styles .style[aria-checked="true"]');
      await стр.evaluate(() => document.fonts.ready);
      await вЭкран(стр, `${тег} пустая`);
      if (демо === ДЕМО[0]) {
        await снимок(стр, `${имя}-${w}x${h}-0-пусто`);
        // недопустимый файл — понятной строкой
        await стр.setInputFiles('#file', мусор);
        const т = await стр.locator('#ferr').innerText().catch(() => '');
        if (!/не чертёж/.test(т)) ошибка(`${тег}: на недопустимый файл нет понятной строки («${т}»)`);
      }
      await стр.setInputFiles('#file', файл);
      await стр.waitForSelector('#go:not([disabled])');
      const имяНаЭкране = await стр.locator('#fname').innerText();
      if (имяНаЭкране !== path.basename(файл)) ошибка(`${тег}: имя файла на экране «${имяНаЭкране}»`);
      if (демо === ДЕМО[0]) await снимок(стр, `${имя}-${w}x${h}-1-файл`);
      const готово = стр.waitForResponse((x) => x.url().endsWith('/convert'), { timeout: 600000 });
      const t0 = Date.now();
      await стр.click('#go');
      await стр.waitForSelector('#progress:not([hidden]) #stages li');
      const первая = await стр.locator('#stages li').first().innerText();
      if (демо === ДЕМО[0] || !сверять) await снимок(стр, `${тег}-2-стадии`);
      const р = await готово;
      if (р.status() !== 200) {
        ошибка(`${тег}: статус ${р.status()} ${(await р.text()).slice(0, 200)}`);
        await ctx.close(); continue;
      }
      await стр.waitForSelector('#view:not([hidden]) #paneA .lay.our svg');
      await стр.waitForFunction(() => document.querySelector('#dl').href.startsWith('blob:'));
      const сек = ((Date.now() - t0) / 1000).toFixed(1);
      // сверяем то, что человек получит по кнопке «Скачать», а не промежуточный ответ
      const скачать = стр.waitForEvent('download');
      await стр.click('#dl');
      const загрузка = await скачать;
      const svg = fs.readFileSync(await загрузка.path(), 'utf8');
      const ждём = path.basename(файл).replace(/\.(dwg|dxf)$/i, '') + '.svg';
      if (загрузка.suggestedFilename() !== ждём) ошибка(`${тег}: имя скачанного файла «${загрузка.suggestedFilename()}»`);
      if (сверять) {
        const эталон = fs.readFileSync(path.join(ЗДЕСЬ, `эталон-${демо}.svg`), 'utf8');
        if (svg !== эталон) ошибка(`${тег}: SVG не совпал с эталоном`);
      } else if (!svg.startsWith('<svg')) ошибка(`${тег}: скачано не SVG`);
      const бокс = await стр.locator('#paneA .lay.our svg').boundingBox();
      if (!(бокс && бокс.width > 200 && бокс.height > 150)) ошибка(`${тег}: превью мелкое или пустое`);
      await вЭкран(стр, `${тег} результат`);
      await плохоеСлово(стр, `${тег} результат`);
      const итог = (await стр.locator('#sum').innerText()).replace(/\s+/g, ' ');
      await снимок(стр, `${тег}-3-результат`);

      // «Проверка»: по умолчанию оба слоя, подсветка, счётчик
      await стр.click('#tabCheck');
      await стр.waitForSelector('#ckbar:not([hidden])');
      const виден = (sel) => стр.evaluate((s) => { const e = document.querySelector(s);
        return !!e && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0; }, sel);
      if (!(await виден('#paneA .lay.src svg')) || !(await виден('#paneA .lay.our svg')))
        ошибка(`${тег}: «Проверка» по умолчанию показывает не оба слоя`);
      const подсветка = await стр.waitForSelector('#paneA canvas.diff.on', { timeout: 20000 }).then(() => true, () => false);
      if (!подсветка) ошибка(`${тег}: подсветка отличий не появилась`);
      const отл = await стр.evaluate(() => { const c = document.querySelector('#paneA canvas.diff');
        return [+c.dataset.del || 0, +c.dataset.add || 0]; });
      const вердикт = (await стр.locator('#verdict').innerText()).replace(/\s+/g, ' ');
      if (!/убрано|Убрано/.test(вердикт)) ошибка(`${тег}: нет счётчика убранного («${вердикт}»)`);
      await вЭкран(стр, `${тег} проверка`);
      await плохоеСлово(стр, `${тег} проверка`);
      await снимок(стр, `${тег}-4-проверка-оба`);
      // мигалка на пробеле
      await стр.locator('#paneA').click({ position: { x: 5, y: 5 } });
      await стр.keyboard.press('Space');
      const м1 = await стр.getAttribute('#view', 'data-mode');
      if (демо === ДЕМО[0] || !сверять) await снимок(стр, `${тег}-4-проверка-dwg`);
      await стр.keyboard.press('Space');
      const м2 = await стр.getAttribute('#view', 'data-mode');
      if (м1 !== 'src' || м2 !== 'our') ошибка(`${тег}: пробел переключает не DWG/SVG (${м1}, ${м2})`);
      await стр.click('.seg [data-mode="side"]');
      await стр.waitForTimeout(150);
      const бА = await стр.locator('#paneA').boundingBox(), бБ = await стр.locator('#paneB').boundingBox();
      if (!(бА && бБ && бБ.x > бА.x + бА.width - 1)) ошибка(`${тег}: «Рядом» не раскладывает две картинки`);
      await вЭкран(стр, `${тег} рядом`);
      if (демо === ДЕМО[0] || !сверять) await снимок(стр, `${тег}-5-рядом`);
      await стр.click('.seg [data-mode="both"]');
      if (консоль.length) ошибка(`${тег}: ошибки страницы: ${консоль.join('; ')}`);
      console.log(`  ${тег}: ${сек} с, стадия «${первая}», ${сверять ? 'эталон сверен' : 'без эталона'}, ` +
        `превью ${Math.round(бокс.width)}×${Math.round(бокс.height)}, отличия ${отл[0]}/${отл[1]} пкс; «${итог}»; «${вердикт.slice(0, 160)}»`);
      await ctx.close();
    }
  }
  // тёмная тема — только по выбору: системная тёмная не подхватывается
  {
    const ctx = await браузер.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
    const стр = await ctx.newPage();
    await стр.goto(база + '/');
    await стр.waitForSelector('#styles .style');
    const до = await стр.evaluate(() => document.documentElement.dataset.theme);
    await стр.click('#theme');
    const после = await стр.evaluate(() => document.documentElement.dataset.theme);
    if (до !== 'light' || после !== 'dark') ошибка(`${имя}: тема — по умолчанию «${до}», после кнопки «${после}»`);
    await стр.evaluate(() => document.fonts.ready);
    await стр.waitForTimeout(400);   // смена темы плавная — снимаем после перехода
    await снимок(стр, `${имя}-1440x900-тёмная`);
    await ctx.close();
  }
  console.log(`  адреса, к которым обращалась страница: ${[...хосты].sort().join(', ')}`);
  for (const х of хосты) if (!/^(127\.0\.0\.1(:\d+)?|data:|blob:)/.test(х)) ошибка(`обращение не к 127.0.0.1: ${х}`);
  await браузер.close();
}
console.log(провалы ? `ИТОГ: провалов ${провалы}` : 'ИТОГ: чисто');
process.exit(провалы ? 1 : 0);
