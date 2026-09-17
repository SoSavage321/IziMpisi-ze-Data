import { useMemo, useState } from 'react';
import {
  Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { useBatches, useCycles, useFleet, useInventory } from '../hooks/data.ts';
import { chemicalUsage } from '@shared/reports.ts';
import { duration, num, pct } from '../lib/format.ts';
import { Card, CardHead, Field, Select, Spinner, cn } from '../components/ui.tsx';

const RANGES = [
  { label: 'Last 24 hours', days: 1 },
  { label: 'Last 7 days', days: 7 },
  { label: 'Last 30 days', days: 30 },
];

const tooltipStyle = {
  background: 'rgb(var(--surface))',
  border: '1px solid rgb(var(--line))',
  borderRadius: 8,
  fontSize: 12,
  color: 'rgb(var(--ink))',
};

export default function Analytics() {
  const { data: fleet } = useFleet();
  const [deviceId, setDeviceId] = useState('');
  const [days, setDays] = useState(7);

  const from = new Date(Date.now() - days * 86400_000).toISOString();
  const { data: batches, isLoading } = useBatches({ deviceId: deviceId || undefined, from, limit: 5000 });
  const { data: cycles } = useCycles({ deviceId: deviceId || undefined, from });
  const { data: inventory } = useInventory();

  const daily = useMemo(() => {
    const map = new Map<string, { day: string; passed: number; failed: number; river: number; blocked: number }>();
    for (const b of batches ?? []) {
      const day = b.started_at.slice(0, 10);
      const row = map.get(day) ?? { day, passed: 0, failed: 0, river: 0, blocked: 0 };
      if (b.result === 'PASS') row.passed += 1; else row.failed += 1;
      if (b.destination === 'RIVER') row.river += Number(b.volume_l); else row.blocked += Number(b.volume_l);
      map.set(day, row);
    }
    return [...map.values()].sort((a, b) => a.day.localeCompare(b.day))
      .map((r) => ({ ...r, label: r.day.slice(5), rate: r.passed + r.failed ? Math.round((r.passed / (r.passed + r.failed)) * 100) : 0 }));
  }, [batches]);

  const phBuckets = useMemo(() => bucket(batches ?? [], 'avg_ph', 3, 11, 0.5), [batches]);
  const tdsBuckets = useMemo(() => bucket(batches ?? [], 'avg_tds', 0, 2000, 200), [batches]);

  const reasons = useMemo(() => {
    const out = { ACID: 0, ALKALINE: 0, TDS: 0 };
    for (const b of batches ?? []) if (b.fail_reason && b.fail_reason in out) out[b.fail_reason as keyof typeof out] += 1;
    return [
      { name: 'Acid (pH low)', value: out.ACID, fill: 'rgb(var(--crit))' },
      { name: 'Alkaline (pH high)', value: out.ALKALINE, fill: 'rgb(var(--serious))' },
      { name: 'TDS over limit', value: out.TDS, fill: 'rgb(var(--warn))' },
    ];
  }, [batches]);

  const released = (cycles ?? []).filter((c) => c.released_at);
  const treatSeconds = released.map((c) =>
    (Date.parse(c.released_at as string) - Date.parse(c.started_at)) / 1000);
  const avgTreat = treatSeconds.length ? treatSeconds.reduce((a, b) => a + b, 0) / treatSeconds.length : null;

  // Reservoir size is a site value; 20 L drums are what the prototype uses.
  const RESERVOIR_L = 20;
  const costPerLitre = inventory?.[0]?.cost_per_unit ?? 48;
  const usage = chemicalUsage(released as never, RESERVOIR_L, Number(costPerLitre));

  const total = (batches ?? []).length;
  const passed = (batches ?? []).filter((b) => b.result === 'PASS').length;
  const toRiver = (batches ?? []).filter((b) => b.destination === 'RIVER').reduce((s, b) => s + Number(b.volume_l), 0);
  const blocked = (batches ?? []).filter((b) => b.destination !== 'RIVER').reduce((s, b) => s + Number(b.volume_l), 0);

  // Uptime from how many batches actually ran against how many could have.
  const expected = Math.max(1, Math.round((days * 24 * 60) / 6));
  const uptime = Math.min(100, Math.round((total / (expected * (deviceId ? 1 : Math.max(1, fleet?.length ?? 1)))) * 100));

  if (isLoading) return <Spinner label="Crunching the numbers" />;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-lg font-semibold text-ink">Analytics</h1>
          <p className="text-sm text-muted">How the plant has been performing</p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Device">
            <Select value={deviceId} onChange={(e) => setDeviceId(e.target.value)} className="min-w-[12rem]">
              <option value="">All devices</option>
              {fleet?.map((f) => <option key={f.device_id} value={f.device_id}>{f.device_name}</option>)}
            </Select>
          </Field>
          <Field label="Period">
            <Select value={days} onChange={(e) => setDays(Number(e.target.value))} className="min-w-[10rem]">
              {RANGES.map((r) => <option key={r.days} value={r.days}>{r.label}</option>)}
            </Select>
          </Field>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line lg:grid-cols-6">
        <Tile label="Batches" value={num(total)} />
        <Tile label="Pass rate" value={total ? pct((passed / total) * 100) : '—'} />
        <Tile label="To river" value={`${num(toRiver)} L*`} />
        <Tile label="Kept out" value={`${num(blocked)} L*`} tone="good" />
        <Tile label="Avg treatment" value={avgTreat === null ? '—' : duration(avgTreat)} />
        <Tile label="Uptime" value={`${uptime}%`} hint="batches run vs expected" />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHead title="Pass rate by day" hint="A falling line means the inflow is getting worse" />
          <div className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={daily} margin={{ top: 8, right: 12, bottom: 4, left: -18 }}>
                <CartesianGrid stroke="rgb(var(--line))" vertical={false} />
                <ReferenceLine y={50} stroke="rgb(var(--warn))" strokeDasharray="5 5"
                  label={{ value: 'alarm at 50%', position: 'insideTopRight', fill: 'rgb(var(--muted))', fontSize: 11 }} />
                <XAxis dataKey="label" tick={{ fill: 'rgb(var(--muted))', fontSize: 11 }} stroke="rgb(var(--line))" />
                <YAxis domain={[0, 100]} tick={{ fill: 'rgb(var(--muted))', fontSize: 11 }} stroke="rgb(var(--line))" width={44} />
                <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => [`${v}%`, 'passed']} />
                <Line type="monotone" dataKey="rate" stroke="rgb(var(--accent))" strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card>
          <CardHead title="Volumes by day" hint="Released to the river against kept out of it" />
          <div className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={daily} margin={{ top: 8, right: 12, bottom: 4, left: -8 }}>
                <CartesianGrid stroke="rgb(var(--line))" vertical={false} />
                <XAxis dataKey="label" tick={{ fill: 'rgb(var(--muted))', fontSize: 11 }} stroke="rgb(var(--line))" />
                <YAxis tick={{ fill: 'rgb(var(--muted))', fontSize: 11 }} stroke="rgb(var(--line))" width={56} />
                <Tooltip contentStyle={tooltipStyle} formatter={(v: number, n) => [`${num(v)} L`, n === 'river' ? 'to river' : 'blocked']} />
                <Legend wrapperStyle={{ fontSize: 12, color: 'rgb(var(--ink-2))' }}
                  formatter={(v) => (v === 'river' ? 'Released to river' : 'Kept out of river')} />
                <Bar dataKey="river" stackId="v" fill="rgb(var(--info))" radius={[0, 0, 0, 0]} />
                <Bar dataKey="blocked" stackId="v" fill="rgb(var(--crit))" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card>
          <CardHead title="pH distribution" hint="Every tested batch, bucketed" />
          <div className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={phBuckets} margin={{ top: 8, right: 12, bottom: 4, left: -8 }}>
                <CartesianGrid stroke="rgb(var(--line))" vertical={false} />
                <XAxis dataKey="label" tick={{ fill: 'rgb(var(--muted))', fontSize: 10 }} stroke="rgb(var(--line))" interval={1} />
                <YAxis tick={{ fill: 'rgb(var(--muted))', fontSize: 11 }} stroke="rgb(var(--line))" width={40} />
                <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => [`${v} batches`, '']} />
                <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                  {phBuckets.map((b) => (
                    <Cell key={b.label}
                      fill={b.from >= 6.5 && b.to <= 8.5 ? 'rgb(var(--good))' : b.to <= 6.5 ? 'rgb(var(--crit))' : 'rgb(var(--serious))'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="mt-2 text-xs text-muted">Green bars sit inside the pass band. Red is acidic, orange alkaline.</p>
        </Card>

        <Card>
          <CardHead title="TDS distribution" hint="Limit 1,200 mg/L" />
          <div className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={tdsBuckets} margin={{ top: 8, right: 12, bottom: 4, left: -8 }}>
                <CartesianGrid stroke="rgb(var(--line))" vertical={false} />
                <XAxis dataKey="label" tick={{ fill: 'rgb(var(--muted))', fontSize: 10 }} stroke="rgb(var(--line))" interval={1} />
                <YAxis tick={{ fill: 'rgb(var(--muted))', fontSize: 11 }} stroke="rgb(var(--line))" width={40} />
                <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => [`${v} batches`, '']} />
                <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                  {tdsBuckets.map((b) => (
                    <Cell key={b.label} fill={b.to <= 1200 ? 'rgb(var(--info))' : 'rgb(var(--warn))'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHead title="Why batches failed" hint="Where the problem actually is" />
          <div className="space-y-3">
            {reasons.map((r) => {
              const max = Math.max(1, ...reasons.map((x) => x.value));
              return (
                <div key={r.name}>
                  <div className="mb-1 flex justify-between text-xs">
                    <span className="text-ink-2">{r.name}</span>
                    <span className="font-mono tabular text-ink">{r.value}</span>
                  </div>
                  <div className="h-2.5 overflow-hidden rounded-full bg-raised">
                    <div className="h-full rounded-full" style={{ width: `${(r.value / max) * 100}%`, background: r.fill }} />
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

        <Card>
          <CardHead title="Neutraliser consumption" hint={`Assuming a ${RESERVOIR_L} L reservoir`} />
          <dl className="space-y-2 text-sm">
            <Row k="Treatment cycles" v={num(released.length)} />
            <Row k="Neutraliser used" v={`${usage.litres_used} L`} />
            <Row k="Water treated" v={`${num(usage.litres_treated)} L*`} />
            <Row k="Per litre treated" v={usage.litres_per_litre === null ? '—' : `${usage.litres_per_litre} L/L`} />
            <Row k="Estimated chemical cost" v={`R ${num(usage.cost, 2)}`} />
            <Row k="Average treatment time" v={avgTreat === null ? '—' : duration(avgTreat)} />
          </dl>
        </Card>
      </div>

      <p className="text-xs text-muted">* Volumes are estimated unless the device reports a flow meter.</p>
    </div>
  );
}

function Tile({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'good' }) {
  return (
    <div className="bg-surface p-4">
      <p className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-muted">{label}</p>
      <p className={cn('mt-1 text-xl font-semibold tabular', tone === 'good' ? 'text-good' : 'text-ink')}>{value}</p>
      {hint ? <p className="text-xs text-ink-2">{hint}</p> : null}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between border-b border-line pb-2">
      <dt className="text-ink-2">{k}</dt>
      <dd className="font-mono tabular text-ink">{v}</dd>
    </div>
  );
}

function bucket<T extends object>(rows: T[], key: string, min: number, max: number, width: number) {
  const buckets: Array<{ label: string; from: number; to: number; count: number }> = [];
  for (let v = min; v < max; v += width) {
    buckets.push({
      label: width < 1 ? v.toFixed(1) : String(v),
      from: v, to: v + width, count: 0,
    });
  }
  for (const r of rows) {
    const v = Number((r as Record<string, unknown>)[key]);
    if (!Number.isFinite(v)) continue;
    const idx = Math.floor((Math.max(min, Math.min(max - 0.0001, v)) - min) / width);
    if (buckets[idx]) buckets[idx].count += 1;
  }
  return buckets;
}
