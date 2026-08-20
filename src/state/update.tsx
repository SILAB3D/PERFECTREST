import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  checkForUpdate,
  currentInfo,
  downloadUpdate,
  installUpdate,
  isUpdaterAvailable,
  onDownloadProgress,
  openInstallSettings,
  type ReleaseInfo,
} from '../lib/updater';
import { loadRaw, saveRaw } from '../lib/storage';

/**
 * Estado del canal de autoactualización, tal y como lo consume la interfaz.
 *
 * El botón principal absorbe estos estados en su propia etiqueta en vez de
 * añadir elementos alrededor: Actualizar → Descargando 45 % → Instalar →
 * Reintentar.
 */
export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'uptodate'
  | 'error';

/** Última versión que el usuario descartó, para no volver a insistir con ella. */
const DISMISSED_KEY = 'perfectrest.update.dismissed';

export interface AppUpdate {
  available: boolean;
  phase: UpdatePhase;
  release: ReleaseInfo | null;
  /** Versión instalada, para mostrarla en Ajustes. */
  installed: string;
  percent: number;
  /** Mensaje exacto del fallo. Sólo se rellena en la comprobación manual. */
  error: string | null;
  /** ¿Concedido el permiso de «instalar apps desconocidas»? */
  canInstall: boolean;
  /** ¿Tiene sentido ofrecer nada aquí? (falso en el navegador) */
  supported: boolean;
  check: (manual?: boolean) => Promise<void>;
  start: () => Promise<void>;
  dismiss: () => void;
  grantPermission: () => Promise<void>;
}

function useUpdateState(): AppUpdate {
  const supported = isUpdaterAvailable();

  const [phase, setPhase] = useState<UpdatePhase>('idle');
  const [release, setRelease] = useState<ReleaseInfo | null>(null);
  const [installed, setInstalled] = useState('');
  const [percent, setPercent] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [canInstall, setCanInstall] = useState(false);
  const [dismissed, setDismissed] = useState<number>(0);

  // La APK descargada sobrevive entre fases: si el usuario sale a conceder el
  // permiso y vuelve, se instala sin repetir la descarga.
  const downloaded = useRef<string | null>(null);

  useEffect(() => {
    void loadRaw(DISMISSED_KEY).then((raw) => setDismissed(Number(raw) || 0));
    void currentInfo().then((info) => {
      setInstalled(info.versionName);
      setCanInstall(info.canInstall);
    });
  }, []);

  // El progreso llega por eventos del plugin: la descarga corre en un hilo
  // nativo, no en el puente.
  useEffect(() => {
    if (!supported) return;
    let handle: { remove: () => void } | null = null;
    void onDownloadProgress((p) => setPercent(p.percent)).then((h) => {
      handle = h;
    });
    return () => handle?.remove();
  }, [supported]);

  /**
   * El permiso de instalación se concede en una pantalla del sistema, fuera de
   * la app, y nada dentro avisa de que ha cambiado. Sin releerlo al volver al
   * primer plano, el aviso seguiría pidiéndolo para siempre.
   */
  useEffect(() => {
    if (!supported) return;
    const recheck = () => {
      if (document.visibilityState !== 'visible') return;
      void currentInfo().then((info) => setCanInstall(info.canInstall));
    };
    document.addEventListener('visibilitychange', recheck);
    return () => document.removeEventListener('visibilitychange', recheck);
  }, [supported]);

  /**
   * Comprobación. La automática del arranque **calla sus errores**: sin
   * cobertura, o con GitHub devolviendo 403, la app tiene que seguir
   * funcionando sin molestar. El precio es que un fallo real se ve igual que
   * «no hay novedades», y por eso la manual sí cuenta lo que ocurre: es la
   * única forma de distinguir «no hay nada» de «está roto».
   */
  const check = useCallback(
    async (manual = false) => {
      if (!supported) return;
      setPhase('checking');
      setError(null);
      try {
        const result = await checkForUpdate();
        setInstalled(result.current.versionName);
        setCanInstall(result.current.canInstall);
        setRelease(result.release);
        setPhase(result.available ? 'available' : 'uptodate');
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (manual) {
          setError(message);
          setPhase('error');
        } else {
          setPhase('idle');
        }
      }
    },
    [supported],
  );

  // Comprobación silenciosa al arrancar.
  useEffect(() => {
    if (!supported) return;
    void check(false);
  }, [supported, check]);

  /** Descarga si hace falta e invoca al instalador del sistema. */
  const start = useCallback(async () => {
    if (!release) return;
    setError(null);
    try {
      if (!downloaded.current) {
        setPhase('downloading');
        setPercent(0);
        downloaded.current = await downloadUpdate(release);
      }
      setPhase('ready');
      await installUpdate(downloaded.current);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // Con la descarga hecha, el fallo es del instalador (permiso, casi
      // siempre): se conserva el fichero para no repetirla.
      setPhase(downloaded.current ? 'ready' : 'error');
    }
  }, [release]);

  const dismiss = useCallback(() => {
    if (!release) return;
    setDismissed(release.versionCode);
    void saveRaw(DISMISSED_KEY, String(release.versionCode));
  }, [release]);

  const grantPermission = useCallback(async () => {
    await openInstallSettings();
  }, []);

  const available =
    supported &&
    release !== null &&
    (phase === 'available' || phase === 'downloading' || phase === 'ready') &&
    release.versionCode > dismissed;

  return useMemo(
    () => ({
      available,
      phase,
      release,
      installed,
      percent,
      error,
      canInstall,
      supported,
      check,
      start,
      dismiss,
      grantPermission,
    }),
    [
      available,
      phase,
      release,
      installed,
      percent,
      error,
      canInstall,
      supported,
      check,
      start,
      dismiss,
      grantPermission,
    ],
  );
}

const UpdateContext = createContext<AppUpdate | null>(null);

/**
 * El estado de actualización se comparte por contexto en vez de llamar al hook
 * en cada pantalla: dos instancias significarían dos comprobaciones contra la
 * API de GitHub en cada arranque —que tiene límite de peticiones sin
 * credenciales— y dos estados que se contradicen entre sí.
 */
export function UpdateProvider({ children }: { children: ReactNode }) {
  const value = useUpdateState();
  return <UpdateContext.Provider value={value}>{children}</UpdateContext.Provider>;
}

export function useAppUpdate(): AppUpdate {
  const ctx = useContext(UpdateContext);
  if (!ctx) throw new Error('useAppUpdate debe usarse dentro de <UpdateProvider>');
  return ctx;
}
