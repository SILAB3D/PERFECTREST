import { Preferences } from '@capacitor/preferences';
import { Capacitor } from '@capacitor/core';

/**
 * Persistencia unificada: Capacitor Preferences en el APK, localStorage en el
 * navegador durante el desarrollo. La misma API en ambos entornos.
 */

const isNative = Capacitor.isNativePlatform();

export async function loadRaw(key: string): Promise<string | null> {
  if (isNative) {
    const { value } = await Preferences.get({ key });
    return value ?? null;
  }
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export async function saveRaw(key: string, value: string): Promise<void> {
  if (isNative) {
    await Preferences.set({ key, value });
    return;
  }
  try {
    localStorage.setItem(key, value);
  } catch {
    /* cuota llena o modo privado: se pierde la persistencia, no la sesión */
  }
}

export async function removeRaw(key: string): Promise<void> {
  if (isNative) {
    await Preferences.remove({ key });
    return;
  }
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignorado */
  }
}

export async function loadJSON<T>(key: string, fallback: T): Promise<T> {
  const raw = await loadRaw(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function saveJSON(key: string, value: unknown): Promise<void> {
  await saveRaw(key, JSON.stringify(value));
}
