/**
 * Alarm rules.
 *
 * These run server-side in the /ingest edge function, on every telemetry
 * batch. They are pure functions over a snapshot so they can be unit-tested
 * without a database, a device or a clock.
 *
 * The engine is a reconciler, not an event emitter: `evaluateAlarms` reports
 * which conditions are true *right now*, and the caller raises what is newly
 * true and clears what is no longer true. That gives duplicate suppression for
 * free — an alarm stays as one row from the moment it is raised until the
 * condition goes away, however many telemetry samples arrive in between.
 */

import { ControllerConfig, TelemetrySample } from './types.ts';

export type Severity = 'info' | 'warning' | 'critical';

export interface AlarmCandidate {
  type: string;
  severity: Severity;
  message: string;
  details: Record<string, unknown>;
}

export interface ExistingAlarm {
  id: string;
  type: string;
  severity: Severity;
  raised_at: string;
  acknowledged_at: string | null;
  escalated: boolean;
}

export interface AlarmContext {
  /** Evaluation time in ms since epoch. */
  now: number;
  device: {
    id: string;
    name: string;
    last_seen: string | null;
    flow_sensor: boolean;
  };
  config: ControllerConfig;
  /** Most recent telemetry sample, or null if the device has never reported. */
  latest: TelemetrySample | null;
  /** Samples over roughly the last 5 minutes, oldest first. */
  window: TelemetrySample[];
  /** Results of the last 20 batches, newest first. */
  recentBatches: Array<{ result: string; started_at: string }>;
  /** When the current HELD condition started, if the plant is holding a batch. */
  heldSince: string | null;
  /** Set when the device reported an INTERLOCK_BLOCK event in this ingest. */
  interlockViolation?: { reason: string } | null;
  /** Earliest overdue calibration item, if any. */
  calibrationOverdue?: { component: string; next_due_at: string } | null;
  /** The most recent completed treatment cycle. */
  lastCycle?: { end_tds: number | null; released_at: string | null } | null;
  /**
   * Neutraliser held in the store for this device's site. Distinct from
   * latest.neutraliser_pct, which is the drum on the plant: the drum can read
   * full while the store behind it is empty, and nobody finds out until the
   * next refill is due. Omit when the caller has no stock figure.
   */
  siteStock?: { item: string; stock: number; reorder_level: number; unit: string } | null;
}

export const OFFLINE_AFTER_MS = 60_000;
export const HELD_ALARM_AFTER_MS = 10 * 60_000;
export const STUCK_SENSOR_AFTER_MS = 5 * 60_000;
export const ESCALATE_AFTER_MS = 10 * 60_000;
export const WIFI_WEAK_RSSI = -80;
export const PASS_RATE_FLOOR = 0.5;
export const PASS_RATE_WINDOW = 20;

/** Physically possible probe readings. Anything outside is a fault, not a value. */
export const PH_RANGE: [number, number] = [0, 14];
export const TDS_RANGE: [number, number] = [0, 5000];

/** Every condition the engine knows how to clear. Order is severity-first. */
export const RULE_TYPES = [
  'neutraliser_empty',
  'stock_out',
  'device_offline',
  'estop_active',
  'interlock_violation',
  'batch_held',
  'sensor_fault',
  'neutraliser_low',
  'stock_low',
  'ph_high_chamber',
  'ph_high_tank',
  'tank_tds_high',
  'pass_rate_low',
  'calibration_overdue',
  'wifi_weak',
] as const;

export function evaluateAlarms(ctx: AlarmContext): AlarmCandidate[] {
  const out: AlarmCandidate[] = [];
  const { latest, config, device, now } = ctx;

  // ------------------------------------------------------------- critical ---

  const stock = ctx.siteStock;
  if (stock) {
    if (stock.stock <= 0) {
      out.push({
        type: 'stock_out',
        severity: 'critical',
        message: `No ${stock.item} left in the store — the next refill cannot be done and treatment stops when the drum empties`,
        details: { item: stock.item, stock: stock.stock, reorder_level: stock.reorder_level, unit: stock.unit },
      });
    } else if (stock.stock < stock.reorder_level) {
      out.push({
        type: 'stock_low',
        severity: 'warning',
        message: `${stock.item} down to ${stock.stock} ${stock.unit} — below the ${stock.reorder_level} ${stock.unit} reorder level`,
        details: { item: stock.item, stock: stock.stock, reorder_level: stock.reorder_level, unit: stock.unit },
      });
    }
  }

  const lastSeenMs = device.last_seen ? Date.parse(device.last_seen) : null;
  if (lastSeenMs === null || now - lastSeenMs > OFFLINE_AFTER_MS) {
    out.push({
      type: 'device_offline',
      severity: 'critical',
      message: lastSeenMs === null
        ? `${device.name} has never reported in`
        : `${device.name} has been offline for ${Math.round((now - lastSeenMs) / 1000)} s`,
      details: { last_seen: device.last_seen, threshold_s: OFFLINE_AFTER_MS / 1000 },
    });
    // Everything below reads live telemetry; a dead device cannot tell us more.
    return out;
  }

  if (!latest) return out;

  if (latest.neutraliser_pct <= 0) {
    out.push({
      type: 'neutraliser_empty',
      severity: 'critical',
      message: 'Neutraliser reservoir is empty — V3 is locked and the siren is sounding',
      details: { neutraliser_pct: latest.neutraliser_pct },
    });
  }

  if (latest.estop) {
    out.push({
      type: 'estop_active',
      severity: 'critical',
      message: 'Emergency stop is active — all valves shut, all pumps stopped',
      details: { state: latest.state },
    });
  }

  if (ctx.interlockViolation) {
    out.push({
      type: 'interlock_violation',
      severity: 'critical',
      message: `Interlock blocked an unsafe action: ${ctx.interlockViolation.reason}`,
      details: { ...ctx.interlockViolation },
    });
  }

  if (ctx.heldSince) {
    const heldMs = now - Date.parse(ctx.heldSince);
    if (heldMs > HELD_ALARM_AFTER_MS) {
      out.push({
        type: 'batch_held',
        severity: 'critical',
        message: `A failed batch has been held in the chamber for ${Math.round(heldMs / 60000)} min — the treatment tank is full`,
        details: { held_since: ctx.heldSince, tank_l: latest.tank_l, tank_cap_l: latest.tank_cap_l },
      });
    }
  }

  const fault = sensorFault(ctx);
  if (fault) out.push(fault);

  // -------------------------------------------------------------- warning ---

  if (latest.neutraliser_pct > 0 && latest.neutraliser_pct < config.neutraliserLowPct) {
    out.push({
      type: 'neutraliser_low',
      severity: 'warning',
      message: `Neutraliser down to ${latest.neutraliser_pct.toFixed(0)}% — below the ${config.neutraliserLowPct}% reorder level`,
      details: { neutraliser_pct: latest.neutraliser_pct, low_pct: config.neutraliserLowPct },
    });
  }

  if (latest.ph > config.phWarnMax) {
    out.push({
      type: 'ph_high_chamber',
      severity: 'warning',
      message: `Chamber pH ${latest.ph.toFixed(2)} is above the ${config.phWarnMax} alkaline limit — check for over-dosing upstream`,
      details: { ph: latest.ph, ph_warn_max: config.phWarnMax },
    });
  }

  if (latest.tank_ph > config.phWarnMax) {
    out.push({
      type: 'ph_high_tank',
      severity: 'warning',
      message: `Treatment tank pH ${latest.tank_ph.toFixed(2)} is above ${config.phWarnMax} — over-dosed, V3 will stay locked until it is trimmed back`,
      details: { tank_ph: latest.tank_ph, ph_warn_max: config.phWarnMax },
    });
  }

  // The tank corrects pH only. A treated batch can still leave with high TDS,
  // so the dashboard watches what the plant cannot fix.
  if (ctx.lastCycle?.released_at && ctx.lastCycle.end_tds != null && ctx.lastCycle.end_tds > config.tdsMax) {
    out.push({
      type: 'tank_tds_high',
      severity: 'warning',
      message: `Treated water released at ${ctx.lastCycle.end_tds} mg/L TDS, above the ${config.tdsMax} limit — the tank neutralises pH but does not remove salts`,
      details: { end_tds: ctx.lastCycle.end_tds, tds_max: config.tdsMax, released_at: ctx.lastCycle.released_at },
    });
  }

  if (ctx.recentBatches.length >= PASS_RATE_WINDOW) {
    const window = ctx.recentBatches.slice(0, PASS_RATE_WINDOW);
    const passed = window.filter((b) => b.result === 'PASS').length;
    const rate = passed / window.length;
    if (rate < PASS_RATE_FLOOR) {
      out.push({
        type: 'pass_rate_low',
        severity: 'warning',
        message: `Only ${passed} of the last ${window.length} batches passed (${Math.round(rate * 100)}%) — inflow quality has deteriorated`,
        details: { passed, of: window.length, rate: Math.round(rate * 100) / 100 },
      });
    }
  }

  if (ctx.calibrationOverdue) {
    const days = Math.floor((now - Date.parse(ctx.calibrationOverdue.next_due_at)) / 86_400_000);
    out.push({
      type: 'calibration_overdue',
      severity: 'warning',
      message: `${ctx.calibrationOverdue.component} calibration is ${days} day${days === 1 ? '' : 's'} overdue — readings may be drifting`,
      details: { ...ctx.calibrationOverdue, days_overdue: days },
    });
  }

  if (latest.wifi_rssi < WIFI_WEAK_RSSI) {
    out.push({
      type: 'wifi_weak',
      severity: 'warning',
      message: `Weak WiFi signal (${latest.wifi_rssi} dBm) — telemetry may be delayed. The plant keeps running offline`,
      details: { wifi_rssi: latest.wifi_rssi },
    });
  }

  return out;
}

/**
 * A probe that has not moved at all for five minutes while a pump is running
 * is almost certainly disconnected or fouled — real water never holds a
 * reading that perfectly. A reading outside the physical range is a fault
 * outright.
 */
function sensorFault(ctx: AlarmContext): AlarmCandidate | null {
  const { latest, window, now } = ctx;
  if (!latest) return null;

  if (latest.ph < PH_RANGE[0] || latest.ph > PH_RANGE[1]) {
    return {
      type: 'sensor_fault', severity: 'critical',
      message: `pH probe reading ${latest.ph} is outside the physical range 0–14 — probe fault`,
      details: { sensor: 'ph', value: latest.ph },
    };
  }
  if (latest.tds < TDS_RANGE[0] || latest.tds > TDS_RANGE[1]) {
    return {
      type: 'sensor_fault', severity: 'critical',
      message: `TDS probe reading ${latest.tds} mg/L is outside the physical range 0–5000 — probe fault`,
      details: { sensor: 'tds', value: latest.tds },
    };
  }

  const span = window.filter((s) => now - Date.parse(s.ts) <= STUCK_SENSOR_AFTER_MS);
  if (span.length < 10) return null;

  const oldest = Date.parse(span[0].ts);
  if (now - oldest < STUCK_SENSOR_AFTER_MS) return null;

  const pumping = span.some((s) => s.sump_pump || s.dosing_pump);
  if (!pumping) return null;

  for (const sensor of ['ph', 'tds'] as const) {
    const values = span.map((s) => Number(s[sensor]));
    const flat = values.every((v) => v === values[0]);
    if (flat) {
      return {
        type: 'sensor_fault', severity: 'critical',
        message: `${sensor.toUpperCase()} probe has not moved from ${values[0]} for ${Math.round(STUCK_SENSOR_AFTER_MS / 60000)} minutes while pumps were running — suspected probe fault`,
        details: { sensor, value: values[0], samples: span.length },
      };
    }
  }
  return null;
}

/** What to raise and what to clear, given what is already open. */
export function reconcile(active: AlarmCandidate[], existing: ExistingAlarm[]) {
  const activeTypes = new Set(active.map((a) => a.type));
  const openTypes = new Set(existing.map((a) => a.type));

  return {
    toRaise: active.filter((a) => !openTypes.has(a.type)),
    toClear: existing.filter((a) => !activeTypes.has(a.type) && RULE_TYPES.includes(a.type as any)),
  };
}

/** An unacknowledged critical alarm escalates to site admins after 10 minutes. */
export function shouldEscalate(alarm: ExistingAlarm, now: number): boolean {
  if (alarm.severity !== 'critical') return false;
  if (alarm.acknowledged_at) return false;
  if (alarm.escalated) return false;
  return now - Date.parse(alarm.raised_at) >= ESCALATE_AFTER_MS;
}

/** Info-level notifications raised from records rather than from conditions. */
export function batchInfoAlarm(batch: { batch_no: number; result: string; destination: string; avg_ph: number; avg_tds: number; fail_reason: string | null }): AlarmCandidate | null {
  if (batch.result === 'PASS') return null;
  return {
    type: `batch_failed`,
    severity: 'info',
    message: `Batch ${batch.batch_no} ${batch.result === 'HELD' ? 'held' : 'diverted'}: pH ${batch.avg_ph}, TDS ${batch.avg_tds} mg/L (${batch.fail_reason})`,
    details: { ...batch },
  };
}

export function cycleInfoAlarm(cycle: { cycle_no: number; end_ph: number | null; volume_released_l: number | null }): AlarmCandidate {
  return {
    type: 'treatment_complete',
    severity: 'info',
    message: `Treatment cycle ${cycle.cycle_no} released ${cycle.volume_released_l ?? 0} L at pH ${cycle.end_ph ?? '—'}`,
    details: { ...cycle },
  };
}
