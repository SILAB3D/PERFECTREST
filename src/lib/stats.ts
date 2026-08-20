import { goalForDate } from './schedule';
import {
  DAY,
  HOUR,
  circularMeanMinutes,
  circularStdMinutes,
  dateKey,
  startOfDay,
} from './time';
import type { ScheduleSettings, SleepSession } from './types';

/**
 * Estadísticas del sueño registrado.
 *
 * Convención: una sesión pertenece al día en el que uno se DESPIERTA. Dormir
 * de lunes 23:40 a martes 07:10 es "la noche del martes", que es como la
 * gente lee su propio descanso.
 */

export interface NightRecord {
  key: string;
  /** Medianoche del día de despertar. */
  dayStart: number;
  session: SleepSession | null;
  /** Duración dormida en ms (0 si no hay registro). */
  durationMs: number;
  /** Meta de ese día en ms. */
  targetMs: number;
  /** duración − meta, en ms. Negativo = déficit. */
  deltaMs: number;
}

export interface Summary {
  nights: NightRecord[];
  /** Noches con datos. */
  recorded: number;
  /** Media de duración, en ms (sólo noches con datos). */
  avgDurationMs: number | null;
  /** Media de la meta en el periodo, en ms. */
  avgTargetMs: number;
  /** Hora media de acostarse, en minutos desde medianoche. */
  avgBedMinutes: number | null;
  /** Hora media de despertar, en minutos desde medianoche. */
  avgWakeMinutes: number | null;
  /** Consistencia 0-100: cuánto se repiten las mismas horas cada día. */
  consistency: number | null;
  /** % de noches que alcanzaron su meta (con 30 min de margen). */
  goalHitRate: number | null;
  /** Deuda acumulada en ms (suma de déficits, los excesos no compensan). */
  debtMs: number;
  /** Racha actual de noches cumpliendo la meta. */
  streak: number;
  /** Calidad media declarada, 1-5. */
  avgQuality: number | null;
}

/** Sesiones válidas (confirmadas o auto de confianza suficiente). */
export function usableSessions(sessions: SleepSession[]): SleepSession[] {
  return sessions
    .filter((s) => s.confirmed || s.confidence !== 'low')
    .sort((a, b) => a.end - b.end);
}

/** Indexa las sesiones por día de despertar, quedándose con la más larga. */
export function byWakeDay(sessions: SleepSession[]): Map<string, SleepSession> {
  const map = new Map<string, SleepSession>();
  for (const s of usableSessions(sessions)) {
    const key = dateKey(s.end);
    const current = map.get(key);
    if (!current || s.end - s.start > current.end - current.start) map.set(key, s);
  }
  return map;
}

/** Construye el historial de las últimas `days` noches, hoy incluido. */
export function buildNights(
  sessions: SleepSession[],
  schedule: ScheduleSettings,
  days: number,
  now: number = Date.now(),
): NightRecord[] {
  const index = byWakeDay(sessions);
  const today = startOfDay(now);
  const out: NightRecord[] = [];

  for (let i = days - 1; i >= 0; i--) {
    const dayStart = today - i * DAY;
    const key = dateKey(dayStart);
    const session = index.get(key) ?? null;
    const goal = goalForDate(schedule, new Date(dayStart));
    const targetMs = goal.targetHours * HOUR;
    const durationMs = session ? session.end - session.start : 0;
    out.push({
      key,
      dayStart,
      session,
      durationMs,
      targetMs,
      deltaMs: session ? durationMs - targetMs : 0,
    });
  }
  return out;
}

/** Tolerancia para dar una meta por cumplida. */
const GOAL_TOLERANCE_MS = 30 * 60_000;

export function summarize(nights: NightRecord[]): Summary {
  const withData = nights.filter((n) => n.session);

  const durations = withData.map((n) => n.durationMs);
  const bedMinutes = withData.map((n) => {
    const d = new Date(n.session!.start);
    return d.getHours() * 60 + d.getMinutes();
  });
  const wakeMinutes = withData.map((n) => {
    const d = new Date(n.session!.end);
    return d.getHours() * 60 + d.getMinutes();
  });
  const qualities = withData
    .map((n) => n.session!.quality)
    .filter((q): q is number => typeof q === 'number');

  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

  // Consistencia: se penaliza la dispersión de las horas de acostarse y
  // despertar. 60 min de desviación típica ya se considera irregular.
  const bedStd = circularStdMinutes(bedMinutes);
  const wakeStd = circularStdMinutes(wakeMinutes);
  let consistency: number | null = null;
  if (bedStd !== null && wakeStd !== null) {
    const spread = (bedStd + wakeStd) / 2;
    consistency = Math.round(Math.max(0, Math.min(100, 100 - (spread / 60) * 100)));
  }

  const hits = withData.filter((n) => n.durationMs + GOAL_TOLERANCE_MS >= n.targetMs);
  const debtMs = withData.reduce((acc, n) => acc + Math.max(0, n.targetMs - n.durationMs), 0);

  // Racha: se cuenta hacia atrás desde la noche más reciente con datos.
  let streak = 0;
  for (let i = nights.length - 1; i >= 0; i--) {
    const n = nights[i];
    if (!n.session) {
      // La noche de hoy aún puede no estar registrada: no rompe la racha.
      if (i === nights.length - 1) continue;
      break;
    }
    if (n.durationMs + GOAL_TOLERANCE_MS >= n.targetMs) streak++;
    else break;
  }

  return {
    nights,
    recorded: withData.length,
    avgDurationMs: avg(durations),
    avgTargetMs: avg(nights.map((n) => n.targetMs)) ?? 0,
    avgBedMinutes: circularMeanMinutes(bedMinutes),
    avgWakeMinutes: circularMeanMinutes(wakeMinutes),
    consistency,
    goalHitRate: withData.length ? Math.round((hits.length / withData.length) * 100) : null,
    debtMs,
    streak,
    avgQuality: avg(qualities),
  };
}

/** Texto interpretativo del resumen, para no dejar al usuario con números sueltos. */
export function insight(s: Summary): { tone: 'good' | 'warn' | 'bad' | 'neutral'; text: string } {
  if (s.recorded === 0) {
    return { tone: 'neutral', text: 'Aún no hay noches registradas en este periodo.' };
  }
  if (s.recorded < 3) {
    return { tone: 'neutral', text: 'Con unas pocas noches más las tendencias serán fiables.' };
  }
  if (s.debtMs > 5 * HOUR) {
    return { tone: 'bad', text: 'Llevas una deuda de sueño notable. Adelanta la hora de acostarte poco a poco, 15 minutos cada vez.' };
  }
  if (s.consistency !== null && s.consistency < 55) {
    return { tone: 'warn', text: 'Tus horarios varían mucho de un día a otro. La regularidad influye más en el descanso que la duración puntual.' };
  }
  if (s.goalHitRate !== null && s.goalHitRate >= 80 && (s.consistency ?? 0) >= 70) {
    return { tone: 'good', text: 'Ritmo excelente: cumples tu meta y mantienes horarios estables.' };
  }
  if (s.goalHitRate !== null && s.goalHitRate < 50) {
    return { tone: 'warn', text: 'Te quedas corto la mayoría de noches. Quizá la meta sea ambiciosa para tu horario actual.' };
  }
  return { tone: 'good', text: 'Vas por buen camino. Mantén la hora de acostarte y la mejora se consolidará.' };
}
