// Конвертация трёх демо через настоящую страницу ui.html в headless Chromium и WebKit.
// Окон нет, звука нет. Сверяет SVG, который вернул сервер, с демо/эталон-*.svg и
// перечисляет все адреса, к которым страница обращалась (должны быть только 127.0.0.1).
//
//   node демо/проверка-браузером.mjs <http://127.0.0.1:ПОРТ> <каталог с демо .dxf> [каталог для скриншотов]
//
// Нужен playwright-core: путь к нему в переменной PLAYWRIGHT_CORE
// (например /private/tmp/zv-od/node_modules/playwright-core) — в проект он не входит,
// это инструмент проверки, а не зависимость чертёжера.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ЗДЕСЬ = path.dirname(fileURLToPath(import.meta.url));
const [база, каталог, снимки] = process.argv.slice(2);
if (!база || !каталог || !process.env.PLAYWRIGHT_CORE) {
  console.error('нужно: <адрес> <каталог демо> и PLAYWRIGHT_CORE=путь/к/playwright-core');
  process.exit(2);
}
const { chromium, webkit } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_CORE);
const ИМЕНА = ['план-комнаты', 'деталь-узла', 'слои-штриховка'];
let провалы = 0;
const ошибка = (м) => { провалы++; console.log('  ПРОВАЛ: ' + м); };

for (const [имя, движок] of [['chromium', chromium], ['webkit', webkit]]) {
  console.log(`== ${имя}`);
  const браузер = await движок.launch({ headless: true, args: имя === 'chromium' ? ['--mute-audio'] : [] });
  const хосты = new Set();
  for (const демо of ИМЕНА) {
    const ctx = await браузер.newContext({ viewport: { width: 1200, height: 900 } });
    const стр = await ctx.newPage();
    стр.on('request', (r) => { try { хосты.add(new URL(r.url()).host || r.url().slice(0, 12)); } catch { хосты.add(r.url().slice(0, 12)); } });
    const консоль = [];
    стр.on('pageerror', (e) => консоль.push(String(e)));
    await стр.goto(база + '/');
    await стр.waitForSelector('#styles .chip');
    await стр.evaluate(() => document.fonts.ready);
    await стр.setInputFiles('#file', path.join(каталог, демо + '.dxf'));
    await стр.waitForSelector('#drop.has');
    const ответ = стр.waitForResponse((r) => r.url().endsWith('/convert'));
    await стр.click('#go');
    const р = await ответ;
    const тело = await р.json();
    if (р.status() !== 200) { ошибка(`${демо}: статус ${р.status()} ${JSON.stringify(тело).slice(0, 200)}`); await ctx.close(); continue; }
    await стр.waitForSelector('.preview svg');
    // размер превью измеряется после загрузки: svg встроен, но шрифты и вёрстка должны осесть
    await стр.evaluate(() => Promise.all([...document.images].map((i) => i.complete ? 0 : new Promise((ok) => { i.onload = i.onerror = ok; }))));
    const бокс = await стр.locator('.preview svg').boundingBox();
    const эталон = fs.readFileSync(path.join(ЗДЕСЬ, `эталон-${демо}.svg`), 'utf8');
    const совпало = тело.svg === эталон;
    const отчёт = await стр.locator('.card.g .tag').innerText();
    console.log(`  ${демо}: статус 200, SVG ${тело.svg.length} байт, ${совпало ? 'СОВПАЛ с эталоном' : 'НЕ СОВПАЛ'}, ` +
      `превью ${Math.round(бокс.width)}×${Math.round(бокс.height)} px, «${отчёт.replace(/\s+/g, ' ')}»`);
    if (!совпало) ошибка(`${демо}: SVG не совпал с эталоном`);
    if (!(бокс.width > 100 && бокс.height > 50)) ошибка(`${демо}: превью пустое`);
    if (консоль.length) ошибка(`${демо}: ошибки страницы: ${консоль.join('; ')}`);
    const href = await стр.locator('a.cta.dl').getAttribute('download');
    if (href !== демо + '.svg') ошибка(`${демо}: имя скачиваемого файла «${href}»`);
    if (снимки) { fs.mkdirSync(снимки, { recursive: true }); await стр.screenshot({ path: path.join(снимки, `${имя}-${демо}.png`), fullPage: true }); }
    await ctx.close();
  }
  console.log(`  адреса, к которым обращалась страница: ${[...хосты].sort().join(', ')}`);
  for (const х of хосты) if (!/^(127\.0\.0\.1(:\d+)?|data:|blob:)/.test(х)) ошибка(`обращение не к 127.0.0.1: ${х}`);
  await браузер.close();
}
console.log(провалы ? `ИТОГ: провалов ${провалы}` : 'ИТОГ: чисто');
process.exit(провалы ? 1 : 0);
