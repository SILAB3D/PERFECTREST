import type { DayIndex } from './types';

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

export const DAY_NAMES: Record<DayIndex, string> = {
  1: 'Lunes', 2: 'Martes', 3: 'Miércoles', 4: 'Jueves',
  5: 'Viernes', 6: 'Sábado', 7: 'Domingo',
};

export const DAY_SHORT: Record<DayIndex, string> = {
  1: 'L', 2: 'M', 3: 'X', 4: 'J', 5: 'V', 6: 'S', 7: 'D',
};

export const ALL_DAYS: DayIndex[] = [1, 2, 3, 4, 5, 6, 7];
export const WEEKDAYS: DayIndex[] = [1, 2, 3, 4, 5];
export const WEEKEND: DayIndex[] = [6, 7];

/** Día ISO (1=lunes … 7=domingo) de una fecha. */
export function isoDay(d: Date): DayIndex {
  return ((d.getDay() + 6) % 7 + 1) as DayIndex;
}

/** "HH:MM" -> minutos desde medianoche. */
export function parseTime(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/**
 * Minutos desde medianoche -> "HH:MM" (envuelve en 24h).
 * Se redondea a minuto entero: las medias circulares devuelven decimales y
 * sin redondear se colarían en la pantalla como "00:15.947576".
 */
export function formatTime(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** Formatea una fecha como "HH:MM" local. */
export function formatClock(ts: number | Date): string {
  const d = ts instanceof Date ? ts : new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Duración en ms -> "7h 30m". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / MINUTE));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/** Horas decimales -> "7h 30m". */
export function formatHours(hours: number): string {
  return formatDuration(hours * HOUR);
}

/** Diferencia con signo, en texto: "+45m", "-1h 10m", "en punto". */
export function formatDelta(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < 5 * MINUTE) return 'en punto';
  return `${ms >= 0 ? '+' : '−'}${formatDuration(abs)}`;
}

/** Inicio del día local de una fecha. */
export function startOfDay(ts: number | Date): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Clave "YYYY-MM-DD" en hora local. */
export function dateKey(ts: number | Date): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** "Hoy", "Ayer" o "mié 14 ago". */
export function relativeDayLabel(ts: number): string {
  const today = startOfDay(Date.now());
  const day = startOfDay(ts);
  const diff = Math.round((today - day) / DAY);
  if (diff === 0) return 'Hoy';
  if (diff === 1) return 'Ayer';
  if (diff === -1) return 'Mañana';
  return new Date(ts).toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' });
}

/**
 * Próxima ocurrencia de una hora "HH:MM" a partir de `from`.
 * Si ya pasó hoy, devuelve la de mañana.
 */
export function nextOccurrence(hhmm: string, from: Date = new Date()): Date {
  const mins = parseTime(hhmm);
  const d = new Date(from);
  d.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
  if (d.getTime() <= from.getTime()) d.setDate(d.getDate() + 1);
  return d;
}

/**
 * ¿Están los minutos `m` dentro de la ventana [start, end)?
 * Soporta ventanas que cruzan medianoche (p. ej. 22:00 → 10:00).
 */
export function inWindow(m: number, startMin: number, endMin: number): boolean {
  if (startMin === endMin) return true;
  return startMin < endMin
    ? m >= startMin && m < endMin
    : m >= startMin || m < endMin;
}

/** Media circular de horas del día (evita que 23:50 y 00:10 promedien a las 12:00). */
export function circularMeanMinutes(values: number[]): number | null {
  if (!values.length) return null;
  let sx = 0, sy = 0;
  for (const v of values) {
    const a = (v / 1440) * Math.PI * 2;
    sx += Math.cos(a);
    sy += Math.sin(a);
  }
  if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) return null;
  const ang = Math.atan2(sy / values.length, sx / values.length);
  return (((ang / (Math.PI * 2)) * 1440) + 1440) % 1440;
}

/** Desviación típica circular, en minutos. */
export function circularStdMinutes(values: number[]): number | null {
  if (values.length < 2) return null;
  let sx = 0, sy = 0;
  for (const v of values) {
    const a = (v / 1440) * Math.PI * 2;
    sx += Math.cos(a);
    sy += Math.sin(a);
  }
  const r = Math.sqrt(sx * sx + sy * sy) / values.length;
  if (r >= 1) return 0;
  return Math.sqrt(-2 * Math.log(r)) * (1440 / (Math.PI * 2));
}
