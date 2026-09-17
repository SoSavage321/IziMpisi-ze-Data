import { Suspense, lazy, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  CartesianGrid, Line, LineChart, ReferenceArea, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { Box, Lock, Share2, SlidersHorizontal, Wifi, WifiOff } from 'lucide-react';
import {
  useBatches, useConfigs, useDevice, useEvents, useTelemetry, useV3Lock,
} from '../hooks/data.ts';
import { ago, litres, num, pct, ph as fmtPh, siteTime, zoneLabel } from '../lib/format.ts';
import { Badge, Button, Card, CardHead, ErrorNote, Spinner, cn, stateTone } from '../components/ui.tsx';
import { Meter, PhBand, ProcessDiagram, StatusLights } from '../components/plant.tsx';
/**
 * three.js is about 600 kB. An operator who prefers the schematic, or who is
 * on a phone on site, should never download it. It arrives only when the 3D
 * view is actually asked for.
 */
const Plant3D = lazy(() =>
  import('../components/plant3d.tsx').then((m) => ({ default: m.Plant3D })));

/** Remembered per viewer; a convenience, never state anything depends on. */
function useViewMode() {
  const [mode, setMode] = useState<'3d' | 'schematic'>(() => {
    try { return (localStorage.getItem('waterguard.plantview') as '3d' | 'schematic') ?? '3d'; }
    catch { return '3d'; }
  });
  const set = (next: '3d' | 'schematic') => {
    setMode(next);
    try { localStorage.setItem('waterguard.plantview', next); } catch { /* private window */ }
  };
  return [mode, set] as const;
}

export default function SiteLive() {
  const { deviceId } = useParams();
  const [viewMode, setViewMode] = useViewMode();
  const { data: device, isLoading, error } = useDevice(deviceId);
  const { data: telemetry } = useTelemetry(deviceId, 20);
  const { data: batches } = useBatches({ deviceId, limit: 60 });
  const { data: events } = useEvents(deviceId, 40);
  const { data: configs } = useConfigs(deviceId);
  const { data: v3Lock } = useV3Lock(deviceId);

  if (isLoading) return <Spinner label="Connecting to the device" />;
  if (error) return <ErrorNote error={error} />;
  if (!device) return <p className="text-muted">That device does not exist, or you cannot see it.</p>;

  const config = configs?.[0];
  const limits = {
    phMin: Number(config?.ph_min ?? 6.5),
    phMax: Number(config?.ph_max ?? 8.5),
    tdsMax: Number(config?.tds_max ?? 1200),
  };
  const tz = device.timezone;
  const latest = telemetry?.[telemetry.length - 1];
  const state = stateTone(device.state, device.offline);

  // today's numbers
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todays = (batches ?? []).filter((b) => new Date(b.started_at) >= today);
  const passed = todays.filter((b) => b.result === 'PASS').length;
  const toRiver = todays.filter((b) => b.destination === 'RIVER').reduce((s, b) => s + Number(b.volume_l), 0);
  const blocked = todays.filter((b) => b.destination !== 'RIVER').reduce((s, b) => s + Number(b.volume_l), 0);

  const chart = (telemetry ?? []).map((t) => ({
    ts: Date.parse(t.ts),
    label: siteTime(t.ts, tz, 'HH:mm:ss'),
    ph: Number(t.ph),
    tankPh: Number(t.tank_ph),
    tds: Number(t.tds),
  }));

  // countdowns driven by the device's own state, not a local timer
  const testWindow = Number(config?.test_window_s ?? 3);
  const stableWindow = Number(config?.stable_window_s ?? 3);
  const inState = secondsInState(telemetry ?? [], device.state);

  /**
   * One description of the plant, rendered two ways. When the physical
   * prototype starts posting to /ingest, this object carries its real
   * telemetry and both views follow the real tanks unchanged.
   */
  const plantView = {
    state: device.state ?? 'UNKNOWN',
    chamberL: Number(latest?.chamber_l ?? 0),
    batchL: Number(config?.batch_l ?? 100),
    tankL: Number(latest?.tank_l ?? device.tank_l ?? 0),
    tankCapL: Number(latest?.tank_cap_l ?? device.tank_cap_l ?? 300),
    tankPh: latest ? Number(latest.tank_ph) : null,
    ph: device.ph === null ? null : Number(device.ph),
    tds: device.tds === null ? null : Number(device.tds),
    v1: Boolean(device.v1), v2: Boolean(device.v2), v3: Boolean(device.v3),
    sumpPump: Boolean(latest?.sump_pump),
    dosingPump: Boolean(latest?.dosing_pump),
    neutraliserPct: device.neutraliser_pct === null ? null : Number(device.neutraliser_pct),
    offline: device.offline,
    v3LockReason: v3Lock ?? null,
  };

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[22px] font-semibold leading-tight text-ink">{device.device_name}</h1>
          <p className="text-sm text-muted">
            {device.site_name} · {device.location ?? 'no location recorded'} · times in {zoneLabel(tz)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={state.tone}>{state.label}</Badge>
          <Badge tone={device.mode === 'AUTO' ? 'neutral' : 'warn'}>{device.mode ?? 'AUTO'}</Badge>
          {device.offline
            ? <Badge tone="crit"><WifiOff className="h-3.5 w-3.5" />Offline · {ago(device.last_seen)}</Badge>
            : <Badge tone="good"><Wifi className="h-3.5 w-3.5" />Connected</Badge>}
          <Link to={`/device/${deviceId}/control`}>
            <Button variant="primary" size="sm"><SlidersHorizontal className="h-4 w-4" />Controls</Button>
          </Link>
        </div>
      </header>

      {device.estop ? (
        <div className="rounded-xl border border-crit bg-crit/10 p-4">
          <p className="font-medium text-crit-ink">Emergency stop is active</p>
          <p className="mt-1 text-sm text-ink-2">
            Every valve is shut and every pump is stopped. The plant will not resume until the E-stop is reset
            at the panel and from the control page.
          </p>
        </div>
      ) : null}

      <Card>
        <CardHead
          title="Process"
          hint={`Pass band pH ${limits.phMin}–${limits.phMax} · TDS ≤ ${num(limits.tdsMax)} mg/L`}
          right={
            <div className="flex flex-wrap items-center justify-end gap-3">
              <StatusLights led={device.led} siren={Boolean(device.siren)} />
              <div className="flex rounded-lg border border-line p-0.5" role="group" aria-label="Plant view">
                <button
                  onClick={() => setViewMode('3d')}
                  aria-pressed={viewMode === '3d'}
                  className={cn('inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs',
                    viewMode === '3d' ? 'bg-raised font-medium text-ink' : 'text-muted hover:text-ink')}
                >
                  <Box className="h-3.5 w-3.5" /> 3D
                </button>
                <button
                  onClick={() => setViewMode('schematic')}
                  aria-pressed={viewMode === 'schematic'}
                  className={cn('inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs',
                    viewMode === 'schematic' ? 'bg-raised font-medium text-ink' : 'text-muted hover:text-ink')}
                >
                  <Share2 className="h-3.5 w-3.5" /> Schematic
                </button>
              </div>
            </div>
          }
        />

        {viewMode === '3d' ? (
          <Suspense fallback={
            <div className="flex h-[320px] items-center justify-center rounded-xl border border-line bg-raised sm:h-[420px]">
              <Spinner label="Loading the 3D view" />
            </div>
          }>
            <Plant3D v={plantView} limits={limits} deviceName={device.device_name} />
          </Suspense>
        ) : (
          <ProcessDiagram limits={limits} v={plantView} />
        )}

        {/* progress bars for the two timed windows */}
        {device.state === 'TEST' ? (
          <Countdown label="Averaging the probes" seconds={inState} of={testWindow} />
        ) : null}
        {device.state === 'CONFIRM' ? (
          <Countdown label="Tank holding inside the band" seconds={inState} of={stableWindow} />
        ) : null}

        {v3Lock && !device.v3 ? (
          <div className="mt-4 flex items-start gap-2.5 rounded-lg border border-line bg-raised p-3">
            <Lock className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden />
            <div>
              <p className="text-sm font-medium text-ink">V3 is locked</p>
              <p className="text-sm text-ink-2">{v3Lock}</p>
              <p className="mt-1 text-xs text-muted">
                This is enforced in the firmware. No dashboard action can override it.
              </p>
            </div>
          </div>
        ) : null}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHead title="Chamber pH" hint="The batch waiting on a decision" />
          <PhBand value={device.ph === null ? null : Number(device.ph)} phMin={limits.phMin} phMax={limits.phMax} />
        </Card>

        <Card className="flex flex-col gap-5">
          <CardHead title="Dissolved solids and reagents" hint="The tank corrects pH only, never TDS" />
          <Meter label="Chamber TDS" value={device.tds === null ? null : Number(device.tds)}
            max={2000} limit={limits.tdsMax} unit="mg/L" />
          <Meter label="Neutraliser reservoir" value={device.neutraliser_pct === null ? null : Number(device.neutraliser_pct)}
            max={100} unit="%" invert />
          <Meter label="Treatment tank" value={Number(latest?.tank_l ?? 0)}
            max={Number(latest?.tank_cap_l ?? 300)} unit="L" />
        </Card>
      </div>

      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line lg:grid-cols-5">
        <Tile label="Batches today" value={num(todays.length)} />
        <Tile label="Passed first time" value={todays.length ? pct((passed / todays.length) * 100) : '—'} hint={`${passed} of ${todays.length}`} />
        <Tile label="To river" value={litres(toRiver, !device.flow_sensor)} />
        <Tile label="Blocked from river" value={litres(blocked, !device.flow_sensor)} tone="good" />
        <Tile label="Neutraliser left" value={pct(device.neutraliser_pct)} />
      </div>

      <Card>
        <CardHead title="pH — last 20 minutes" hint="Chamber and treatment tank against the band" />
        <div className="h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chart} margin={{ top: 8, right: 12, bottom: 4, left: -18 }}>
              <CartesianGrid stroke="rgb(var(--line))" vertical={false} />
              <ReferenceArea y1={limits.phMin} y2={limits.phMax} fill="rgb(var(--good))" fillOpacity={0.1} />
              <ReferenceLine y={limits.phMin} stroke="rgb(var(--good))" strokeWidth={1.5}
                label={{ value: `floor ${limits.phMin}`, position: 'insideBottomRight', fill: 'rgb(var(--muted))', fontSize: 11 }} />
              <ReferenceLine y={limits.phMax} stroke="rgb(var(--good))" strokeWidth={1.5}
                label={{ value: `ceiling ${limits.phMax}`, position: 'insideTopRight', fill: 'rgb(var(--muted))', fontSize: 11 }} />
              <XAxis dataKey="label" tick={{ fill: 'rgb(var(--muted))', fontSize: 11 }} minTickGap={48} stroke="rgb(var(--line))" />
              <YAxis domain={[3, 11]} tick={{ fill: 'rgb(var(--muted))', fontSize: 11 }} stroke="rgb(var(--line))" width={44} />
              <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: 'rgb(var(--muted))' }} />
              <Line type="monotone" dataKey="ph" name="Chamber" stroke="rgb(var(--info))" strokeWidth={2} dot={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="tankPh" name="Tank" stroke="rgb(var(--accent))" strokeWidth={2} strokeDasharray="5 4" dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <Legend items={[['Chamber', 'bg-info'], ['Treatment tank', 'bg-accent']]} />
      </Card>

      <Card>
        <CardHead title="TDS — last 20 minutes" hint={`Limit ${num(limits.tdsMax)} mg/L`} />
        <div className="h-48 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chart} margin={{ top: 8, right: 12, bottom: 4, left: -18 }}>
              <CartesianGrid stroke="rgb(var(--line))" vertical={false} />
              <ReferenceLine y={limits.tdsMax} stroke="rgb(var(--crit))" strokeDasharray="5 5" strokeWidth={1.5} />
              <XAxis dataKey="label" tick={{ fill: 'rgb(var(--muted))', fontSize: 11 }} minTickGap={48} stroke="rgb(var(--line))" />
              <YAxis domain={[0, 2000]} tick={{ fill: 'rgb(var(--muted))', fontSize: 11 }} stroke="rgb(var(--line))" width={44} />
              <Tooltip contentStyle={tooltipStyle} />
              <Line type="monotone" dataKey="tds" name="TDS mg/L" stroke="rgb(var(--info))" strokeWidth={2} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <Card>
        <CardHead title="Device events" hint="State changes, valve moves and interlock blocks, newest first" />
        <ul className="max-h-80 space-y-0 overflow-y-auto font-mono text-xs">
          {(events ?? []).map((e) => (
            <li key={String(e.id)} className={cn(
              'flex gap-3 border-b border-line py-2 pl-2.5',
              e.type === 'INTERLOCK_BLOCK' && 'border-l-2 border-l-crit',
              e.type === 'VALVE' && 'border-l-2 border-l-accent',
            )}>
              <span className="shrink-0 tabular text-muted">{siteTime(e.ts, tz)}</span>
              <span className="text-ink-2">{describeEvent(e.type, e.details)}</span>
            </li>
          ))}
          {!events?.length ? <li className="py-6 text-center text-muted">No events recorded yet.</li> : null}
        </ul>
      </Card>
    </div>
  );
}

const tooltipStyle = {
  background: 'rgb(var(--surface))',
  border: '1px solid rgb(var(--line))',
  borderRadius: 8,
  fontSize: 12,
  color: 'rgb(var(--ink))',
};

function Tile({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'good' }) {
  return (
    <div className="bg-surface p-4">
      <p className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-muted">{label}</p>
      <p className={cn('mt-1 text-xl font-semibold tabular', tone === 'good' ? 'text-good-ink' : 'text-ink')}>{value}</p>
      {hint ? <p className="text-xs text-ink-2">{hint}</p> : null}
    </div>
  );
}

function Countdown({ label, seconds, of }: { label: string; seconds: number; of: number }) {
  const frac = Math.max(0, Math.min(1, seconds / of));
  return (
    <div className="mt-4">
      <div className="mb-1.5 flex items-baseline justify-between text-xs">
        <span className="text-ink-2">{label}</span>
        <span className="font-mono tabular text-ink">{seconds.toFixed(1)} / {of} s</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-raised">
        <div className="h-full rounded-full bg-accent transition-[width] duration-200" style={{ width: `${frac * 100}%` }} />
      </div>
    </div>
  );
}

function Legend({ items }: { items: Array<[string, string]> }) {
  return (
    <div className="mt-3 flex flex-wrap gap-4 border-t border-line pt-3 text-xs text-ink-2">
      {items.map(([label, colour]) => (
        <span key={label} className="inline-flex items-center gap-2">
          <span className={cn('h-2.5 w-2.5 rounded-full', colour)} />
          {label}
        </span>
      ))}
    </div>
  );
}

/** How long the device has been in its current state, from its own samples. */
function secondsInState(telemetry: Array<{ ts: string; state: string }>, state: string | null): number {
  if (!state || !telemetry.length) return 0;
  let since = telemetry[telemetry.length - 1].ts;
  for (let n = telemetry.length - 1; n >= 0; n--) {
    if (telemetry[n].state !== state) break;
    since = telemetry[n].ts;
  }
  return Math.max(0, (Date.now() - Date.parse(since)) / 1000);
}

function describeEvent(type: string, details: Record<string, unknown>): string {
  switch (type) {
    case 'STATE_CHANGE': return `${details.from} → ${details.to}${details.batch_no ? ` (batch ${details.batch_no})` : ''}`;
    case 'VALVE': return `${details.valve} ${details.open ? 'opened' : 'closed'}`;
    case 'PUMP': return `${details.pump} slug ${details.slug ?? ''} at tank pH ${details.tank_ph ?? '—'}`;
    case 'INTERLOCK_BLOCK': return `BLOCKED: ${details.reason}`;
    case 'COMMAND': return `${details.type} ${details.accepted ? 'accepted' : 'rejected'} — ${details.reason}`;
    case 'CONFIG_APPLIED': return `configuration version ${details.version} applied`;
    case 'MODE_CHANGE': return `mode set to ${details.mode}`;
    case 'BOOT': return `controller booted on configuration version ${details.config_version}`;
    default: return `${type} ${JSON.stringify(details)}`;
  }
}
