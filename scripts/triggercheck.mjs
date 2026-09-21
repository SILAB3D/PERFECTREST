/**
 * Comprobación de los disparadores sobre un dispositivo real.
 *
 * El problema que resuelve: `nightsim.ts` simula la máquina de estados del
 * servicio, pero simula también los eventos de Android. Si lo que falla es que
 * la señal del sistema no llega —el servicio muerto, el receptor sin registrar,
 * un permiso retirado— la simulación pasa en verde y el móvil no detecta nada.
 * Eso es exactamente lo que no se puede comprobar desde el PC.
 *
 * Aquí se provocan las cuatro señales de verdad, con adb, sobre el aparato:
 *
 *   screen   input keyevent SLEEP / WAKEUP + dismiss-keyguard
 *   charger  dumpsys battery unplug / set ac 1
 *   idle     dumpsys deviceidle force-idle / unforce
 *   dnd      cmd notification set_dnd priority / off
 *
 * y después se lee el estado que el servicio dejó en sus preferencias. Si el
 * disparador funciona, `openAt.<id>` y `lastUsedAt` se mueven; si no, no.
 *
 *   node scripts/triggercheck.mjs            todos los disparadores
 *   node scripts/triggercheck.mjs screen     sólo uno
 *
 * Deja el móvil como estaba: la batería, el reposo y «no molestar» se
 * restauran al terminar, incluso si una comprobación falla.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PKG = 'com.perfectrest.app';
const PREFS_FILE = `/data/data/${PKG}/shared_prefs/perfectrest.monitor.xml`;

// --- adb ---------------------------------------------------------------------

function findAdb() {
  if (process.env.PERFECTREST_ADB) return process.env.PERFECTREST_ADB;
  const candidates = [
    join(homedir(), 'AppData/Local/Android/Sdk/platform-tools/adb.exe'),
    join(homedir(), 'Android/Sdk/platform-tools/adb'),
    join(homedir(), 'Library/Android/sdk/platform-tools/adb'),
    'adb',
  ];
  for (const c of candidates) {
    if (c === 'adb' || existsSync(c)) return c;
  }
  return 'adb';
}

const ADB = findAdb();
let serial = null;

function adb(args, { quiet = true } = {}) {
  const full = serial ? ['-s', serial, ...args] : args;
  const res = spawnSync(ADB, full, { encoding: 'utf8' });
  if (res.error) throw new Error(`no se pudo ejecutar adb (${ADB}): ${res.error.message}`);
  if (!quiet && res.status !== 0) {
    throw new Error(`adb ${full.join(' ')} falló:\n${res.stderr || res.stdout}`);
  }
  return (res.stdout ?? '').trim();
}

/** `adb shell` como una sola cadena, que es como se escriben estos comandos. */
const sh = (cmd) => adb(['shell', cmd]);

function pickDevice() {
  const lines = adb(['devices'])
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean);
  const ready = lines.filter((l) => l.endsWith('\tdevice')).map((l) => l.split('\t')[0]);
  if (!ready.length) {
    const pending = lines.length ? `\n  ${lines.join('\n  ')}` : '';
    throw new Error(
      `No hay ningún dispositivo listo.${pending}\n` +
        'Conecta el móvil por USB con la depuración activada, o emparéjalo por wifi\n' +
        'con «adb pair IP:PUERTO» y «adb connect IP:PUERTO».',
    );
  }
  return ready[0];
}

// --- Lectura del estado del servicio ----------------------------------------

/**
 * Las preferencias del servicio, leídas del propio fichero.
 *
 * `run-as` sólo funciona si la build instalada es depurable. Con una release
 * firmada no hay forma de leer el fichero, así que se dice en vez de fingir que
 * la comprobación no ha visto nada.
 */
function readPrefs() {
  const xml = sh(`run-as ${PKG} cat ${PREFS_FILE} 2>/dev/null`);
  if (!xml || !xml.includes('<map')) return null;

  const prefs = {};
  for (const m of xml.matchAll(/<(long|int|boolean|string)\s+name="([^"]+)"(?:\s+value="([^"]*)")?\s*(?:\/>|>([\s\S]*?)<\/\1>)/g)) {
    const [, type, name, attr, body] = m;
    const raw = attr ?? body ?? '';
    prefs[name] =
      type === 'long' || type === 'int'
        ? Number(raw)
        : type === 'boolean'
          ? raw === 'true'
          : decodeEntities(raw);
  }
  return prefs;
}

function decodeEntities(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Hora del móvil en epoch ms: comparar contra la del PC descuadra por minutos. */
function deviceNow() {
  const out = sh('date +%s%3N');
  const n = Number(out);
  return Number.isFinite(n) && n > 0 ? n : Date.now();
}

const clock = (ts) =>
  ts > 0 ? new Date(ts).toTimeString().slice(0, 8) : '—';

const ago = (ts, now) => (ts > 0 ? `hace ${Math.round((now - ts) / 1000)}s` : 'nunca');

// --- Estado del dispositivo --------------------------------------------------

const screenOn = () => /mHoldingDisplaySuspendBlocker=true|mScreenOn=true|Display Power: state=ON/.test(
  sh('dumpsys power | grep -E "mHoldingDisplaySuspendBlocker|Display Power"'),
);

const keyguardSecure = () =>
  /isKeyguardSecure=true|mIsSecure=true/.test(sh('dumpsys window | grep -iE "isKeyguardSecure|mIsSecure"'));

function serviceAlive(prefs, now) {
  if (!prefs) return null;
  const alive = prefs.aliveAt ?? 0;
  return alive > 0 && now - alive < 45 * 60_000;
}

// --- Espera -----------------------------------------------------------------

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Espera a que una preferencia cambie. El servicio escribe con `apply()`, que
 * es asíncrono, así que leer justo después del evento da el valor viejo y haría
 * fallar una comprobación que en realidad ha funcionado.
 */
function waitFor(predicate, { timeoutMs = 8000, stepMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  do {
    last = readPrefs();
    if (last && predicate(last)) return { ok: true, prefs: last };
    sleep(stepMs);
  } while (Date.now() < deadline);
  return { ok: false, prefs: last };
}

// --- Comprobaciones ----------------------------------------------------------

let failures = 0;
const results = [];

function report(name, ok, detail) {
  if (!ok) failures++;
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'ok  ' : 'FALLA'} ${name}${detail ? ` — ${detail}` : ''}`);
}

/**
 * Pantalla: apagar y volver a desbloquear.
 *
 * Es el disparador que la app declara más fiable, y el que el usuario ve en la
 * fila «Último uso del móvil». Se comprueban las dos mitades por separado
 * porque fallan por motivos distintos: SCREEN_OFF abre el hueco, USER_PRESENT
 * lo cierra y además es lo único que refresca `lastUsedAt` con bloqueo seguro.
 */
function checkScreen() {
  console.log('\n  pantalla (SCREEN_OFF → USER_PRESENT)');
  const before = readPrefs();
  const secure = keyguardSecure();
  console.log(`    bloqueo seguro: ${secure ? 'sí (hace falta USER_PRESENT)' : 'no (basta SCREEN_ON)'}`);

  // Apagar la pantalla: abre el hueco y marca uso.
  sh('input keyevent KEYCODE_SLEEP');
  const off = waitFor((p) => (p['openAt.screen'] ?? 0) > (before?.['openAt.screen'] ?? 0) || (p['openAt.screen'] ?? 0) > 0);
  report(
    'SCREEN_OFF abre el hueco de pantalla',
    off.ok,
    off.ok ? `openAt.screen = ${clock(off.prefs['openAt.screen'])}` : 'openAt.screen sigue a 0',
  );

  const usedAfterOff = off.prefs?.lastUsedAt ?? 0;

  // Y volver: encender, quitar el bloqueo y comprobar que se cierra.
  sleep(1500);
  sh('input keyevent KEYCODE_WAKEUP');
  sleep(800);
  sh('wm dismiss-keyguard');
  const back = waitFor((p) => (p['openAt.screen'] ?? 0) === 0 && (p.lastUsedAt ?? 0) > usedAfterOff - 1);

  report(
    'el desbloqueo cierra el hueco',
    back.ok && (back.prefs?.['openAt.screen'] ?? 0) === 0,
    `openAt.screen = ${back.prefs ? clock(back.prefs['openAt.screen']) : '?'}`,
  );

  const now = deviceNow();
  const used = back.prefs?.lastUsedAt ?? 0;
  const fresh = used > 0 && now - used < 30_000;
  report(
    'el desbloqueo refresca «Último uso del móvil»',
    fresh,
    `lastUsedAt = ${clock(used)} (${ago(used, now)})`,
  );
}

/** Cargador: enchufar y desenchufar sin tocar el cable. */
function checkCharger() {
  console.log('\n  cargador (POWER_CONNECTED → POWER_DISCONNECTED)');
  sh('dumpsys battery unplug');
  sleep(1200);
  sh('dumpsys battery set ac 1');
  const on = waitFor((p) => (p['openAt.charger'] ?? 0) > 0);
  report(
    'POWER_CONNECTED abre el hueco del cargador',
    on.ok,
    on.ok ? `openAt.charger = ${clock(on.prefs['openAt.charger'])}` : 'openAt.charger sigue a 0',
  );

  sleep(1200);
  sh('dumpsys battery set ac 0');
  const off = waitFor((p) => (p['openAt.charger'] ?? 0) === 0);
  report('POWER_DISCONNECTED lo cierra', off.ok, off.ok ? '' : 'el hueco sigue abierto');

  sh('dumpsys battery reset');
}

/** Reposo profundo: forzar Doze y sacarlo. */
function checkIdle() {
  console.log('\n  reposo profundo (Doze)');
  sh('dumpsys battery unplug');
  sh('dumpsys deviceidle enable');
  // Doze exige pantalla apagada y batería desenchufada; los saltos de estado
  // los da `step` hasta llegar a IDLE.
  sh('input keyevent KEYCODE_SLEEP');
  sleep(1500);
  for (let i = 0; i < 6; i++) {
    const state = sh('dumpsys deviceidle step deep');
    if (/IDLE\b/.test(state) && !/IDLE_PENDING|IDLE_MAINTENANCE/.test(state)) break;
    sleep(600);
  }
  const on = waitFor((p) => (p['openAt.idle'] ?? 0) > 0, { timeoutMs: 12_000 });
  report(
    'entrar en Doze abre el hueco de reposo',
    on.ok,
    on.ok ? `openAt.idle = ${clock(on.prefs['openAt.idle'])}` : 'openAt.idle sigue a 0',
  );

  sh('dumpsys deviceidle unforce');
  sh('dumpsys battery reset');
  sh('input keyevent KEYCODE_WAKEUP');
  sleep(800);
  sh('wm dismiss-keyguard');
  const off = waitFor((p) => (p['openAt.idle'] ?? 0) === 0);
  report('volver al móvil lo cierra', off.ok, off.ok ? '' : 'el hueco de reposo sigue abierto');
}

/** «No molestar»: encenderlo y apagarlo desde el sistema. */
function checkDnd() {
  console.log('\n  no molestar');
  sh('cmd notification set_dnd priority');
  const on = waitFor((p) => (p['openAt.dnd'] ?? 0) > 0);
  report(
    'activar «no molestar» abre el hueco',
    on.ok,
    on.ok ? `openAt.dnd = ${clock(on.prefs['openAt.dnd'])}` : 'openAt.dnd sigue a 0',
  );

  sleep(1000);
  sh('cmd notification set_dnd off');
  const off = waitFor((p) => (p['openAt.dnd'] ?? 0) === 0);
  report('apagarlo lo cierra', off.ok, off.ok ? '' : 'el hueco sigue abierto');
}

const CHECKS = {
  screen: checkScreen,
  charger: checkCharger,
  idle: checkIdle,
  dnd: checkDnd,
};

/** Devuelve el móvil al estado en que estaba, pase lo que pase. */
function restore() {
  try {
    sh('dumpsys deviceidle unforce');
    sh('dumpsys battery reset');
    sh('cmd notification set_dnd off');
    sh('input keyevent KEYCODE_WAKEUP');
    sh('wm dismiss-keyguard');
  } catch {
    /* si el dispositivo ya no está, no hay nada que restaurar */
  }
}

// --- Ejecución ---------------------------------------------------------------

function main() {
  const wanted = process.argv.slice(2).filter((a) => a in CHECKS);
  const toRun = wanted.length ? wanted : Object.keys(CHECKS);

  serial = pickDevice();
  const model = sh('getprop ro.product.model');
  const release = sh('getprop ro.build.version.release');
  console.log(`\n--- Disparadores sobre ${model} (Android ${release}, ${serial}) ---`);

  if (!sh(`pm list packages ${PKG}`).includes(PKG)) {
    throw new Error(`PerfectRest no está instalado en el dispositivo (${PKG}).`);
  }

  const prefs = readPrefs();
  if (!prefs) {
    throw new Error(
      'No se pueden leer las preferencias del servicio.\n' +
        'La build instalada no es depurable: reinstala la de debug con\n' +
        '  npm run android:apk && adb install -r android/app/build/outputs/apk/debug/app-debug.apk',
    );
  }

  const now = deviceNow();
  const alive = serviceAlive(prefs, now);
  console.log('\n  estado del servicio');
  console.log(`    activado por el usuario : ${prefs.serviceEnabled ? 'sí' : 'no'}`);
  console.log(`    disparadores escuchados : ${prefs.triggers ?? '(ninguno)'}`);
  console.log(`    último latido           : ${clock(prefs.aliveAt)} (${ago(prefs.aliveAt, now)})`);
  console.log(`    en primer plano desde   : ${clock(prefs.startedAt)} (${ago(prefs.startedAt, now)})`);
  console.log(`    último uso del móvil    : ${clock(prefs.lastUsedAt)} (${ago(prefs.lastUsedAt, now)})`);
  console.log(`    último hueco encolado   : ${clock(prefs.lastGapAt)} (${ago(prefs.lastGapAt, now)})`);
  console.log(`    último fallo            : ${prefs.lastError ?? '—'}`);

  report('el servicio sigue vivo', alive === true, alive ? '' : 'sin latido reciente: no está escuchando nada');

  for (const name of toRun) {
    const listening = (prefs.triggers ?? '').split(',').includes(name);
    if (!listening) {
      console.log(`\n  ${name}: apagado en Ajustes, se omite`);
      continue;
    }
    CHECKS[name]();
  }

  console.log(
    failures ? `\n${failures} comprobación(es) fallidas\n` : '\nTodos los disparadores responden\n',
  );
}

try {
  main();
} catch (e) {
  console.error(`\n${e.message}\n`);
  failures = 1;
} finally {
  restore();
}

process.exit(failures ? 1 : 0);
