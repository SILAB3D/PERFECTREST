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

/**
 * Estado de todo lo que la detección necesita para funcionar.
 *
 * Va junto a propósito: ninguno de estos permisos falla con un error visible.
 * Sin ellos la app simplemente no detecta nada, que desde fuera es idéntico a
 * una noche sin señal, y el usuario no tiene forma de distinguir una cosa de
 * la otra. Ésta es esa forma.
 */
export interface MonitorStatus {
  running: boolean;
  enabled: boolean;
  /**
   * false cuando Android sigue aplicando optimización de batería a la app.
   * Es la causa más común de que el servicio deje de recibir eventos por la
   * noche, así que la UI lo expone y ofrece pedir la exención.
   */
  batteryExempt: boolean;
  /**
   * Permiso de notificaciones concedido **y** notificaciones de la app
   * habilitadas. Sin él no hay servicio en primer plano visible ni aviso al
   * despertar.
   */
  notifications: boolean;
  /**
   * Alarmas exactas permitidas. Sin ellas la alarma de vigilancia se degrada a
   * inexacta, Doze la agrupa y el servicio puede pasar la noche sin rearmarse.
   */
  exactAlarms: boolean;
  /** Último uso real del dispositivo detectado por el servicio (epoch ms). */
  lastUsedAt: number;
  /** Cuándo entró el servicio en primer plano por última vez. */
  startedAt: number;
  /** Último latido del servicio: prueba de que sigue escuchando eventos. */
  aliveAt: number;
  /** Último hueco de inactividad encolado. */
  lastGapAt: number;
  /** Por qué no pudo hacer su trabajo, cuando lo hay. */
  lastError: string | null;
}

interface SleepMonitorPlugin {
  start(options: {
    minGapMinutes: number;
    /** Disparadores nativos activos; el servicio ignora el resto de eventos. */
    triggers: TriggerId[];
    /** Avisar con la estimación al cerrarse la noche. */
    wakeSummary: boolean;
    /** Ventana nocturna en minutos desde medianoche, para filtrar ese aviso. */
    nightStartMinutes: number;
    nightEndMinutes: number;
  }): Promise<{ running: boolean }>;
  stop(): Promise<{ running: boolean }>;
  isRunning(): Promise<MonitorStatus>;
  diagnostics(): Promise<MonitorStatus>;
  getGaps(): Promise<{ gaps: NativeGap[]; lastUsedAt: number; screenOffAt: number }>;
  /** Borra los huecos ya procesados; `until` evita perder los recién llegados. */
  clearGaps(options: { until: number }): Promise<void>;
  /** Abre el diálogo del sistema para eximir a la app del ahorro de batería. */
  requestBatteryExemption(): Promise<{ requested: boolean }>;
  /** Abre la pantalla de «alarmas y recordatorios» del sistema. */
  requestExactAlarms(): Promise<{ requested: boolean }>;
  /** Ficha de la app en ajustes: la única salida a un permiso denegado para siempre. */
  openAppSettings(): Promise<{ opened: boolean }>;
  openNotificationSettings(): Promise<{ opened: boolean }>;
}

const SleepMonitor = registerPlugin<SleepMonitorPlugin>('SleepMonitor');

const IDLE_STATUS: MonitorStatus = {
  running: false,
  enabled: false,
  batteryExempt: false,
  notifications: false,
  exactAlarms: false,
  lastUsedAt: 0,
  startedAt: 0,
  aliveAt: 0,
  lastGapAt: 0,
  lastError: null,
};

/** ¿Hay servicio nativo disponible en esta plataforma? */
export function isBackgroundAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('SleepMonitor');
}

export interface BackgroundOptions {
  minGapMinutes: number;
  triggers: TriggerId[];
  /** Avisar con la estimación al cerrarse la noche (Módulo 3). */
  wakeSummary: boolean;
  /** Ventana nocturna en minutos desde medianoche. */
  nightStartMinutes: number;
  nightEndMinutes: number;
}

export async function startBackground(options: BackgroundOptions): Promise<boolean> {
  if (!isBackgroundAvailable()) return false;
  // Sin ningún disparador nativo activo el servicio no tendría nada que
  // escuchar: mejor pararlo que mantener viva una notificación permanente.
  if (!options.triggers.length) {
    await stopBackground();
    return false;
  }
  try {
    const { running } = await SleepMonitor.start(options);
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
    return { ...IDLE_STATUS, ...(await SleepMonitor.diagnostics()) };
  } catch {
    // Una versión anterior del plugin no conoce `diagnostics`; el estado
    // reducido de `isRunning` sigue siendo mejor que nada.
    try {
      return { ...IDLE_STATUS, ...(await SleepMonitor.isRunning()) };
    } catch {
      return IDLE_STATUS;
    }
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

/** Abre la pantalla de «alarmas y recordatorios» del sistema (Android 12+). */
export async function requestExactAlarms(): Promise<boolean> {
  if (!isBackgroundAvailable()) return false;
  try {
    const { requested } = await SleepMonitor.requestExactAlarms();
    return requested;
  } catch {
    return false;
  }
}

/**
 * Abre la ficha de la app en los ajustes del sistema.
 *
 * Es la única salida cuando un permiso está denegado de forma permanente: a
 * partir de la segunda negativa Android ya no muestra el diálogo, así que el
 * botón «conceder permiso» dejaba de hacer nada sin decirlo.
 */
export async function openAppSettings(): Promise<boolean> {
  if (!isBackgroundAvailable()) return false;
  try {
    const { opened } = await SleepMonitor.openAppSettings();
    return opened;
  } catch {
    return false;
  }
}

/** Ajustes de notificaciones de la app, para reactivar un canal silenciado. */
export async function openNotificationSettings(): Promise<boolean> {
  if (!isBackgroundAvailable()) return false;
  try {
    const { opened } = await SleepMonitor.openNotificationSettings();
    return opened;
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
