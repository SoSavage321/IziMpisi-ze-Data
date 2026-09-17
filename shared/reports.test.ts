import { describe, it, expect } from 'vitest';
import {
  ReportBatch,
  ReportCycle,
  buildComplianceReport,
  chemicalUsage,
  daysOfStockLeft,
  noUntestedWaterStatement,
  stats,
  summariseIncidents,
  summariseQuality,
  summariseVolumes,
} from './reports.ts';

const LIMITS = { phMin: 6.5, phMax: 8.5, tdsMax: 1200 };

function batch(patch: Partial<ReportBatch> = {}): ReportBatch {
  return {
    batch_no: 1,
    started_at: '2026-09-17T06:00:00Z',
    avg_ph: 7.0,
    avg_tds: 420,
    result: 'PASS',
    destination: 'RIVER',
    volume_l: 100,
    fail_reason: null,
    ...patch,
  };
}

function cycle(patch: Partial<ReportCycle> = {}): ReportCycle {
  return {
    cycle_no: 1,
    started_at: '2026-09-17T06:10:00Z',
    released_at: '2026-09-17T06:18:00Z',
    start_ph: 4.2,
    end_ph: 7.1,
    end_tds: 600,
    neutraliser_used_pct: 4,
    volume_released_l: 100,
    ...patch,
  };
}

describe('stats', () => {
  it('ignores nulls and reports n, min, avg, max', () => {
    expect(stats([6.8, null, 7.2, undefined, 7.0])).toEqual({ n: 3, min: 6.8, avg: 7, max: 7.2 });
  });

  it('returns nulls rather than NaN for an empty set', () => {
    expect(stats([])).toEqual({ n: 0, min: null, avg: null, max: null });
  });
});

describe('volumes', () => {
  const batches = [
    batch({ batch_no: 1 }),
    batch({ batch_no: 2 }),
    batch({ batch_no: 3, result: 'FAIL', destination: 'TANK', fail_reason: 'ACID', avg_ph: 4.1 }),
    batch({ batch_no: 4, result: 'HELD', destination: 'HELD', fail_reason: 'TDS', avg_tds: 1500 }),
  ];

  it('separates what reached the river from what was blocked', () => {
    const v = summariseVolumes(batches, [cycle()], false);
    expect(v.direct_to_river_l).toBe(200);
    expect(v.treated_released_l).toBe(100);
    expect(v.total_to_river_l).toBe(300);
    expect(v.blocked_l).toBe(200);
    expect(v.held_l).toBe(100);
  });

  it('marks volumes as estimated unless a flow meter is fitted', () => {
    expect(summariseVolumes(batches, [], false).measured).toBe(false);
    expect(summariseVolumes(batches, [], true).measured).toBe(true);
  });

  it('does not count a treatment cycle that has not been released', () => {
    const v = summariseVolumes([], [cycle({ released_at: null, volume_released_l: null })], false);
    expect(v.treated_released_l).toBe(0);
  });
});

describe('quality of discharged water', () => {
  it('summarises only what actually went to the river', () => {
    const q = summariseQuality(
      [
        batch({ batch_no: 1, avg_ph: 6.8, avg_tds: 400 }),
        batch({ batch_no: 2, avg_ph: 7.4, avg_tds: 800 }),
        batch({ batch_no: 3, result: 'FAIL', destination: 'TANK', avg_ph: 3.1, avg_tds: 1900 }),
      ],
      [cycle({ end_ph: 7.1, end_tds: 620 })],
    );
    expect(q.discharged_batches).toBe(2);
    expect(q.ph.min).toBe(6.8);
    expect(q.ph.max).toBe(7.4);       // the pH 3.1 batch never reached the river
    expect(q.tds.max).toBe(800);
    expect(q.treated_release_ph.avg).toBe(7.1);
  });
});

describe('the "no untested water" statement', () => {
  it('is computed from the records, not asserted', () => {
    const s = noUntestedWaterStatement(
      [batch({ batch_no: 1 }), batch({ batch_no: 2, avg_ph: 8.4 })],
      [cycle()],
      LIMITS,
    );
    expect(s.compliant).toBe(true);
    expect(s.exceptions).toHaveLength(0);
    expect(s.statement).toMatch(/No untested water was released/);
    expect(s.statement).toMatch(/pH 6\.5–8\.5/);
  });

  it('flags a batch released above the alkaline ceiling', () => {
    const s = noUntestedWaterStatement([batch({ batch_no: 7, avg_ph: 9.1 })], [], LIMITS);
    expect(s.compliant).toBe(false);
    expect(s.exceptions[0]).toEqual({ batch_no: 7, reason: 'released at pH 9.1, above the 8.5 ceiling' });
    expect(s.statement).toMatch(/reportable exception/);
  });

  it('flags a batch released below the acid floor', () => {
    const s = noUntestedWaterStatement([batch({ batch_no: 8, avg_ph: 5.4 })], [], LIMITS);
    expect(s.exceptions[0].reason).toMatch(/below the 6.5 floor/);
  });

  it('flags a batch released with no reading at all', () => {
    const s = noUntestedWaterStatement([batch({ batch_no: 9, avg_ph: null, avg_tds: null })], [], LIMITS);
    expect(s.exceptions[0].reason).toMatch(/without a recorded probe reading/);
  });

  it('flags a batch that reached the river without passing', () => {
    const s = noUntestedWaterStatement(
      [batch({ batch_no: 10, result: 'FAIL', destination: 'RIVER' })], [], LIMITS);
    expect(s.exceptions[0].reason).toMatch(/released with result FAIL/);
  });

  it('ignores failed batches that were correctly diverted', () => {
    const s = noUntestedWaterStatement(
      [batch({ batch_no: 11, result: 'FAIL', destination: 'TANK', avg_ph: 3.0, avg_tds: 1800 })],
      [], LIMITS);
    expect(s.compliant).toBe(true);
  });

  // The tank neutralises pH but does not remove salts — reported separately
  // because it is a plant limitation, not a breach of the release rule.
  it('lists treated releases over the TDS limit without failing compliance', () => {
    const s = noUntestedWaterStatement([], [cycle({ end_tds: 1400 })], LIMITS);
    expect(s.compliant).toBe(true);
    expect(s.tds_exceedances).toEqual([{ cycle_no: 1, end_tds: 1400 }]);
  });
});

describe('incidents', () => {
  const alarm = (patch: any = {}) => ({
    type: 'neutraliser_empty', severity: 'critical',
    message: 'empty', raised_at: '2026-09-17T06:00:00Z',
    acknowledged_at: '2026-09-17T06:04:00Z', ack_note: 'refilled', cleared_at: null, escalated: false,
    ...patch,
  });

  it('counts by severity and reports the median acknowledgement time', () => {
    const s = summariseIncidents([
      alarm(),
      alarm({ acknowledged_at: '2026-09-17T06:10:00Z' }),
      alarm({ severity: 'warning', acknowledged_at: null }),
      alarm({ severity: 'critical', acknowledged_at: null, escalated: true }),
    ]);
    expect(s.total).toBe(4);
    expect(s.critical).toBe(3);
    expect(s.warning).toBe(1);
    expect(s.unacknowledged).toBe(2);
    expect(s.escalated).toBe(1);
    expect(s.median_ack_minutes).toBe(7);     // median of 4 and 10
  });

  it('reports null rather than zero when nothing was acknowledged', () => {
    expect(summariseIncidents([alarm({ acknowledged_at: null })]).median_ack_minutes).toBeNull();
  });
});

describe('chemical usage and stock', () => {
  it('converts reservoir percentage into litres and cost', () => {
    const u = chemicalUsage([cycle({ neutraliser_used_pct: 5 }), cycle({ cycle_no: 2, neutraliser_used_pct: 5 })], 20, 48);
    expect(u.litres_used).toBe(2);            // 10% of a 20 L drum
    expect(u.litres_treated).toBe(200);
    expect(u.litres_per_litre).toBe(0.01);
    expect(u.cost).toBe(96);
  });

  it('does not divide by zero when nothing was treated', () => {
    expect(chemicalUsage([], 20, 48).litres_per_litre).toBeNull();
  });

  it('estimates days of stock left', () => {
    expect(daysOfStockLeft(60, 4)).toBe(15);
    expect(daysOfStockLeft(60, 0)).toBeNull();
  });
});

describe('the assembled compliance report', () => {
  it('carries every section an environmental officer has to sign off', () => {
    const report = buildComplianceReport({
      site: 'Kusile — sump 3',
      device: 'WG-01',
      from: '2026-09-10T00:00:00Z',
      to: '2026-09-17T00:00:00Z',
      generatedAt: '2026-09-17T08:00:00Z',
      batches: [batch({ batch_no: 1 }), batch({ batch_no: 2, result: 'FAIL', destination: 'TANK', fail_reason: 'ACID', avg_ph: 4.0 })],
      cycles: [cycle()],
      alarms: [],
      configChanges: [{ version: 2, created_at: '2026-09-12T09:00:00Z', reason: 'Tightened after audit', changed_by: 'T. Mokoena', ph_min: 6.5, ph_max: 8.5, tds_max: 1200 }],
      calibration: [{ component: 'pH probe', last_done_at: '2026-09-01T00:00:00Z', next_due_at: '2026-10-01T00:00:00Z', overdue: false }],
      config: LIMITS,
      flowSensor: false,
    });

    expect(report.batches_tested).toBe(2);
    expect(report.batches_failed_caught).toBe(1);
    expect(report.treated_releases).toBe(1);
    expect(report.volumes.total_to_river_l).toBe(200);
    expect(report.volumes.measured).toBe(false);
    expect(report.compliance.compliant).toBe(true);
    expect(report.config_changes).toHaveLength(1);
    expect(report.calibration[0].overdue).toBe(false);
  });
});
