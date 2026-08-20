import { useEffect, useMemo, useState } from 'react';
import { Card, Pill, Segmented, Stepper, TimeField } from '../components/ui';
import { CycleRing, PhaseLegend } from '../components/viz';
import { bedtimesForWake, bestOption, wakeTimesForBedtime, type CycleOption } from '../lib/cycles';
import { upcomingNight } from '../lib/schedule';
import { formatClock, formatDuration, nextOccurrence } from '../lib/time';
import { useStore } from '../state/store';

type Mode = 'wake' | 'now';

const RATING_TONE = {
  ideal: 'mint',
  bueno: 'primary',
  justo: 'amber',
  escaso: 'rose',
} as const;

/** Módulo 2 — Cálculo de la hora de acostarse según los ciclos de sueño. */
export function CyclesScreen() {
  const { state, patch } = useStore();
  const { cycles } = state;

  const night = useMemo(() => upcomingNight(state.schedule), [state.schedule]);
  const [mode, setMode] = useState<Mode>('wake');
  const [wakeTime, setWakeTime] = useState(night.goal.wakeTime);
  const [now, setNow] = useState(() => new Date());
  const [selected, setSelected] = useState<number | null>(null);

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const options: CycleOption[] = useMemo(() => {
    if (mode === 'wake') {
      return bedtimesForWake(nextOccurrence(wakeTime, now), cycles, night.goal.targetHours);
    }
    return wakeTimesForBedtime(now, cycles, night.goal.targetHours);
  }, [mode, wakeTime, now, cycles, night.goal.targetHours]);

  const recommended = useMemo(() => bestOption(options), [options]);
  const active = options.find((o) => o.cycles === selected) ?? recommended;

  return (
    <>
      <Card
        title="¿Desde qué extremo calculamos?"
        sub="Los ciclos duran unos 90 minutos. Despertar al terminar uno evita la sensación de aturdimiento."
      >
        <Segmented
          value={mode}
          label="Modo de cálculo"
          options={[
            { value: 'wake', label: 'Quiero despertar a las…' },
            { value: 'now', label: 'Me acuesto ahora' },
          ]}
          onChange={(m) => {
            setMode(m);
            setSelected(null);
          }}
        />

        {mode === 'wake' ? (
          <div className="row" style={{ marginTop: 'var(--sp-3)' }}>
            <div>
              <div className="row__label">Hora de despertar</div>
              <div className="row__hint">Por defecto, la meta de la próxima noche</div>
            </div>
            <TimeField value={wakeTime} onChange={setWakeTime} label="Hora de despertar" />
          </div>
        ) : (
          <div className="row" style={{ marginTop: 'var(--sp-3)' }}>
            <div>
              <div className="row__label">Te acuestas a las {formatClock(now)}</div>
              <div className="row__hint">
                Contando {cycles.latencyMinutes} min en conciliar el sueño
              </div>
            </div>
          </div>
        )}
      </Card>

      <Card
        title={mode === 'wake' ? 'Tu noche recomendada' : 'Si te duermes ahora'}
        action={<Pill tone={RATING_TONE[active.rating]}>{active.rating}</Pill>}
      >
        <CycleRing
          cycles={active.cycles}
          bedtime={active.bedtime}
          wakeTime={active.wakeTime}
          sleepMs={active.sleepMs}
          latencyMs={cycles.latencyMinutes * 60_000}
        />
        <PhaseLegend />
        <p
          style={{
            fontSize: '0.8rem',
            color: 'var(--text-muted)',
            lineHeight: 1.6,
            marginTop: 'var(--sp-4)',
            textAlign: 'center',
          }}
        >
          Acostándote a las <strong>{formatClock(active.bedtime)}</strong> despertarás a las{' '}
          <strong>{formatClock(active.wakeTime)}</strong> al terminar el ciclo{' '}
          {active.cycles}.
        </p>
      </Card>

      <Card
        title={mode === 'wake' ? 'Horas a las que acostarte' : 'Horas a las que despertar'}
        sub={`Tu meta es ${formatDuration(night.goal.targetHours * 3_600_000)}; la opción marcada es la que más se ajusta.`}
      >
        <div className="cycle-list">
          {options.map((o) => {
            const isRec = o.cycles === recommended.cycles;
            const time = mode === 'wake' ? o.bedtime : o.wakeTime;
            return (
              <button
                key={o.cycles}
                type="button"
                className="cycle-opt"
                aria-pressed={o.cycles === active.cycles}
                onClick={() => setSelected(o.cycles)}
              >
                <span className="cycle-opt__time">{formatClock(time)}</span>
                <span className="cycle-opt__meta">
                  <span className="cycle-opt__cycles">{o.cycles} ciclos</span>
                  <span className="cycle-opt__dur">
                    {formatDuration(o.sleepMs)} de sueño · {formatDuration(o.inBedMs)} en la cama
                  </span>
                </span>
                {isRec ? (
                  <Pill tone="mint">recomendada</Pill>
                ) : (
                  <Pill tone={RATING_TONE[o.rating]}>{o.rating}</Pill>
                )}
              </button>
            );
          })}
        </div>
      </Card>

      <Card title="Ajusta el modelo a tu cuerpo" sub="Los valores por defecto son la media poblacional; si te conoces, afínalos.">
        <div className="row">
          <div>
            <div className="row__label">Duración del ciclo</div>
            <div className="row__hint">Entre 70 y 120 min según la persona; la media son 90</div>
          </div>
          <Stepper
            value={cycles.cycleMinutes}
            min={70}
            max={120}
            step={5}
            label="Duración del ciclo"
            onChange={(v) => patch({ cycles: { ...cycles, cycleMinutes: v } })}
            format={(v) => `${v} min`}
          />
        </div>

        <div className="row">
          <div>
            <div className="row__label">Tardo en dormirme</div>
            <div className="row__hint">Se suma al tiempo en la cama para calcular la hora</div>
          </div>
          <Stepper
            value={cycles.latencyMinutes}
            min={0}
            max={45}
            step={5}
            label="Latencia del sueño"
            onChange={(v) => patch({ cycles: { ...cycles, latencyMinutes: v } })}
            format={(v) => `${v} min`}
          />
        </div>
      </Card>
    </>
  );
}
