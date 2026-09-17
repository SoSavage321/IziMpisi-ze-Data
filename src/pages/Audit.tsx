import { useMemo, useState } from 'react';
import { Download } from 'lucide-react';
import { useAudit, useProfiles } from '../hooks/data.ts';
import { downloadCsv } from '../lib/csv.ts';
import { siteDateTime } from '../lib/format.ts';
import { Badge, Button, Card, Empty, Field, Input, Select, Spinner, Table, Td } from '../components/ui.tsx';

const TABLES = [
  { value: '', label: 'Everything' },
  { value: 'device_config', label: 'Discharge limits' },
  { value: 'commands', label: 'Commands' },
  { value: 'alarms', label: 'Alarm acknowledgements' },
  { value: 'devices', label: 'Devices' },
  { value: 'profiles', label: 'People' },
  { value: 'sites', label: 'Sites' },
];

const ACTION_TONE: Record<string, 'good' | 'warn' | 'info' | 'neutral'> = {
  INSERT: 'good',
  UPDATE: 'warn',
  DELETE: 'warn',
  ACK: 'info',
  REGISTER_DEVICE: 'info',
  ROTATE_KEY: 'warn',
};

export default function Audit() {
  const [table, setTable] = useState('');
  const [actor, setActor] = useState('');
  const [query, setQuery] = useState('');
  const { data, isLoading } = useAudit({ table: table || undefined, actor: actor || undefined, limit: 500 });
  const { data: profiles } = useProfiles();

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return data ?? [];
    return (data ?? []).filter((r) =>
      r.action.toLowerCase().includes(q) ||
      r.target_table.toLowerCase().includes(q) ||
      JSON.stringify(r.after ?? {}).toLowerCase().includes(q));
  }, [data, query]);

  if (isLoading) return <Spinner label="Loading the audit trail" />;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-semibold leading-tight text-ink">Audit log</h1>
          <p className="text-sm text-muted">
            Who changed what, and when. Written by database triggers, so it records the change itself rather than
            an application&apos;s account of it.
          </p>
        </div>
        <Button onClick={() => downloadCsv(
          `waterguard-audit-${new Date().toISOString().slice(0, 10)}.csv`,
          rows.map((r) => ({
            ts: r.ts, actor: r.actor_name ?? r.actor ?? '', action: r.action,
            target_table: r.target_table, target_id: r.target_id ?? '',
            before: JSON.stringify(r.before ?? {}), after: JSON.stringify(r.after ?? {}),
          })),
        )}>
          <Download className="h-4 w-4" /> Export CSV
        </Button>
      </header>

      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Area">
            <Select value={table} onChange={(e) => setTable(e.target.value)} className="min-w-[14rem]">
              {TABLES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </Select>
          </Field>
          <Field label="Person">
            <Select value={actor} onChange={(e) => setActor(e.target.value)} className="min-w-[12rem]">
              <option value="">Anyone</option>
              {profiles?.map((p) => <option key={p.user_id} value={p.user_id}>{p.full_name}</option>)}
            </Select>
          </Field>
          <Field label="Search">
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="ph_min, EMERGENCY_STOP…" />
          </Field>
        </div>
      </Card>

      <Card>
        {rows.length === 0 ? (
          <Empty title="Nothing matches" body="Try a wider filter." />
        ) : (
          <Table head={['When', 'Who', 'Action', 'Area', 'Change']}>
            {rows.map((r) => (
              <tr key={String(r.id)} className="hover:bg-raised">
                <Td className="whitespace-nowrap font-mono text-xs">{siteDateTime(r.ts)}</Td>
                <Td className="text-xs text-ink">{r.actor_name ?? r.actor ?? 'system'}</Td>
                <Td><Badge tone={ACTION_TONE[r.action] ?? 'neutral'}>{r.action}</Badge></Td>
                <Td className="font-mono text-xs">{r.target_table}</Td>
                <Td className="max-w-md">
                  <Diff before={r.before} after={r.after} />
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

/** Show only the fields that actually moved. */
function Diff({ before, after }: { before: Record<string, unknown> | null; after: Record<string, unknown> | null }) {
  if (!after) return <span className="text-xs text-muted">deleted</span>;
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after)])]
    .filter((k) => !['id', 'created_at', 'updated_at'].includes(k))
    .filter((k) => JSON.stringify(before?.[k]) !== JSON.stringify(after[k]));

  if (!keys.length) return <span className="text-xs text-muted">no field changes</span>;

  return (
    <ul className="space-y-0.5 font-mono text-[11px]">
      {keys.slice(0, 6).map((k) => (
        <li key={k}>
          <span className="text-muted">{k}: </span>
          {before && k in before ? (
            <>
              <span className="text-muted line-through">{fmt(before[k])}</span>
              <span className="text-muted"> → </span>
            </>
          ) : null}
          <span className="text-ink">{fmt(after[k])}</span>
        </li>
      ))}
      {keys.length > 6 ? <li className="text-muted">+{keys.length - 6} more</li> : null}
    </ul>
  );
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return '—';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}
