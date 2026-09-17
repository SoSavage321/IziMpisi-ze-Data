import { useMemo, useState } from 'react';
import { FileDown, FileText, ShieldCheck, ShieldAlert } from 'lucide-react';
import { buildComplianceReport } from '@shared/reports.ts';
import { useAlarms, useBatches, useConfigs, useCycles, useFleet, useMaintenance } from '../hooks/data.ts';
import { useAuth } from '../hooks/auth.tsx';
import { compliancePdf } from '../lib/pdf.ts';
import { downloadCsv } from '../lib/csv.ts';
import { num, siteDate, zoneLabel } from '../lib/format.ts';
import { Badge, Button, Card, CardHead, Field, Input, Select, Spinner } from '../components/ui.tsx';

export default function Reports() {
  const { data: fleet } = useFleet();
  const { session } = useAuth();
  const [deviceId, setDeviceId] = useState('');
  const [from, setFrom] = useState(() => new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10));
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));

  const device = fleet?.find((f) => f.device_id === deviceId) ?? fleet?.[0];
  const activeId = device?.device_id;

  const fromIso = new Date(`${from}T00:00:00`).toISOString();
  const toIso = new Date(`${to}T23:59:59`).toISOString();

  const { data: batches, isLoading } = useBatches({ deviceId: activeId, from: fromIso, to: toIso, limit: 5000 });
  const { data: cycles } = useCycles({ deviceId: activeId, from: fromIso, to: toIso });
  const { data: alarms } = useAlarms({ deviceId: activeId, from: fromIso });
  const { data: configs } = useConfigs(activeId);
  const { data: maintenance } = useMaintenance(activeId);

  const report = useMemo(() => {
    if (!device) return null;
    const config = configs?.[0];
    return buildComplianceReport({
      site: device.site_name,
      device: device.device_name,
      from: fromIso,
      to: toIso,
      batches: (batches ?? []).map((b) => ({
        batch_no: b.batch_no, started_at: b.started_at,
        avg_ph: b.avg_ph === null ? null : Number(b.avg_ph),
        avg_tds: b.avg_tds === null ? null : Number(b.avg_tds),
        result: b.result, destination: b.destination,
        volume_l: Number(b.volume_l), fail_reason: b.fail_reason,
      })),
      cycles: (cycles ?? []).map((c) => ({
        cycle_no: c.cycle_no, started_at: c.started_at, released_at: c.released_at,
        start_ph: c.start_ph === null ? null : Number(c.start_ph),
        end_ph: c.end_ph === null ? null : Number(c.end_ph),
        end_tds: c.end_tds === null ? null : Number(c.end_tds),
        neutraliser_used_pct: c.neutraliser_used_pct === null ? null : Number(c.neutraliser_used_pct),
        volume_released_l: c.volume_released_l === null ? null : Number(c.volume_released_l),
      })),
      alarms: (alarms ?? []).filter((a) => a.severity !== 'info').map((a) => ({
        type: a.type, severity: a.severity, message: a.message, raised_at: a.raised_at,
        acknowledged_at: a.acknowledged_at, ack_note: a.ack_note,
        cleared_at: a.cleared_at, escalated: a.escalated,
      })),
      configChanges: (configs ?? [])
        .filter((c) => c.created_at >= fromIso && c.created_at <= toIso)
        .map((c) => ({
          version: c.version, created_at: c.created_at, reason: c.reason,
          changed_by: c.created_by_name ?? c.created_by,
          ph_min: Number(c.ph_min), ph_max: Number(c.ph_max), tds_max: Number(c.tds_max),
        })),
      calibration: (maintenance ?? []).filter((m) => m.task === 'calibrate').map((m) => ({
        component: m.component,
        last_done_at: m.last_done_at,
        next_due_at: m.next_due_at,
        overdue: Boolean(m.next_due_at && Date.parse(m.next_due_at) < Date.now()),
      })),
      config: {
        phMin: Number(config?.ph_min ?? 6.5),
        phMax: Number(config?.ph_max ?? 8.5),
        tdsMax: Number(config?.tds_max ?? 1200),
      },
      flowSensor: device.flow_sensor,
    });
  }, [device, batches, cycles, alarms, configs, maintenance, fromIso, toIso]);

  if (isLoading || !report || !device) return <Spinner label="Assembling the report" />;

  const c = report.compliance;

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-[22px] font-semibold leading-tight text-ink">Compliance report</h1>
        <p className="text-sm text-muted">
          Built from the controller&apos;s own batch records — every figure traces back to a row in the register
        </p>
      </header>

      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Site and device">
            <Select value={activeId} onChange={(e) => setDeviceId(e.target.value)} className="min-w-[16rem]">
              {fleet?.map((f) => (
                <option key={f.device_id} value={f.device_id}>{f.site_name} — {f.device_name}</option>
              ))}
            </Select>
          </Field>
          <Field label="From">
            <Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To">
            <Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <div className="ml-auto flex gap-2">
            <Button
              onClick={() => downloadCsv(
                `waterguard-compliance-${from}-to-${to}.csv`,
                (batches ?? []).map((b) => ({
                  batch_no: b.batch_no, started_at: b.started_at, avg_ph: b.avg_ph,
                  avg_tds_mg_l: b.avg_tds, result: b.result, destination: b.destination,
                  fail_reason: b.fail_reason ?? '', volume_l: b.volume_l,
                })),
              )}
            >
              <FileDown className="h-4 w-4" /> CSV
            </Button>
            <Button
              variant="primary"
              onClick={() => compliancePdf(report, {
                timezone: zoneLabel(device.timezone),
                generatedBy: session?.profile.full_name ?? 'WaterGuard',
              })}
            >
              <FileText className="h-4 w-4" /> Generate PDF
            </Button>
          </div>
        </div>
      </Card>

      <Card className={c.compliant ? 'border-good/50 bg-good/5' : 'border-crit/50 bg-crit/5'}>
        <div className="flex items-start gap-3">
          {c.compliant
            ? <ShieldCheck className="mt-0.5 h-6 w-6 shrink-0 text-good" aria-hidden />
            : <ShieldAlert className="mt-0.5 h-6 w-6 shrink-0 text-crit-ink" aria-hidden />}
          <div>
            <p className={`text-[13px] font-semibold uppercase tracking-[0.06em] ${c.compliant ? 'text-good-ink' : 'text-crit-ink'}`}>
              {c.compliant ? 'Compliant' : 'Exceptions found'}
            </p>
            <p className="mt-1 text-sm text-ink">{c.statement}</p>
          </div>
        </div>

        {c.exceptions.length ? (
          <ul className="mt-4 space-y-1.5 border-t border-crit/30 pt-3">
            {c.exceptions.map((e) => (
              <li key={e.batch_no} className="text-sm text-ink-2">
                <span className="font-mono text-ink">Batch {e.batch_no}</span> — {e.reason}
              </li>
            ))}
          </ul>
        ) : null}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHead title="Volumes" hint={report.volumes.measured ? 'Measured by flow meter' : 'Estimated — no flow meter fitted'} />
          <dl className="space-y-2 text-sm">
            <Row k="Passed the test, discharged through V1" v={`${num(report.volumes.direct_to_river_l)} L`} />
            <Row k="Treated, released through V3" v={`${num(report.volumes.treated_released_l)} L`} />
            <Row k="Total reaching the river" v={`${num(report.volumes.total_to_river_l)} L`} strong />
            <Row k="Failed and kept out of the river" v={`${num(report.volumes.blocked_l)} L`} strong tone="good" />
            <Row k="Held in the chamber" v={`${num(report.volumes.held_l)} L`} />
          </dl>
        </Card>

        <Card>
          <CardHead title="Quality of everything discharged" />
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted">
                  <th className="py-2 text-left">Measure</th><th className="py-2 text-right">Min</th>
                  <th className="py-2 text-right">Avg</th><th className="py-2 text-right">Max</th>
                </tr>
              </thead>
              <tbody className="font-mono tabular">
                <QRow label="pH via V1" s={report.quality.ph} />
                <QRow label="TDS via V1" s={report.quality.tds} />
                <QRow label="pH via V3" s={report.quality.treated_release_ph} />
                <QRow label="TDS via V3" s={report.quality.treated_release_tds} />
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHead title="Testing" />
          <dl className="space-y-2 text-sm">
            <Row k="Batches tested" v={num(report.batches_tested)} />
            <Row k="Failures caught" v={num(report.batches_failed_caught)} tone="good" />
            <Row k="Treated releases" v={num(report.treated_releases)} />
          </dl>
        </Card>
        <Card>
          <CardHead title="Incidents" />
          <dl className="space-y-2 text-sm">
            <Row k="Alarms raised" v={num(report.incidents.total)} />
            <Row k="Critical" v={num(report.incidents.critical)} />
            <Row k="Unacknowledged" v={num(report.incidents.unacknowledged)}
              tone={report.incidents.unacknowledged > 0 ? 'crit' : undefined} />
            <Row k="Median ack time" v={report.incidents.median_ack_minutes === null ? '—' : `${report.incidents.median_ack_minutes} min`} />
          </dl>
        </Card>
        <Card>
          <CardHead title="Calibration" />
          <ul className="space-y-2 text-sm">
            {report.calibration.map((c2) => (
              <li key={c2.component} className="flex items-center justify-between gap-2 border-b border-line pb-2">
                <span className="text-ink-2">{c2.component}</span>
                {c2.overdue
                  ? <Badge tone="warn">overdue</Badge>
                  : <span className="font-mono text-xs text-muted">due {c2.next_due_at ? siteDate(c2.next_due_at) : '—'}</span>}
              </li>
            ))}
            {!report.calibration.length ? <li className="text-muted">No calibration schedule recorded.</li> : null}
          </ul>
        </Card>
      </div>

      {report.compliance.tds_exceedances.length ? (
        <Card className="border-warn/40 bg-warn/5">
          <CardHead title="Treated releases above the TDS limit" hint="Disclosed, not omitted" />
          <p className="mb-3 text-sm text-ink-2">
            The treatment tank neutralises pH. It does not remove dissolved salts, so a batch that failed on TDS
            can be returned to the river still carrying them. {report.compliance.tds_exceedances.length} release(s)
            in this period left above {num(1200)} mg/L.
          </p>
          <ul className="space-y-1 font-mono text-sm">
            {report.compliance.tds_exceedances.map((e) => (
              <li key={e.cycle_no} className="text-ink-2">Cycle {e.cycle_no}: {num(e.end_tds)} mg/L</li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

function Row({ k, v, strong, tone }: { k: string; v: string; strong?: boolean; tone?: 'good' | 'crit' }) {
  return (
    <div className="flex justify-between gap-4 border-b border-line pb-2">
      <dt className="text-ink-2">{k}</dt>
      <dd className={`font-mono tabular ${strong ? 'font-medium' : ''} ${
        tone === 'good' ? 'text-good-ink' : tone === 'crit' ? 'text-crit' : 'text-ink'}`}>
        {v}
      </dd>
    </div>
  );
}

function QRow({ label, s }: { label: string; s: { min: number | null; avg: number | null; max: number | null; n: number } }) {
  return (
    <tr className="border-b border-line">
      <td className="py-2 font-sans text-ink-2">{label} <span className="text-xs text-muted">(n={s.n})</span></td>
      <td className="py-2 text-right text-ink">{s.min ?? '—'}</td>
      <td className="py-2 text-right text-ink">{s.avg ?? '—'}</td>
      <td className="py-2 text-right text-ink">{s.max ?? '—'}</td>
    </tr>
  );
}
