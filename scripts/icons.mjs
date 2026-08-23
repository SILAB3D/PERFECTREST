/**
 * Genera los PNG del icono de la app a partir de `public/logo.svg`.
 *
 * Casi todo el juego de iconos es vectorial (`android/app/src/main/res`), pero
 * Android sólo usa los adaptativos desde API 26 y el proyecto arranca en la 24,
 * así que los `mipmap-*` de respaldo tienen que existir como mapa de bits.
 * Se rasterizan con el Chrome del sistema, que ya es la dependencia que usan
 * `screenshots.mjs` y `layoutcheck.mjs`.
 *
 *   node scripts/icons.mjs [--preview]
 */
import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const res = resolve(root, 'android/app/src/main/res');

const BG = '#090D1A';

const executablePath = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => existsSync(p));

if (!executablePath) {
  console.error('No se encontró Chrome ni Edge para rasterizar los iconos.');
  process.exit(1);
}

/** El contenido de `logo.svg` sin su etiqueta raíz: se reutiliza en cada lienzo. */
const mark = readFileSync(resolve(root, 'public/logo.svg'), 'utf8')
  .replace(/^[\s\S]*?<svg[^>]*>/, '')
  .replace(/<\/svg>\s*$/, '')
  .trim();

/** El dibujo ocupa 83 de las 100 unidades del lienzo, centrado en (50,50). */
const CONTENT = 75.5;

/**
 * Encaja la marca en un lienzo cuadrado de `size`, ocupando `ratio` de su lado.
 * `shape` decide el fondo: cuadrado redondeado, círculo o nada (adaptativo).
 */
function canvas(size, ratio, shape) {
  const scale = (size * ratio) / CONTENT;
  const offset = size / 2 - 50 * scale;
  const bg =
    shape === 'square'
      ? `<rect width="${size}" height="${size}" rx="${size * 0.2237}" fill="${BG}"/>`
      : shape === 'circle'
        ? `<circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="${BG}"/>`
        : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
${bg}<g transform="translate(${offset} ${offset}) scale(${scale})">${mark}</g></svg>`;
}

/** Densidades de Android: el icono heredado mide 48dp y el adaptativo 108dp. */
const DENSITIES = [
  ['mdpi', 1],
  ['hdpi', 1.5],
  ['xhdpi', 2],
  ['xxhdpi', 3],
  ['xxxhdpi', 4],
];

const targets = [];
for (const [density, k] of DENSITIES) {
  const dir = resolve(res, `mipmap-${density}`);
  // 0.66 deja el margen que Android espera alrededor del icono heredado; el
  // adaptativo usa 0.648 de 108dp (= 70dp) para no salirse de la zona segura.
  targets.push({ file: resolve(dir, 'ic_launcher.png'), svg: canvas(48 * k, 0.66, 'square') });
  targets.push({ file: resolve(dir, 'ic_launcher_round.png'), svg: canvas(48 * k, 0.66, 'circle') });
  targets.push({
    file: resolve(dir, 'ic_launcher_foreground.png'),
    svg: canvas(108 * k, 0.648, 'none'),
  });
}

if (process.argv.includes('--preview')) {
  targets.push({ file: resolve(root, 'screenshots/icon-preview.png'), svg: preview() });
}

/** Hoja de contacto para revisar el icono a los tamaños en que se usa de verdad. */
function preview() {
  const shots = [
    ['Lanzador 192', canvas(192, 0.66, 'square')],
    ['Redondo 192', canvas(192, 0.66, 'circle')],
    ['Lanzador 48', canvas(48, 0.66, 'square')],
    ['Adaptativo', canvas(192, 0.648, 'none')],
  ];
  const cell = (label, svg, i) => {
    const x = 40 + (i % 4) * 240;
    return `<g transform="translate(${x} 40)">${svg.replace('<svg', '<svg x="0" y="0"')}
      <text x="96" y="215" fill="#A7B0D8" font-family="sans-serif" font-size="14" text-anchor="middle">${label}</text></g>`;
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1040" height="300" viewBox="0 0 1040 300">
<rect width="1040" height="300" fill="#151E3D"/>
${shots.map(([l, s], i) => cell(l, s, i)).join('\n')}</svg>`;
}

const browser = await puppeteer.launch({ executablePath, headless: true });
const page = await browser.newPage();

for (const { file, svg } of targets) {
  mkdirSync(dirname(file), { recursive: true });
  await page.setContent(
    `<style>html,body{margin:0;padding:0;background:transparent}svg{display:block}</style>${svg}`,
  );
  const el = await page.$('svg');
  const png = await el.screenshot({ omitBackground: true });
  writeFileSync(file, png);
  console.log('·', file.slice(root.length + 1));
}

await browser.close();
