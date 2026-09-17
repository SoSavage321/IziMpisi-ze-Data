/**
 * The plant, drawn.
 *
 * The process diagram is the page an operator looks at first, so it shows the
 * real thing: which valve is open, how full each vessel is, which way water is
 * moving, and what colour that water is. Water colour follows quality, but it
 * is never the only cue — every vessel carries its numbers too.
 */

import { Badge, cn } from './ui.tsx';
import { ph as fmtPh, num } from '../lib/format.ts';

export interface PlantView {
  state: string;
  chamberL: number;
  batchL: number;
  tankL: number;
  tankCapL: number;
  tankPh: number | null;
  ph: number | null;
  tds: number | null;
  v1: boolean;
  v2: boolean;
  v3: boolean;
  sumpPump: boolean;
  dosingPump: boolean;
  neutraliserPct: number | null;
  offline: boolean;
  v3LockReason: string | null;
}

/** Quality -> the colour of the water in the vessel. */
function waterClass(ph: number | null, tds: number | null, limits: { phMin: number; phMax: number; tdsMax: number }) {
  if (ph === null) return 'fill-muted/30';
  if (ph < limits.phMin) return 'fill-crit/40';
  if (ph > limits.phMax) return 'fill-serious/45';
  if (tds !== null && tds > limits.tdsMax) return 'fill-warn/45';
  return 'fill-info/35';
}

export function ProcessDiagram({ v, limits }: {
  v: PlantView;
  limits: { phMin: number; phMax: number; tdsMax: number };
}) {
  const chamberFrac = Math.max(0, Math.min(1, v.chamberL / Math.max(1, v.batchL)));
  const tankFrac = Math.max(0, Math.min(1, v.tankL / Math.max(1, v.tankCapL)));
  const chamberH = 130 * chamberFrac;
  const tankH = 74 * tankFrac;
  const chamberWater = waterClass(v.ph, v.tds, limits);
  const tankWater = waterClass(v.tankPh, null, limits);

  const pipe = (on: boolean) =>
    cn('fill-none [stroke-width:7] [stroke-linecap:round] [stroke-linejoin:round]',
      on ? 'stroke-accent' : 'stroke-line',
      on && 'animate-flow [stroke-dasharray:9_13]');

  const node = (open: boolean, locked?: boolean) =>
    cn('[stroke-width:2]',
      open ? 'fill-good/20 stroke-good' : locked ? 'fill-crit/15 stroke-crit' : 'fill-surface stroke-line');

  return (
    <svg viewBox="0 0 820 256" className={cn('block h-auto w-full', v.offline && 'opacity-40')} role="img"
      aria-label={`Process flow. State ${v.state}. V1 ${v.v1 ? 'open' : 'shut'}, V2 ${v.v2 ? 'open' : 'shut'}, V3 ${v.v3 ? 'open' : 'shut'}.`}>
      {/* pipes */}
      <path d="M94 122 H130" className={pipe(v.sumpPump)} />
      <path d="M240 122 H280 V88 H358" className={pipe(v.v1)} />
      <path d="M240 122 H280 V186 H358" className={pipe(v.v2)} />
      <path d="M394 88 H658" className={pipe(v.v1)} />
      <path d="M394 186 H430" className={pipe(v.v2)} />
      <path d="M613 186 H640 V120 H658" className={pipe(v.v3)} />

      {/* sump */}
      <rect x="8" y="96" width="86" height="52" rx="8" className="fill-raised stroke-line [stroke-width:1.5]" />
      <text x="51" y="118" textAnchor="middle" className="fill-ink font-display text-[11px] font-semibold uppercase tracking-[0.1em]">Sump</text>
      <text x="51" y="136" textAnchor="middle" className="fill-muted font-mono text-[10.5px]">{v.sumpPump ? 'pumping' : 'pump off'}</text>

      {/* check chamber */}
      <rect x="130" y="56" width="110" height="132" rx="8" className="fill-raised stroke-line [stroke-width:1.5]" />
      <rect x="132" y={186 - chamberH} width="106" height={Math.max(0, chamberH)} rx="6" className={chamberWater} />
      {chamberH > 2 ? <line x1="132" y1={186 - chamberH} x2="238" y2={186 - chamberH} className="stroke-info [stroke-width:1.5]" /> : null}
      <text x="185" y="44" textAnchor="middle" className="fill-ink font-display text-[11px] font-semibold uppercase tracking-[0.1em]">Check chamber</text>
      <text x="185" y="208" textAnchor="middle" className="fill-muted font-mono text-[10.5px]">
        {num(v.chamberL)} / {num(v.batchL)} L
      </text>
      <text x="185" y="222" textAnchor="middle" className="fill-muted font-mono text-[10.5px]">
        pH {fmtPh(v.ph)} · {num(v.tds)} mg/L
      </text>

      {/* valves */}
      <circle cx="376" cy="88" r="18" className={node(v.v1)} />
      <text x="376" y="92" textAnchor="middle" className="fill-ink font-mono text-[11.5px] font-medium">V1</text>
      <text x="376" y="57" textAnchor="middle" className="fill-muted font-mono text-[10.5px]">{v.v1 ? 'open' : 'shut'}</text>

      <circle cx="376" cy="186" r="18" className={node(v.v2)} />
      <text x="376" y="190" textAnchor="middle" className="fill-ink font-mono text-[11.5px] font-medium">V2</text>
      <text x="376" y="223" textAnchor="middle" className="fill-muted font-mono text-[10.5px]">{v.v2 ? 'open' : 'shut'}</text>

      {/* treatment tank */}
      <rect x="430" y="148" width="150" height="76" rx="8" className="fill-raised stroke-line [stroke-width:1.5]" />
      <rect x="432" y={222 - tankH} width="146" height={Math.max(0, tankH)} rx="6" className={tankWater} />
      {tankH > 2 ? <line x1="432" y1={222 - tankH} x2="578" y2={222 - tankH} className="stroke-info [stroke-width:1.5]" /> : null}
      <text x="505" y="138" textAnchor="middle" className="fill-ink font-display text-[11px] font-semibold uppercase tracking-[0.1em]">Treatment tank</text>
      <text x="505" y="176" textAnchor="middle" className="fill-muted font-mono text-[10.5px]">{num(v.tankL)} / {num(v.tankCapL)} L</text>
      <text x="505" y="192" textAnchor="middle" className="fill-muted font-mono text-[10.5px]">
        {v.tankL > 0 ? `pH ${fmtPh(v.tankPh)}` : 'empty'}{v.dosingPump ? ' · dosing' : ''}
      </text>

      <circle cx="596" cy="186" r="18" className={node(v.v3, Boolean(v.v3LockReason) && !v.v3)} />
      <text x="596" y="190" textAnchor="middle" className="fill-ink font-mono text-[11.5px] font-medium">V3</text>
      <text x="596" y="223" textAnchor="middle" className="fill-muted font-mono text-[10.5px]">
        {v.v3 ? 'open' : v.v3LockReason ? 'locked' : 'shut'}
      </text>

      {/* river */}
      <rect x="658" y="56" width="154" height="64" rx="8" className="fill-raised stroke-line [stroke-width:1.5]" />
      <text x="735" y="82" textAnchor="middle" className="fill-ink font-display text-[11px] font-semibold uppercase tracking-[0.1em]">River</text>
      <text x="735" y="100" textAnchor="middle" className="fill-muted font-mono text-[10.5px]">
        {v.v1 ? 'tested water' : v.v3 ? 'treated water' : 'no discharge'}
      </text>
    </svg>
  );
}

/**
 * The pH band. The whole system exists to keep a reading inside this window,
 * so it is drawn as a window: everything outside it is dimmed.
 */
export function PhBand({ value, phMin, phMax, height = 92 }: {
  value: number | null; phMin: number; phMax: number; height?: number;
}) {
  const x = (v: number) => 8 + (v / 14) * 584;
  const inBand = value !== null && value >= phMin && value <= phMax;
  const tone = value === null ? 'text-muted' : inBand ? 'text-good' : value < phMin ? 'text-crit' : 'text-serious';

  return (
    <div>
      <svg viewBox="0 0 600 92" className="block h-auto w-full overflow-visible" role="img"
        aria-label={`pH ${value === null ? 'unknown' : value.toFixed(2)}; acceptance band ${phMin} to ${phMax}`}>
        <defs>
          <linearGradient id="phscale" x1="0" x2="1">
            <stop offset="0%" stopColor="#b8332f" /><stop offset="24%" stopColor="#c2694a" />
            <stop offset="48%" stopColor="#6b7a76" /><stop offset="52%" stopColor="#6b7a76" />
            <stop offset="76%" stopColor="#2f6ea8" /><stop offset="100%" stopColor="#1d4f9e" />
          </linearGradient>
        </defs>

        <rect x="8" y="40" width="584" height="26" rx="5" fill="url(#phscale)" opacity="0.3" />
        <rect x={x(phMin)} y="40" width={x(phMax) - x(phMin)} height="26" fill="url(#phscale)" opacity="0.95" />
        <rect x={x(phMin)} y="39" width={x(phMax) - x(phMin)} height="28" fill="none"
          className="stroke-good [stroke-width:1.5]" />

        <text x={x(phMin) - 6} y="32" textAnchor="end" className="fill-ink-2 font-mono text-[11px] font-medium">{phMin}</text>
        <text x={x(phMax) + 6} y="32" className="fill-ink-2 font-mono text-[11px] font-medium">{phMax}</text>
        <text x="8" y="84" className="fill-muted font-mono text-[10px] tracking-[0.14em]">ACID pH 0</text>
        <text x="592" y="84" textAnchor="end" className="fill-muted font-mono text-[10px] tracking-[0.14em]">pH 14 ALKALINE</text>

        {value !== null ? (
          <g>
            <rect x={x(Math.max(0, Math.min(14, value))) - 1.5} y="32" width="3" height="42" rx="1.5"
              className={cn('fill-current', tone)} />
            <circle cx={x(Math.max(0, Math.min(14, value)))} cy="30" r="4.5" className={cn('fill-current', tone)} />
          </g>
        ) : null}
      </svg>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <span className={cn('font-mono text-lg font-medium tabular', tone)}>pH {fmtPh(value)}</span>
        <Badge tone={value === null ? 'neutral' : inBand ? 'good' : value < phMin ? 'crit' : 'serious'}>
          {value === null ? 'No reading' : inBand ? 'Inside the band' : value < phMin ? 'Acidic — will divert' : 'Alkaline — will divert'}
        </Badge>
      </div>
    </div>
  );
}

/** A horizontal meter with a limit marker. Used for TDS and for reservoirs. */
export function Meter({ value, max, limit, unit, label, invert }: {
  value: number | null; max: number; limit?: number; unit: string; label: string; invert?: boolean;
}) {
  const v = value ?? 0;
  const frac = Math.max(0, Math.min(1, v / max));
  // invert: for a reservoir, low is bad. Otherwise high is bad.
  const bad = invert ? v <= max * 0.05 : limit !== undefined && v > limit;
  const near = invert ? v < max * 0.2 : limit !== undefined && v > limit * 0.8;
  const tone = bad ? 'bg-crit' : near ? 'bg-warn' : 'bg-accent';

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-xs text-ink-2">{label}</span>
        <span className="font-mono text-sm font-medium tabular text-ink">
          {value === null ? '—' : num(v)} {unit}
        </span>
      </div>
      <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-raised">
        <div className={cn('h-full rounded-full transition-[width] duration-500', tone)} style={{ width: `${frac * 100}%` }} />
        {limit !== undefined ? (
          <div className="absolute inset-y-0 w-0.5 bg-ink/60" style={{ left: `${(limit / max) * 100}%` }}
            aria-hidden title={`limit ${limit} ${unit}`} />
        ) : null}
      </div>
      {limit !== undefined ? (
        <p className="mt-1 font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted">
          limit {num(limit)} {unit}
        </p>
      ) : null}
    </div>
  );
}

/** Panel lamps, mirrored from the device. Colour plus the word, always. */
export function StatusLights({ led, siren }: { led: string | null; siren: boolean }) {
  const lamps: Array<{ key: string; label: string; on: boolean; className: string }> = [
    { key: 'green', label: 'Pass', on: led === 'green', className: 'bg-good' },
    { key: 'red', label: 'Fail', on: led === 'red', className: 'bg-crit' },
    { key: 'yellow', label: 'Testing / empty', on: led === 'yellow', className: 'bg-warn' },
  ];
  return (
    <div className="flex flex-wrap items-center gap-3">
      {lamps.map((l) => (
        <span key={l.key} className="inline-flex items-center gap-1.5 text-xs text-ink-2">
          <span className={cn('h-3 w-3 rounded-full border border-line', l.on ? l.className : 'bg-transparent')} />
          <span className={l.on ? 'font-medium text-ink' : 'text-muted'}>{l.label}</span>
        </span>
      ))}
      <span className="inline-flex items-center gap-1.5 text-xs">
        <span className={cn('h-3 w-3 rounded-full border border-line', siren ? 'animate-pulseDot bg-crit' : 'bg-transparent')} />
        <span className={siren ? 'font-medium text-crit' : 'text-muted'}>{siren ? 'Siren sounding' : 'Siren off'}</span>
      </span>
    </div>
  );
}
