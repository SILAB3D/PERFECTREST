/** Modelo de dominio de PerfectRest. */

/** Índice de día ISO: 1 = lunes … 7 = domingo. */
export type DayIndex = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** Cómo se personaliza la meta de sueño (Módulo 1). */
export type ScheduleMode =
  /** Un único objetivo para los siete días. */
  | 'uniform'
  /** Un objetivo para L-V y otro para S-D. */
  | 'weekday-weekend'
  /** Un objetivo distinto por cada día. */
  | 'per-day';

/** Meta de un día concreto. Las horas son "HH:MM" en hora local. */
export interface DayGoal {
  /** Hora a la que el usuario quiere despertarse. */
  wakeTime: string;
  /** Horas de sueño objetivo (decimal: 7.5 = 7h 30m). */
  targetHours: number;
}

export interface ScheduleSettings {
  mode: ScheduleMode;
  /** Meta por día ISO. Siempre están los 7; el modo decide cuáles se editan. */
  goals: Record<DayIndex, DayGoal>;
}

export interface CycleSettings {
  /** Duración de un ciclo de sueño en minutos (típico 90, rango 70-120). */
  cycleMinutes: number;
  /** Latencia: minutos que se tarda en dormir desde que uno se acuesta. */
  latencyMinutes: number;
}

export interface ReminderSettings {
  enabled: boolean;
  /** Minutos antes de la hora de acostarse para el aviso de preparación. */
  windDownMinutes: number;
  /** Margen de tolerancia (± minutos) sobre la hora ideal de acostarse. */
  toleranceMinutes: number;
  /** Aviso extra si a la hora límite el usuario sigue activo. */
  nagIfLate: boolean;
  /** Alarma/recordatorio a la hora de despertar. */
  wakeAlarm: boolean;
}

/**
 * Señales a partir de las que se puede deducir una noche de sueño. Cada una se
 * activa por separado desde Ajustes, y cuando varias coinciden sobre el mismo
 * hueco la sesión se propone con más confianza.
 */
export type TriggerId =
  /** Pantalla apagada → desbloqueo del dispositivo. La medida más directa. */
  | 'screen'
  /** Móvil puesto a cargar → desenchufado. Útil para quien carga de noche. */
  | 'charger'
  /** Hueco entre dos aperturas de PerfectRest. Funciona sin servicio nativo. */
  | 'appOpen'
  /** Sin ninguna otra señal, se propone la meta del horario como estimación. */
  | 'schedule';

export interface MonitorSettings {
  enabled: boolean;
  /** Inactividad mínima (minutos) para considerarla una sesión de sueño. */
  minGapMinutes: number;
  /** Inactividad máxima creíble; por encima se marca como dudosa. */
  maxGapMinutes: number;
  /** Ventana nocturna en la que se espera dormir: "HH:MM". */
  nightStart: string;
  nightEnd: string;
  /** Registrar sesiones automáticamente sin pedir confirmación. */
  autoConfirm: boolean;
  /**
   * Avisar con la estimación en cuanto se cierra la noche, para validarla sin
   * tener que abrir la app. Lo dispara el servicio nativo, no la web: al
   * despertar nadie abre PerfectRest, y esperar a que lo haga era lo que dejaba
   * la propuesta enterrada durante días.
   */
  wakeSummary: boolean;
  /**
   * Mantener la detección activa con la app cerrada (sólo en el APK).
   * Requiere un servicio en primer plano con notificación permanente.
   */
  background: boolean;
  /** Qué disparadores están activos. Catálogo en `lib/triggers.ts`. */
  triggers: Record<TriggerId, boolean>;
}

/** Grado de confianza de una sesión detectada automáticamente. */
export type Confidence = 'high' | 'medium' | 'low';

export type SessionSource = 'auto' | 'manual' | 'edited';

export interface SleepSession {
  id: string;
  /** Instante de inicio del sueño (epoch ms). */
  start: number;
  /** Instante de despertar (epoch ms). */
  end: number;
  source: SessionSource;
  confidence: Confidence;
  /** false mientras el usuario no la haya validado. */
  confirmed: boolean;
  /** Señales que produjeron la detección, de más a menos directa. */
  triggers?: TriggerId[];
  /** Valoración subjetiva del descanso, 1-5. */
  quality?: number;
  note?: string;
}

export interface AppState {
  schedule: ScheduleSettings;
  cycles: CycleSettings;
  reminders: ReminderSettings;
  monitor: MonitorSettings;
  sessions: SleepSession[];
  theme: 'dark' | 'light';
  /** Marca temporal del último latido de actividad registrado. */
  lastActiveAt: number | null;
  /**
   * Último uso real del dispositivo según el servicio nativo. A diferencia de
   * `lastActiveAt`, no depende de que la app se abra.
   */
  lastDeviceUseAt: number | null;
  /** Sesión pendiente de que el usuario la confirme o descarte. */
  pendingSession: SleepSession | null;
  onboarded: boolean;
}
