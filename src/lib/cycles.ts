import { MINUTE } from './time';
import type { CycleSettings } from './types';

/**
 * Módulo 2 — Ciclos de sueño.
 *
 * El sueño avanza en ciclos de ~90 min (ligero → profundo → REM). Despertar
 * al final de un ciclo, en fase ligera, produce mucha menos inercia del sueño
 * que hacerlo en mitad de uno profundo. Todo el cálculo consiste en encajar un
 * número entero de ciclos entre el momento de dormirse y el de despertar,
 * añadiendo la latencia (lo que se tarda en caer dormido).
 */

/** Nº de ciclos que se ofrecen como opción. 4-6 cubre de 6h a 9h. */
export const CYCLE_OPTIONS = [3, 4, 5, 6, 7] as const;

export interface CycleOption {
  /** Número de ciclos completos. */
  cycles: number;
  /** Instante en el que acostarse (incluye la latencia). */
  bedtime: Date;
  /** Instante en el que despertar. */
  wakeTime: Date;
  /** Tiempo real dormido (sin contar la latencia), en ms. */
  sleepMs: number;
  /** Tiempo total en la cama, en ms. */
  inBedMs: number;
  /** Cercanía a la meta: 0 = clavado. Menor es mejor. */
  deviationMs: number;
  /** Recomendación cualitativa. */
  rating: 'ideal' | 'bueno' | 'justo' | 'escaso';
}

function rate(sleepHours: number, deviationHours: number): CycleOption['rating'] {
  if (deviationHours <= 0.5 && sleepHours >= 6) return 'ideal';
  if (deviationHours <= 1.25 && sleepHours >= 6) return 'bueno';
  if (sleepHours >= 4.5) return 'justo';
  return 'escaso';
}

/**
 * Dada una hora de despertar, calcula a qué horas convendría acostarse.
 * Devuelve una opción por cada nº de ciclos, ordenadas de más a menos sueño.
 */
export function bedtimesForWake(
  wake: Date,
  settings: CycleSettings,
  targetHours: number,
): CycleOption[] {
  const cycleMs = settings.cycleMinutes * MINUTE;
  const latencyMs = settings.latencyMinutes * MINUTE;

  return CYCLE_OPTIONS.map((cycles) => {
    const sleepMs = cycles * cycleMs;
    const inBedMs = sleepMs + latencyMs;
    const bedtime = new Date(wake.getTime() - inBedMs);
    const deviationMs = Math.abs(sleepMs - targetHours * 3_600_000);
    return {
      cycles,
      bedtime,
      wakeTime: wake,
      sleepMs,
      inBedMs,
      deviationMs,
      rating: rate(sleepMs / 3_600_000, deviationMs / 3_600_000),
    };
  }).sort((a, b) => b.cycles - a.cycles);
}

/**
 * Dada una hora de acostarse, calcula a qué horas convendría despertar.
 * Es el cálculo inverso, para el modo "me acuesto ahora".
 */
export function wakeTimesForBedtime(
  bedtime: Date,
  settings: CycleSettings,
  targetHours: number,
): CycleOption[] {
  const cycleMs = settings.cycleMinutes * MINUTE;
  const latencyMs = settings.latencyMinutes * MINUTE;
  const asleepAt = bedtime.getTime() + latencyMs;

  return CYCLE_OPTIONS.map((cycles) => {
    const sleepMs = cycles * cycleMs;
    const wakeTime = new Date(asleepAt + sleepMs);
    const deviationMs = Math.abs(sleepMs - targetHours * 3_600_000);
    return {
      cycles,
      bedtime,
      wakeTime,
      sleepMs,
      inBedMs: sleepMs + latencyMs,
      deviationMs,
      rating: rate(sleepMs / 3_600_000, deviationMs / 3_600_000),
    };
  }).sort((a, b) => a.cycles - b.cycles);
}

/** La opción que mejor se ajusta a la meta de horas. */
export function bestOption(options: CycleOption[]): CycleOption {
  return options.reduce((best, o) => (o.deviationMs < best.deviationMs ? o : best), options[0]);
}

/**
 * Reparte una duración de sueño en sus ciclos y estima la fase de cada tramo.
 * Es una aproximación didáctica para la visualización, no una medición real:
 * el sueño profundo domina los primeros ciclos y el REM se alarga al final.
 */
export interface PhaseSlice {
  phase: 'ligero' | 'profundo' | 'rem';
  /** Fracción del ciclo, 0-1. */
  share: number;
}

export function cycleComposition(cycleIndex: number, total: number): PhaseSlice[] {
  const progress = total > 1 ? cycleIndex / (total - 1) : 0;
  const deep = 0.42 - 0.34 * progress;   // mucho al principio, casi nada al final
  const rem = 0.10 + 0.32 * progress;    // al revés
  const light = 1 - deep - rem;
  return [
    { phase: 'ligero', share: light },
    { phase: 'profundo', share: deep },
    { phase: 'rem', share: rem },
  ];
}
