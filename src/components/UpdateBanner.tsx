import { Pill } from './ui';
import type { AppUpdate } from '../state/update';

/**
 * Aviso de versión nueva.
 *
 * Enseña lo mínimo: que hay actualización, cuál es, qué va a pasar al instalar
 * y los botones. Nada de notas de la versión ni tamaño del descargable, que son
 * datos que nadie lee en un aviso y sólo alargan la decisión.
 *
 * Lo único que sí merece el espacio son las instrucciones: al instalar fuera de
 * Play Store, Android enseña una pantalla con tono de advertencia y un botón
 * poco evidente, y ese es el momento exacto en que la gente cancela.
 * Anticiparlo convierte un susto en un trámite.
 */
export function UpdateBanner({ update }: { update: AppUpdate }) {
  const { phase, release, percent, error, canInstall } = update;
  if (!release) return null;

  return (
    <div className="update">
      <div className="update__head">
        <span className="eyebrow">Actualización disponible</span>
        <Pill tone="primary">{release.versionName}</Pill>
      </div>

      <p className="update__text">
        Se instalará sobre la versión actual. <strong>Tus datos no se tocan</strong>: las
        noches registradas y los ajustes siguen donde están.
      </p>

      {canInstall ? (
        <p className="update__hint">
          Android pedirá confirmación con aviso de seguridad. Pulsa{' '}
          <strong>Instalar de todos modos</strong>: la app va firmada con la misma clave que
          la que ya tienes.
        </p>
      ) : (
        <p className="update__hint">
          Falta darle permiso para instalar apps desconocidas. Se concede una sola vez, en
          una pantalla de ajustes del sistema.
        </p>
      )}

      {error && <p className="update__error">{error}</p>}

      <div className="pending__actions">
        <button className="btn btn--ghost" onClick={update.dismiss}>
          Ahora no
        </button>
        {canInstall ? (
          <button
            className="btn btn--primary"
            onClick={() => void update.start()}
            disabled={phase === 'downloading'}
          >
            {buttonLabel(phase, percent, error)}
          </button>
        ) : (
          <button className="btn btn--primary" onClick={() => void update.grantPermission()}>
            Conceder permiso
          </button>
        )}
      </div>
    </div>
  );
}

/** El botón absorbe el estado en su etiqueta en vez de añadir elementos. */
function buttonLabel(phase: string, percent: number, error: string | null): string {
  if (phase === 'downloading') return `Descargando… ${percent} %`;
  if (error) return 'Reintentar';
  if (phase === 'ready') return 'Instalar';
  return 'Actualizar';
}
