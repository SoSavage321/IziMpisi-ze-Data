import { Link } from 'react-router-dom';
import { ArrowRight, MapPin, Wifi, WifiOff } from 'lucide-react';
import { useFleet } from '../hooks/data.ts';
import { ago, litres, num, pct, ph as fmtPh } from '../lib/format.ts';
import { Badge, Card, ErrorNote, Spinner, cn, stateTone } from '../components/ui.tsx';
import { Meter } from '../components/plant.tsx';
import type { FleetRow } from '../lib/types.ts';

export default function Fleet() {
  const { data, isLoading, error } = useFleet();

  if (isLoading) return <Spinner label="Loading the fleet" />;
  if (error) return <ErrorNote error={error} />;
  if (!data?.length) return <p className="text-muted">No devices registered yet.</p>;

  const sites = [...new Set(data.map((d) => d.site_id))];
  const totals = data.reduce(
    (acc, d) => ({
      river: acc.river + Number(d.litres_to_river_today ?? 0),
      blocked: acc.blocked + Number(d.litres_blocked_today ?? 0),
      batches: acc.batches + Number(d.batches_today ?? 0),
      passed: acc.passed + Number(d.passed_today ?? 0),
    }),
    { river: 0, blocked: 0, batches: 0, passed: 0 },
  );

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-display text-lg font-semibold text-ink">Fleet overview</h1>
        <p className="text-sm text-muted">
          {data.length} controller{data.length === 1 ? '' : 's'} across {sites.length} site{sites.length === 1 ? '' : 's'} · today so far
        </p>
      </div>

      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line lg:grid-cols-4">
        <Stat label="Batches tested" value={num(totals.batches)} />
        <Stat label="Passed first time" value={totals.batches ? pct((totals.passed / totals.batches) * 100) : '—'}
          hint={`${totals.passed} of ${totals.batches}`} />
        <Stat label="Released to river" value={litres(totals.river)} />
        <Stat label="Blocked from river" value={litres(totals.blocked)} tone={totals.blocked > 0 ? 'good' : undefined}
          hint="water the plant kept out" />
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {data.map((d) => <DeviceCard key={d.device_id} d={d} />)}
      </div>

      <SiteMap rows={data} />

      <p className="text-xs text-muted">
        * Volumes are estimated from batch counts unless the device reports a flow meter.
      </p>
    </div>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'good' }) {
  return (
    <div className="bg-surface p-4">
      <p className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-muted">{label}</p>
      <p className={cn('mt-1 text-2xl font-semibold tabular', tone === 'good' ? 'text-good' : 'text-ink')}>{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-ink-2">{hint}</p> : null}
    </div>
  );
}

function DeviceCard({ d }: { d: FleetRow }) {
  const state = stateTone(d.state, d.offline);
  const passRate = d.batches_today ? Math.round((d.passed_today / d.batches_today) * 100) : null;

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link to={`/device/${d.device_id}`} className="font-medium text-ink hover:text-accent">
            {d.device_name}
          </Link>
          <p className="truncate text-xs text-muted">{d.site_name}</p>
        </div>
        <Badge tone={state.tone}>{state.label}</Badge>
      </div>

      <div className="flex items-center gap-3 text-xs text-muted">
        {d.offline
          ? <span className="inline-flex items-center gap-1.5 text-crit"><WifiOff className="h-3.5 w-3.5" /> last seen {ago(d.last_seen)}</span>
          : <span className="inline-flex items-center gap-1.5"><Wifi className="h-3.5 w-3.5" /> {ago(d.last_seen)}</span>}
        {d.estop ? <Badge tone="crit">E-stop</Badge> : null}
        {d.mode && d.mode !== 'AUTO' ? <Badge tone="warn">{d.mode}</Badge> : null}
      </div>

      <div className="grid grid-cols-2 gap-3 border-t border-line pt-3">
        <div>
          <p className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-muted">Chamber pH</p>
          <p className="font-mono text-lg tabular text-ink">{fmtPh(d.ph)}</p>
        </div>
        <div>
          <p className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-muted">TDS</p>
          <p className="font-mono text-lg tabular text-ink">{d.tds === null ? '—' : `${num(d.tds)}`}<span className="ml-1 text-xs text-muted">mg/L</span></p>
        </div>
      </div>

      <Meter label="Neutraliser" value={d.neutraliser_pct} max={100} unit="%" invert />

      <div className="grid grid-cols-2 gap-3 border-t border-line pt-3 text-xs">
        <div>
          <p className="text-muted">To river today</p>
          <p className="font-medium text-ink">{litres(d.litres_to_river_today, !d.flow_sensor)}</p>
        </div>
        <div>
          <p className="text-muted">Blocked today</p>
          <p className="font-medium text-ink">{litres(d.litres_blocked_today, !d.flow_sensor)}</p>
        </div>
      </div>

      <div className="mt-auto flex items-center justify-between gap-2 border-t border-line pt-3">
        {d.active_alarms > 0 ? (
          <Badge tone={d.critical_alarms > 0 ? 'crit' : 'warn'}>
            {d.active_alarms} active alarm{d.active_alarms === 1 ? '' : 's'}
          </Badge>
        ) : (
          <Badge tone="good">No alarms</Badge>
        )}
        <Link to={`/device/${d.device_id}`} className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline">
          Live view <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>

      {passRate !== null ? (
        <p className="text-xs text-muted">{passRate}% of today&apos;s {d.batches_today} batches passed first time</p>
      ) : null}
    </Card>
  );
}

/**
 * A positional map of the sites.
 *
 * Deliberately not a tile map: a control room on a mine often has poor
 * connectivity, and a map that fails to load is worse than a diagram that
 * always works. Positions are real latitude and longitude, projected into the
 * box.
 */
function SiteMap({ rows }: { rows: FleetRow[] }) {
  const pts = rows.filter((r) => r.latitude !== null && r.longitude !== null);
  if (!pts.length) return null;

  const lats = pts.map((p) => p.latitude as number);
  const lngs = pts.map((p) => p.longitude as number);
  const pad = 0.06;
  const minLat = Math.min(...lats) - pad, maxLat = Math.max(...lats) + pad;
  const minLng = Math.min(...lngs) - pad, maxLng = Math.max(...lngs) + pad;

  const x = (lng: number) => 40 + ((lng - minLng) / Math.max(0.0001, maxLng - minLng)) * 720;
  const y = (lat: number) => 40 + ((maxLat - lat) / Math.max(0.0001, maxLat - minLat)) * 240;

  const seen = new Set<string>();

  return (
    <Card>
      <h2 className="mb-1 font-display text-[12px] font-semibold uppercase tracking-[0.13em] text-ink">Sites</h2>
      <p className="mb-3 text-xs text-muted">Positions from each site&apos;s recorded coordinates</p>
      <svg viewBox="0 0 800 320" className="block h-auto w-full" role="img" aria-label="Map of monitored sites">
        <rect x="0" y="0" width="800" height="320" rx="10" className="fill-raised" />
        {[0, 1, 2, 3, 4].map((n) => (
          <line key={`h${n}`} x1="20" y1={40 + n * 60} x2="780" y2={40 + n * 60} className="stroke-line" strokeWidth="1" />
        ))}
        {[0, 1, 2, 3, 4, 5, 6].map((n) => (
          <line key={`v${n}`} x1={40 + n * 120} y1="20" x2={40 + n * 120} y2="300" className="stroke-line" strokeWidth="1" />
        ))}

        {pts.map((p) => {
          if (seen.has(p.site_id)) return null;
          seen.add(p.site_id);
          const atSite = rows.filter((r) => r.site_id === p.site_id);
          const crit = atSite.some((r) => r.critical_alarms > 0 || r.offline);
          const warn = atSite.some((r) => r.active_alarms > 0);
          const cls = crit ? 'fill-crit' : warn ? 'fill-warn' : 'fill-good';
          const cx = x(p.longitude as number), cy = y(p.latitude as number);
          return (
            <g key={p.site_id}>
              <circle cx={cx} cy={cy} r="14" className={cn(cls, 'opacity-20')} />
              <circle cx={cx} cy={cy} r="6" className={cls} />
              <text x={cx} y={cy - 20} textAnchor="middle" className="fill-ink font-display text-[11px] font-semibold">
                {p.site_name}
              </text>
              <text x={cx} y={cy + 26} textAnchor="middle" className="fill-muted font-mono text-[10px]">
                {atSite.length} device{atSite.length === 1 ? '' : 's'}{crit ? ' · attention' : ''}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="mt-3 flex flex-wrap gap-4 text-xs text-ink-2">
        {rows.map((r) => (
          <span key={r.device_id} className="inline-flex items-center gap-1.5">
            <MapPin className="h-3.5 w-3.5 text-muted" />
            {r.site_name} — {r.location ?? 'no location recorded'}
          </span>
        )).slice(0, 2)}
      </div>
    </Card>
  );
}
