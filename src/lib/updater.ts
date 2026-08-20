import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

/**
 * Autoactualización por releases de GitHub.
 *
 * Un push a `main` acaba convertido en una actualización instalada en el móvil.
 * El reparto de trabajo entre esta capa y el plugin nativo no es arbitrario:
 *
 *   JavaScript  consulta la API de GitHub y compara versiones
 *   Java        descarga la APK y lanza el instalador del sistema
 *
 * El motivo es el CORS. La WebView corre en un origen `localhost`, así que sus
 * peticiones pasan por CORS: `api.github.com` responde con
 * `Access-Control-Allow-Origin: *` y se puede consultar sin problema, pero la
 * URL de descarga de un asset redirige a `release-assets.githubusercontent.com`,
 * que no manda esa cabecera y hace que la WebView cancele la petición.
 *
 * De ahí una decisión que parece un rodeo y no lo es: el `versionCode` sale de
 * la **etiqueta** de la release (`v0.1.0-b23` → 23), que ya viene en la
 * respuesta de la API. Publicar un `latest.json` como asset y leerlo con
 * `fetch` sería lo natural, y no funcionaría nunca.
 */

/** "owner/repo", inyectado en tiempo de compilación desde el remoto de git. */
declare const __UPDATE_REPO__: string;
/** Versión de package.json, para poder mostrar algo también en el navegador. */
declare const __APP_VERSION__: string;

export const UPDATE_REPO: string = typeof __UPDATE_REPO__ === 'string' ? __UPDATE_REPO__ : '';
export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';

export interface UpdaterInfo {
  versionCode: number;
  versionName: string;
  packageName: string;
  /** ¿Está concedido el permiso de «instalar apps desconocidas»? */
  canInstall: boolean;
}

export interface DownloadProgress {
  percent: number;
  downloaded: number;
  total: number;
}

interface UpdaterPlugin {
  getInfo(): Promise<UpdaterInfo>;
  download(options: { url: string; version: string }): Promise<{ path: string; size: number }>;
  install(options: { path: string }): Promise<{ launched: boolean }>;
  openInstallSettings(): Promise<{ opened: boolean }>;
  clearDownloads(): Promise<void>;
  addListener(
    event: 'downloadProgress',
    fn: (progress: DownloadProgress) => void,
  ): Promise<PluginListenerHandle>;
}

const Updater = registerPlugin<UpdaterPlugin>('Updater');

/** ¿Puede esta instalación actualizarse sola? */
export function isUpdaterAvailable(): boolean {
  return (
    Capacitor.isNativePlatform() &&
    Capacitor.isPluginAvailable('Updater') &&
    UPDATE_REPO !== ''
  );
}

export interface ReleaseInfo {
  tag: string;
  versionName: string;
  versionCode: number;
  apkUrl: string;
}

/**
 * Extrae versión y número de compilación de la etiqueta `v<versionName>-b<n>`.
 * Devuelve null para cualquier etiqueta que no siga el formato: una release
 * publicada a mano no debe interpretarse como actualización.
 */
export function parseTag(tag: string): { versionName: string; versionCode: number } | null {
  const match = /^v(.+)-b(\d+)$/.exec(tag.trim());
  if (!match) return null;
  const versionCode = Number(match[2]);
  if (!Number.isSafeInteger(versionCode) || versionCode <= 0) return null;
  return { versionName: match[1], versionCode };
}

/** Forma mínima de la respuesta de la API que aquí se usa. */
interface GitHubRelease {
  tag_name?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: { name?: string; browser_download_url?: string }[];
}

/** Convierte la respuesta de la API en lo único que interesa. */
export function readRelease(payload: GitHubRelease): ReleaseInfo | null {
  if (!payload || payload.draft) return null;

  const parsed = parseTag(payload.tag_name ?? '');
  if (!parsed) return null;

  const apk = (payload.assets ?? []).find((a) => a.name?.toLowerCase().endsWith('.apk'));
  if (!apk?.browser_download_url) return null;

  return { tag: payload.tag_name!, apkUrl: apk.browser_download_url, ...parsed };
}

/** La última release publicada. Lanza con un mensaje legible si algo falla. */
export async function fetchLatestRelease(repo: string = UPDATE_REPO): Promise<ReleaseInfo> {
  if (!repo) throw new Error('No hay repositorio configurado para las actualizaciones');

  let res: Response;
  try {
    res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
  } catch {
    throw new Error('Sin conexión con GitHub');
  }

  if (res.status === 404) {
    // También es lo que responde un repositorio privado: la app consulta sin
    // credenciales a propósito, meter un token en el APK no es una opción.
    throw new Error('El repositorio no tiene releases publicadas');
  }
  if (res.status === 403) throw new Error('GitHub ha limitado las peticiones; prueba más tarde');
  if (!res.ok) throw new Error(`GitHub respondió ${res.status}`);

  const release = readRelease((await res.json()) as GitHubRelease);
  if (!release) throw new Error('La última release no trae una APK reconocible');
  return release;
}

/** Versión instalada. En el navegador se responde con lo que dice package.json. */
export async function currentInfo(): Promise<UpdaterInfo> {
  if (!isUpdaterAvailable()) {
    return {
      versionCode: 0,
      versionName: APP_VERSION,
      packageName: 'com.perfectrest.app',
      canInstall: false,
    };
  }
  return Updater.getInfo();
}

export interface UpdateCheck {
  current: UpdaterInfo;
  release: ReleaseInfo;
  /** true si la release publicada es posterior a la instalada. */
  available: boolean;
}

/**
 * Compara lo instalado con lo publicado. Android sólo acepta actualizar a un
 * `versionCode` estrictamente mayor, así que se usa el mismo criterio.
 */
export async function checkForUpdate(): Promise<UpdateCheck> {
  const [current, release] = await Promise.all([currentInfo(), fetchLatestRelease()]);
  return { current, release, available: release.versionCode > current.versionCode };
}

export async function downloadUpdate(release: ReleaseInfo): Promise<string> {
  const { path } = await Updater.download({ url: release.apkUrl, version: release.tag });
  return path;
}

export async function installUpdate(path: string): Promise<void> {
  await Updater.install({ path });
}

export async function openInstallSettings(): Promise<void> {
  await Updater.openInstallSettings();
}

export async function clearDownloads(): Promise<void> {
  if (!isUpdaterAvailable()) return;
  await Updater.clearDownloads().catch(() => {});
}

export function onDownloadProgress(
  fn: (progress: DownloadProgress) => void,
): Promise<PluginListenerHandle> {
  return Updater.addListener('downloadProgress', fn);
}
