import { Capacitor, registerPlugin } from '@capacitor/core';
import type { TriggerId } from './types';

/**
 * Acceso al servicio nativo de monitorización en segundo plano.
 *
 * En el APK, un servicio en primer plano escucha los eventos del dispositivo
 * mientras la app está cerrada —apagado de pantalla, desbloqueo, conexión y
 * desconexión del cargador— y va acumulando los huecos de inactividad, cada
 * uno etiquetado con el disparador que lo abrió y el que lo cerró.
 *
 * En el navegador el plugin no existe: todas las funciones degradan a un
 * comportamiento neutro y sólo queda la detección al reabrir la app.
 */

export interface NativeGap {
  start: number;
  end: number;
  /** Disparador que marcó el inicio de la inactividad. */
  startTrigger: TriggerId;
  /** Disparador que la cerró. */
  endTrigger: TriggerId;
}

export interface MonitorStatus {
  running: boolean;
  enabled: boolean;
  /**
   * false cuando Android sigue aplicando optimización de batería a la app.
   * Es la causa más común de que el servicio deje de recibir eventos por la
   * noche, así que la UI lo expone y ofrece pedir la exención.
   */
  batteryExempt: boolean;
  /** Último uso real del dispositivo detectado por el servicio (epoch ms). */
  lastUsedAt: number;
}

interface SleepMonitorPlugin {
  start(options: {
    minGapMinutes: number;
    /** Disparadores nativos activos; el servicio ignora el resto de eventos. */
    triggers: TriggerId[];
  }): Promise<{ running: boolean }>;
  stop(): Promise<{ running: boolean }>;
  isRunning(): Promise<MonitorStatus>;
  getGaps(): Promise<{ gaps: NativeGap[]; lastUsedAt: number; screenOffAt: number }>;
  /** Borra los huecos ya procesados; `until` evita perder los recién llegados. */
  clearGaps(options: { until: number }): Promise<void>;
  /** Abre el diálogo del sistema para eximir a la app del ahorro de batería. */
  requestBatteryExemption(): Promise<{ requested: boolean }>;
}

const SleepMonitor = registerPlugin<SleepMonitorPlugin>('SleepMonitor');

const IDLE_STATUS: MonitorStatus = {
  running: false,
  enabled: false,
  batteryExempt: false,
  lastUsedAt: 0,
};

/** ¿Hay servicio nativo disponible en esta plataforma? */
export function isBackgroundAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('SleepMonitor');
}

export async function startBackground(
  minGapMinutes: number,
  triggers: TriggerId[],
): Promise<boolean> {
  if (!isBackgroundAvailable()) return false;
  // Sin ningún disparador nativo activo el servicio no tendría nada que
  // escuchar: mejor pararlo que mantener viva una notificación permanente.
  if (!triggers.length) {
    await stopBackground();
    return false;
  }
  try {
    const { running } = await SleepMonitor.start({ minGapMinutes, triggers });
    return running;
  } catch {
    return false;
  }
}

export async function stopBackground(): Promise<void> {
  if (!isBackgroundAvailable()) return;
  try {
    await SleepMonitor.stop();
  } catch {
    /* el servicio ya no estaba activo */
  }
}

export async function backgroundStatus(): Promise<MonitorStatus> {
  if (!isBackgroundAvailable()) return IDLE_STATUS;
  try {
    return { ...IDLE_STATUS, ...(await SleepMonitor.isRunning()) };
  } catch {
    return IDLE_STATUS;
  }
}

/** Pide al sistema eximir la app del ahorro de batería. */
export async function requestBatteryExemption(): Promise<boolean> {
  if (!isBackgroundAvailable()) return false;
  try {
    const { requested } = await SleepMonitor.requestBatteryExemption();
    return requested;
  } catch {
    return false;
  }
}

/**
 * Lee los huecos registrados mientras la app estaba cerrada.
 * No los borra: eso lo hace `clearGaps` una vez procesados, de modo que un
 * cierre inesperado a mitad no pierda una noche.
 */
export async function readGaps(): Promise<{
  gaps: NativeGap[];
  lastUsedAt: number;
  screenOffAt: number;
}> {
  if (!isBackgroundAvailable()) return { gaps: [], lastUsedAt: 0, screenOffAt: 0 };
  try {
    const res = await SleepMonitor.getGaps();
    return {
      gaps: res.gaps ?? [],
      lastUsedAt: res.lastUsedAt ?? 0,
      screenOffAt: res.screenOffAt ?? 0,
    };
  } catch {
    return { gaps: [], lastUsedAt: 0, screenOffAt: 0 };
  }
}

/**
 * Descarta los huecos cerrados hasta `until`. Se pasa la marca del último
 * hueco leído en vez de vaciar la cola entera, porque entre la lectura y el
 * borrado el servicio puede haber encolado uno nuevo.
 */
export async function clearGaps(until: number): Promise<void> {
  if (!isBackgroundAvailable()) return;
  try {
    await SleepMonitor.clearGaps({ until });
  } catch {
    /* sin servicio no hay nada que limpiar */
  }
}
