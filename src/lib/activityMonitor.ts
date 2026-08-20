import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { HOUR, MINUTE, inWindow, parseTime } from './time';
import { loadRaw, saveRaw } from './storage';
import { clearGaps, isBackgroundAvailable, readGaps } from './backgroundMonitor';
import { TRIGGERS, sortTriggers, triggerEnabled } from './triggers';
import { goalForDate } from './schedule';
import type {
  Confidence,
  MonitorSettings,
  ScheduleSettings,
  SleepSession,
  TriggerId,
} from './types';

/**
 * Módulo 3 — Detección del sueño por inactividad del dispositivo.
 *
 * La idea de fondo no cambia: mientras el usuario está despierto usa el móvil
 * cada cierto tiempo, y mientras duerme no. Lo que cambia es de dónde sale esa
 * señal. Hay varios disparadores, cada uno activable por separado:
 *
 *   screen    apagar la pantalla → desbloquear      (servicio nativo)
 *   charger   enchufar el cargador → desenchufarlo  (servicio nativo)
 *   appOpen   hueco entre dos aperturas de la app   (siempre)
 *   schedule  la meta del horario, a falta de todo  (siempre)
 *
 * Los tres primeros producen huecos que se evalúan igual; cuando dos caen
 * sobre la misma noche se fusionan en una única propuesta y la coincidencia
 * eleva la confianza. El cuarto sólo entra si la noche no dejó ninguna señal.
 *
 * Toda sesión se propone con un nivel de confianza y queda editable: ninguna
 * de estas señales mide el sueño, sólo el uso del dispositivo.
 */

const HEARTBEAT_KEY = 'perfectrest.heartbeat';
/** Última noche propuesta a partir del horario, para no repetirla. */
const SCHEDULE_MARK_KEY = 'perfectrest.scheduleProposal';
/** Cada cuánto se refresca el latido mientras la app está visible. */
const HEARTBEAT_INTERVAL = 30_000;

export interface DetectionResult {
  session: SleepSession;
  /** Duración del hueco de inactividad detectado, en ms. */
  gapMs: number;
}

/** Disparadores que dependen del servicio nativo. */
export const NATIVE_TRIGGERS: TriggerId[] = TRIGGERS.filter((t) => t.native).map((t) => t.id);

/** Los disparadores nativos que el usuario tiene activos ahora mismo. */
export function activeNativeTriggers(settings: MonitorSettings): TriggerId[] {
  return NATIVE_TRIGGERS.filter((id) => triggerEnabled(settings, id));
}

/**
 * Evalúa un hueco de inactividad y decide si merece proponerse como sueño.
 * Devuelve null cuando el hueco no cumple los criterios.
 */
export function evaluateGap(
  lastActive: number,
  now: number,
  settings: MonitorSettings,
  triggers: TriggerId[] = ['appOpen'],
): DetectionResult | null {
  const gapMs = now - lastActive;
  if (gapMs < settings.minGapMinutes * MINUTE) return null;

  const startDate = new Date(lastActive);
  const endDate = new Date(now);
  const startMin = startDate.getHours() * 60 + startDate.getMinutes();
  const endMin = endDate.getHours() * 60 + endDate.getMinutes();

  const nightStart = parseTime(settings.nightStart);
  const nightEnd = parseTime(settings.nightEnd);

  // El sueño empieza en la ventana nocturna, termina en ella, o la atraviesa
  // entera (quien se acuesta antes de la ventana y despierta después).
  const startsAtNight = inWindow(startMin, nightStart, nightEnd);
  const endsAtNight = inWindow(endMin, nightStart, nightEnd);
  const spansNight = gapMs >= 6 * HOUR;

  if (!startsAtNight && !endsAtNight && !spansNight) return null;

  return {
    gapMs,
    session: {
      id: `auto-${lastActive}`,
      start: lastActive,
      end: now,
      source: 'auto',
      confidence: scoreConfidence(gapMs, startsAtNight, endsAtNight, settings, triggers),
      confirmed: false,
      triggers: sortTriggers(triggers),
    },
  };
}

function scoreConfidence(
  gapMs: number,
  startsAtNight: boolean,
  endsAtNight: boolean,
  settings: MonitorSettings,
  triggers: TriggerId[],
): Confidence {
  const hours = gapMs / HOUR;
  const tooLong = gapMs > settings.maxGapMinutes * MINUTE;

  // Un hueco nocturno de duración plausible por ambos extremos es lo más
  // fiable que este método puede ofrecer.
  if (startsAtNight && endsAtNight && hours >= 4 && hours <= 11) return 'high';
  if (tooLong || hours < 3.5) return 'low';
  // Dos señales independientes sobre el mismo hueco valen más que una: si el
  // cargador y la pantalla coinciden, el margen de error se reduce mucho.
  if (startsAtNight || endsAtNight) {
    return new Set(triggers).size >= 2 ? 'high' : 'medium';
  }
  return 'low';
}

/**
 * Fusiona las detecciones que se solapan: dos disparadores distintos sobre la
 * misma noche describen un único sueño, no dos.
 *
 * Del solape se queda con la **intersección** (el inicio más tardío y el fin
 * más temprano), porque cada señal acota el sueño por fuera: el cargador se
 * enchufa antes de apagar la pantalla y se desenchufa después de desbloquear,
 * así que el tramo en el que todas coinciden es el más cercano al sueño real.
 */
export function mergeDetections(
  results: DetectionResult[],
  settings: MonitorSettings,
): DetectionResult[] {
  const sorted = [...results].sort((a, b) => a.session.start - b.session.start);
  const merged: DetectionResult[] = [];

  for (const result of sorted) {
    const prev = merged[merged.length - 1];
    if (!prev || result.session.start >= prev.session.end) {
      merged.push(result);
      continue;
    }

    const start = Math.max(prev.session.start, result.session.start);
    const end = Math.min(prev.session.end, result.session.end);
    const triggers = sortTriggers([
      ...(prev.session.triggers ?? []),
      ...(result.session.triggers ?? []),
    ]);
    // La intersección se vuelve a evaluar desde cero: puede quedarse corta y
    // dejar de ser plausible, en cuyo caso se conserva el hueco original.
    const fused = evaluateGap(start, end, settings, triggers);
    merged[merged.length - 1] = fused ?? {
      ...prev,
      session: { ...prev.session, triggers },
    };
  }

  return merged;
}

/**
 * Ajusta los bordes de la sesión: la inactividad empieza un poco antes de
 * dormirse de verdad (primero se suelta el móvil, luego se concilia el sueño)
 * y termina un poco después de despertar (nadie coge el móvil al instante).
 * Corregir ambos extremos acerca la estimación al sueño real en lugar de
 * medir simplemente el tiempo sin pantalla.
 */
export function refineEdges(session: SleepSession, latencyMinutes: number): SleepSession {
  // Una propuesta calcada del horario ya está expresada en tiempo de sueño:
  // corregirle los bordes descontaría la latencia dos veces.
  if (session.triggers?.length === 1 && session.triggers[0] === 'schedule') return session;

  const startBias = latencyMinutes * MINUTE; // tarda en dormirse
  const endBias = 5 * MINUTE; // tarda en coger el móvil
  const start = session.start + startBias;
  const end = session.end - endBias;
  if (end - start < 60 * MINUTE) return session;
  return { ...session, start, end };
}

/**
 * Procesa los huecos que el servicio nativo registró con la app cerrada.
 *
 * Estos huecos son mejores que los deducidos por la propia app: miden el
 * tiempo real entre que el dispositivo deja de usarse y el usuario vuelve a
 * él, en vez del tiempo entre dos aperturas de PerfectRest. Aun así pasan por
 * el mismo filtro de plausibilidad, y sólo se descartan de la cola nativa
 * cuando ya se han entregado.
 */
export async function collectNativeGaps(settings: MonitorSettings): Promise<DetectionResult[]> {
  if (!isBackgroundAvailable()) return [];

  const { gaps } = await readGaps();
  if (!gaps.length) return [];

  const results: DetectionResult[] = [];
  let processedUntil = 0;

  for (const gap of gaps) {
    processedUntil = Math.max(processedUntil, gap.end);
    // Un hueco puede haberse registrado con un disparador que el usuario ha
    // apagado desde entonces; en ese caso se descarta sin proponerlo.
    const triggers = [gap.startTrigger, gap.endTrigger].filter(Boolean);
    if (!triggers.every((id) => triggerEnabled(settings, id))) continue;

    const result = evaluateGap(gap.start, gap.end, settings, triggers);
    if (result) results.push(result);
  }

  // Sólo se borra hasta el último hueco leído: si el servicio encoló uno nuevo
  // entre la lectura y el borrado, sobrevive hasta la vuelta siguiente.
  await clearGaps(processedUntil);
  return mergeDetections(results, settings);
}

/**
 * Disparador de horario: cuando una noche no ha dejado ninguna otra señal, se
 * propone la sesión que marcaría la meta del usuario, siempre con confianza
 * baja y a la espera de que la corrija. Es el último recurso, pensado para
 * quien duerme sin bloqueo de pantalla y pasa días sin abrir la app.
 *
 * Devuelve null si el disparador está apagado, si la noche todavía no ha
 * terminado, si ya hay algo registrado en esa franja o si ya se propuso antes.
 */
export function proposeFromSchedule(
  schedule: ScheduleSettings,
  settings: MonitorSettings,
  sessions: SleepSession[],
  lastProposalKey: string | null,
  now: number = Date.now(),
): { result: DetectionResult; key: string } | null {
  if (!triggerEnabled(settings, 'schedule')) return null;

  // La noche que acaba de terminar es la de la última hora de despertar ya
  // pasada: si la de hoy aún no ha llegado, se retrocede a la de ayer.
  const wake = new Date(now);
  const todayMins = parseTime(goalForDate(schedule, wake).wakeTime);
  wake.setHours(Math.floor(todayMins / 60), todayMins % 60, 0, 0);
  if (wake.getTime() > now) {
    const yesterday = new Date(now - 24 * HOUR);
    const mins = parseTime(goalForDate(schedule, yesterday).wakeTime);
    wake.setTime(yesterday.getTime());
    wake.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
  }

  const wakeAt = wake.getTime();
  // Se dejan pasar un par de horas desde la hora de despertar: si el usuario
  // abre la app justo después, otra señal aún puede llegar y siempre es mejor.
  if (now - wakeAt < 2 * HOUR || now - wakeAt > 36 * HOUR) return null;

  const goal = goalForDate(schedule, wake);
  const start = wakeAt - goal.targetHours * HOUR;
  const key = wake.toDateString();
  if (lastProposalKey === key) return null;

  // Si algo cubre ya esa noche —detectado o registrado a mano— no hay nada que
  // proponer: el horario sólo rellena las noches sin datos.
  if (sessions.some((s) => start < s.end && s.start < wakeAt)) return null;

  return {
    key,
    result: {
      gapMs: wakeAt - start,
      session: {
        id: `schedule-${wakeAt}`,
        start,
        end: wakeAt,
        source: 'auto',
        confidence: 'low',
        confirmed: false,
        triggers: ['schedule'],
      },
    },
  };
}

/** Persiste el latido de actividad. */
export async function beat(now: number = Date.now()): Promise<void> {
  await saveRaw(HEARTBEAT_KEY, String(now));
}

/** Lee el último latido registrado. */
export async function readLastBeat(): Promise<number | null> {
  const raw = await loadRaw(HEARTBEAT_KEY);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Última noche propuesta por horario, para no repetirla en cada apertura. */
export async function readScheduleMark(): Promise<string | null> {
  return loadRaw(SCHEDULE_MARK_KEY);
}

export async function writeScheduleMark(key: string): Promise<void> {
  await saveRaw(SCHEDULE_MARK_KEY, key);
}

export interface MonitorHandle {
  stop: () => void;
  /** Fuerza una comprobación inmediata (p. ej. tras cambiar los ajustes). */
  check: () => Promise<void>;
}

export interface MonitorCallbacks {
  /** Cada sesión candidata nueva. */
  onDetect: (result: DetectionResult) => void;
  /** Último latido de la app, para que la UI lo refleje. */
  onBeat?: (ts: number) => void;
  /**
   * Último uso real del dispositivo según el servicio nativo. Es distinto del
   * latido: marca cuándo se usó el móvil, no cuándo se abrió la app.
   */
  onDeviceUse?: (ts: number) => void;
  /**
   * Una comprobación que no ha detectado nada. Es el punto donde el store
   * decide si aplicar el disparador de horario, que necesita datos que este
   * módulo no tiene (las metas y las sesiones ya registradas).
   */
  onQuiet?: (now: number) => void;
}

/**
 * Arranca el monitor. Escucha el ciclo de vida de la app para saber cuándo
 * volver a evaluar; el trabajo real de vigilar el dispositivo lo hace el
 * servicio nativo, que sigue vivo con la app cerrada.
 */
export function startMonitor(
  getSettings: () => MonitorSettings,
  callbacks: MonitorCallbacks,
): MonitorHandle {
  let stopped = false;
  const listeners: Array<() => void> = [];
  const { onDetect, onBeat, onDeviceUse, onQuiet } = callbacks;

  const check = async () => {
    if (stopped) return;
    const settings = getSettings();
    const now = Date.now();
    const last = await readLastBeat();
    let detected = 0;

    if (settings.enabled) {
      // Lo registrado en segundo plano tiene prioridad: es una medida directa
      // del uso del dispositivo, no una deducción a partir de la app.
      const native = activeNativeTriggers(settings).length
        ? await collectNativeGaps(settings)
        : [];
      for (const result of native) {
        if (!stopped) onDetect(result);
      }
      detected += native.length;

      // El hueco entre aperturas de la app sólo se usa cuando el servicio
      // nativo no aportó nada, para no proponer la misma noche dos veces.
      if (!native.length && last !== null && triggerEnabled(settings, 'appOpen')) {
        const result = evaluateGap(last, now, settings, ['appOpen']);
        if (result) {
          onDetect(result);
          detected += 1;
        }
      }

      if (isBackgroundAvailable()) {
        const { lastUsedAt } = await readGaps();
        if (lastUsedAt > 0) onDeviceUse?.(lastUsedAt);
      }
    }

    await beat(now);
    onBeat?.(now);
    if (detected === 0 && settings.enabled && !stopped) onQuiet?.(now);
  };

  // Un latido periódico no evalúa huecos: sólo mantiene fresca la marca
  // mientras la app está delante del usuario.
  const tick = async () => {
    if (stopped) return;
    const now = Date.now();
    await beat(now);
    onBeat?.(now);
  };

  // Al volver del segundo plano es cuando el hueco resulta informativo.
  if (Capacitor.isNativePlatform()) {
    void App.addListener('appStateChange', ({ isActive }) => {
      if (isActive) void check();
      else void beat();
    }).then((h) => listeners.push(() => void h.remove()));
  }

  const onVisibility = () => {
    if (document.visibilityState === 'visible') void check();
    else void beat();
  };
  document.addEventListener('visibilitychange', onVisibility);
  listeners.push(() => document.removeEventListener('visibilitychange', onVisibility));

  window.addEventListener('focus', onVisibility);
  listeners.push(() => window.removeEventListener('focus', onVisibility));

  const timer = window.setInterval(() => void tick(), HEARTBEAT_INTERVAL);
  void check();

  return {
    stop: () => {
      stopped = true;
      window.clearInterval(timer);
      listeners.forEach((off) => off());
    },
    check,
  };
}
