/**
 * Shift logbook.
 *
 * The handover note is the oldest and most reliable piece of plant safety
 * equipment there is. This page writes one and attaches an automatic summary
 * of what the plant actually did during the shift, so the next operator reads
 * both what happened and what a person thought about it.
 */

import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { NotebookPen, UserRoundCheck } from 'lucide-react';
import { useAlarms, useBatches, useFleet, useProfiles, useShifts } from '../hooks/data.ts';
import { useAuth } from '../hooks/auth.tsx';
import { api } from '../lib/api.ts';
import { num, siteDateTime, siteTime } from '../lib/format.ts';
import {
  Badge, Button, Card, CardHead, Dialog, Empty, Field, Select, Spinner, Textarea, useToast,
} from '../components/ui.tsx';

export default function Logbook() {
  const { data: fleet } = useFleet();
  const [siteId, setSiteId] = useState('');
  const site = siteId || fleet?.[0]?.site_id;
  const { data: shifts, isLoading } = useShifts(site);
  const { data: profiles } = useProfiles();
  const { session, can } = useAuth();
  const { push } = useToast();
  const qc = useQueryClient();

  const [writing, setWriting] = useState(false);
  const [notes, setNotes] = useState('');
  const [handoverTo, setHandoverTo] = useState('');
  const [hours, setHours] = useState(8);
  const [busy, setBusy] = useState(false);

  const since = useMemo(() => new Date(Date.now() - hours * 3600_000).toISOString(), [hours]);
  const deviceIds = useMemo(
    () => new Set((fleet ?? []).filter((f) => f.site_id === site).map((f) => f.device_id)),
    [fleet, site],
  );

  const { data: batches } = useBatches({ from: since, limit: 2000 });
  const { data: alarms } = useAlarms({ from: since });

  const summary = useMemo(() => {
    const b = (batches ?? []).filter((x) => deviceIds.has(x.device_id));
    const a = (alarms ?? []).filter((x) => deviceIds.has(x.device_id) && x.severity !== 'info');
    return {
      batches: b.length,
      passed: b.filter((x) => x.result === 'PASS').length,
      acid: b.filter((x) => x.fail_reason === 'ACID').length,
      alkaline: b.filter((x) => x.fail_reason === 'ALKALINE').length,
      tds: b.filter((x) => x.fail_reason === 'TDS').length,
      held: b.filter((x) => x.result === 'HELD').length,
      toRiver: b.filter((x) => x.destination === 'RIVER').reduce((s, x) => s + Number(x.volume_l), 0),
      blocked: b.filter((x) => x.destination !== 'RIVER').reduce((s, x) => s + Number(x.volume_l), 0),
      alarms: a.length,
      critical: a.filter((x) => x.severity === 'critical').length,
      unacked: a.filter((x) => !x.acknowledged_at).length,
    };
  }, [batches, alarms, deviceIds]);

  async function save() {
    if (!session || !site) return;
    if (!notes.trim()) {
      push({ tone: 'warn', title: 'Write something first', body: 'Even "nothing unusual" is worth recording.' });
      return;
    }
    setBusy(true);
    try {
      await api.addShift({
        siteId: site,
        notes: notes.trim(),
        shiftStart: since,
        handoverTo: handoverTo || null,
        userId: session.user_id,
      });
      push({ tone: 'good', title: 'Shift logged', body: 'The next operator will see this on their first page.' });
      qc.invalidateQueries({ queryKey: ['shifts'] });
      setWriting(false);
      setNotes('');
      setHandoverTo('');
    } catch (e) {
      push({ tone: 'crit', title: 'Could not save the entry', body: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  if (isLoading) return <Spinner label="Loading the logbook" />;

  const sites = [...new Map((fleet ?? []).map((f) => [f.site_id, f.site_name])).entries()];

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-semibold leading-tight text-ink">Shift logbook</h1>
          <p className="text-sm text-muted">Handover notes and what the plant did while you were on</p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Site">
            <Select value={site} onChange={(e) => setSiteId(e.target.value)} className="min-w-[14rem]">
              {sites.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </Select>
          </Field>
          <Button variant="primary" disabled={!can('operate')} onClick={() => setWriting(true)}>
            <NotebookPen className="h-4 w-4" /> Write handover
          </Button>
        </div>
      </header>

      <Card>
        <CardHead
          title={`Automatic summary — last ${hours} hours`}
          hint="Generated from the batch register and the alarm log"
          right={
            <Select value={hours} onChange={(e) => setHours(Number(e.target.value))} className="w-28">
              <option value={8}>8 hours</option>
              <option value={12}>12 hours</option>
              <option value={24}>24 hours</option>
            </Select>
          }
        />
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-4">
          <Cell label="Batches tested" value={num(summary.batches)} />
          <Cell label="Passed" value={num(summary.passed)} />
          <Cell label="Kept out of the river" value={`${num(summary.blocked)} L*`} tone="good" />
          <Cell label="Alarms" value={num(summary.alarms)} tone={summary.critical > 0 ? 'crit' : undefined}
            hint={summary.critical ? `${summary.critical} critical` : undefined} />
        </div>
        <p className="mt-3 text-sm text-ink-2">
          {summary.batches === 0
            ? 'No batches were tested in this window.'
            : `Of ${summary.batches} batches, ${summary.passed} passed first time. ` +
              `${summary.acid} were rejected as acidic, ${summary.alkaline} as alkaline and ${summary.tds} on dissolved solids` +
              `${summary.held ? `, and ${summary.held} had to be held in the chamber because the tank was full` : ''}. ` +
              `${num(summary.toRiver)} L reached the river and ${num(summary.blocked)} L were kept out of it.` +
              (summary.unacked ? ` ${summary.unacked} alarm(s) are still unacknowledged.` : '')}
        </p>
      </Card>

      {shifts?.length ? (
        <div className="space-y-3">
          {shifts.map((s) => (
            <Card key={s.id}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <p className="text-sm font-medium text-ink">{s.author_name ?? 'Operator'}</p>
                  <p className="font-mono text-xs text-muted">
                    {siteDateTime(s.shift_start)} → {s.shift_end ? siteTime(s.shift_end) : 'open'}
                  </p>
                </div>
                {s.handover_to_name ? (
                  <Badge tone="info"><UserRoundCheck className="h-3.5 w-3.5" />handed to {s.handover_to_name}</Badge>
                ) : null}
              </div>
              <p className="mt-3 whitespace-pre-wrap text-sm text-ink-2">{s.notes}</p>
            </Card>
          ))}
        </div>
      ) : (
        <Empty title="No entries for this site yet" body="The first handover note goes here." />
      )}

      <Dialog
        open={writing}
        onClose={() => setWriting(false)}
        title="Shift handover"
        description="Write what the next person needs to know. The automatic summary above is attached to this entry."
        footer={
          <>
            <Button onClick={() => setWriting(false)}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={save}>Save entry</Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Notes" hint="What happened, what you changed, what to watch">
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="min-h-[140px]"
              placeholder="Inflow turned acid around 01:00, twelve batches diverted in a row. Tank kept up. Refilled the neutraliser drum at 03:20 — about half a drum left in the store."
            />
          </Field>
          <Field label="Handing over to" hint="Optional">
            <Select value={handoverTo} onChange={(e) => setHandoverTo(e.target.value)}>
              <option value="">Nobody in particular</option>
              {profiles?.filter((p) => p.user_id !== session?.user_id).map((p) => (
                <option key={p.user_id} value={p.user_id}>{p.full_name} ({p.role})</option>
              ))}
            </Select>
          </Field>
        </div>
      </Dialog>
    </div>
  );
}

function Cell({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'good' | 'crit' }) {
  return (
    <div className="bg-surface p-3">
      <p className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-muted">{label}</p>
      <p className={`mt-1 text-lg font-semibold tabular ${
        tone === 'good' ? 'text-good-ink' : tone === 'crit' ? 'text-crit' : 'text-ink'}`}>
        {value}
      </p>
      {hint ? <p className="text-xs text-ink-2">{hint}</p> : null}
    </div>
  );
}
