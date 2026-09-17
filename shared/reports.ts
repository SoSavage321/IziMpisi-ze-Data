/**
 * Compliance report calculations.
 *
 * These numbers go to an environmental officer and may end up in front of a
 * regulator, so they are computed from the batch and cycle records — the
 * device's own account of what it did — and never from telemetry averages.
 * Every figure here can be traced back to a row in the batch register.
 */

import { ControllerConfig } from './types.ts';

export interface ReportBatch {
  batch_no: number;
  started_at: string;
  avg_ph: number | null;
  avg_tds: number | null;
  result: 'PASS' | 'FAIL' | 'HELD';
  destination: 'RIVER' | 'TANK' | 'HELD';
  volume_l: number;
  fail_reason: string | null;
}

export interface ReportCycle {
  cycle_no: number;
  started_at: string;
  released_at: string | null;
  start_ph: number | null;
  end_ph: number | null;
  end_tds: number | null;
  neutraliser_used_pct: number | null;
  volume_released_l: number | null;
}

export interface ReportAlarm {
  type: string;
  severity: string;
  message: string;
  raised_at: string;
  acknowledged_at: string | null;
  ack_note: string | null;
  cleared_at: string | null;
  escalated: boolean;
}

export interface ReportConfigChange {
  version: number;
  created_at: string;
  reason: string | null;
  changed_by: string | null;
  ph_min: number;
  ph_max: number;
  tds_max: number;
}

export interface ReportCalibration {
  component: string;
  last_done_at: string | null;
  next_due_at: string | null;
  overdue: boolean;
}

export interface Stats {
  n: number;
  min: number | null;
  avg: number | null;
  max: number | null;
}

export function stats(values: Array<number | null | undefined>): Stats {
  const v = values.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  if (v.length === 0) return { n: 0, min: null, avg: null, max: null };
  const sum = v.reduce((a, b) => a + b, 0);
  return {
    n: v.length,
    min: Math.min(...v),
    avg: Math.round((sum / v.length) * 100) / 100,
    max: Math.max(...v),
  };
}

export interface VolumeSummary {
  /** Passed the test and went straight out through V1. */
  direct_to_river_l: number;
  /** Treated in the tank and released through V3. */
  treated_released_l: number;
  /** Everything that reached the river, however it got there. */
  total_to_river_l: number;
  /** Failed the test and was kept out of the river. */
  blocked_l: number;
  /** Still held in the chamber because the tank was full. */
  held_l: number;
  /** True only when the device reports a real flow meter. */
  measured: boolean;
}

export function summariseVolumes(
  batches: ReportBatch[],
  cycles: ReportCycle[],
  flowSensor: boolean,
): VolumeSummary {
  const direct = sum(batches.filter((b) => b.destination === 'RIVER').map((b) => b.volume_l));
  const blocked = sum(batches.filter((b) => b.destination !== 'RIVER').map((b) => b.volume_l));
  const held = sum(batches.filter((b) => b.destination === 'HELD').map((b) => b.volume_l));
  const treated = sum(cycles.filter((c) => c.released_at).map((c) => c.volume_released_l ?? 0));
  return {
    direct_to_river_l: round1(direct),
    treated_released_l: round1(treated),
    total_to_river_l: round1(direct + treated),
    blocked_l: round1(blocked),
    held_l: round1(held),
    measured: flowSensor,
  };
}

export interface QualitySummary {
  discharged_batches: number;
  ph: Stats;
  tds: Stats;
  treated_release_ph: Stats;
  treated_release_tds: Stats;
}

export function summariseQuality(batches: ReportBatch[], cycles: ReportCycle[]): QualitySummary {
  const discharged = batches.filter((b) => b.destination === 'RIVER');
  const released = cycles.filter((c) => c.released_at);
  return {
    discharged_batches: discharged.length,
    ph: stats(discharged.map((b) => b.avg_ph)),
    tds: stats(discharged.map((b) => b.avg_tds)),
    treated_release_ph: stats(released.map((c) => c.end_ph)),
    treated_release_tds: stats(released.map((c) => c.end_tds)),
  };
}

export interface ComplianceStatement {
  /** True when nothing reached the river without passing the test first. */
  compliant: boolean;
  statement: string;
  /** Batches that reached the river without a clean pass — should be empty. */
  exceptions: Array<{ batch_no: number; reason: string }>;
  /** Treated releases that left above the TDS limit — a known plant limitation. */
  tds_exceedances: Array<{ cycle_no: number; end_tds: number }>;
}

/**
 * The headline claim of the report: no untested water was released.
 *
 * It is computed, not asserted. Every batch that went to the river must carry
 * a recorded pH and TDS reading and must satisfy the pass rule that was in
 * force. Anything else is listed as an exception, and the statement flips.
 */
export function noUntestedWaterStatement(
  batches: ReportBatch[],
  cycles: ReportCycle[],
  config: Pick<ControllerConfig, 'phMin' | 'phMax' | 'tdsMax'>,
): ComplianceStatement {
  const exceptions: ComplianceStatement['exceptions'] = [];

  for (const b of batches) {
    if (b.destination !== 'RIVER') continue;
    if (b.avg_ph == null || b.avg_tds == null) {
      exceptions.push({ batch_no: b.batch_no, reason: 'released without a recorded probe reading' });
      continue;
    }
    if (b.result !== 'PASS') {
      exceptions.push({ batch_no: b.batch_no, reason: `released with result ${b.result}` });
      continue;
    }
    if (b.avg_ph < config.phMin) {
      exceptions.push({ batch_no: b.batch_no, reason: `released at pH ${b.avg_ph}, below the ${config.phMin} floor` });
    } else if (b.avg_ph > config.phMax) {
      exceptions.push({ batch_no: b.batch_no, reason: `released at pH ${b.avg_ph}, above the ${config.phMax} ceiling` });
    } else if (b.avg_tds > config.tdsMax) {
      exceptions.push({ batch_no: b.batch_no, reason: `released at ${b.avg_tds} mg/L TDS, above the ${config.tdsMax} limit` });
    }
  }

  const tds_exceedances = cycles
    .filter((c) => c.released_at && c.end_tds != null && c.end_tds > config.tdsMax)
    .map((c) => ({ cycle_no: c.cycle_no, end_tds: c.end_tds as number }));

  const discharged = batches.filter((b) => b.destination === 'RIVER').length;
  const compliant = exceptions.length === 0;

  const statement = compliant
    ? `All ${discharged} batch${discharged === 1 ? '' : 'es'} discharged to the river in this period were tested before release and met the discharge limits in force ` +
      `(pH ${config.phMin}–${config.phMax}, TDS ≤ ${config.tdsMax} mg/L). No untested water was released.`
    : `${exceptions.length} batch${exceptions.length === 1 ? '' : 'es'} reached the river without satisfying the discharge limits in force. ` +
      `This is a reportable exception and is itemised below.`;

  return { compliant, statement, exceptions, tds_exceedances };
}

export interface IncidentSummary {
  total: number;
  critical: number;
  warning: number;
  unacknowledged: number;
  escalated: number;
  /** Median minutes from raised to acknowledged, for alarms that were. */
  median_ack_minutes: number | null;
}

export function summariseIncidents(alarms: ReportAlarm[]): IncidentSummary {
  const acked = alarms
    .filter((a) => a.acknowledged_at)
    .map((a) => (Date.parse(a.acknowledged_at as string) - Date.parse(a.raised_at)) / 60000)
    .sort((a, b) => a - b);

  return {
    total: alarms.length,
    critical: alarms.filter((a) => a.severity === 'critical').length,
    warning: alarms.filter((a) => a.severity === 'warning').length,
    unacknowledged: alarms.filter((a) => !a.acknowledged_at).length,
    escalated: alarms.filter((a) => a.escalated).length,
    median_ack_minutes: acked.length ? Math.round(median(acked) * 10) / 10 : null,
  };
}

export interface ComplianceReport {
  site: string;
  device: string;
  from: string;
  to: string;
  generated_at: string;
  volumes: VolumeSummary;
  quality: QualitySummary;
  batches_tested: number;
  batches_failed_caught: number;
  treated_releases: number;
  compliance: ComplianceStatement;
  incidents: IncidentSummary;
  alarms: ReportAlarm[];
  config_changes: ReportConfigChange[];
  calibration: ReportCalibration[];
}

export function buildComplianceReport(input: {
  site: string;
  device: string;
  from: string;
  to: string;
  generatedAt?: string;
  batches: ReportBatch[];
  cycles: ReportCycle[];
  alarms: ReportAlarm[];
  configChanges: ReportConfigChange[];
  calibration: ReportCalibration[];
  config: Pick<ControllerConfig, 'phMin' | 'phMax' | 'tdsMax'>;
  flowSensor: boolean;
}): ComplianceReport {
  return {
    site: input.site,
    device: input.device,
    from: input.from,
    to: input.to,
    generated_at: input.generatedAt ?? new Date().toISOString(),
    volumes: summariseVolumes(input.batches, input.cycles, input.flowSensor),
    quality: summariseQuality(input.batches, input.cycles),
    batches_tested: input.batches.length,
    batches_failed_caught: input.batches.filter((b) => b.result !== 'PASS').length,
    treated_releases: input.cycles.filter((c) => c.released_at).length,
    compliance: noUntestedWaterStatement(input.batches, input.cycles, input.config),
    incidents: summariseIncidents(input.alarms),
    alarms: input.alarms,
    config_changes: input.configChanges,
    calibration: input.calibration,
  };
}

/** Neutraliser litres per litre treated, and what that costs. */
export function chemicalUsage(
  cycles: ReportCycle[],
  reservoirLitres: number,
  costPerLitre: number,
): { litres_used: number; litres_treated: number; litres_per_litre: number | null; cost: number } {
  const pct = sum(cycles.map((c) => c.neutraliser_used_pct ?? 0));
  const treated = sum(cycles.map((c) => c.volume_released_l ?? 0));
  const used = (pct / 100) * reservoirLitres;
  return {
    litres_used: round2(used),
    litres_treated: round1(treated),
    litres_per_litre: treated > 0 ? round4(used / treated) : null,
    cost: round2(used * costPerLitre),
  };
}

/** Days of neutraliser left at the recent burn rate. */
export function daysOfStockLeft(stockLitres: number, litresPerDay: number): number | null {
  if (litresPerDay <= 0) return null;
  return Math.round((stockLitres / litresPerDay) * 10) / 10;
}

function sum(v: number[]): number { return v.reduce((a, b) => a + b, 0); }
function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function round1(n: number) { return Math.round(n * 10) / 10; }
function round2(n: number) { return Math.round(n * 100) / 100; }
function round4(n: number) { return Math.round(n * 10000) / 10000; }
