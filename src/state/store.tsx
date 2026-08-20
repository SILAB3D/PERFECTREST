import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { DEFAULT_GOALS } from '../lib/schedule';
import { loadJSON, saveJSON } from '../lib/storage';
import {
  activeNativeTriggers,
  proposeFromSchedule,
  readScheduleMark,
  refineEdges,
  startMonitor,
  writeScheduleMark,
  type DetectionResult,
} from '../lib/activityMonitor';
import { DEFAULT_TRIGGERS } from '../lib/triggers';
import { ensureChannel, rescheduleAll, scheduleForegroundReminders } from '../lib/notifications';
import { startBackground, stopBackground } from '../lib/backgroundMonitor';
import type { AppState, SleepSession } from '../lib/types';

const STORAGE_KEY = 'perfectrest.state.v1';

export const initialState: AppState = {
  schedule: { mode: 'weekday-weekend', goals: DEFAULT_GOALS },
  cycles: { cycleMinutes: 90, latencyMinutes: 15 },
  reminders: {
    enabled: true,
    windDownMinutes: 30,
    toleranceMinutes: 15,
    nagIfLate: true,
    wakeAlarm: false,
  },
  monitor: {
    enabled: true,
    minGapMinutes: 180,
    maxGapMinutes: 780,
    nightStart: '21:30',
    nightEnd: '11:00',
    autoConfirm: false,
    background: true,
    triggers: DEFAULT_TRIGGERS,
  },
  sessions: [],
  theme: 'dark',
  lastActiveAt: null,
  lastDeviceUseAt: null,
  pendingSession: null,
  onboarded: false,
};

type Action =
  | { type: 'hydrate'; state: AppState }
  | { type: 'patch'; patch: Partial<AppState> }
  | { type: 'upsertSession'; session: SleepSession }
  | { type: 'removeSession'; id: string }
  | { type: 'proposeSession'; session: SleepSession }
  | { type: 'dismissPending' }
  | { type: 'reset' };

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'hydrate':
      return action.state;

    case 'patch':
      return { ...state, ...action.patch };

    case 'upsertSession': {
      const rest = state.sessions.filter((s) => s.id !== action.session.id);
      return {
        ...state,
        sessions: [...rest, action.session].sort((a, b) => b.end - a.end),
        pendingSession: state.pendingSession?.id === action.session.id ? null : state.pendingSession,
      };
    }

    case 'removeSession':
      return {
        ...state,
        sessions: state.sessions.filter((s) => s.id !== action.id),
        pendingSession: state.pendingSession?.id === action.id ? null : state.pendingSession,
      };

    case 'proposeSession': {
      // Se ignora si ya existe una sesión que solape con la propuesta: el
      // usuario puede haber registrado esa noche a mano.
      const overlaps = state.sessions.some(
        (s) => action.session.start < s.end && s.start < action.session.end,
      );
      if (overlaps || state.pendingSession?.id === action.session.id) return state;

      if (state.monitor.autoConfirm) {
        return {
          ...state,
          sessions: [...state.sessions, { ...action.session, confirmed: true }].sort(
            (a, b) => b.end - a.end,
          ),
        };
      }
      return { ...state, pendingSession: action.session };
    }

    case 'dismissPending':
      return { ...state, pendingSession: null };

    case 'reset':
      return { ...initialState, onboarded: true };

    default:
      return state;
  }
}

interface StoreValue {
  state: AppState;
  dispatch: React.Dispatch<Action>;
  /** false hasta que se ha leído el estado persistido. */
  ready: boolean;
  patch: (patch: Partial<AppState>) => void;
  saveSession: (session: SleepSession) => void;
  deleteSession: (id: string) => void;
}

const StoreContext = createContext<StoreValue | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  // `ready` es estado, no ref: los efectos que dependen de él (arrancar el
  // servicio, programar avisos) deben volver a ejecutarse en cuanto la
  // hidratación termina. Con un ref se evaluaban una sola vez, cuando aún
  // valía false, y no llegaban a hacer nada.
  const [ready, setReady] = useState(false);
  const stateRef = useRef(state);
  stateRef.current = state;

  // --- Hidratación inicial ---
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stored = await loadJSON<Partial<AppState> | null>(STORAGE_KEY, null);
      if (cancelled) return;
      if (stored) {
        // Merge superficial por sección: así los ajustes nuevos de una versión
        // posterior conservan su valor por defecto en estados antiguos.
        dispatch({
          type: 'hydrate',
          state: {
            ...initialState,
            ...stored,
            schedule: { ...initialState.schedule, ...stored.schedule },
            cycles: { ...initialState.cycles, ...stored.cycles },
            reminders: { ...initialState.reminders, ...stored.reminders },
            monitor: {
              ...initialState.monitor,
              ...stored.monitor,
              // Los disparadores se mezclan aparte: uno nuevo en una versión
              // posterior debe estrenarse con su valor por defecto en vez de
              // desaparecer bajo el objeto guardado.
              triggers: { ...DEFAULT_TRIGGERS, ...stored.monitor?.triggers },
            },
            sessions: stored.sessions ?? [],
            pendingSession: null,
          },
        });
      }
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // --- Persistencia ---
  useEffect(() => {
    if (!ready) return;
    void saveJSON(STORAGE_KEY, state);
  }, [state, ready]);

  // --- Tema ---
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', state.theme);
  }, [state.theme]);

  // --- Monitor de inactividad (Módulo 3) ---
  // Espera a la hidratación: arrancar antes evaluaría el primer hueco con los
  // ajustes por defecto en vez de con los del usuario.
  useEffect(() => {
    if (!ready) return;
    void ensureChannel();

    const propose = (result: DetectionResult) => {
      const refined = refineEdges(result.session, stateRef.current.cycles.latencyMinutes);
      dispatch({ type: 'proposeSession', session: refined });
    };

    const handle = startMonitor(() => stateRef.current.monitor, {
      onDetect: propose,
      onBeat: (ts) => dispatch({ type: 'patch', patch: { lastActiveAt: ts } }),
      onDeviceUse: (ts) => dispatch({ type: 'patch', patch: { lastDeviceUseAt: ts } }),
      // Ninguna señal esta vez: es el turno del disparador de horario, que
      // necesita las metas y el historial y por eso se resuelve aquí.
      onQuiet: (now) => {
        void (async () => {
          const { schedule, monitor, sessions, pendingSession } = stateRef.current;
          if (pendingSession) return;
          const proposal = proposeFromSchedule(
            schedule,
            monitor,
            sessions,
            await readScheduleMark(),
            now,
          );
          if (!proposal) return;
          // Se marca antes de proponer: si el usuario la descarta, no debe
          // reaparecer en la siguiente apertura del mismo día.
          await writeScheduleMark(proposal.key);
          propose(proposal.result);
        })();
      },
    });

    return () => handle.stop();
  }, [ready]);

  // --- Servicio en segundo plano (Módulo 3) ---
  // Sigue al ajuste del usuario: mientras esté activo, la detección continúa
  // con la app cerrada; al desactivarlo, el servicio y su notificación
  // permanente desaparecen.
  useEffect(() => {
    if (!ready) return;
    const { enabled, background, minGapMinutes } = state.monitor;
    // Al servicio se le pasan los disparadores nativos activos: si el usuario
    // apaga el del cargador, deja de escuchar ese evento en vez de filtrarlo
    // después. Sin ninguno activo, `startBackground` para el servicio.
    const triggers = activeNativeTriggers(state.monitor);
    if (enabled && background) void startBackground(minGapMinutes, triggers);
    else void stopBackground();
    // Depende del objeto entero en vez de campo a campo: volver a arrancar el
    // servicio es idempotente y así ningún ajuste nuevo se queda sin propagar.
  }, [ready, state.monitor]);

  // --- Reprogramación de avisos (Módulo 1) ---
  useEffect(() => {
    if (!ready) return;
    void rescheduleAll(state.schedule, state.cycles, state.reminders);
    return scheduleForegroundReminders(state.schedule, state.cycles, state.reminders);
  }, [ready, state.schedule, state.cycles, state.reminders]);

  const patch = useCallback((p: Partial<AppState>) => dispatch({ type: 'patch', patch: p }), []);
  const saveSession = useCallback(
    (session: SleepSession) => dispatch({ type: 'upsertSession', session }),
    [],
  );
  const deleteSession = useCallback((id: string) => dispatch({ type: 'removeSession', id }), []);

  const value = useMemo<StoreValue>(
    () => ({ state, dispatch, ready, patch, saveSession, deleteSession }),
    [state, ready, patch, saveSession, deleteSession],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreValue {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore debe usarse dentro de <StoreProvider>');
  return ctx;
}
