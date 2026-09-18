/**
 * The AcidShield bench prototype.
 *
 * A Flask process on the bench PC reads the Arduino over serial and serves
 * what it has seen at /api/readings/latest, /api/readings/history and
 * /api/health. This module turns that into the same Telemetry shape the rest
 * of the dashboard already speaks, so the prototype can sit in the fleet
 * beside the simulated controllers instead of needing its own screen.
 *
 * Two things constrain where this can work, and neither is fixable from here:
 *
 *  - Mixed content. The deployed dashboard is served over HTTPS and the bench
 *    API is plain HTTP on a LAN address, so a browser refuses the request
 *    outright. The prototype therefore only reports when the dashboard itself
 *    is opened over HTTP — `npm run dev` on the same network.
 *  - CORS. Flask must return Access-Control-Allow-Origin or the browser drops
 *    the response before this code sees it. `pip install flask-cors` and
 *    `CORS(app)` is the whole fix.
 *
 * When either blocks, or the bench PC is off, the fetch fails, last_seen goes
 * stale and the device shows as offline — which is the honest answer.
 */

import type { Telemetry } from './types.ts';

/** Bench PC on the site WiFi. Override with VITE_PROTOTYPE_API. */
export const PROTOTYPE_API =
  (import.meta.env.VITE_PROTOTYPE_API as string | undefined)?.replace(/\/$/, '')
  ?? 'http://192.168.40.249:5000';

export const PROTOTYPE_DEVICE_ID = 'dev-proto';

/**
 * The ultrasonic head looks DOWN at the water, so it returns the distance to
 * the surface: the smaller the reading, the fuller the tank. The sketch calls
 * it full below TANK_FULL_CM. The other end of the scale — the distance to a
 * dry bottom — is a property of how the rig is built and is not in the
 * firmware, so it is configurable and defaults to a plausible bench value.
 */
export const TANK_FULL_CM = Number(import.meta.env.VITE_PROTOTYPE_TANK_FULL_CM ?? 4);
export const TANK_EMPTY_CM = Number(import.meta.env.VITE_PROTOTYPE_TANK_EMPTY_CM ?? 20);

/** Depth to the surface -> how full the tank is, 0..1. */
export function tankFraction(tankCm: number | null): number | null {
  if (tankCm === null || tankCm <= 0) return null;
  const span = TANK_EMPTY_CM - TANK_FULL_CM;
  if (span <= 0) return null;
  return Math.max(0, Math.min(1, (TANK_EMPTY_CM - tankCm) / span));
}

type Raw = Record<string, unknown>;

/**
 * The firmware sketch and this dashboard were written by different people, so
 * rather than demand one spelling, look for any of the ones a reading could
 * plausibly arrive under — including one level of nesting, since Flask
 * responses often wrap the payload.
 */
function pick(raw: Raw, names: string[]): unknown {
  for (const n of names) {
    if (raw[n] !== undefined && raw[n] !== null) return raw[n];
  }
  for (const nest of ['reading', 'data', 'latest', 'values']) {
    const inner = raw[nest];
    if (inner && typeof inner === 'object') {
      for (const n of names) {
        const v = (inner as Raw)[n];
        if (v !== undefined && v !== null) return v;
      }
    }
  }
  return undefined;
}

function num(raw: Raw, names: string[]): number | null {
  const v = pick(raw, names);
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function bool(raw: Raw, names: string[]): boolean {
  const v = pick(raw, names);
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return ['1', 'true', 'yes', 'on', 'open'].includes(v.toLowerCase());
  return false;
}

/**
 * Whatever the bench sent -> the Telemetry the dashboard renders.
 *
 * From the sketch (AcidShield node, Arduino Uno), one JSON line per 500 ms:
 *
 *   cond      analogRead(A1) averaged over 10 samples — a raw 0..1023 ADC
 *             count from the conductivity probe, NOT uS/cm and NOT mg/L
 *   risk      dirtyScore(cond, COND_CLEAN, COND_DIRTY), 0..100, the rig's own
 *             calibrated contamination score; >= 50 counts as bad
 *   state     "PASS" | "FAIL", after CONFIRM consecutive agreeing samples
 *   valve     "RIVER" | "TANK"
 *   tankCm    ultrasonic depth, or null when the echo times out
 *   tankFull  tankCm below TANK_FULL_CM
 *   tempC     thermistor, or null when the divider reads rail-to-rail
 *   alarm     buzzer and LED, set by failing || tankFull
 *
 * What this rig does NOT have: a pH probe, a TDS meter, and any reagent level
 * sensor. `cond` is an ADC count on an uncalibrated scale, so it cannot be
 * turned into mg/L without a two-point calibration against known solutions —
 * a number derived from it would look like a measurement and be nothing of
 * the kind. pH, TDS and reagent level are therefore all reported unmeasured,
 * and the rig's own risk score is carried through as itself.
 */
export function toTelemetry(raw: Raw, now = Date.now()): Telemetry | null {
  const cond = num(raw, ['cond', 'conductivity']);
  const risk = num(raw, ['risk']);
  const ph = num(raw, ['ph', 'pH', 'PH', 'ph_value']);
  const tds = num(raw, ['tds', 'TDS', 'tds_ppm']);
  // A payload with none of these is not a reading.
  if (cond === null && risk === null && ph === null && tds === null) return null;

  // The bench stamps local time with no offset, and the bench and this
  // dashboard both sit in Johannesburg, so parsing it as local is correct.
  const tsRaw = pick(raw, ['timestamp', 'ts', 'time', 'created_at', 'receivedAt']);
  let ts = new Date(now).toISOString();
  if (typeof tsRaw === 'string' && !Number.isNaN(Date.parse(tsRaw))) ts = new Date(tsRaw).toISOString();
  else if (typeof tsRaw === 'number') ts = new Date(tsRaw < 1e12 ? tsRaw * 1000 : tsRaw).toISOString();

  // The sketch writes TANK; the event log prose says TREATMENT. Accept both.
  const valve = String(pick(raw, ['valve']) ?? '').toUpperCase();
  const toTank = valve.startsWith('TANK') || valve.startsWith('TREAT');
  const toRiver = valve.startsWith('RIV') || valve.startsWith('DAM');

  const rawState = String(pick(raw, ['state', 'status', 'phase']) ?? '').toUpperCase();
  let state = rawState || 'TEST';
  if (toTank || rawState === 'FAIL' || rawState === 'AMD') state = 'DIVERT';
  else if (toRiver || rawState === 'PASS') state = 'DISCHARGE';

  const tankCm = num(raw, ['tankCm', 'tank_cm']);
  const tempC = num(raw, ['tempC', 'temp_c', 'temperature']);

  const extra: Record<string, number | string | boolean> = {};
  if (risk !== null) extra.risk = risk;
  if (cond !== null) extra.cond = cond;
  if (tempC !== null) extra.tempC = tempC;
  if (tankCm !== null) {
    extra.tankCm = tankCm;
    const frac = tankFraction(tankCm);
    if (frac !== null) extra.tankFraction = frac;
  }
  if (pick(raw, ['tankFull']) !== undefined) extra.tankFull = bool(raw, ['tankFull']);

  const unmeasured: string[] = [];
  if (ph === null) unmeasured.push('ph');
  if (tds === null) unmeasured.push('tds');
  if (num(raw, ['neutraliser_pct', 'neutraliserPct', 'reagent_pct']) === null) unmeasured.push('neutraliser_pct');
  // tankCm is a depth. Without the tank's cross-section it cannot become
  // litres, so the level is known and the volume is not.
  if (num(raw, ['tank_l', 'tankL']) === null) unmeasured.push('tank_l');

  return {
    ts,
    state,
    mode: 'AUTO',
    estop: bool(raw, ['estop', 'e_stop', 'emergency_stop']),
    // Placeholders the control types demand; both are listed in `unmeasured`
    // and the dashboard prints them as unknown.
    ph: ph ?? 7,
    tds: tds ?? 0,
    chamber_l: num(raw, ['chamber_l', 'chamberL', 'volume_l']) ?? 0,
    tank_l: num(raw, ['tank_l', 'tankL']) ?? 0,
    tank_cap_l: num(raw, ['tank_cap_l', 'tankCapL']) ?? 300,
    tank_ph: num(raw, ['tank_ph', 'tankPh']) ?? (ph ?? 7),
    tank_tds: num(raw, ['tank_tds', 'tankTds']) ?? (tds ?? 0),
    neutraliser_pct: num(raw, ['neutraliser_pct', 'neutraliserPct', 'reagent_pct']) ?? 100,
    v1: bool(raw, ['v1', 'V1', 'valve1']) || toRiver,
    v2: bool(raw, ['v2', 'V2', 'valve2']) || toTank,
    v3: bool(raw, ['v3', 'V3', 'valve3']),
    sump_pump: bool(raw, ['sump_pump', 'sumpPump', 'pump']),
    dosing_pump: bool(raw, ['dosing_pump', 'dosingPump', 'doser']),
    siren: bool(raw, ['alarm', 'siren', 'buzzer']),
    led: typeof pick(raw, ['led']) === 'string' ? String(pick(raw, ['led'])) : 'off',
    wifi_rssi: num(raw, ['wifi_rssi', 'rssi']) ?? -50,
    uptime_s: num(raw, ['uptime_s', 'uptime']) ?? 0,
    unmeasured,
    extra: Object.keys(extra).length ? extra : undefined,
  };
}

async function get(path: string, timeoutMs = 4000): Promise<unknown> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetch(`${PROTOTYPE_API}${path}`, { signal: abort.signal, mode: 'cors' });
    if (!res.ok) return null;          // 503 "no reading yet" lands here
    return await res.json();
  } catch {
    return null;                       // offline, blocked, or CORS-refused
  } finally {
    clearTimeout(timer);
  }
}

/** One reading, or null when the bench has nothing or cannot be reached. */
export async function latestReading(): Promise<Telemetry | null> {
  const raw = await get('/api/readings/latest');
  return raw && typeof raw === 'object' ? toTelemetry(raw as Raw) : null;
}

/** Backfill, oldest first, so the charts have a line on first load. */
export async function readingHistory(limit = 200): Promise<Telemetry[]> {
  const raw = await get(`/api/readings/history?limit=${limit}`, 8000);
  if (!Array.isArray(raw)) return [];
  const out: Telemetry[] = [];
  for (const item of raw) {
    if (item && typeof item === 'object') {
      const t = toTelemetry(item as Raw);
      if (t) out.push(t);
    }
  }
  return out.sort((a, b) => a.ts.localeCompare(b.ts));
}
