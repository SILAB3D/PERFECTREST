import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { bedtimesForWake, bestOption } from './cycles';
import { upcomingNight } from './schedule';
import { MINUTE, formatClock, isoDay } from './time';
import type { CycleSettings, ReminderSettings, ScheduleSettings } from './types';

/**
 * Módulo 1 (avisos) — Recordatorios para acostarse a la hora propuesta.
 *
 * Se programan notificaciones repetidas semanalmente, una por día y tipo, de
 * forma que el APK las siga disparando aunque la app esté cerrada. En el
 * navegador se usa la Notification API como sustituto durante el desarrollo.
 */

const isNative = Capacitor.isNativePlatform();

/** Rangos de id fijos por tipo, para poder reprogramar sin duplicar. */
const ID_WIND_DOWN = 100;
const ID_BEDTIME = 200;
const ID_LATE = 300;
const ID_WAKE = 400;

export type PermissionState = 'granted' | 'denied' | 'unsupported' | 'prompt';

export async function requestPermission(): Promise<PermissionState> {
  if (isNative) {
    const res = await LocalNotifications.requestPermissions();
    return res.display === 'granted' ? 'granted' : 'denied';
  }
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  const res = await Notification.requestPermission();
  return res === 'granted' ? 'granted' : 'denied';
}

export async function currentPermission(): Promise<PermissionState> {
  if (isNative) {
    const res = await LocalNotifications.checkPermissions();
    if (res.display === 'granted') return 'granted';
    if (res.display === 'denied') return 'denied';
    return 'prompt';
  }
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission === 'default' ? 'prompt' : (Notification.permission as PermissionState);
}

interface PlannedNotification {
  id: number;
  title: string;
  body: string;
  /** Día ISO (1-7) en el que se dispara. */
  isoWeekday: number;
  hour: number;
  minute: number;
}

/**
 * Calcula todos los avisos de la semana a partir de las metas y los ciclos.
 * Se expone aparte de la programación para poder mostrarlos en la UI.
 */
export function planWeek(
  schedule: ScheduleSettings,
  cycles: CycleSettings,
  reminders: ReminderSettings,
): PlannedNotification[] {
  const out: PlannedNotification[] = [];
  if (!reminders.enabled) return out;

  // Se recorren los 7 próximos días para resolver cada meta en su fecha real.
  const base = new Date();
  for (let i = 0; i < 7; i++) {
    const date = new Date(base.getTime() + i * 86_400_000);
    const day = isoDay(date);
    const goal = schedule.goals[day];

    const wake = new Date(date);
    const [wh, wm] = goal.wakeTime.split(':').map(Number);
    wake.setHours(wh, wm, 0, 0);

    const ideal = bestOption(bedtimesForWake(wake, cycles, goal.targetHours)).bedtime;
    // La hora de acostarse suele caer en el día anterior al de despertar.
    const bedDay = isoDay(ideal);

    const windDown = new Date(ideal.getTime() - reminders.windDownMinutes * MINUTE);
    out.push({
      id: ID_WIND_DOWN + day,
      title: 'Hora de bajar el ritmo',
      body: `Acuéstate a las ${formatClock(ideal)} para despertar descansado a las ${goal.wakeTime}.`,
      isoWeekday: isoDay(windDown),
      hour: windDown.getHours(),
      minute: windDown.getMinutes(),
    });

    out.push({
      id: ID_BEDTIME + day,
      title: 'Es tu hora de dormir',
      body: `Acostándote ahora completas ${goal.targetHours}h y despiertas al final de un ciclo.`,
      isoWeekday: bedDay,
      hour: ideal.getHours(),
      minute: ideal.getMinutes(),
    });

    if (reminders.nagIfLate) {
      const late = new Date(ideal.getTime() + reminders.toleranceMinutes * MINUTE);
      out.push({
        id: ID_LATE + day,
        title: 'Se te está pasando la hora',
        body: 'Cada 15 minutos de más hoy son 15 menos de descanso mañana.',
        isoWeekday: isoDay(late),
        hour: late.getHours(),
        minute: late.getMinutes(),
      });
    }

    if (reminders.wakeAlarm) {
      out.push({
        id: ID_WAKE + day,
        title: 'Buenos días',
        body: 'Final de ciclo: es el mejor momento para levantarte.',
        isoWeekday: day,
        hour: wake.getHours(),
        minute: wake.getMinutes(),
      });
    }
  }

  // Un aviso por id: los días repetidos ya quedan cubiertos por la repetición
  // semanal, así que basta con la primera aparición de cada uno.
  const seen = new Set<number>();
  return out.filter((n) => (seen.has(n.id) ? false : (seen.add(n.id), true)));
}

/** Reprograma todos los avisos. Idempotente: primero limpia los anteriores. */
export async function rescheduleAll(
  schedule: ScheduleSettings,
  cycles: CycleSettings,
  reminders: ReminderSettings,
): Promise<{ scheduled: number; error?: string }> {
  const plan = planWeek(schedule, cycles, reminders);

  if (!isNative) {
    // En el navegador no hay programación persistente; los avisos inminentes
    // los cubre el temporizador en memoria de `scheduleForegroundReminders`.
    return { scheduled: plan.length };
  }

  try {
    const pending = await LocalNotifications.getPending();
    if (pending.notifications.length) {
      await LocalNotifications.cancel({ notifications: pending.notifications });
    }
    if (!plan.length) return { scheduled: 0 };

    await LocalNotifications.schedule({
      notifications: plan.map((n) => ({
        id: n.id,
        title: n.title,
        body: n.body,
        schedule: {
          on: { weekday: (n.isoWeekday % 7) + 1, hour: n.hour, minute: n.minute },
          allowWhileIdle: true,
          repeats: true,
        },
        smallIcon: 'ic_stat_icon',
        channelId: 'perfectrest-sleep',
      })),
    });
    return { scheduled: plan.length };
  } catch (e) {
    return { scheduled: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Notificación inmediata (prueba manual desde ajustes). */
export async function notifyNow(title: string, body: string): Promise<void> {
  if (isNative) {
    await LocalNotifications.schedule({
      notifications: [{ id: Math.floor(Math.random() * 10000) + 9000, title, body, channelId: 'perfectrest-sleep' }],
    });
    return;
  }
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    new Notification(title, { body });
  }
}

/** Crea el canal de notificaciones en Android (obligatorio desde Android 8). */
export async function ensureChannel(): Promise<void> {
  if (!isNative) return;
  try {
    await LocalNotifications.createChannel({
      id: 'perfectrest-sleep',
      name: 'Recordatorios de sueño',
      description: 'Avisos para acostarte y despertar a tu hora',
      importance: 4,
      visibility: 1,
    });
  } catch {
    /* algunos dispositivos rechazan la recreación del canal: no es crítico */
  }
}

/**
 * Avisos en primer plano para el desarrollo en navegador: mientras la pestaña
 * vive, dispara los recordatorios de las próximas horas con setTimeout.
 */
export function scheduleForegroundReminders(
  schedule: ScheduleSettings,
  cycles: CycleSettings,
  reminders: ReminderSettings,
): () => void {
  if (isNative || !reminders.enabled) return () => {};

  const timers: number[] = [];
  const now = new Date();
  const { goal, wakeAt } = upcomingNight(schedule, now);
  const ideal = bestOption(bedtimesForWake(wakeAt, cycles, goal.targetHours)).bedtime;

  const events: Array<[Date, string, string]> = [
    [new Date(ideal.getTime() - reminders.windDownMinutes * MINUTE), 'Hora de bajar el ritmo', `Acuéstate a las ${formatClock(ideal)}.`],
    [ideal, 'Es tu hora de dormir', `Despertarás a las ${formatClock(wakeAt)} al final de un ciclo.`],
  ];
  if (reminders.nagIfLate) {
    events.push([
      new Date(ideal.getTime() + reminders.toleranceMinutes * MINUTE),
      'Se te está pasando la hora',
      'Cada minuto de más hoy es uno menos de descanso mañana.',
    ]);
  }

  for (const [when, title, body] of events) {
    const delay = when.getTime() - Date.now();
    // setTimeout no admite retardos mayores de ~24,8 días; aquí nunca se
    // acerca, pero se descartan los pasados igualmente.
    if (delay > 0 && delay < 86_400_000) {
      timers.push(window.setTimeout(() => void notifyNow(title, body), delay));
    }
  }

  return () => timers.forEach((t) => window.clearTimeout(t));
}
