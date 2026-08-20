import { ALL_DAYS, MINUTE, isoDay, nextOccurrence, parseTime, WEEKDAYS } from './time';
import type { DayGoal, DayIndex, ScheduleMode, ScheduleSettings } from './types';

/**
 * Módulo 1 — Metas de sueño.
 *
 * El estado siempre guarda los siete días. El modo sólo decide qué días se
 * editan a la vez, de forma que cambiar de modo nunca pierde información:
 * al volver a 'per-day' reaparecen los valores individuales previos.
 */

/** Días que se editan juntos con un día dado, según el modo. */
export function linkedDays(mode: ScheduleMode, day: DayIndex): DayIndex[] {
  if (mode === 'uniform') return ALL_DAYS;
  if (mode === 'weekday-weekend') return WEEKDAYS.includes(day) ? [1, 2, 3, 4, 5] : [6, 7];
  return [day];
}

/** Grupos de edición que muestra la UI para el modo activo. */
export function editGroups(mode: ScheduleMode): { label: string; days: DayIndex[] }[] {
  if (mode === 'uniform') return [{ label: 'Todos los días', days: ALL_DAYS }];
  if (mode === 'weekday-weekend') {
    return [
      { label: 'Entre semana', days: [1, 2, 3, 4, 5] },
      { label: 'Fin de semana', days: [6, 7] },
    ];
  }
  return ALL_DAYS.map((d) => ({ label: '', days: [d] }));
}

/** Aplica un cambio de meta propagándolo a los días enlazados por el modo. */
export function applyGoal(
  schedule: ScheduleSettings,
  day: DayIndex,
  patch: Partial<DayGoal>,
): ScheduleSettings {
  const goals = { ...schedule.goals };
  for (const d of linkedDays(schedule.mode, day)) {
    goals[d] = { ...goals[d], ...patch };
  }
  return { ...schedule, goals };
}

/**
 * Al cambiar de modo, normaliza los días para que el grupo sea coherente:
 * se toma el valor del primer día del grupo como referencia.
 */
export function normalizeForMode(schedule: ScheduleSettings, mode: ScheduleMode): ScheduleSettings {
  const goals = { ...schedule.goals };
  for (const group of editGroups(mode)) {
    const ref = goals[group.days[0]];
    for (const d of group.days) goals[d] = { ...ref };
  }
  return { mode, goals };
}

/** La meta que aplica a un instante dado (según el día de la semana). */
export function goalForDate(schedule: ScheduleSettings, date: Date): DayGoal {
  return schedule.goals[isoDay(date)];
}

/**
 * La meta de la próxima noche: si aún no ha pasado la hora de despertar de
 * hoy, la noche en curso es la de hoy; si ya pasó, la de mañana.
 */
export function upcomingNight(schedule: ScheduleSettings, now: Date = new Date()): {
  day: DayIndex;
  goal: DayGoal;
  wakeAt: Date;
} {
  const todayGoal = schedule.goals[isoDay(now)];
  const todayWake = new Date(now);
  const mins = parseTime(todayGoal.wakeTime);
  todayWake.setHours(Math.floor(mins / 60), mins % 60, 0, 0);

  if (todayWake.getTime() > now.getTime()) {
    return { day: isoDay(now), goal: todayGoal, wakeAt: todayWake };
  }
  const tomorrow = new Date(now.getTime() + 86_400_000);
  const day = isoDay(tomorrow);
  const goal = schedule.goals[day];
  return { day, goal, wakeAt: nextOccurrence(goal.wakeTime, now) };
}

/**
 * Rango de tolerancia alrededor de la hora ideal de acostarse.
 * "Poco flexible" a propósito: la constancia del horario pesa más que la
 * duración puntual, así que el margen por defecto es estrecho.
 */
export function bedtimeWindow(ideal: Date, toleranceMinutes: number): { from: Date; to: Date } {
  return {
    from: new Date(ideal.getTime() - toleranceMinutes * MINUTE),
    to: new Date(ideal.getTime() + toleranceMinutes * MINUTE),
  };
}

/** Estado del usuario respecto a su ventana de acostarse ahora mismo. */
export type BedtimeStatus = 'lejos' | 'preparacion' | 'ventana' | 'tarde';

export function bedtimeStatus(
  now: Date,
  ideal: Date,
  toleranceMinutes: number,
  windDownMinutes: number,
): BedtimeStatus {
  const { from, to } = bedtimeWindow(ideal, toleranceMinutes);
  const t = now.getTime();
  if (t > to.getTime()) return 'tarde';
  if (t >= from.getTime()) return 'ventana';
  if (t >= from.getTime() - windDownMinutes * MINUTE) return 'preparacion';
  return 'lejos';
}

export const DEFAULT_GOALS: Record<DayIndex, DayGoal> = {
  1: { wakeTime: '07:00', targetHours: 8 },
  2: { wakeTime: '07:00', targetHours: 8 },
  3: { wakeTime: '07:00', targetHours: 8 },
  4: { wakeTime: '07:00', targetHours: 8 },
  5: { wakeTime: '07:00', targetHours: 8 },
  6: { wakeTime: '09:00', targetHours: 8.5 },
  7: { wakeTime: '09:00', targetHours: 8.5 },
};
