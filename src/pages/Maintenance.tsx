import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Wrench } from 'lucide-react';
import { useDuty, useFleet, useMaintenance, useMaintenanceLogs } from '../hooks/data.ts';
import { useAuth } from '../hooks/auth.tsx';
import { api } from '../lib/api.ts';
import { num, siteDate, siteDateTime } from '../lib/format.ts';
import {
  Badge, Button, Card, CardHead, Dialog, Empty, Field, Input, Select, Spinner,
  Table, Td, Textarea, useToast,
} from '../components/ui.tsx';
import type { MaintenanceItem } from '../lib/types.ts';

/** Service thresholds we recommend against the duty counters. */
const SERVICE_LIMITS = {
  sump_run_hours: 500,
  dosing_run_hours: 250,
  valve_cycles: 20000,
};

export default function Maintenance() {
  const { data: fleet } = useFleet();
  const [deviceId, setDeviceId] = useState('');
  const active = deviceId || fleet?.[0]?.device_id;
  const { data: items, isLoading } = useMaintenance(active);
  const { data: logs } = useMaintenanceLogs(active);
  const { data: duty } = useDuty(active);
  const { session, can } = useAuth();
  const { push } = useToast();
  const qc = useQueryClient();

  const [logging, setLogging] = useState<MaintenanceItem | null>(null);
  const [notes, setNotes] = useState('');
  const [before, setBefore] = useState({ a: '', b: '' });
  const [after, setAfter] = useState({ a: '', b: '' });
  const [busy, setBusy] = useState(false);

  const device = fleet?.find((f) => f.device_id === active);
  const inMaintenanceMode = device?.mode === 'MAINTENANCE';

  async function save() {
    if (!logging || !session) return;
    setBusy(true);
    try {
      const isCal = logging.task === 'calibrate';
      await api.logMaintenance({
        itemId: logging.id,
        deviceId: logging.device_id,
        notes,
        before: isCal ? { point_1: Number(before.a), point_2: Number(before.b) } : {},
        after: isCal ? { point_1: Number(after.a), point_2: Number(after.b) } : {},
        userId: session.user_id,
      });
      push({ tone: 'good', title: 'Recorded', body: `${logging.component} — next due date updated.` });
      qc.invalidateQueries({ queryKey: ['maintenance'] });
      qc.invalidateQueries({ queryKey: ['maintenance-logs'] });
      setLogging(null);
      setNotes('');
      setBefore({ a: '', b: '' });
      setAfter({ a: '', b: '' });
    } catch (e) {
      push({ tone: 'crit', title: 'Could not record it', body: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  if (isLoading) return <Spinner label="Loading the maintenance schedule" />;

  const overdue = (items ?? []).filter((i) => i.next_due_at && Date.parse(i.next_due_at) < Date.now());
  const dueSoon = (items ?? []).filter((i) =>
    i.next_due_at && Date.parse(i.next_due_at) >= Date.now() && Date.parse(i.next_due_at) < Date.now() + 7 * 86400_000);

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-lg font-semibold text-ink">Maintenance</h1>
          <p className="text-sm text-muted">
            {overdue.length ? `${overdue.length} overdue · ` : ''}{dueSoon.length} due within a week
          </p>
        </div>
        <Field label="Device">
          <Select value={active} onChange={(e) => setDeviceId(e.target.value)} className="min-w-[14rem]">
            {fleet?.map((f) => <option key={f.device_id} value={f.device_id}>{f.device_name}</option>)}
          </Select>
        </Field>
      </header>

      {!inMaintenanceMode ? (
        <div className="flex items-start gap-3 rounded-xl border border-line bg-raised p-4">
          <Wrench className="mt-0.5 h-5 w-5 shrink-0 text-muted" aria-hidden />
          <div className="text-sm">
            <p className="font-medium text-ink">Put the plant in MAINTENANCE mode before you touch a probe</p>
            <p className="mt-0.5 text-ink-2">
              It stops the sequence and shuts every valve, so a probe lifted into buffer solution cannot make
              the controller decide anything about real water. Do it from the device&apos;s control page.
            </p>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-warn/50 bg-warn/5 p-4 text-sm">
          <p className="font-medium text-warn">This device is in MAINTENANCE mode</p>
          <p className="mt-0.5 text-ink-2">
            The plant is stopped and no water is being tested. Return it to AUTO when you are done.
          </p>
        </div>
      )}

      <Card>
        <CardHead title="Calibration and service schedule" />
        <Table head={['Component', 'Task', 'Interval', 'Last done', 'Next due', 'Status', '']}>
          {(items ?? []).map((i) => {
            const isOverdue = Boolean(i.next_due_at && Date.parse(i.next_due_at) < Date.now());
            const soon = Boolean(i.next_due_at && !isOverdue && Date.parse(i.next_due_at) < Date.now() + 7 * 86400_000);
            return (
              <tr key={i.id} className="hover:bg-raised">
                <Td className="font-medium text-ink">{i.component}</Td>
                <Td className="capitalize">{i.task}</Td>
                <Td>{i.interval_days ? `${i.interval_days} days` : '—'}</Td>
                <Td className="font-mono text-xs">{i.last_done_at ? siteDate(i.last_done_at) : 'never'}</Td>
                <Td className="font-mono text-xs">{i.next_due_at ? siteDate(i.next_due_at) : '—'}</Td>
                <Td>
                  {isOverdue ? <Badge tone="warn">overdue</Badge>
                    : soon ? <Badge tone="info">due soon</Badge>
                    : <Badge tone="good">in date</Badge>}
                </Td>
                <Td className="text-right">
                  <Button size="sm" disabled={!can('operate')} onClick={() => setLogging(i)}>Record</Button>
                </Td>
              </tr>
            );
          })}
        </Table>
      </Card>

      <Card>
        <CardHead
          title="Duty counters"
          hint="Derived from telemetry, not from a counter the device could lose"
        />
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-5">
          <Counter label="Sump pump" value={`${num(duty?.sump_run_hours ?? 0, 1)} h`}
            limit={SERVICE_LIMITS.sump_run_hours} actual={duty?.sump_run_hours ?? 0} unit="h" />
          <Counter label="Dosing pump" value={`${num(duty?.dosing_run_hours ?? 0, 1)} h`}
            limit={SERVICE_LIMITS.dosing_run_hours} actual={duty?.dosing_run_hours ?? 0} unit="h" />
          <Counter label="V1 cycles" value={num(duty?.v1_cycles ?? 0)}
            limit={SERVICE_LIMITS.valve_cycles} actual={duty?.v1_cycles ?? 0} unit="" />
          <Counter label="V2 cycles" value={num(duty?.v2_cycles ?? 0)}
            limit={SERVICE_LIMITS.valve_cycles} actual={duty?.v2_cycles ?? 0} unit="" />
          <Counter label="V3 cycles" value={num(duty?.v3_cycles ?? 0)}
            limit={SERVICE_LIMITS.valve_cycles} actual={duty?.v3_cycles ?? 0} unit="" />
        </div>
        <p className="mt-3 text-xs text-muted">
          Recommended service points: sump pump every {SERVICE_LIMITS.sump_run_hours} h,
          dosing pump every {SERVICE_LIMITS.dosing_run_hours} h (it handles slurry),
          solenoid valves every {num(SERVICE_LIMITS.valve_cycles)} cycles.
        </p>
      </Card>

      <Card>
        <CardHead title="Maintenance history" hint="Calibration values before and after, so drift is visible" />
        {logs?.length ? (
          <div className="space-y-3">
            {logs.map((l) => (
              <div key={l.id} className="rounded-lg border border-line p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm font-medium text-ink">
                    {items?.find((i) => i.id === l.item_id)?.component ?? 'Maintenance'}
                  </span>
                  <span className="font-mono text-xs text-muted">
                    {siteDateTime(l.performed_at)} · {l.performed_by_name ?? 'operator'}
                  </span>
                </div>
                {l.notes ? <p className="mt-1 text-sm text-ink-2">{l.notes}</p> : null}
                {Object.keys(l.before_values ?? {}).length ? (
                  <div className="mt-2 flex flex-wrap gap-4 font-mono text-xs">
                    <span className="text-muted">before: {JSON.stringify(l.before_values)}</span>
                    <span className="text-ink">after: {JSON.stringify(l.after_values)}</span>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <Empty title="Nothing recorded yet" body="Calibrations and services logged here become part of the compliance report." />
        )}
      </Card>

      <Dialog
        open={Boolean(logging)}
        onClose={() => setLogging(null)}
        title={`Record: ${logging?.component ?? ''}`}
        description={
          logging?.task === 'calibrate'
            ? 'Record what the probe read in each buffer before you adjusted it, and what it read afterwards. The difference is the drift, and it is what tells you when a probe is failing.'
            : 'Record what was done. The next due date is recalculated from today.'
        }
        footer={
          <>
            <Button onClick={() => setLogging(null)}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={save}>
              <CalendarClock className="h-4 w-4" /> Save
            </Button>
          </>
        }
      >
        {logging?.task === 'calibrate' ? (
          <div className="mb-4 grid grid-cols-2 gap-3">
            <Field label="Before — point 1" hint={logging.component.includes('pH') ? 'pH 4.01 buffer' : 'low standard'}>
              <Input inputMode="decimal" value={before.a} onChange={(e) => setBefore({ ...before, a: e.target.value })} placeholder="4.18" />
            </Field>
            <Field label="Before — point 2" hint={logging.component.includes('pH') ? 'pH 7.00 buffer' : 'high standard'}>
              <Input inputMode="decimal" value={before.b} onChange={(e) => setBefore({ ...before, b: e.target.value })} placeholder="7.14" />
            </Field>
            <Field label="After — point 1">
              <Input inputMode="decimal" value={after.a} onChange={(e) => setAfter({ ...after, a: e.target.value })} placeholder="4.01" />
            </Field>
            <Field label="After — point 2">
              <Input inputMode="decimal" value={after.b} onChange={(e) => setAfter({ ...after, b: e.target.value })} placeholder="7.00" />
            </Field>
          </div>
        ) : null}
        <Field label="Notes">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)}
            placeholder="Probe cleaned, membrane intact. Two-point calibration." />
        </Field>
      </Dialog>
    </div>
  );
}

function Counter({ label, value, limit, actual, unit }: {
  label: string; value: string; limit: number; actual: number; unit: string;
}) {
  const frac = Math.min(1, actual / limit);
  const due = frac >= 1;
  const near = !due && frac > 0.8;
  return (
    <div className="bg-surface p-3">
      <p className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-muted">{label}</p>
      <p className="mt-1 font-mono text-lg tabular text-ink">{value}</p>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-raised">
        <div className={`h-full rounded-full ${due ? 'bg-crit' : near ? 'bg-warn' : 'bg-accent'}`}
          style={{ width: `${frac * 100}%` }} />
      </div>
      <p className="mt-1 text-[10.5px] text-muted">
        {due ? 'service due' : `of ${num(limit)}${unit ? ` ${unit}` : ''}`}
      </p>
    </div>
  );
}
