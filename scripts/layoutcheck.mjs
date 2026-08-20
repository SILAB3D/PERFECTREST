/**
 * Auditoría de maquetación en un navegador real.
 *
 * Carga la app a varios anchos de móvil, recorre todas las pantallas y busca
 * los defectos que no se ven leyendo el CSS: desbordamientos horizontales,
 * cajas que se salen de su contenedor, textos que se solapan, contenido tapado
 * por la barra fija y valores de espaciado fuera de la escala del tema.
 *
 *   node scripts/layoutcheck.mjs [url]
 */
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const URL = process.argv[2] ?? 'http://127.0.0.1:5178/';

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];
const executablePath = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!executablePath) {
  console.error('No se encontró Chrome ni Edge para ejecutar la auditoría.');
  process.exit(1);
}

/** Anchos representativos: móvil pequeño, medio, grande y tablet estrecha. */
const WIDTHS = [320, 360, 390, 430, 520];
const TABS = [
  ['home', 'Inicio'],
  ['goals', 'Metas'],
  ['cycles', 'Ciclos'],
  ['stats', 'Datos'],
  ['settings', 'Ajustes'],
];

/** Escala de espaciado del tema: cualquier otro valor es una desviación. */
const SCALE = [0, 2, 4, 8, 12, 16, 20, 24, 32, 40, 48, 96];

/** Estado sembrado para que todas las pantallas tengan contenido real. */
function seedState() {
  const DAY = 86400000;
  const now = Date.now();
  const sessions = [];
  for (let i = 1; i <= 12; i++) {
    const end = new Date(now - i * DAY);
    end.setHours(7 + (i % 3 === 0 ? 1 : 0), (i * 7) % 60, 0, 0);
    const hours = 6.5 + ((i * 37) % 200) / 100;
    sessions.push({
      id: `seed-${i}`,
      start: end.getTime() - hours * 3600000,
      end: end.getTime(),
      source: i % 3 === 0 ? 'auto' : 'manual',
      confidence: i % 4 === 0 ? 'medium' : 'high',
      confirmed: i % 3 !== 0,
      quality: (i % 5) + 1,
    });
  }
  return {
    schedule: {
      mode: 'weekday-weekend',
      goals: {
        1: { wakeTime: '07:00', targetHours: 8 },
        2: { wakeTime: '07:00', targetHours: 8 },
        3: { wakeTime: '07:00', targetHours: 8 },
        4: { wakeTime: '07:00', targetHours: 8 },
        5: { wakeTime: '07:00', targetHours: 8 },
        6: { wakeTime: '09:30', targetHours: 8.75 },
        7: { wakeTime: '09:30', targetHours: 8.75 },
      },
    },
    cycles: { cycleMinutes: 90, latencyMinutes: 15 },
    reminders: {
      enabled: true,
      windDownMinutes: 30,
      toleranceMinutes: 15,
      nagIfLate: true,
      wakeAlarm: true,
    },
    monitor: {
      enabled: true,
      minGapMinutes: 180,
      maxGapMinutes: 780,
      nightStart: '21:30',
      nightEnd: '11:00',
      autoConfirm: false,
      background: true,
    },
    sessions,
    theme: 'dark',
    lastActiveAt: now - 3600000,
    pendingSession: null,
    onboarded: true,
  };
}

/** Se ejecuta dentro de la página: recoge todos los defectos de una pantalla. */
function auditPage(scale) {
  const problems = [];
  const spacingUsage = {};

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  };

  /** ¿El elemento o alguno de sus ancestros está fuera del flujo normal? */
  const positioned = (el) => {
    for (let p = el; p && p !== document.body; p = p.parentElement) {
      if (getComputedStyle(p).position !== 'static') return true;
    }
    return false;
  };

  const describe = (el) => {
    const cls = typeof el.className === 'string' ? el.className.split(' ')[0] : '';
    const txt = (el.textContent || '').trim().slice(0, 34).replace(/\s+/g, ' ');
    return `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}${txt ? ` "${txt}"` : ''}`;
  };

  // 1. Scroll horizontal de la página: nunca debe existir en móvil.
  const docOverflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
  if (docOverflow > 1) {
    problems.push({ kind: 'scroll-horizontal', detail: `la página desborda ${docOverflow}px` });
  }

  const all = [...document.querySelectorAll('body *')].filter(visible);

  // 2. Elementos que se salen del viewport por los lados.
  const vw = document.documentElement.clientWidth;
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.left < -1 || r.right > vw + 1) {
      // Los contenedores con scroll propio pueden ser más anchos por diseño.
      let inScroller = false;
      for (let p = el.parentElement; p; p = p.parentElement) {
        if (getComputedStyle(p).overflowX !== 'visible') { inScroller = true; break; }
      }
      if (!inScroller) {
        problems.push({
          kind: 'fuera-de-viewport',
          detail: `${describe(el)} ocupa ${Math.round(r.left)}…${Math.round(r.right)} en ${vw}px`,
        });
      }
    }
  }

  // 3. Contenido desbordando su propio contenedor (texto que se escapa).
  for (const el of all) {
    const cs = getComputedStyle(el);
    if (cs.overflowX !== "visible" || cs.overflowY !== "visible") continue;
    // En SVG clientWidth/scrollWidth no describen el contenido: se omiten.
    if (el.ownerSVGElement || el.tagName === "svg") continue;
    if (el.scrollWidth - el.clientWidth > 1 && el.clientWidth > 0) {
      problems.push({
        kind: 'desborda-contenedor',
        detail: `${describe(el)} contenido ${el.scrollWidth}px en ${el.clientWidth}px`,
      });
    }
  }

  // 4. Solapamiento entre hermanos con texto propio.
  const leafText = all.filter(
    (el) => el.children.length === 0 && (el.textContent || '').trim().length > 0,
  );
  for (let i = 0; i < leafText.length; i++) {
    for (let j = i + 1; j < leafText.length; j++) {
      const a = leafText[i];
      const b = leafText[j];
      if (a.contains(b) || b.contains(a)) continue;
      // Sólo interesan elementos en el flujo normal. Lo que está posicionado
      // —o cuelga de algo posicionado, como la barra fija o una hoja modal—
      // se superpone a propósito y no es un defecto.
      if (positioned(a) || positioned(b)) continue;
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      const ox = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const oy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (ox > 2 && oy > 2) {
        problems.push({
          kind: 'solapamiento',
          detail: `${describe(a)} × ${describe(b)} (${Math.round(ox)}×${Math.round(oy)}px)`,
        });
      }
    }
  }

  // 5. Contenido tapado por la barra de navegación fija.
  const tabbar = document.querySelector('.tabbar');
  if (tabbar) {
    const tb = tabbar.getBoundingClientRect();
    const screen = document.querySelector('.screen');
    if (screen) {
      const last = [...screen.querySelectorAll('*')]
        .filter(visible)
        .reduce((acc, el) => Math.max(acc, el.getBoundingClientRect().bottom), 0);
      const docBottom = document.documentElement.scrollHeight;
      // Con la página al final, el último contenido debe quedar por encima.
      if (Math.abs(window.scrollY + window.innerHeight - docBottom) < 4 && last > tb.top + 1) {
        problems.push({
          kind: 'tapado-por-tabbar',
          detail: `el contenido llega a ${Math.round(last)}px y la barra empieza en ${Math.round(tb.top)}px`,
        });
      }
    }
  }

  // 6. Objetivos táctiles demasiado pequeños.
  for (const el of all) {
    if (!['BUTTON', 'A', 'INPUT'].includes(el.tagName)) continue;
    const r = el.getBoundingClientRect();
    if (r.height < 32 || r.width < 32) {
      problems.push({
        kind: 'zona-tactil-pequena',
        detail: `${describe(el)} mide ${Math.round(r.width)}×${Math.round(r.height)}px`,
      });
    }
  }

  // 7. Espaciados fuera de la escala del tema.
  for (const el of all) {
    const cs = getComputedStyle(el);
    for (const prop of ['paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight', 'gap', 'rowGap', 'columnGap', 'marginTop', 'marginBottom']) {
      const raw = cs[prop];
      if (!raw || raw === 'normal' || raw === 'auto') continue;
      const v = Math.round(parseFloat(raw) * 100) / 100;
      if (!Number.isFinite(v) || v === 0) continue;
      spacingUsage[v] = (spacingUsage[v] || 0) + 1;
      if (!scale.includes(v)) {
        problems.push({
          kind: 'espaciado-fuera-de-escala',
          detail: `${describe(el)} ${prop}: ${v}px`,
        });
      }
    }
  }

  return { problems, spacingUsage };
}

const browser = await puppeteer.launch({
  executablePath,
  headless: 'new',
  args: ['--no-sandbox', '--font-render-hinting=none'],
});

const seeded = seedState();
let total = 0;
const byKind = {};
const spacingAll = {};

/**
 * Estados que no aparecen en el recorrido normal pero se muestran a pantalla
 * completa: hay que auditarlos igual.
 */
const VARIANTS = [
  { name: 'oscuro', state: seeded },
  { name: 'claro', state: { ...seeded, theme: 'light' } },
  { name: 'onboarding', state: { ...seeded, onboarded: false }, skipTabs: true },
  {
    name: 'sesión pendiente',
    state: {
      ...seeded,
      pendingSession: {
        id: 'pend-1',
        start: Date.now() - 9 * 3600000,
        end: Date.now() - 3600000,
        source: 'auto',
        confidence: 'medium',
        confirmed: false,
      },
    },
  },
];

for (const variant of VARIANTS) {
for (const width of WIDTHS) {
  const page = await browser.newPage();
  await page.setViewport({ width, height: 800, deviceScaleFactor: 2, isMobile: true });
  await page.evaluateOnNewDocument((state) => {
    localStorage.setItem('perfectrest.state.v1', JSON.stringify(state));
  }, variant.state);
  await page.goto(URL, { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 350));

  // El onboarding ocupa toda la pantalla: se audita tal cual, sin pestañas.
  if (variant.skipTabs) {
    const { problems, spacingUsage } = await page.evaluate(auditPage, SCALE);
    for (const [k, v] of Object.entries(spacingUsage)) spacingAll[k] = (spacingAll[k] || 0) + v;
    for (const p of problems) {
      const key = `${p.kind}|${p.detail}`;
      byKind[p.kind] ??= new Map();
      const prev = byKind[p.kind].get(key);
      if (prev) prev.widths.add(width);
      else byKind[p.kind].set(key, { detail: p.detail, widths: new Set([width]), tab: variant.name });
      total++;
    }
    await page.close();
    continue;
  }

  for (const [tab, label] of TABS) {
    await page.evaluate((t) => {
      const byLabel = [...document.querySelectorAll('.tab')].find(
        (b) => b.textContent.trim().endsWith(t),
      );
      if (byLabel) byLabel.click();
      else document.querySelector('.iconbtn')?.click();
    }, label);
    await new Promise((r) => setTimeout(r, 260));

    // Se audita arriba del todo y con la página desplazada al final, que es
    // donde aparecen los problemas con la barra fija.
    for (const position of ['top', 'bottom']) {
      if (position === 'bottom') {
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await new Promise((r) => setTimeout(r, 220));
      }
      const { problems, spacingUsage } = await page.evaluate(auditPage, SCALE);
      for (const [k, v] of Object.entries(spacingUsage)) spacingAll[k] = (spacingAll[k] || 0) + v;

      // Se agrupan por tipo y detalle para no repetir el mismo defecto en
      // cada ancho y posición.
      for (const p of problems) {
        const key = `${p.kind}|${p.detail}`;
        byKind[p.kind] ??= new Map();
        const prev = byKind[p.kind].get(key);
        if (prev) prev.widths.add(width);
        else byKind[p.kind].set(key, { detail: p.detail, widths: new Set([width]), tab: `${variant.name}/${label}` });
        total++;
      }
    }
    await page.evaluate(() => window.scrollTo(0, 0));

    // La hoja de edición se abre sobre el historial y tapa la pantalla: se
    // audita como un estado más.
    if (label === 'Datos') {
      const opened = await page.evaluate(() => {
        const first = document.querySelector('.session');
        if (!first) return false;
        first.click();
        return true;
      });
      if (opened) {
        await new Promise((r) => setTimeout(r, 300));
        const { problems } = await page.evaluate(auditPage, SCALE);
        for (const pr of problems) {
          const key = `${pr.kind}|${pr.detail}`;
          byKind[pr.kind] ??= new Map();
          const prev = byKind[pr.kind].get(key);
          if (prev) prev.widths.add(width);
          else byKind[pr.kind].set(key, { detail: pr.detail, widths: new Set([width]), tab: `${variant.name}/hoja` });
          total++;
        }
        await page.keyboard.press('Escape');
      }
    }
  }
  await page.close();
}
}

await browser.close();

console.log('\n=== Auditoría de maquetación ===');
console.log(`Anchos probados: ${WIDTHS.join(', ')}px · pantallas: ${TABS.length}\n`);

const ORDER = [
  'scroll-horizontal',
  'fuera-de-viewport',
  'desborda-contenedor',
  'solapamiento',
  'tapado-por-tabbar',
  'zona-tactil-pequena',
  'espaciado-fuera-de-escala',
];

let distinct = 0;
for (const kind of ORDER) {
  const map = byKind[kind];
  if (!map || map.size === 0) continue;
  console.log(`\n## ${kind} (${map.size})`);
  for (const { detail, widths, tab } of [...map.values()].slice(0, 14)) {
    console.log(`   [${tab}] ${detail}  @${[...widths].join('/')}px`);
    distinct++;
  }
  if (map.size > 14) console.log(`   … y ${map.size - 14} más`);
}

console.log('\n## espaciados usados (px → veces)');
console.log(
  '   ' +
    Object.entries(spacingAll)
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([v, n]) => `${v}:${n}`)
      .join('  '),
);

console.log(
  distinct === 0
    ? '\nMAQUETACIÓN OK — sin defectos\n'
    : `\n${distinct} defectos distintos (${total} incidencias)\n`,
);
process.exit(distinct === 0 ? 0 : 1);
