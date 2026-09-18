import { describe, it, expect } from 'vitest';
import {
  AlarmContext,
  ExistingAlarm,
  evaluateAlarms,
  reconcile,
  shouldEscalate,
  batchInfoAlarm,
  ESCALATE_AFTER_MS,
} from './alarms.ts';
import { DEFAULT_CONFIG, TelemetrySample } from './types.ts';

const NOW = Date.parse('2026-09-17T08:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function sample(patch: Partial<TelemetrySample> = {}): TelemetrySample {
  return {
    ts: ago(1000),
    state: 'FILL', mode: 'AUTO', estop: false,
    ph: 7.0, tds: 420,
    chamber_l: 40, tank_l: 0, tank_cap_l: 300, tank_ph: 7.0, tank_tds: 400,
    neutraliser_pct: 80,
    v1: false, v2: false, v3: false,
    sump_pump: true, dosing_pump: false, siren: false, led: 'off',
    wifi_rssi: -58, uptime_s: 3600,
    ...patch,
  };
}

function ctx(patch: Partial<AlarmContext> = {}): AlarmContext {
  const latest = patch.latest === undefined ? sample() : patch.latest;
  return {
    now: NOW,
    device: { id: 'd1', name: 'Sump 3 controller', last_seen: ago(4000), flow_sensor: false },
    config: DEFAULT_CONFIG,
    latest,
    window: [],
    recentBatches: [],
    heldSince: null,
    ...patch,
    ...(patch.latest === undefined ? { latest } : {}),
  };
}

const types = (c: AlarmContext) => evaluateAlarms(c).map((a) => a.type);

describe('critical rules', () => {
  it('raises device_offline past 60 s and stops reading stale telemetry', () => {
    const out = evaluateAlarms(ctx({ device: { id: 'd1', name: 'Sump 3', last_seen: ago(95_000), flow_sensor: false } }));
    expect(out.map((a) => a.type)).toEqual(['device_offline']);
    expect(out[0].severity).toBe('critical');
    expect(out[0].message).toMatch(/95 s/);
  });

  it('does not raise device_offline inside the window', () => {
    expect(types(ctx({ device: { id: 'd1', name: 'Sump 3', last_seen: ago(30_000), flow_sensor: false } })))
      .not.toContain('device_offline');
  });

  it('treats a device that has never reported as offline', () => {
    const out = evaluateAlarms(ctx({ device: { id: 'd1', name: 'Sump 3', last_seen: null, flow_sensor: false } }));
    expect(out[0].type).toBe('device_offline');
    expect(out[0].message).toMatch(/never reported/);
  });

  it('raises neutraliser_empty at zero', () => {
    expect(types(ctx({ latest: sample({ neutraliser_pct: 0 }) }))).toContain('neutraliser_empty');
  });

  it('raises estop_active while the E-stop is engaged', () => {
    expect(types(ctx({ latest: sample({ estop: true, state: 'ESTOP' }) }))).toContain('estop_active');
  });

  it('raises interlock_violation when the device reports a block', () => {
    const out = evaluateAlarms(ctx({ interlockViolation: { reason: 'V3 requested while V2 open' } }));
    expect(out.find((a) => a.type === 'interlock_violation')?.message).toMatch(/V3 requested while V2 open/);
  });

  it('raises batch_held only after 10 minutes', () => {
    expect(types(ctx({ heldSince: ago(9 * 60_000), latest: sample({ state: 'HOLD' }) }))).not.toContain('batch_held');
    expect(types(ctx({ heldSince: ago(11 * 60_000), latest: sample({ state: 'HOLD' }) }))).toContain('batch_held');
  });
});

describe('sensor fault detection', () => {
  const stuckWindow = (value: number, pumping: boolean) =>
    Array.from({ length: 60 }, (_, n) =>
      sample({ ts: ago(6 * 60_000 - n * 5_000), ph: value, sump_pump: pumping }));

  it('flags a probe that has not moved for 5 minutes while pumping', () => {
    const out = evaluateAlarms(ctx({ window: stuckWindow(7.0, true), latest: sample({ ph: 7.0 }) }));
    const fault = out.find((a) => a.type === 'sensor_fault');
    expect(fault?.severity).toBe('critical');
    expect(fault?.message).toMatch(/has not moved/);
  });

  it('does not flag a flat reading when nothing is running', () => {
    expect(types(ctx({ window: stuckWindow(7.0, false) }))).not.toContain('sensor_fault');
  });

  it('does not flag probes that are moving', () => {
    // both probes have to move: a rock-steady TDS reading while the sump pump
    // is running is exactly the fault this rule is looking for
    const moving = Array.from({ length: 60 }, (_, n) =>
      sample({ ts: ago(6 * 60_000 - n * 5_000), ph: 7 + n * 0.01, tds: 420 + n, sump_pump: true }));
    expect(types(ctx({ window: moving }))).not.toContain('sensor_fault');
  });

  it('flags a reading outside the physical range immediately', () => {
    const out = evaluateAlarms(ctx({ latest: sample({ ph: 15.2 }) }));
    expect(out.find((a) => a.type === 'sensor_fault')?.message).toMatch(/outside the physical range/);
  });
});

describe('warning rules', () => {
  it('raises stock_out when the store is empty, whatever the drum reads', () => {
    const empty = { item: 'neutraliser (hydrated lime slurry)', stock: 0, reorder_level: 120, unit: 'L' };
    // The drum on the plant is nearly full; the store behind it is not.
    const t = types(ctx({ latest: sample({ neutraliser_pct: 80 }), siteStock: empty }));
    expect(t).toContain('stock_out');
    expect(t).not.toContain('stock_low');
  });

  it('warns on stock_low below the reorder level', () => {
    const low = { item: 'neutraliser (hydrated lime slurry)', stock: 85, reorder_level: 120, unit: 'L' };
    const t = types(ctx({ siteStock: low }));
    expect(t).toContain('stock_low');
    expect(t).not.toContain('stock_out');
  });

  it('stays quiet when the store is above the reorder level', () => {
    const ok = { item: 'neutraliser (hydrated lime slurry)', stock: 340, reorder_level: 120, unit: 'L' };
    const t = types(ctx({ siteStock: ok }));
    expect(t).not.toContain('stock_low');
    expect(t).not.toContain('stock_out');
  });

  it('still reports an empty store while the device is offline', () => {
    // Stock is a fact about the store, not a reading, so a dead controller
    // must not be able to hide it.
    const t = types(ctx({
      device: { id: 'd1', name: 'Sump 3 controller', last_seen: ago(120_000), flow_sensor: false },
      siteStock: { item: 'neutraliser (hydrated lime slurry)', stock: 0, reorder_level: 120, unit: 'L' },
    }));
    expect(t).toContain('device_offline');
    expect(t).toContain('stock_out');
  });

  it('says nothing about stock when no figure is supplied', () => {
    const t = types(ctx());
    expect(t).not.toContain('stock_low');
    expect(t).not.toContain('stock_out');
  });

  it('warns below the neutraliser reorder level but not at zero', () => {
    expect(types(ctx({ latest: sample({ neutraliser_pct: 15 }) }))).toContain('neutraliser_low');
    const empty = types(ctx({ latest: sample({ neutraliser_pct: 0 }) }));
    expect(empty).toContain('neutraliser_empty');
    expect(empty).not.toContain('neutraliser_low');    // the critical one supersedes it
  });

  // The documented limitation: the plant has no upper pH limit in the original
  // pass rule, so the dashboard watches for over-dosing regardless.
  it('warns when chamber pH goes above the alkaline limit', () => {
    expect(types(ctx({ latest: sample({ ph: 8.9 }) }))).toContain('ph_high_chamber');
    expect(types(ctx({ latest: sample({ ph: 8.4 }) }))).not.toContain('ph_high_chamber');
  });

  it('warns when the treatment tank is over-dosed', () => {
    const out = evaluateAlarms(ctx({ latest: sample({ tank_ph: 9.1, tank_l: 200 }) }));
    expect(out.find((a) => a.type === 'ph_high_tank')?.message).toMatch(/V3 will stay locked/);
  });

  // The other documented limitation: the tank corrects pH only.
  it('warns when treated water is released above the TDS limit', () => {
    const out = evaluateAlarms(ctx({ lastCycle: { end_tds: 1450, released_at: ago(30_000) } }));
    const a = out.find((x) => x.type === 'tank_tds_high');
    expect(a?.severity).toBe('warning');
    expect(a?.message).toMatch(/does not remove salts/);
  });

  it('warns when the pass rate drops below half over 20 batches', () => {
    const fail = { result: 'FAIL', started_at: ago(60_000) };
    const pass = { result: 'PASS', started_at: ago(60_000) };
    const bad = [...Array(12).fill(fail), ...Array(8).fill(pass)];
    const good = [...Array(8).fill(fail), ...Array(12).fill(pass)];
    expect(types(ctx({ recentBatches: bad }))).toContain('pass_rate_low');
    expect(types(ctx({ recentBatches: good }))).not.toContain('pass_rate_low');
  });

  it('does not judge the pass rate on fewer than 20 batches', () => {
    const fail = { result: 'FAIL', started_at: ago(60_000) };
    expect(types(ctx({ recentBatches: Array(19).fill(fail) }))).not.toContain('pass_rate_low');
  });

  it('warns on overdue calibration and says how overdue', () => {
    const out = evaluateAlarms(ctx({
      calibrationOverdue: { component: 'pH probe', next_due_at: ago(3 * 86_400_000) },
    }));
    expect(out.find((a) => a.type === 'calibration_overdue')?.message).toMatch(/3 days overdue/);
  });

  it('warns on weak WiFi but says the plant keeps running', () => {
    const out = evaluateAlarms(ctx({ latest: sample({ wifi_rssi: -87 }) }));
    expect(out.find((a) => a.type === 'wifi_weak')?.message).toMatch(/keeps running offline/);
  });
});

describe('reconciliation and duplicate suppression', () => {
  const open = (type: string, severity: any = 'critical'): ExistingAlarm => ({
    id: `a-${type}`, type, severity, raised_at: ago(60_000), acknowledged_at: null, escalated: false,
  });

  it('raises only what is not already open', () => {
    const active = evaluateAlarms(ctx({ latest: sample({ neutraliser_pct: 0 }) }));
    const { toRaise } = reconcile(active, [open('neutraliser_empty')]);
    expect(toRaise).toHaveLength(0);
  });

  it('clears an alarm once its condition goes away', () => {
    const active = evaluateAlarms(ctx());                     // everything healthy
    const { toClear } = reconcile(active, [open('neutraliser_empty')]);
    expect(toClear.map((a) => a.type)).toEqual(['neutraliser_empty']);
  });

  it('never clears an alarm type it does not own', () => {
    const { toClear } = reconcile([], [open('manually_raised_by_someone')]);
    expect(toClear).toHaveLength(0);
  });
});

describe('escalation', () => {
  const alarm = (patch: Partial<ExistingAlarm> = {}): ExistingAlarm => ({
    id: 'a1', type: 'neutraliser_empty', severity: 'critical',
    raised_at: ago(ESCALATE_AFTER_MS + 1000), acknowledged_at: null, escalated: false,
    ...patch,
  });

  it('escalates an unacknowledged critical after 10 minutes', () => {
    expect(shouldEscalate(alarm(), NOW)).toBe(true);
  });

  it('does not escalate once acknowledged', () => {
    expect(shouldEscalate(alarm({ acknowledged_at: ago(60_000) }), NOW)).toBe(false);
  });

  it('does not escalate twice', () => {
    expect(shouldEscalate(alarm({ escalated: true }), NOW)).toBe(false);
  });

  it('does not escalate warnings', () => {
    expect(shouldEscalate(alarm({ severity: 'warning' }), NOW)).toBe(false);
  });

  it('does not escalate before the window is up', () => {
    expect(shouldEscalate(alarm({ raised_at: ago(5 * 60_000) }), NOW)).toBe(false);
  });
});

describe('info notifications', () => {
  it('reports a diverted batch and says why', () => {
    const a = batchInfoAlarm({
      batch_no: 42, result: 'FAIL', destination: 'TANK', avg_ph: 4.2, avg_tds: 600, fail_reason: 'ACID',
    });
    expect(a?.severity).toBe('info');
    expect(a?.message).toMatch(/Batch 42 diverted/);
  });

  it('says nothing about a batch that passed', () => {
    expect(batchInfoAlarm({
      batch_no: 43, result: 'PASS', destination: 'RIVER', avg_ph: 7.0, avg_tds: 400, fail_reason: null,
    })).toBeNull();
  });
});
