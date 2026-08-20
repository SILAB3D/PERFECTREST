import { useState } from 'react';
import { Pill } from './ui';
import { describeTriggers } from '../lib/triggers';
import { formatDuration } from '../lib/time';
import type { SleepSession } from '../lib/types';

/** Convierte un epoch a los valores que necesita <input type="datetime-local">. */
function toLocalInput(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}

const QUALITY_FACES = ['😴', '🙁', '😐', '🙂', '🤩'];

/** Hoja inferior para crear o corregir una sesión de sueño. */
export function SessionSheet({
  session,
  onSave,
  onDelete,
  onClose,
}: {
  session: SleepSession;
  onSave: (s: SleepSession) => void;
  onDelete?: (id: string) => void;
  onClose: () => void;
}) {
  const [start, setStart] = useState(session.start);
  const [end, setEnd] = useState(session.end);
  const [quality, setQuality] = useState(session.quality);

  const duration = end - start;
  const invalid = duration <= 0;
  const origin = session.source === 'auto' ? describeTriggers(session.triggers) : null;

  const save = () => {
    if (invalid) return;
    onSave({
      ...session,
      start,
      end,
      quality,
      confirmed: true,
      source: session.source === 'auto' ? 'edited' : session.source,
    });
    onClose();
  };

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label="Editar sesión de sueño"
      onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet__panel">
        <div className="sheet__grab" />
        <h2 className="sheet__title">
          {session.source === 'auto' ? 'Confirma esta noche' : 'Editar registro'}
        </h2>

        <div className="row">
          <div>
            <div className="row__label">Me dormí</div>
          </div>
          <input
            type="datetime-local"
            className="timefield"
            value={toLocalInput(start)}
            aria-label="Inicio del sueño"
            onChange={(e) => e.target.value && setStart(new Date(e.target.value).getTime())}
          />
        </div>

        <div className="row">
          <div>
            <div className="row__label">Me desperté</div>
          </div>
          <input
            type="datetime-local"
            className="timefield"
            value={toLocalInput(end)}
            aria-label="Fin del sueño"
            onChange={(e) => e.target.value && setEnd(new Date(e.target.value).getTime())}
          />
        </div>

        {origin && (
          <div className="row">
            <div>
              <div className="row__label">Detectado por</div>
              <div className="row__hint">Señales que marcaron el principio y el final</div>
            </div>
            <Pill tone="muted">{origin}</Pill>
          </div>
        )}

        <div className="row">
          <div className="row__label">Total dormido</div>
          {invalid ? (
            <Pill tone="rose">El despertar debe ir después</Pill>
          ) : (
            <Pill tone="primary">{formatDuration(duration)}</Pill>
          )}
        </div>

        <div style={{ marginTop: 'var(--sp-4)' }}>
          <div className="row__label" style={{ marginBottom: 'var(--sp-3)' }}>
            ¿Cómo descansaste?
          </div>
          <div className="quality">
            {QUALITY_FACES.map((face, i) => (
              <button
                key={face}
                type="button"
                className="quality__btn"
                aria-pressed={quality === i + 1}
                aria-label={`Calidad ${i + 1} de 5`}
                onClick={() => setQuality(quality === i + 1 ? undefined : i + 1)}
              >
                {face}
              </button>
            ))}
          </div>
        </div>

        <div className="pending__actions">
          <button className="btn btn--ghost" onClick={onClose}>Cancelar</button>
          <button className="btn btn--primary" onClick={save} disabled={invalid}>Guardar</button>
        </div>

        {onDelete && (
          <button
            className="btn btn--danger btn--full"
            style={{ marginTop: 'var(--sp-3)' }}
            onClick={() => {
              onDelete(session.id);
              onClose();
            }}
          >
            Eliminar registro
          </button>
        )}
      </div>
    </div>
  );
}
