/**
 * One batch, traceable end to end: the readings that decided it, where it
 * went, and — if it failed — the treatment cycle that dealt with it.
 *
 * This is the page an environmental officer opens when somebody asks "what
 * happened to the water at 02:14 on Tuesday".
 */

import { Link, useParams } from 'react-router-dom';
import { ChevronLeft, Download } from 'lucide-react';
import {
  CartesianGrid, Line, LineChart, ReferenceArea, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { useBatches, useCycles, useFleet, useTelemetry } from '../hooks/data.ts';
import { downloadCsv } from '../lib/csv.ts';
import { duration, num, ph as fmtPh, siteDateTime, siteTime } from '../lib/format.ts';
import { Badge, Button, Card, CardHead, Spinner, Table, Td } from '../components/ui.tsx';

export default function BatchDetail() {
  const { batchId } = useParams();
  const { data: batches, isLoading } = useBatches({ limit: 2000 });
  const { data: fleet } = useFleet();
  const batch = batches?.find((b) => b.id === batchId);
  const device = fleet?.find((f) => f.device_id === batch?.device_id);
  const { data: cycles } = useCycles({ deviceId: batch?.device_id });
  const { data: telemetry } = useTelemetry(batch?.device_id, 60 * 24);

  if (isLoading) return <Spinner label="Finding that batch" />;
  if (!batch) return <p className="text-muted">That batch is not in the register.</p>;

  const tz = device?.timezone;
  const started = Date.parse(batch.started_at);
  const ended = batch.ended_at ? Date.parse(batch.ended_at) : started + 200_000;

  // Telemetry that was recorded while this batch was in the chamber.
  const during = (telemetry ?? []).filter((t) => {
    const ts = Date.parse(t.ts);
    return ts >= started - 20_000 && ts <= ended + 60_000;
  });

  // The treatment cycle that started right after a failed batch was diverted.
  const cycle = batch.result === 'PASS' ? null
    : (cycles ?? []).find((c) => {
        const s = Date.parse(c.started_at);
        return s >= started && s <= ended + 10 * 60_000;
      }) ?? null;

  const chart = during.map((t) => ({
    label: siteTime(t.ts, tz, 'HH:mm:ss'),
    ph: Number(t.ph),
    tds: Number(t.tds),
  }));

  const tone = batch.result === 'PASS' ? 'good'
    : batch.fail_reason === 'ALKALINE' ? 'serious'
    : batch.fail_reason === 'TDS' ? 'warn' : 'crit';

  return (
    <div className="space-y-4">
      <div>
        <Link to="/batches" className="mb-1 inline-flex items-center gap-1 text-xs text-muted hover:text-ink">
          <ChevronLeft className="h-3.5 w-3.5" /> Back to the register
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-[22px] font-semibold leading-tight text-ink">
              Batch {String(batch.batch_no).padStart(4, '0')}
            </h1>
            <p className="text-sm text-muted">
              {device?.device_name} · {device?.site_name} · {siteDateTime(batch.started_at, tz)}
            </p>
          </div>
          <Badge tone={tone as 'good'}>
            {batch.result === 'PASS' ? 'Passed — released to the river'
              : batch.fail_reason === 'ACID' ? 'Acid reject — diverted'
              : batch.fail_reason === 'ALKALINE' ? 'Alkaline reject — diverted'
              : batch.fail_reason === 'TDS' ? 'TDS reject — diverted'
              : `${batch.result} — ${batch.destination}`}
          </Badge>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line lg:grid-cols-4">
        <Fact label="Average pH" value={fmtPh(batch.avg_ph)} hint="over the 3 s test window" />
        <Fact label="Average TDS" value={`${num(batch.avg_tds)} mg/L`} />
        <Fact label="Volume" value={`${num(batch.volume_l)} L${device?.flow_sensor ? '' : '*'}`}
          hint={device?.flow_sensor ? 'measured' : 'estimated — no flow meter'} />
        <Fact label="Time in the chamber" value={duration((ended - started) / 1000)} />
      </div>

      <Card>
        <CardHead
          title="Readings during this batch"
          hint={`Shaded area is the pass band; the decision was taken on the average, not on any single sample`}
          right={
            <Button size="sm" onClick={() => downloadCsv(
              `batch-${batch.batch_no}-telemetry.csv`,
              during.map((t) => ({ ts: t.ts, state: t.state, ph: t.ph, tds: t.tds, v1: t.v1, v2: t.v2, v3: t.v3 })),
            )}>
              <Download className="h-4 w-4" /> CSV
            </Button>
          }
        />
        {chart.length ? (
          <div className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chart} margin={{ top: 8, right: 12, bottom: 4, left: -18 }}>
                <CartesianGrid stroke="rgb(var(--line))" vertical={false} />
                <ReferenceArea y1={6.5} y2={8.5} fill="rgb(var(--good))" fillOpacity={0.1} />
                <XAxis dataKey="label" tick={{ fill: 'rgb(var(--muted))', fontSize: 11 }} minTickGap={40} stroke="rgb(var(--line))" />
                <YAxis domain={[3, 11]} tick={{ fill: 'rgb(var(--muted))', fontSize: 11 }} stroke="rgb(var(--line))" width={44} />
                <Tooltip contentStyle={{
                  background: 'rgb(var(--surface))', border: '1px solid rgb(var(--line))',
                  borderRadius: 8, fontSize: 12, color: 'rgb(var(--ink))',
                }} />
                <Line type="monotone" dataKey="ph" name="pH" stroke="rgb(var(--info))" strokeWidth={2} dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <p className="py-8 text-center text-sm text-muted">
            The raw telemetry for this batch has been downsampled or is older than the retention window.
            The decision and its readings are kept permanently in the register above.
          </p>
        )}
      </Card>

      <Card>
        <CardHead title="What happened to this water" />
        <ol className="space-y-3">
          <Step n={1} title="Filled" body={`The sump pump filled the check chamber to ${num(batch.volume_l)} L.`} />
          <Step n={2} title="Tested"
            body={`Probes averaged over 3 seconds: pH ${fmtPh(batch.avg_ph)}, TDS ${num(batch.avg_tds)} mg/L.`} />
          <Step
            n={3}
            title={batch.result === 'PASS' ? 'Passed the test' : 'Failed the test'}
            body={batch.result === 'PASS'
              ? 'Inside the pass band on both pH and TDS, so V1 opened and the batch went to the river.'
              : batch.fail_reason === 'ACID' ? 'pH was below the floor, so V1 stayed shut and V2 sent it to the treatment tank.'
              : batch.fail_reason === 'ALKALINE' ? 'pH was above the ceiling. Alkaline water is a pollution event in the same way acid water is, so V1 stayed shut and V2 sent it to the treatment tank.'
              : batch.fail_reason === 'TDS' ? 'TDS was over the limit, so V1 stayed shut and V2 sent it to the treatment tank.'
              : 'The tank was full, so the batch was held in the chamber rather than released.'}
            tone={batch.result === 'PASS' ? 'good' : 'crit'}
          />
          {cycle ? (
            <Step n={4} title="Treated and released"
              body={`Dosed from pH ${fmtPh(cycle.start_ph)} to pH ${fmtPh(cycle.end_ph)} using ${cycle.neutraliser_used_pct ?? 0}% of the reservoir, then V3 released ${num(cycle.volume_released_l)} L at ${siteDateTime(cycle.released_at, tz)}.`}
              tone="good" />
          ) : batch.result !== 'PASS' ? (
            <Step n={4} title="Still in the tank"
              body="This batch has not yet been released. It is held until the tank is inside the release band for three continuous seconds." />
          ) : null}
        </ol>
      </Card>

      {cycle ? (
        <Card>
          <CardHead title="Linked treatment cycle" hint={`Cycle ${cycle.cycle_no}`} />
          <Table head={['Started', 'Released', 'Start pH', 'End pH', 'End TDS', 'Neutraliser used', 'Volume']}>
            <tr>
              <Td className="font-mono text-xs">{siteDateTime(cycle.started_at, tz)}</Td>
              <Td className="font-mono text-xs">{siteDateTime(cycle.released_at, tz)}</Td>
              <Td className="font-mono tabular">{fmtPh(cycle.start_ph)}</Td>
              <Td className="font-mono tabular">{fmtPh(cycle.end_ph)}</Td>
              <Td className="font-mono tabular">
                {num(cycle.end_tds)} mg/L
                {Number(cycle.end_tds) > 1200 ? <Badge tone="warn" className="ml-2">over the limit</Badge> : null}
              </Td>
              <Td className="font-mono tabular">{cycle.neutraliser_used_pct ?? 0}%</Td>
              <Td className="font-mono tabular">{num(cycle.volume_released_l)} L</Td>
            </tr>
          </Table>
          {Number(cycle.end_tds) > 1200 ? (
            <p className="mt-3 rounded-lg border border-warn/40 bg-warn/5 p-3 text-xs text-ink-2">
              This water left the tank above the TDS limit. The treatment tank neutralises pH; it does not remove
              dissolved salts. This is a known limitation of the current plant and is reported rather than hidden.
            </p>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}

function Fact({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="bg-surface p-4">
      <p className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-muted">{label}</p>
      <p className="mt-1 font-mono text-xl tabular text-ink">{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

function Step({ n, title, body, tone }: { n: number; title: string; body: string; tone?: 'good' | 'crit' }) {
  return (
    <li className="flex gap-3">
      <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border font-mono text-xs ${
        tone === 'good' ? 'border-good text-good' : tone === 'crit' ? 'border-crit text-crit' : 'border-line text-muted'
      }`}>
        {n}
      </span>
      <div>
        <p className="text-sm font-medium text-ink">{title}</p>
        <p className="text-sm text-ink-2">{body}</p>
      </div>
    </li>
  );
}
