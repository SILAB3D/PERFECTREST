import { useEffect, useMemo, useState } from 'react';
import { Bar, Card, Metric, Pill } from '../components/ui';
import { bedtimesForWake, bestOption } from '../lib/cycles';
import { bedtimeStatus, bedtimeWindow, upcomingNight } from '../lib/schedule';
import { buildNights, insight, summarize } from '../lib/stats';
import {
  DAY_NAMES,
  HOUR,
  MINUTE,
  formatClock,
  formatDuration,
  formatHours,
  relativeDayLabel,
} from '../lib/time';
import { useStore } from '../state/store';

const STATUS_COPY: Record<string, { tone: 'primary' | 'amber' | 'rose' | 'mint'; text: string }> = {
  lejos: { tone: 'primary', text: 'Aún tienes margen' },
  preparacion: { tone: 'amber', text: 'Hora de bajar el ritmo' },
  ventana: { tone: 'mint', text: 'Es tu momento de dormir' },
  tarde: { tone: 'rose', text: 'Vas con retraso' },
};

export function HomeScreen({ onGoTo }: { onGoTo: (tab: string) => void }) {
  const { state } = useStore();
  const [now, setNow] = useState(() => new Date());

  // Un tic por minuto basta: todo lo que se muestra tiene resolución de minuto.
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const night = useMemo(() => upcomingNight(state.schedule, now), [state.schedule, now]);
  const options = useMemo(
    () => bedtimesForWake(night.wakeAt, state.cycles, night.goal.targetHours),
    [night, state.cycles],
  );
  const best = useMemo(() => bestOption(options), [options]);
  const window_ = bedtimeWindow(best.bedtime, state.reminders.toleranceMinutes);
  const status = bedtimeStatus(
    now,
    best.bedtime,
    state.reminders.toleranceMinutes,
    state.reminders.windDownMinutes,
  );

  const msToBed = best.bedtime.getTime() - now.getTime();
  const copy = STATUS_COPY[status];

  const week = useMemo(
    () => summarize(buildNights(state.sessions, state.schedule, 7, now.getTime())),
    [state.sessions, state.schedule, now],
  );
  const tip = insight(week);

  const lastNight = week.nights[week.nights.length - 1];
  const targetPct = lastNight?.session ? (lastNight.durationMs / lastNight.targetMs) * 100 : 0;

  return (
    <>
      <div className="hero">
        <div className="hero__label">
          {msToBed > 0 ? 'Acuéstate hoy a las' : 'Tu hora era a las'}
        </div>
        <div className="hero__time">{formatClock(best.bedtime)}</div>
        <p className="hero__meta">
          Despertarás a las <strong>{formatClock(night.wakeAt)}</strong> tras{' '}
          <strong>{best.cycles} ciclos</strong> ({formatDuration(best.sleepMs)} de sueño),
          justo al final de una fase ligera.
        </p>

        <div className="hero__row">
          <Pill tone={copy.tone}>{copy.text}</Pill>
          <Pill tone="muted">
            Margen {formatClock(window_.from)}–{formatClock(window_.to)}
          </Pill>
        </div>

        <div className="countdown">
          <span className="countdown__value">
            {msToBed > 0 ? `Faltan ${formatDuration(msToBed)}` : `Hace ${formatDuration(-msToBed)}`}
          </span>
          <span className="countdown__label">
            · meta de {DAY_NAMES[night.day].toLowerCase()}: {formatHours(night.goal.targetHours)}
          </span>
        </div>
      </div>

      <div className="grid-2">
        <Card>
          <Metric
            value={week.avgDurationMs ? formatDuration(week.avgDurationMs) : '—'}
            label="Media de 7 días"
            tone={
              week.avgDurationMs && week.avgDurationMs >= week.avgTargetMs - 30 * MINUTE
                ? 'mint'
                : 'amber'
            }
            note={week.recorded ? `${week.recorded} de 7 noches` : 'sin datos aún'}
          />
        </Card>
        <Card>
          <Metric
            value={week.consistency !== null ? `${week.consistency}%` : '—'}
            label="Consistencia"
            tone={week.consistency !== null && week.consistency >= 70 ? 'mint' : 'amber'}
            note={week.streak > 0 ? `racha de ${week.streak} noches` : 'sin racha activa'}
          />
        </Card>
      </div>

      <Card
        title="Última noche"
        sub={lastNight?.session ? relativeDayLabel(lastNight.dayStart) : undefined}
        action={
          lastNight?.session ? (
            <Pill tone={targetPct >= 94 ? 'mint' : targetPct >= 80 ? 'amber' : 'rose'}>
              {Math.round(targetPct)}% de la meta
            </Pill>
          ) : null
        }
      >
        {lastNight?.session ? (
          <>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'baseline',
                marginBottom: 'var(--sp-3)',
              }}
            >
              <span style={{ fontSize: '1.35rem', fontWeight: 700, letterSpacing: '-0.02em' }}>
                {formatDuration(lastNight.durationMs)}
              </span>
              <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                {formatClock(lastNight.session.start)} → {formatClock(lastNight.session.end)}
              </span>
            </div>
            <Bar pct={targetPct} />
            <p style={{ fontSize: '0.76rem', color: 'var(--text-faint)', marginTop: 'var(--sp-3)' }}>
              Meta: {formatDuration(lastNight.targetMs)} ·{' '}
              {lastNight.deltaMs >= 0
                ? `${formatDuration(lastNight.deltaMs)} de sobra`
                : `te faltaron ${formatDuration(-lastNight.deltaMs)}`}
            </p>
          </>
        ) : (
          <>
            <p style={{ fontSize: '0.83rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>
              Todavía no hay registro de esta noche. La app lo detectará sola en cuanto pases unas
              horas sin usar el móvil.
            </p>
            <button
              className="btn btn--ghost btn--full"
              style={{ marginTop: 'var(--sp-4)' }}
              onClick={() => onGoTo('stats')}
            >
              Añadir la noche a mano
            </button>
          </>
        )}
      </Card>

      <Card title="Cómo vas">
        <p style={{ fontSize: '0.85rem', lineHeight: 1.65, color: 'var(--text-muted)' }}>
          {tip.text}
        </p>
        {week.debtMs > HOUR && (
          <p style={{ fontSize: '0.78rem', marginTop: 'var(--sp-3)', color: 'var(--amber)' }}>
            Deuda acumulada esta semana: {formatDuration(week.debtMs)}
          </p>
        )}
      </Card>
    </>
  );
}
