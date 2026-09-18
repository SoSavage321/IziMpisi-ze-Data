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

/** Whatever the bench sent -> the Telemetry the dashboard renders. */
export function toTelemetry(raw: Raw, now = Date.now()): Telemetry | null {
  const ph = num(raw, ['ph', 'pH', 'PH', 'ph_value', 'phValue']);
  const tds = num(raw, ['tds', 'TDS', 'tds_ppm', 'tdsPpm', 'tds_value', 'ec', 'EC']);
  // A reading with neither probe in it is not a reading.
  if (ph === null && tds === null) return null;

  const tsRaw = pick(raw, ['ts', 'timestamp', 'time', 'created_at', 'receivedAt']);
  let ts = new Date(now).toISOString();
  if (typeof tsRaw === 'string' && !Number.isNaN(Date.parse(tsRaw))) ts = new Date(tsRaw).toISOString();
  else if (typeof tsRaw === 'number') ts = new Date(tsRaw < 1e12 ? tsRaw * 1000 : tsRaw).toISOString();

  const state = pick(raw, ['state', 'status', 'phase']);

  return {
    ts,
    // The bench rig measures continuously rather than running the batch
    // machine, so TEST is the truthful default: it is testing water.
    state: typeof state === 'string' && state ? state.toUpperCase() : 'TEST',
    mode: 'AUTO',
    estop: bool(raw, ['estop', 'e_stop', 'emergency_stop']),
    ph: ph ?? 7,
    tds: tds ?? 0,
    chamber_l: num(raw, ['chamber_l', 'chamberL', 'volume_l', 'volume']) ?? 0,
    tank_l: num(raw, ['tank_l', 'tankL']) ?? 0,
    tank_cap_l: num(raw, ['tank_cap_l', 'tankCapL']) ?? 300,
    tank_ph: num(raw, ['tank_ph', 'tankPh']) ?? (ph ?? 7),
    tank_tds: num(raw, ['tank_tds', 'tankTds']) ?? (tds ?? 0),
    neutraliser_pct: num(raw, ['neutraliser_pct', 'neutraliserPct', 'reagent_pct']) ?? 100,
    v1: bool(raw, ['v1', 'V1', 'valve1', 'valve_1']),
    v2: bool(raw, ['v2', 'V2', 'valve2', 'valve_2']),
    v3: bool(raw, ['v3', 'V3', 'valve3', 'valve_3']),
    sump_pump: bool(raw, ['sump_pump', 'sumpPump', 'pump']),
    dosing_pump: bool(raw, ['dosing_pump', 'dosingPump', 'doser']),
    siren: bool(raw, ['siren', 'buzzer', 'alarm']),
    led: typeof pick(raw, ['led']) === 'string' ? String(pick(raw, ['led'])) : 'off',
    wifi_rssi: num(raw, ['wifi_rssi', 'rssi']) ?? -50,
    uptime_s: num(raw, ['uptime_s', 'uptime', 'secondsSinceLastReading']) ?? 0,
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
