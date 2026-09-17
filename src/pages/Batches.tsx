import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, Search } from 'lucide-react';
import { useBatches, useFleet } from '../hooks/data.ts';
import { downloadCsv } from '../lib/csv.ts';
import { num, ph as fmtPh, siteDateTime } from '../lib/format.ts';
import {
  Badge, Button, Card, Empty, Field, Input, Select, Spinner, Table, Td, cn,
} from '../components/ui.tsx';
import type { Batch } from '../lib/types.ts';

const REASON_TONE: Record<string, 'crit' | 'serious' | 'warn' | 'neutral'> = {
  ACID: 'crit',
  ALKALINE: 'serious',
  TDS: 'warn',
};

export default function Batches() {
  const { data: fleet } = useFleet();
  const [deviceId, setDeviceId] = useState('');
  const [result, setResult] = useState('');
  const [query, setQuery] = useState('');
  const { data, isLoading } = useBatches({ deviceId: deviceId || undefined, result: result || undefined, limit: 1000 });

  const rows = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    if (!q) return data;
    return data.filter((b) =>
      String(b.batch_no).includes(q) ||
      (b.fail_reason ?? '').toLowerCase().includes(q) ||
      b.result.toLowerCase().includes(q) ||
      b.destination.toLowerCase().includes(q));
  }, [data, query]);

  const deviceName = (id: string) => fleet?.find((f) => f.device_id === id)?.device_name ?? id;
  const tz = fleet?.find((f) => f.device_id === deviceId)?.timezone;

  const passed = rows.filter((b) => b.result === 'PASS').length;
  const caught = rows.filter((b) => b.result !== 'PASS').length;

  if (isLoading) return <Spinner label="Loading the batch register" />;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-semibold leading-tight text-ink">Batch register</h1>
          <p className="text-sm text-muted">
            Every 100 L batch the plant has tested — {num(rows.length)} shown, {num(caught)} kept out of the river
          </p>
        </div>
        <Button
          onClick={() => downloadCsv(
            `waterguard-batches-${new Date().toISOString().slice(0, 10)}.csv`,
            rows.map((b) => ({
              batch_no: b.batch_no,
              device: deviceName(b.device_id),
              started_at: b.started_at,
              ended_at: b.ended_at,
              avg_ph: b.avg_ph,
              avg_tds_mg_l: b.avg_tds,
              result: b.result,
              destination: b.destination,
              fail_reason: b.fail_reason ?? '',
              volume_l: b.volume_l,
            })),
          )}
        >
          <Download className="h-4 w-4" /> Export CSV
        </Button>
      </header>

      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Device">
            <Select value={deviceId} onChange={(e) => setDeviceId(e.target.value)} className="min-w-[12rem]">
              <option value="">All devices</option>
              {fleet?.map((f) => <option key={f.device_id} value={f.device_id}>{f.device_name}</option>)}
            </Select>
          </Field>
          <Field label="Result">
            <Select value={result} onChange={(e) => setResult(e.target.value)} className="min-w-[9rem]">
              <option value="">All results</option>
              <option value="PASS">Passed</option>
              <option value="FAIL">Failed</option>
              <option value="HELD">Held</option>
            </Select>
          </Field>
          <Field label="Search">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
              <Input value={query} onChange={(e) => setQuery(e.target.value)}
                className="pl-9" placeholder="batch number or reason" />
            </div>
          </Field>
          <div className="ml-auto flex gap-4 pb-1 text-xs">
            <span><span className="font-mono text-base tabular text-good">{num(passed)}</span> <span className="text-muted">passed</span></span>
            <span><span className="font-mono text-base tabular text-crit-ink">{num(caught)}</span> <span className="text-muted">diverted</span></span>
          </div>
        </div>
      </Card>

      <Card className="p-0 sm:p-0">
        {rows.length === 0 ? (
          <Empty title="No batches match" body="Try widening the filter." />
        ) : (
          <div className="p-4 sm:p-5">
            <Table head={['Batch', 'Device', 'Started', 'pH', 'TDS mg/L', 'Result', 'Routed to', '']}>
              {rows.slice(0, 300).map((b) => <Row key={b.id} b={b} deviceName={deviceName(b.device_id)} tz={tz} />)}
            </Table>
            {rows.length > 300 ? (
              <p className="mt-3 text-center text-xs text-muted">
                Showing the 300 most recent of {num(rows.length)}. Export the CSV for the full set.
              </p>
            ) : null}
          </div>
        )}
      </Card>
    </div>
  );
}

function Row({ b, deviceName, tz }: { b: Batch; deviceName: string; tz?: string }) {
  const tone = b.result === 'PASS' ? 'good' : REASON_TONE[b.fail_reason ?? ''] ?? 'crit';
  return (
    <tr className="hover:bg-raised">
      <Td className="font-mono tabular text-ink">{String(b.batch_no).padStart(4, '0')}</Td>
      <Td className="text-xs">{deviceName}</Td>
      <Td className="font-mono text-xs tabular">{siteDateTime(b.started_at, tz)}</Td>
      <Td className={cn('font-mono tabular',
        b.avg_ph !== null && (Number(b.avg_ph) < 6.5 || Number(b.avg_ph) > 8.5) ? 'font-medium text-crit' : '')}>
        {fmtPh(b.avg_ph)}
      </Td>
      <Td className={cn('font-mono tabular', Number(b.avg_tds) > 1200 && 'font-medium text-warn')}>
        {num(b.avg_tds)}
      </Td>
      <Td>
        <Badge tone={tone as 'good'}>
          {b.result === 'PASS' ? 'Pass' : b.fail_reason === 'ACID' ? 'Acid reject'
            : b.fail_reason === 'ALKALINE' ? 'Alkaline reject'
            : b.fail_reason === 'TDS' ? 'TDS reject' : b.result}
        </Badge>
      </Td>
      <Td className="text-xs">{b.destination === 'RIVER' ? 'V1 → river' : b.destination === 'TANK' ? 'V2 → tank' : 'held in chamber'}</Td>
      <Td className="text-right">
        <Link to={`/batches/${b.id}`} className="text-xs font-medium text-accent hover:underline">Open</Link>
      </Td>
    </tr>
  );
}
