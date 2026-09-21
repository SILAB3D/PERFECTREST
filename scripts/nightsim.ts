/**
 * Simulación de noches completas, del evento de Android a la sesión propuesta.
 *
 * El problema que resuelve: las comprobaciones de `selfcheck.ts` entran por la
 * mitad de la tubería. Le dan a `evaluateGap` un hueco ya formado y comprueban
 * que lo puntúa bien, pero el hueco se lo inventa la propia prueba. Lo que
 * fallaba de verdad estaba antes: en cómo el servicio nativo convierte una
 * ristra de eventos del sistema en huecos, y en cómo la capa web funde esos
 * huecos. Una noche real no produce un hueco limpio de 23:30 a 07:00; produce
 * media docena de trozos, porque Android sale de Doze en cada ventana de
 * mantenimiento y la pantalla se enciende sola con cada notificación.
 *
 * Aquí se simula la noche entera:
 *
 *   eventos de Android -> máquina de estados del servicio -> huecos ->
 *   evaluateGaps() -> refineEdges() -> sesión propuesta
 *
 * El segundo tramo es el código real (`src/lib/activityMonitor.ts`). El
 * primero es un modelo de {@link SleepMonitorService}, porque está en Java y
 * no se puede importar. El modelo es la parte frágil de todo esto: si se toca
 * `openGap` o `closeGap` en el servicio, hay que tocarlos aquí, y la marca
 * `SPEC:` señala cada regla que debe coincidir línea por línea con el Java.
 *
 *   npm run check
 */
import {
  evaluateGaps,
  refineEdges,
  type DetectionResult,
} from '../src/lib/activityMonitor';
import type { NativeGap } from '../src/lib/backgroundMonitor';
import { DEFAULT_TRIGGERS } from '../src/lib/triggers';
import { formatDuration } from '../src/lib/time';
import type { MonitorSettings, SleepSession, TriggerId } from '../src/lib/types';

let failures = 0;
function assert(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}`, extra ?? '');
  }
}

// --- Modelo del servicio nativo -------------------------------------------

/** Los eventos del sistema que el servicio sabe escuchar. */
type Action =
  | 'SCREEN_OFF'
  | 'SCREEN_ON'
  | 'USER_PRESENT'
  | 'POWER_CONNECTED'
  | 'POWER_DISCONNECTED'
  | 'IDLE_ON'
  | 'IDLE_OFF'
  | 'DND_ON'
  | 'DND_OFF'
  /** El servicio arranca o se rearma: mira en qué estado encuentra el móvil. */
  | 'SERVICE_START';

interface Event {
  at: number;
  action: Action;
}

interface Device {
  /** ¿Exige PIN, patrón o huella? Cambia qué señal cierra el hueco. */
  keyguardSecure: boolean;
  /** Estado de la pantalla, que el modelo va siguiendo. */
  interactive: boolean;
  idle: boolean;
  dnd: boolean;
}

/** SPEC: SleepMonitorService.REOPEN_GRACE_MS */
const REOPEN_GRACE_MS = 15 * 60_000;

class ServiceModel {
  private openAt = new Map<TriggerId, number>();
  private shortOpen = new Map<TriggerId, number>();
  private shortClose = new Map<TriggerId, number>();
  readonly gaps: NativeGap[] = [];
  /** Avisos «has dormido X» que el servicio habría emitido. */
  readonly summaries: Array<{ at: number; start: number; end: number }> = [];
  private lastSummaryAt = 0;
  lastUsedAt = 0;

  constructor(
    private readonly on: TriggerId[],
    private readonly minGapMs: number,
    private readonly device: Device,
    private readonly nightStartMin = 21 * 60 + 30,
    private readonly nightEndMin = 11 * 60,
  ) {}

  private enabled(id: TriggerId): boolean {
    return this.on.includes(id);
  }

  /** SPEC: SleepMonitorService.openGap */
  private open(trigger: TriggerId, now: number, marksUse: boolean): void {
    if (!this.enabled(trigger)) return;
    if ((this.openAt.get(trigger) ?? 0) > 0) return;

    let at = now;
    const closedAt = this.shortClose.get(trigger) ?? 0;
    const resumeFrom = this.shortOpen.get(trigger) ?? 0;
    // Una interrupción breve no parte la noche: se reanuda el hueco anterior.
    if (closedAt > 0 && resumeFrom > 0 && now - closedAt <= REOPEN_GRACE_MS) {
      at = resumeFrom;
    }

    this.openAt.set(trigger, at);
    this.shortClose.delete(trigger);
    this.shortOpen.delete(trigger);
    if (marksUse) this.lastUsedAt = now;
  }

  /** SPEC: SleepMonitorService.closeGap */
  private close(trigger: TriggerId, now: number, marksUse: boolean): void {
    if (!this.enabled(trigger)) return;
    const openedAt = this.openAt.get(trigger) ?? 0;

    if (openedAt > 0) {
      const elapsed = now - openedAt;
      if (elapsed >= this.minGapMs) {
        this.gaps.push({ start: openedAt, end: now, startTrigger: trigger, endTrigger: trigger });
        this.shortOpen.delete(trigger);
        this.shortClose.delete(trigger);
        this.maybeSummary(openedAt, now);
      } else {
        // Se recuerda por si esto era una interrupción y no el final.
        this.shortOpen.set(trigger, openedAt);
        this.shortClose.set(trigger, now);
      }
    }

    this.openAt.set(trigger, 0);
    if (marksUse) this.lastUsedAt = now;
  }

  /** SPEC: SleepMonitorService.maybeNotifySummary */
  private maybeSummary(start: number, end: number): void {
    if (!this.inNight(start) && !this.inNight(end)) return;
    // Dos disparadores cerrando la misma mañana son un aviso, no dos.
    if (end - this.lastSummaryAt < 6 * 3_600_000) return;
    this.lastSummaryAt = end;
    this.summaries.push({ at: end, start, end });
  }

  private inNight(ts: number): boolean {
    const d = new Date(ts);
    const m = d.getHours() * 60 + d.getMinutes();
    return this.nightStartMin <= this.nightEndMin
      ? m >= this.nightStartMin && m <= this.nightEndMin
      : m >= this.nightStartMin || m <= this.nightEndMin;
  }

  /** SPEC: SleepMonitorService.handleEvent */
  handle({ at, action }: Event): void {
    const dev = this.device;
    switch (action) {
      case 'SCREEN_OFF':
        dev.interactive = false;
        this.open('screen', at, true);
        break;

      case 'SCREEN_ON':
        dev.interactive = true;
        // Sin bloqueo seguro no hay USER_PRESENT: encender es volver.
        if (!dev.keyguardSecure) {
          this.close('screen', at, true);
          this.close('idle', at, true);
        }
        break;

      case 'USER_PRESENT':
        dev.interactive = true;
        this.close('screen', at, true);
        // Doze puede haber salido ya con la pantalla apagada, o no haber
        // salido todavía: en ambos casos el usuario está de vuelta.
        this.close('idle', at, true);
        break;

      case 'POWER_CONNECTED':
        this.open('charger', at, false);
        break;

      case 'POWER_DISCONNECTED':
        this.close('charger', at, false);
        break;

      case 'IDLE_ON':
        dev.idle = true;
        this.open('idle', at, false);
        break;

      case 'IDLE_OFF':
        dev.idle = false;
        // Salir de Doze con la pantalla apagada es una ventana de
        // mantenimiento del sistema, no el usuario cogiendo el móvil.
        if (dev.interactive) this.close('idle', at, true);
        break;

      case 'DND_ON':
        dev.dnd = true;
        this.open('dnd', at, false);
        break;

      case 'DND_OFF':
        dev.dnd = false;
        this.close('dnd', at, false);
        break;

      case 'SERVICE_START':
        // SPEC: SleepMonitorService.primeScreenState
        if (!dev.interactive) this.open('screen', at, false);
        if (dev.idle) this.open('idle', at, false);
        if (dev.dnd) this.open('dnd', at, false);
        break;
    }
  }
}

// --- Escenarios -------------------------------------------------------------

const MON: MonitorSettings = {
  enabled: true,
  minGapMinutes: 180,
  maxGapMinutes: 780,
  nightStart: '21:30',
  nightEnd: '11:00',
  autoConfirm: false,
  background: true,
  wakeSummary: true,
  triggers: { ...DEFAULT_TRIGGERS },
};

const t = (iso: string) => new Date(iso).getTime();
const ev = (iso: string, action: Action): Event => ({ at: t(iso), action });

interface Night {
  name: string;
  triggers: TriggerId[];
  device: Partial<Device>;
  events: Event[];
  /** Lo que de verdad durmió el usuario, para comparar. */
  truth: { start: string; end: string };
  /** Cuántos avisos «has dormido X» debería haber emitido el servicio. */
  summaries?: number;
  settings?: Partial<MonitorSettings>;
}

const NIGHTS: Night[] = [
  {
    // El caso que rompía todo: Doze no es un tramo continuo. Android sale del
    // reposo profundo cada pocas horas para dejar correr las tareas
    // pendientes y vuelve a entrar; la pantalla no se enciende y el usuario
    // sigue durmiendo, pero el servicio lo veía como «ha vuelto al móvil».
    name: 'noche normal con ventanas de mantenimiento de Doze',
    triggers: ['screen', 'idle'],
    device: { keyguardSecure: true, interactive: false },
    truth: { start: '2026-09-18T23:30:00', end: '2026-09-19T07:00:00' },
    summaries: 1,
    events: [
      ev('2026-09-18T23:30:00', 'SCREEN_OFF'),
      ev('2026-09-18T23:45:00', 'IDLE_ON'),
      ev('2026-09-19T01:20:00', 'IDLE_OFF'),
      ev('2026-09-19T01:29:00', 'IDLE_ON'),
      ev('2026-09-19T03:00:00', 'IDLE_OFF'),
      ev('2026-09-19T03:08:00', 'IDLE_ON'),
      ev('2026-09-19T05:40:00', 'IDLE_OFF'),
      ev('2026-09-19T05:49:00', 'IDLE_ON'),
      ev('2026-09-19T07:00:00', 'IDLE_OFF'),
      ev('2026-09-19T07:00:00', 'SCREEN_ON'),
      ev('2026-09-19T07:00:05', 'USER_PRESENT'),
    ],
  },
  {
    // Sin bloqueo seguro Android nunca emite USER_PRESENT, así que encender la
    // pantalla es la única señal de vuelta. El precio es que cada notificación
    // que despierta la pantalla parece una vuelta al móvil.
    name: 'sin bloqueo seguro, con notificaciones que encienden la pantalla',
    triggers: ['screen'],
    device: { keyguardSecure: false, interactive: false },
    truth: { start: '2026-09-18T23:10:00', end: '2026-09-19T06:45:00' },
    summaries: 1,
    events: [
      ev('2026-09-18T23:10:00', 'SCREEN_OFF'),
      ev('2026-09-19T00:42:00', 'SCREEN_ON'),
      ev('2026-09-19T00:42:20', 'SCREEN_OFF'),
      ev('2026-09-19T02:15:00', 'SCREEN_ON'),
      ev('2026-09-19T02:15:15', 'SCREEN_OFF'),
      ev('2026-09-19T04:58:00', 'SCREEN_ON'),
      ev('2026-09-19T04:58:30', 'SCREEN_OFF'),
      ev('2026-09-19T06:45:00', 'SCREEN_ON'),
    ],
  },
  {
    // El cargador acota por fuera: se enchufa antes de soltar el móvil y se
    // desenchufa después de cogerlo. La pantalla es más ajustada y debe mandar.
    name: 'cargador y pantalla sobre la misma noche',
    triggers: ['screen', 'charger'],
    device: { keyguardSecure: true, interactive: false },
    truth: { start: '2026-09-18T23:20:00', end: '2026-09-19T07:10:00' },
    summaries: 1,
    events: [
      ev('2026-09-18T22:40:00', 'POWER_CONNECTED'),
      ev('2026-09-18T23:20:00', 'SCREEN_OFF'),
      ev('2026-09-19T07:10:00', 'USER_PRESENT'),
      ev('2026-09-19T07:40:00', 'POWER_DISCONNECTED'),
    ],
  },
  {
    // Quien duerme sin bloqueo de pantalla depende sólo de Doze; los trozos
    // que deja el mantenimiento tienen que unirse en una única noche.
    name: 'sólo Doze, sin disparador de pantalla',
    triggers: ['idle'],
    device: { keyguardSecure: false, interactive: false },
    truth: { start: '2026-09-18T23:50:00', end: '2026-09-19T07:05:00' },
    summaries: 1,
    events: [
      ev('2026-09-18T23:50:00', 'IDLE_ON'),
      ev('2026-09-19T02:30:00', 'IDLE_OFF'),
      ev('2026-09-19T02:39:00', 'IDLE_ON'),
      ev('2026-09-19T05:10:00', 'IDLE_OFF'),
      ev('2026-09-19T05:18:00', 'IDLE_ON'),
      ev('2026-09-19T07:05:00', 'SCREEN_ON'),
      ev('2026-09-19T07:05:10', 'IDLE_OFF'),
    ],
  },
  {
    // «No molestar» expresa intención: quien lo enciende al acostarse está
    // diciendo la hora. Aquí es la única señal, porque el móvil pasa la noche
    // recibiendo avisos y nunca llega a entrar en Doze.
    name: 'noche marcada sólo con «no molestar»',
    triggers: ['dnd', 'screen'],
    device: { keyguardSecure: true, interactive: false },
    truth: { start: '2026-09-18T23:00:00', end: '2026-09-19T07:30:00' },
    summaries: 1,
    events: [
      ev('2026-09-18T23:00:00', 'DND_ON'),
      ev('2026-09-18T23:02:00', 'SCREEN_OFF'),
      ev('2026-09-19T07:30:00', 'DND_OFF'),
      ev('2026-09-19T07:31:00', 'USER_PRESENT'),
    ],
  },
  {
    // Android mató el servicio de madrugada y la alarma de vigilancia lo
    // rearmó. El hueco abierto sobrevive en preferencias, así que la noche no
    // debe perderse ni empezar de nuevo a la hora del rearme.
    name: 'el sistema mata el servicio y el vigilante lo rearma',
    triggers: ['screen'],
    device: { keyguardSecure: true, interactive: false },
    truth: { start: '2026-09-18T23:15:00', end: '2026-09-19T06:50:00' },
    summaries: 1,
    events: [
      ev('2026-09-18T23:15:00', 'SCREEN_OFF'),
      ev('2026-09-19T02:00:00', 'SERVICE_START'),
      ev('2026-09-19T04:30:00', 'SERVICE_START'),
      ev('2026-09-19T06:50:00', 'USER_PRESENT'),
    ],
  },
  {
    // Levantarse al baño a las cuatro no parte la noche en dos sesiones.
    name: 'despertar breve de madrugada',
    triggers: ['screen'],
    device: { keyguardSecure: true, interactive: false },
    truth: { start: '2026-09-18T23:00:00', end: '2026-09-19T07:20:00' },
    summaries: 1,
    events: [
      ev('2026-09-18T23:00:00', 'SCREEN_OFF'),
      ev('2026-09-19T04:05:00', 'SCREEN_ON'),
      ev('2026-09-19T04:05:30', 'USER_PRESENT'),
      ev('2026-09-19T04:11:00', 'SCREEN_OFF'),
      ev('2026-09-19T07:20:00', 'USER_PRESENT'),
    ],
  },
];

// --- Ejecución --------------------------------------------------------------

console.log('\n--- Simulación de noches completas ---');

/** Tolerancia al comparar con la verdad: los bordes se corrigen a propósito. */
const TOLERANCE_MS = 25 * 60_000;

function runNight(night: Night): {
  gaps: NativeGap[];
  sessions: SleepSession[];
  summaries: number;
} {
  const device: Device = {
    keyguardSecure: true,
    interactive: false,
    idle: false,
    dnd: false,
    ...night.device,
  };
  const settings: MonitorSettings = {
    ...MON,
    ...night.settings,
    triggers: Object.fromEntries(
      Object.keys(DEFAULT_TRIGGERS).map((id) => [id, night.triggers.includes(id as TriggerId)]),
    ) as MonitorSettings['triggers'],
  };

  const service = new ServiceModel(
    night.triggers,
    settings.minGapMinutes * 60_000,
    device,
  );
  for (const event of night.events) service.handle(event);

  const { results } = evaluateGaps(service.gaps, settings);
  return {
    gaps: service.gaps,
    summaries: service.summaries.length,
    sessions: results.map((r: DetectionResult) => refineEdges(r.session, 15)),
  };
}

for (const night of NIGHTS) {
  const { gaps, sessions, summaries } = runNight(night);
  const truthStart = t(night.truth.start);
  const truthEnd = t(night.truth.end);
  const truthMs = truthEnd - truthStart;

  const shown = sessions
    .map((s) => `${formatDuration(s.end - s.start)} (${new Date(s.start).toTimeString().slice(0, 5)}→${new Date(s.end).toTimeString().slice(0, 5)})`)
    .join(', ');

  assert(
    `${night.name}: una sola sesión`,
    sessions.length === 1,
    `${sessions.length} sesiones de ${gaps.length} huecos: ${shown || '—'}`,
  );

  if (sessions.length === 1) {
    const s = sessions[0];
    assert(
      `${night.name}: duración ≈ ${formatDuration(truthMs)}`,
      Math.abs(s.end - s.start - truthMs) <= TOLERANCE_MS,
      `detectado ${formatDuration(s.end - s.start)}, real ${formatDuration(truthMs)}`,
    );
    assert(
      `${night.name}: bordes correctos`,
      Math.abs(s.start - truthStart) <= TOLERANCE_MS && Math.abs(s.end - truthEnd) <= TOLERANCE_MS,
      shown,
    );
  }

  if (night.summaries !== undefined) {
    assert(
      `${night.name}: ${night.summaries} aviso(s) al despertar`,
      summaries === night.summaries,
      `emitidos ${summaries}`,
    );
  }
}

console.log('\n--- Regresiones concretas ---');

// El fallo original, aislado: un fragmento de Doze no debe recortar la noche
// que la pantalla midió entera. Con la fusión por intersección, el resultado
// era el fragmento (3h15) más una segunda sesión inventada.
const fragmentada: NativeGap[] = [
  { start: t('2026-09-18T23:30:00'), end: t('2026-09-19T07:00:00'), startTrigger: 'screen', endTrigger: 'screen' },
  { start: t('2026-09-18T23:45:00'), end: t('2026-09-19T03:00:00'), startTrigger: 'idle', endTrigger: 'idle' },
  { start: t('2026-09-19T03:08:00'), end: t('2026-09-19T07:00:00'), startTrigger: 'idle', endTrigger: 'idle' },
];
const { results: fus } = evaluateGaps(fragmentada, MON);
assert('un fragmento de Doze no recorta la noche de la pantalla', fus.length === 1, fus.length);
assert(
  'y la noche conserva sus 7h30',
  fus.length === 1 && fus[0].session.end - fus[0].session.start === 7.5 * 3_600_000,
  fus.length === 1 && formatDuration(fus[0].session.end - fus[0].session.start),
);
assert(
  'con los dos disparadores como origen',
  fus.length === 1 && new Set(fus[0].session.triggers).size === 2,
  fus.length === 1 && fus[0].session.triggers,
);

// Dos noches distintas siguen siendo dos: el agrupado salva interrupciones
// cortas, no días enteros.
const dosNoches: NativeGap[] = [
  { start: t('2026-09-17T23:30:00'), end: t('2026-09-18T07:00:00'), startTrigger: 'screen', endTrigger: 'screen' },
  { start: t('2026-09-18T23:30:00'), end: t('2026-09-19T07:00:00'), startTrigger: 'screen', endTrigger: 'screen' },
];
assert('dos noches separadas no se funden', evaluateGaps(dosNoches, MON).results.length === 2);

// Un disparador apagado después de registrar el hueco no propone nada.
const soloCargador: NativeGap[] = [
  { start: t('2026-09-18T23:30:00'), end: t('2026-09-19T07:00:00'), startTrigger: 'charger', endTrigger: 'charger' },
];
const apagado = evaluateGaps(soloCargador, { ...MON, triggers: { ...DEFAULT_TRIGGERS, charger: false } });
assert('un hueco de un disparador apagado se descarta', apagado.results.length === 0);
assert('y queda anotado el motivo', apagado.rejected[0]?.reason === 'trigger-off');

console.log(failures ? `\n${failures} comprobación(es) fallidas` : '\nTodo correcto');
process.exit(failures ? 1 : 0);
