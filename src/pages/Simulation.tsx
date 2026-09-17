/**
 * Node simulation — one site, end to end, on a bench.
 *
 * This is the explainer: a single mine-water node you can poke at. Trigger a
 * contamination slug and watch the batch get caught; empty the neutraliser and
 * watch V3 lock; cut the Wi-Fi and watch the controller keep deciding while
 * the dashboard goes stale and events buffer on the device.
 *
 * It runs the real `Controller` from /shared, not a simplified copy, so the
 * rule it enforces here is the rule the firmware enforces on the rig:
 * 6.5 ≤ pH ≤ 8.5 AND TDS ≤ 1200 mg/L. A demo that taught a different rule to
 * the one the plant uses would be worse than no demo.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Beaker, Droplet, FlaskConical, RefreshCw, Waves, Wifi, WifiOff,
} from 'lucide-react';
import { Controller } from '@shared/controller.ts';
import { DEFAULT_CONFIG } from '@shared/types.ts';
import { Plant } from '../../simulator/plant.ts';
import { Badge, Button, Card, CardHead, PageHead, cn, stateTone } from '../components/ui.tsx';
import { num, ph as fmtPh } from '../lib/format.ts';

const TICK_MS = 200;
const RESERVOIR_L = 20;

interface Snapshot {
  clock: number;
  state: string;
  batch: number;
  chamberL: number;
  tankL: number;
  ph: number;
  tds: number;
  tankPh: number;
  neutraliserPct: number;
  v1: boolean; v2: boolean; v3: boolean;
  sump: boolean; dosing: boolean; siren: boolean;
  v3Lock: string | null;
  releasedL: number;
  treatedL: number;
  passed: number;
  failed: number;
}

interface LogEntry { id: number; time: string; msg: string; tone: 'good' | 'warn' | 'crit' | 'plain'; buffered?: boolean }

const LIMITS = { phMin: DEFAULT_CONFIG.phMin, phMax: DEFAULT_CONFIG.phMax, tdsMax: DEFAULT_CONFIG.tdsMax };

export default function Simulation() {
  const controllerRef = useRef<Controller | null>(null);
  const plantRef = useRef<Plant | null>(null);
  const clockRef = useRef(0);
  const logId = useRef(0);

  const [snap, setSnap] = useState<Snapshot | null>(null);
  /** What the dashboard has actually received. Frozen while offline. */
  const [twin, setTwin] = useState<Snapshot | null>(null);
  const [online, setOnline] = useState(true);
  const onlineRef = useRef(true);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [queue, setQueue] = useState<LogEntry[]>([]);
  const [lastSync, setLastSync] = useState(0);
  const [running, setRunning] = useState(true);
  const runningRef = useRef(true);

  const totals = useRef({ released: 0, treated: 0, passed: 0, failed: 0 });
  /** So a level alarm is narrated once, not on every tick. */
  const emptyToldRef = useRef(false);
  const lowToldRef = useRef(false);

  const say = useCallback((msg: string, tone: LogEntry['tone'] = 'plain') => {
    const entry: LogEntry = { id: logId.current++, time: mmss(clockRef.current), msg, tone };
    if (onlineRef.current) setLog((l) => [entry, ...l].slice(0, 60));
    else setQueue((q) => [{ ...entry, buffered: true }, ...q]);
  }, []);

  const boot = useCallback(() => {
    clockRef.current = 0;
    totals.current = { released: 0, treated: 0, passed: 0, failed: 0 };
    controllerRef.current = new Controller({
      config: { ...DEFAULT_CONFIG },
      now: () => Date.now(),
    });
    plantRef.current = new Plant({ scenario: 'normal', seed: 4242, reservoirLitres: RESERVOIR_L });
    plantRef.current.i.neutraliserPct = 55;
    setLog([]);
    setQueue([]);
    setSnap(null);
    setTwin(null);
    setLastSync(0);
    logId.current = 0;
    say('Controller booted. Pass band 6.5–8.5 pH, TDS ≤ 1,200 mg/L');
  }, [say]);

  useEffect(() => { boot(); }, [boot]);
  useEffect(() => { onlineRef.current = online; }, [online]);
  useEffect(() => { runningRef.current = running; }, [running]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const c = controllerRef.current;
      const p = plantRef.current;
      if (!c || !p || !runningRef.current) return;

      clockRef.current += TICK_MS / 1000;
      p.step(TICK_MS / 1000, c.out, c.tankL, c.chamberL);
      const before = { v1: c.out.v1, v2: c.out.v2, v3: c.out.v3, dosing: c.out.dosingPump || c.out.acidPump };
      const beforeState = c.state;
      c.tick(TICK_MS, p.i);

      // Litres moved this tick, from what the valves were actually doing.
      const dt = TICK_MS / 1000;
      if (c.out.v1) totals.current.released += 25 * dt;
      if (c.out.v3) { totals.current.released += 25 * dt; }
      if (c.out.v2) totals.current.treated += 25 * dt;

      // Narrate in the operator's language rather than dumping state names.
      for (const b of c.drainBatches()) {
        const reading = `pH ${b.avg_ph.toFixed(2)}, TDS ${num(b.avg_tds)} mg/L`;
        if (b.result === 'PASS') {
          totals.current.passed += 1;
          say(`Batch ${b.batch_no} passed (${reading}): V1 open to the river`, 'good');
        } else if (b.result === 'HELD') {
          totals.current.failed += 1;
          say(`Batch ${b.batch_no} failed (${reading}). Tank full — batch held in the chamber`, 'crit');
        } else {
          totals.current.failed += 1;
          const why = b.fail_reason === 'ACID' ? 'too acidic'
            : b.fail_reason === 'ALKALINE' ? 'too alkaline'
            : 'dissolved solids over the limit';
          say(`Batch ${b.batch_no} failed — ${why} (${reading}): V2 open to the treatment tank`, 'crit');
        }
      }
      for (const cy of c.drainCycles()) {
        say(`Treatment cycle ${cy.cycle_no} released ${num(cy.volume_released_l)} L at pH ${fmtPh(cy.end_ph)}`, 'good');
      }
      c.drainEvents();
      c.drainVerdicts();

      if (c.state !== beforeState) {
        if (c.state === 'LOCKOUT') say(`V3 locked: ${c.lockoutReason ?? 'interlock'}`, 'crit');
        if (c.state === 'CONFIRM') say('Tank inside the band — holding for 3 s before V3 opens');
      }
      const dosingNow = c.out.dosingPump || c.out.acidPump;
      if (dosingNow !== before.dosing) {
        say(dosingNow
          ? `Tank at pH ${p.i.tankPh.toFixed(2)} — dosing pump on`
          : `Tank at pH ${p.i.tankPh.toFixed(2)} — dosing pump off`);
      }
      if (c.out.v3 !== before.v3) say(c.out.v3 ? 'V3 open — treated water to the river' : 'V3 shut', c.out.v3 ? 'good' : 'plain');

      if (p.i.neutraliserPct <= 0 && !emptyToldRef.current) {
        emptyToldRef.current = true;
        say('Level sensor: neutraliser empty. Dosing stopped, V3 locked', 'crit');
      }
      if (p.i.neutraliserPct > 0 && p.i.neutraliserPct < 20 && !lowToldRef.current) {
        lowToldRef.current = true;
        say('Level sensor: neutraliser below 20%, refill soon', 'warn');
      }

      const s: Snapshot = {
        clock: clockRef.current,
        state: c.state,
        batch: c.batchNo,
        chamberL: c.chamberL,
        tankL: c.tankL,
        ph: p.i.ph,
        tds: p.i.tds,
        tankPh: p.i.tankPh,
        neutraliserPct: p.i.neutraliserPct,
        v1: c.out.v1, v2: c.out.v2, v3: c.out.v3,
        sump: c.out.sumpPump, dosing: dosingNow, siren: c.out.siren,
        v3Lock: c.v3LockReason,
        releasedL: totals.current.released,
        treatedL: totals.current.treated,
        passed: totals.current.passed,
        failed: totals.current.failed,
      };
      setSnap(s);
      // The twin only sees what actually reached it.
      if (onlineRef.current) { setTwin(s); setLastSync(clockRef.current); }
    }, TICK_MS);

    return () => window.clearInterval(timer);
  }, [say]);

  // ------------------------------------------------------------ actions ---

  const contaminate = () => {
    plantRef.current?.injectAcid(3.6);
    say('Contamination enters the mine sump — pH falling', 'warn');
  };
  const alkalineSlug = () => {
    plantRef.current?.injectAlkaline(9.3);
    say('Alkaline slug enters the sump — pH 9.3', 'warn');
  };
  const saltLoad = () => {
    plantRef.current?.injectSalt(1600);
    say('Salt load enters the sump — TDS 1,600 mg/L', 'warn');
  };
  const refill = () => {
    plantRef.current?.refill(100);
    emptyToldRef.current = false;
    lowToldRef.current = false;
    say('Neutraliser refilled — level sensor reads 100%', 'good');
  };
  const toggleWifi = () => {
    if (online) {
      setOnline(false);
      onlineRef.current = false;
      say('Wi-Fi lost — the controller keeps deciding locally', 'warn');
    } else {
      onlineRef.current = true;
      setOnline(true);
      const n = queue.length;
      setLog((l) => [...queue.map((e) => ({ ...e, buffered: false })), ...l].slice(0, 60));
      setQueue([]);
      say(`Wi-Fi restored — ${n} buffered event${n === 1 ? '' : 's'} synced`, 'good');
      if (snap) { setTwin(snap); setLastSync(clockRef.current); }
    }
  };

  if (!snap) return null;

  const view = twin ?? snap;
  const stale = !online;
  const st = stateTone(snap.state);

  return (
    <div className="space-y-5">
      <PageHead
        title="Node simulation"
        sub="One mine-water node, end to end. Push it around and watch what the controller does."
        right={
          <div className="flex items-center gap-2">
            <Badge tone={st.tone}>{st.label}</Badge>
            {snap.siren ? <Badge tone="crit">Siren</Badge> : null}
          </div>
        }
      />

      <Card className="border-secondary/25 bg-secondary/5">
        <div className="flex gap-3">
          <Beaker className="mt-0.5 h-5 w-5 shrink-0 text-secondary" aria-hidden />
          <p className="text-sm text-ink-2">
            This runs the same controller as the firmware, so what you see here is what the rig does:
            a batch passes only when <strong className="font-medium text-ink">6.5 ≤ pH ≤ 8.5</strong> and
            {' '}<strong className="font-medium text-ink">TDS ≤ 1,200 mg/L</strong>. Nothing on this page can
            override an interlock, exactly as on the real plant.
          </p>
        </div>
      </Card>

      {/* --------------------------------------------------------- controls --- */}
      <Card>
        <CardHead title="Push the plant around" hint="Each of these changes what is arriving at the sump" />
        <div className="flex flex-wrap gap-2">
          <Button onClick={contaminate}><Droplet className="h-4 w-4" />Acid contamination</Button>
          <Button onClick={alkalineSlug}><Waves className="h-4 w-4" />Alkaline slug</Button>
          <Button onClick={saltLoad}><FlaskConical className="h-4 w-4" />Salt load</Button>
          <Button onClick={refill} variant="secondary"><Droplet className="h-4 w-4" />Refill neutraliser</Button>
          <Button onClick={toggleWifi} variant={online ? 'default' : 'primary'}>
            {online ? <WifiOff className="h-4 w-4" /> : <Wifi className="h-4 w-4" />}
            {online ? 'Cut Wi-Fi' : 'Restore Wi-Fi'}
          </Button>
          <Button onClick={() => setRunning((r) => !r)}>{running ? 'Pause' : 'Resume'}</Button>
          <Button onClick={() => { emptyToldRef.current = false; lowToldRef.current = false; boot(); }}>
            <RefreshCw className="h-4 w-4" />Reset
          </Button>
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
        {/* ------------------------------------------------------ diagram --- */}
        <Card>
          <CardHead
            title="The node"
            hint="Water colour follows quality: blue in band, amber over the TDS limit, red out of the pH band"
          />
          <NodeDiagram s={snap} />
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 border-t border-line-soft pt-3 text-xs text-ink-2">
            <Legend swatch="bg-secondary" label="Inside the band" />
            <Legend swatch="bg-warn" label="TDS over the limit" />
            <Legend swatch="bg-crit" label="Outside the pH band" />
            <Legend swatch="bg-good" label="Valve open / pump on" />
          </div>
        </Card>

        {/* ---------------------------------------------------- twin feed --- */}
        <div className="space-y-5">
          <Card className={cn(stale && 'border-warn/40')}>
            <CardHead
              title="Digital twin feed"
              hint={stale ? 'The plant is still running — this is the last data that reached us' : 'Live from the controller'}
              right={
                <Badge tone={stale ? 'warn' : 'good'}>
                  {stale ? `Offline · last sync ${mmss(lastSync)}` : 'Live'}
                </Badge>
              }
            />
            <dl className={cn('grid grid-cols-2 gap-3', stale && 'opacity-60')}>
              <Metric k="Batch" v={`#${view.batch}`} sub={view.state.toLowerCase()} />
              <Metric k="Chamber" v={`${num(view.chamberL)} L`} sub={`pH ${fmtPh(view.ph)} · ${num(view.tds)} mg/L`} />
              <Metric k="Tank" v={`${num(view.tankL)} / 300 L`} sub={view.tankL > 0 ? `pH ${fmtPh(view.tankPh)}` : 'empty'} />
              <Metric k="Neutraliser" v={view.neutraliserPct <= 0 ? 'Empty' : `${Math.round(view.neutraliserPct)}%`} />
              <Metric k="To river" v={`${num(view.releasedL)} L`} sub={`${view.passed} batches passed`} />
              <Metric k="Diverted" v={`${num(view.treatedL)} L`} sub={`${view.failed} batches caught`} />
            </dl>
            {stale ? (
              <p className="mt-3 rounded-lg border border-warn/30 bg-warn/5 p-2.5 text-xs text-ink-2">
                This is the point: the controller has not stopped. It is still filling, testing and
                diverting on its own, and buffering every event. The dashboard is the only thing that
                went blind.
              </p>
            ) : null}
          </Card>

          {snap.v3Lock ? (
            <Card className="border-warn/40 bg-warn/5">
              <p className="text-[13px] font-medium text-warn-ink">V3 is locked</p>
              <p className="mt-1 text-sm text-ink-2">{snap.v3Lock}</p>
            </Card>
          ) : null}
        </div>
      </div>

      {/* -------------------------------------------------------- event log --- */}
      <Card>
        <CardHead
          title="Event log"
          hint={queue.length ? `${queue.length} event(s) buffered on the device` : 'What the controller has done'}
        />
        <ul className="max-h-80 space-y-0 overflow-y-auto">
          {[...queue, ...log].slice(0, 40).map((e) => (
            <li key={e.id} className={cn(
              'flex gap-3 border-b border-line-soft py-2 text-[13px] last:border-b-0',
              e.buffered && 'opacity-55',
            )}>
              <span className="shrink-0 font-mono text-xs tabular text-muted">{e.time}</span>
              <span className={cn(
                e.tone === 'crit' ? 'text-crit-ink font-medium'
                  : e.tone === 'warn' ? 'text-warn-ink'
                  : e.tone === 'good' ? 'text-ink' : 'text-ink-2',
              )}>
                {e.msg}
                {e.buffered ? <span className="ml-1.5 text-muted">(buffered on device)</span> : null}
              </span>
            </li>
          ))}
          {!log.length && !queue.length ? (
            <li className="py-6 text-center text-sm text-muted">Waiting for the first batch.</li>
          ) : null}
        </ul>
      </Card>
    </div>
  );
}

// ============================================================ pieces =========

function Legend({ swatch, label }: { swatch: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className={cn('h-2.5 w-2.5 rounded-full', swatch)} />
      {label}
    </span>
  );
}

function Metric({ k, v, sub }: { k: string; v: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-line-soft bg-raised/50 p-3">
      <dt className="text-[11.5px] text-muted">{k}</dt>
      <dd className="mt-0.5 text-[17px] font-semibold tabular text-ink">{v}</dd>
      {sub ? <dd className="text-[11.5px] text-muted">{sub}</dd> : null}
    </div>
  );
}

function mmss(seconds: number): string {
  const s = Math.floor(seconds);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** Water colour class from the same rule the controller decides on. */
function quality(ph: number, tds: number | null): 'good' | 'warn' | 'crit' {
  if (ph < LIMITS.phMin || ph > LIMITS.phMax) return 'crit';
  if (tds !== null && tds > LIMITS.tdsMax) return 'warn';
  return 'good';
}

const WATER_FILL = { good: 'fill-secondary/70', warn: 'fill-warn/70', crit: 'fill-crit/70' };
const WATER_STROKE = { good: 'stroke-secondary', warn: 'stroke-warn', crit: 'stroke-crit' };

/**
 * The node, drawn left to right: the pass path across the top, the treatment
 * path along the bottom. Same geometry as the bench schematic so the two read
 * as the same plant.
 */
function NodeDiagram({ s }: { s: Snapshot }) {
  const chamberQ = quality(s.ph, s.tds);
  const tankQ = quality(s.tankPh, null);
  const chamberFrac = Math.max(0, Math.min(1, s.chamberL / 100));
  const tankFrac = Math.max(0, Math.min(1, s.tankL / 300));
  const resFrac = Math.max(0, Math.min(1, s.neutraliserPct / 100));

  const pipe = (on: boolean, q: 'good' | 'warn' | 'crit' = 'good') =>
    cn('fill-none [stroke-width:7] [stroke-linecap:round] [stroke-linejoin:round] transition-colors',
      on ? WATER_STROKE[q] : 'stroke-line',
      on && 'animate-flow [stroke-dasharray:9_12]');

  const valve = (open: boolean, locked = false) =>
    cn('[stroke-width:2] transition-colors',
      open ? 'fill-good/25 stroke-good' : locked ? 'fill-crit/15 stroke-crit' : 'fill-surface stroke-line');

  const chamberH = 130 * chamberFrac;
  const tankH = 95 * tankFrac;
  const resH = 72 * resFrac;

  return (
    <svg viewBox="0 0 800 400" className="block h-auto w-full" role="img"
      aria-label={
        `Node diagram. Batch ${s.batch}, state ${s.state}. Chamber ${Math.round(s.chamberL)} litres at pH ${s.ph.toFixed(2)}. ` +
        `Tank ${Math.round(s.tankL)} litres. V1 ${s.v1 ? 'open' : 'shut'}, V2 ${s.v2 ? 'open' : 'shut'}, V3 ${s.v3 ? 'open' : 'shut'}.`
      }>
      {/* pipes, drawn under the vessels */}
      <path d="M150 105 H186" className={pipe(s.sump, chamberQ)} />
      <path d="M214 105 H244" className={pipe(s.sump, chamberQ)} />
      <path d="M274 105 H300" className={pipe(s.sump, chamberQ)} />
      <path d="M450 105 H520" className={pipe(s.v1, chamberQ)} />
      <path d="M520 105 H600" className={pipe(s.v1, chamberQ)} />
      <path d="M375 190 V250" className={pipe(s.v2, chamberQ)} />
      <path d="M140 305 H190" className={pipe(s.dosing)} />
      <path d="M210 305 H300" className={pipe(s.dosing)} />
      <path d="M500 310 H560 V175 L600 140" className={pipe(s.v3, tankQ)} />

      {/* mine sump */}
      <rect x="20" y="50" width="130" height="110" rx="10" className="fill-raised stroke-line [stroke-width:1.5]" />
      <rect x="24" y="96" width="122" height="60" rx="6" className="fill-secondary/45" />
      <text x="85" y="72" textAnchor="middle" className="fill-ink text-[13px] font-semibold">Mine sump</text>
      <text x="85" y="178" textAnchor="middle" className="fill-muted font-mono text-[11px]">
        {s.sump ? 'pumping' : 'pump off'}
      </text>

      {/* pump + meter */}
      <circle cx="200" cy="105" r="11" className={cn('[stroke-width:2]', s.sump ? 'fill-good/30 stroke-good' : 'fill-surface stroke-line')} />
      <text x="200" y="83" textAnchor="middle" className="fill-muted text-[11px]">Pump</text>
      <rect x="244" y="94" width="30" height="22" rx="4" className="fill-surface stroke-line [stroke-width:1.5]" />
      <text x="259" y="83" textAnchor="middle" className="fill-muted text-[11px]">Meter</text>
      <text x="259" y="133" textAnchor="middle" className="fill-ink font-mono text-[11px] tabular">{Math.round(s.chamberL)} L</text>

      {/* check chamber */}
      <rect x="300" y="30" width="150" height="160" rx="10" className="fill-raised stroke-line [stroke-width:1.5]" />
      <rect x="304" y={186 - chamberH} width="142" height={Math.max(0, chamberH)} rx="6"
        className={cn('transition-all duration-300', WATER_FILL[chamberQ])} />
      <text x="375" y="18" textAnchor="middle" className="fill-ink text-[13px] font-semibold">Check chamber</text>
      <text x="375" y="52" textAnchor="middle" className="fill-muted text-[11px]">pH + TDS probe</text>
      <text x="375" y="112" textAnchor="middle" className="fill-ink font-mono text-[13px] font-medium tabular">
        pH {s.ph.toFixed(2)}
      </text>
      <text x="375" y="130" textAnchor="middle" className="fill-ink-2 font-mono text-[11px] tabular">
        {num(s.tds)} mg/L
      </text>

      {/* valves */}
      <circle cx="490" cy="105" r="13" className={valve(s.v1)} />
      <text x="490" y="110" textAnchor="middle" className="fill-ink font-mono text-[11px] font-medium">V1</text>
      <text x="490" y="80" textAnchor="middle" className="fill-muted text-[11px]">{s.v1 ? 'open' : 'shut'}</text>

      <circle cx="375" cy="222" r="13" className={valve(s.v2)} />
      <text x="375" y="227" textAnchor="middle" className="fill-ink font-mono text-[11px] font-medium">V2</text>
      <text x="410" y="226" className="fill-muted text-[11px]">{s.v2 ? 'open' : 'shut'}</text>

      <circle cx="530" cy="310" r="13" className={valve(s.v3, Boolean(s.v3Lock) && !s.v3)} />
      <text x="530" y="315" textAnchor="middle" className="fill-ink font-mono text-[11px] font-medium">V3</text>
      <text x="530" y="342" textAnchor="middle" className="fill-muted text-[11px]">
        {s.v3 ? 'open' : s.v3Lock ? 'locked' : 'shut'}
      </text>

      {/* river */}
      <rect x="600" y="40" width="175" height="130" rx="10" className="fill-raised stroke-line [stroke-width:1.5]" />
      <rect x="604" y="112" width="167" height="54" rx="6" className="fill-secondary/45" />
      <text x="687" y="72" textAnchor="middle" className="fill-ink text-[13px] font-semibold">River</text>
      <text x="687" y="96" textAnchor="middle" className="fill-muted text-[11px]">
        {s.v1 ? 'receiving tested water' : s.v3 ? 'receiving treated water' : 'no discharge'}
      </text>

      {/* treatment tank */}
      <rect x="300" y="250" width="200" height="120" rx="10" className="fill-raised stroke-line [stroke-width:1.5]" />
      <rect x="304" y={366 - tankH} width="192" height={Math.max(0, tankH)} rx="6"
        className={cn('transition-all duration-300', WATER_FILL[tankQ])} />
      <text x="400" y="240" textAnchor="middle" className="fill-ink text-[13px] font-semibold">Treatment tank</text>
      <text x="400" y="292" textAnchor="middle" className="fill-ink font-mono text-[12px] tabular">
        {Math.round(s.tankL)} / 300 L
      </text>
      <text x="400" y="310" textAnchor="middle" className="fill-ink-2 font-mono text-[11px] tabular">
        {s.tankL > 0 ? `pH ${s.tankPh.toFixed(2)}` : 'empty'}{s.dosing ? ' · dosing' : ''}
      </text>

      {/* neutraliser reservoir */}
      <rect x="30" y="255" width="110" height="100" rx="10" className="fill-raised stroke-line [stroke-width:1.5]" />
      <rect x="34" y={351 - resH} width="102" height={Math.max(0, resH)} rx="6"
        className={cn('transition-all duration-300', s.neutraliserPct < 20 ? 'fill-warn/70' : 'fill-accent/60')} />
      <text x="85" y="245" textAnchor="middle" className="fill-ink text-[13px] font-semibold">Neutraliser</text>
      <text x="85" y="374" textAnchor="middle" className="fill-muted font-mono text-[11px]">
        {s.neutraliserPct <= 0 ? 'level sensor: empty' : `level sensor: ${Math.round(s.neutraliserPct)}%`}
      </text>

      {/* dosing pump */}
      <circle cx="200" cy="305" r="11" className={cn('[stroke-width:2]', s.dosing ? 'fill-good/30 stroke-good' : 'fill-surface stroke-line')} />
      <text x="200" y="283" textAnchor="middle" className="fill-muted text-[11px]">Dosing pump</text>
    </svg>
  );
}
