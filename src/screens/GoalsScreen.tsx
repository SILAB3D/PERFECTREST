import { useState } from 'react';
import { Card, Pill, Segmented, Stepper, TimeField, Toggle } from '../components/ui';
import { bedtimesForWake, bestOption } from '../lib/cycles';
import { applyGoal, editGroups, normalizeForMode } from '../lib/schedule';
import { ALL_DAYS, DAY_NAMES, DAY_SHORT, formatHours, isoDay, nextOccurrence } from '../lib/time';
import type { DayIndex, ScheduleMode } from '../lib/types';
import { useStore } from '../state/store';

const MODE_OPTIONS: { value: ScheduleMode; label: string }[] = [
  { value: 'uniform', label: 'Toda la semana' },
  { value: 'weekday-weekend', label: 'Semana + finde' },
  { value: 'per-day', label: 'Día a día' },
];

/** Módulo 1 — Metas de sueño y avisos. */
export function GoalsScreen() {
  const { state, patch } = useStore();
  const { schedule, cycles, reminders } = state;
  const today = isoDay(new Date());
  const [selectedDay, setSelectedDay] = useState<DayIndex>(today);

  const groups = editGroups(schedule.mode);
  const activeDay = schedule.mode === 'per-day' ? selectedDay : undefined;

  const setMode = (mode: ScheduleMode) => patch({ schedule: normalizeForMode(schedule, mode) });

  const update = (day: DayIndex, p: Parameters<typeof applyGoal>[2]) =>
    patch({ schedule: applyGoal(schedule, day, p) });

  /** Hora de acostarse resultante para un día, según ciclos y meta. */
  const bedtimeFor = (day: DayIndex) => {
    const goal = schedule.goals[day];
    const wake = nextOccurrence(goal.wakeTime);
    return bestOption(bedtimesForWake(wake, cycles, goal.targetHours)).bedtime;
  };

  const renderEditor = (day: DayIndex, label: string) => {
    const goal = schedule.goals[day];
    const bed = bedtimeFor(day);
    return (
      <Card
        key={day}
        title={label || DAY_NAMES[day]}
        sub={`Acostándote a las ${bed.getHours().toString().padStart(2, '0')}:${bed
          .getMinutes()
          .toString()
          .padStart(2, '0')} cumples la meta al final de un ciclo`}
      >
        <div className="row">
          <div>
            <div className="row__label">Despertar a las</div>
            <div className="row__hint">La hora que quieres estar en pie</div>
          </div>
          <TimeField
            value={goal.wakeTime}
            label={`Hora de despertar (${DAY_NAMES[day]})`}
            onChange={(v) => update(day, { wakeTime: v })}
          />
        </div>

        <div className="row">
          <div>
            <div className="row__label">Horas objetivo</div>
            <div className="row__hint">Se redondea al ciclo completo más cercano</div>
          </div>
          <Stepper
            value={goal.targetHours}
            min={4}
            max={11}
            step={0.25}
            label={`Horas objetivo (${DAY_NAMES[day]})`}
            onChange={(v) => update(day, { targetHours: v })}
            format={formatHours}
          />
        </div>
      </Card>
    );
  };

  return (
    <>
      <Card
        title="Cómo quieres personalizar tu meta"
        sub="Puedes cambiar de modo cuando quieras: los valores de cada día se conservan."
      >
        <Segmented value={schedule.mode} options={MODE_OPTIONS} onChange={setMode} label="Modo de personalización" />
      </Card>

      {schedule.mode === 'per-day' ? (
        <>
          <Card title="Elige el día">
            <div className="daypicker">
              {ALL_DAYS.map((d) => (
                <button
                  key={d}
                  type="button"
                  className="daypicker__day"
                  aria-pressed={selectedDay === d}
                  aria-label={DAY_NAMES[d]}
                  onClick={() => setSelectedDay(d)}
                >
                  {DAY_SHORT[d]}
                </button>
              ))}
            </div>
          </Card>
          {renderEditor(activeDay!, DAY_NAMES[activeDay!])}
        </>
      ) : (
        groups.map((g) => renderEditor(g.days[0], g.label))
      )}

      <Card title="Tu semana" sub="Hora de acostarse calculada a partir de cada meta">
        <div className="weeklist">
          {ALL_DAYS.map((d) => {
            const goal = schedule.goals[d];
            const bed = bedtimeFor(d);
            const hh = String(bed.getHours()).padStart(2, '0');
            const mm = String(bed.getMinutes()).padStart(2, '0');
            return (
              <div key={d} className="weekrow">
                <span className={`weekrow__day ${d === today ? 'weekrow__today' : ''}`}>
                  {DAY_NAMES[d]}
                </span>
                <span className="weekrow__times">
                  <span className="weekrow__bed">{hh}:{mm}</span>
                  <span className="weekrow__arrow" aria-hidden="true">→</span>
                  <span className="weekrow__wake">{goal.wakeTime}</span>
                  <Pill tone="muted">{formatHours(goal.targetHours)}</Pill>
                </span>
              </div>
            );
          })}
        </div>
      </Card>

      <Card
        title="Avisos"
        sub="Los recordatorios son lo que convierte la meta en un hábito."
        action={<Pill tone={reminders.enabled ? 'mint' : 'muted'}>{reminders.enabled ? 'Activos' : 'Apagados'}</Pill>}
      >
        <Toggle
          checked={reminders.enabled}
          onChange={(v) => patch({ reminders: { ...reminders, enabled: v } })}
          label="Recordatorios de sueño"
          hint="Aviso previo, aviso a la hora exacta y alarma opcional al despertar"
        />

        {reminders.enabled && (
          <>
            <div className="row">
              <div>
                <div className="row__label">Aviso previo</div>
                <div className="row__hint">Para ir bajando el ritmo antes de acostarte</div>
              </div>
              <Stepper
                value={reminders.windDownMinutes}
                min={0}
                max={90}
                step={5}
                label="Minutos de aviso previo"
                onChange={(v) => patch({ reminders: { ...reminders, windDownMinutes: v } })}
                format={(v) => (v === 0 ? 'sin aviso' : `${v} min`)}
              />
            </div>

            <div className="row">
              <div>
                <div className="row__label">Margen de tolerancia</div>
                <div className="row__hint">
                  Cuánto puedes desviarte de la hora ideal antes de considerarlo tarde
                </div>
              </div>
              <Stepper
                value={reminders.toleranceMinutes}
                min={5}
                max={60}
                step={5}
                label="Margen de tolerancia"
                onChange={(v) => patch({ reminders: { ...reminders, toleranceMinutes: v } })}
                format={(v) => `± ${v} min`}
              />
            </div>

            <Toggle
              checked={reminders.nagIfLate}
              onChange={(v) => patch({ reminders: { ...reminders, nagIfLate: v } })}
              label="Insistir si me paso"
              hint="Un segundo aviso al agotarse el margen"
            />

            <Toggle
              checked={reminders.wakeAlarm}
              onChange={(v) => patch({ reminders: { ...reminders, wakeAlarm: v } })}
              label="Recordatorio al despertar"
              hint="No sustituye a tu alarma: es un aviso adicional a la hora objetivo"
            />
          </>
        )}
      </Card>
    </>
  );
}
