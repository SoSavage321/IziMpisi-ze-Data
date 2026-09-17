/**
 * Shared vocabulary for the WaterGuard system.
 *
 * This file is dependency-free on purpose: it is imported by the Vite app
 * (Node/browser), by Supabase edge functions (Deno) and by the simulator, and
 * it is the reference the ESP32 firmware structs are written against.
 */

export type PlantState =
  | 'BOOT'
  | 'FILL'
  | 'TEST'
  | 'DISCHARGE'
  | 'DIVERT'
  | 'TREAT'
  | 'CONFIRM'
  | 'RELEASE'
  | 'HOLD'
  | 'LOCKOUT'
  | 'ESTOP'
  | 'MAINTENANCE';

export type PlantMode = 'AUTO' | 'MANUAL' | 'MAINTENANCE';
export type Led = 'green' | 'red' | 'yellow' | 'off';

export type BatchResult = 'PASS' | 'FAIL' | 'HELD';
export type BatchDestination = 'RIVER' | 'TANK' | 'HELD';
export type FailReason = 'ACID' | 'ALKALINE' | 'TDS' | null;

export type CommandType =
  | 'EMERGENCY_STOP'
  | 'RESET_ESTOP'
  | 'SET_MODE'
  | 'MANUAL_VALVE'
  | 'MANUAL_PUMP'
  | 'START_BATCH'
  | 'PAUSE_INTAKE'
  | 'RESUME_INTAKE'
  | 'SILENCE_SIREN'
  | 'APPLY_CONFIG'
  | 'REQUEST_CALIBRATION_MODE';

export interface DeviceCommand {
  id: string;
  type: CommandType;
  payload?: Record<string, unknown>;
}

export interface CommandVerdict {
  id: string;
  accepted: boolean;
  /** The firmware's own words. Shown verbatim in the UI. */
  reason: string;
}

/** Thresholds and timings. Mirrors the device_config table. */
export interface ControllerConfig {
  version: number;
  phMin: number;
  /** Hard ceiling. Alkaline batches are diverted, not released. */
  phMax: number;
  tdsMax: number;
  treatTargetPh: number;
  testWindowS: number;
  stableWindowS: number;
  batchL: number;
  tankCapL: number;
  phWarnMax: number;
  neutraliserLowPct: number;
}

export const DEFAULT_CONFIG: ControllerConfig = {
  version: 1,
  phMin: 6.5,
  phMax: 8.5,
  tdsMax: 1200,
  treatTargetPh: 6.8,
  testWindowS: 3,
  stableWindowS: 3,
  batchL: 100,
  tankCapL: 300,
  phWarnMax: 8.5,
  neutraliserLowPct: 20,
};

/** What the probes and level sensors report to the controller each tick. */
export interface SensorInputs {
  ph: number;
  tds: number;
  tankPh: number;
  tankTds: number;
  neutraliserPct: number;
  /** Optional measured volumes; when absent the controller counts litres itself. */
  measuredChamberL?: number;
  measuredTankL?: number;
}

/** One telemetry sample. Matches the `telemetry` table column for column. */
export interface TelemetrySample {
  ts: string;
  state: PlantState;
  mode: PlantMode;
  estop: boolean;
  ph: number;
  tds: number;
  chamber_l: number;
  tank_l: number;
  tank_cap_l: number;
  tank_ph: number;
  tank_tds: number;
  neutraliser_pct: number;
  v1: boolean;
  v2: boolean;
  v3: boolean;
  sump_pump: boolean;
  dosing_pump: boolean;
  siren: boolean;
  led: Led;
  wifi_rssi: number;
  uptime_s: number;
}

export interface BatchRecord {
  batch_no: number;
  started_at: string;
  ended_at: string;
  avg_ph: number;
  avg_tds: number;
  result: BatchResult;
  destination: BatchDestination;
  volume_l: number;
  fail_reason: FailReason;
}

export interface TreatmentCycleRecord {
  cycle_no: number;
  started_at: string;
  released_at: string | null;
  start_ph: number;
  end_ph: number | null;
  end_tds: number | null;
  neutraliser_used_pct: number;
  volume_released_l: number | null;
}

export interface DeviceEvent {
  ts: string;
  type:
    | 'BOOT'
    | 'STATE_CHANGE'
    | 'VALVE'
    | 'PUMP'
    | 'INTERLOCK_BLOCK'
    | 'COMMAND'
    | 'CONFIG_APPLIED'
    | 'MODE_CHANGE';
  details: Record<string, unknown>;
}

/** The body the device POSTs to /ingest. */
export interface IngestPayload {
  device_id: string;
  firmware_version?: string;
  flow_sensor?: boolean;
  config_version?: number;
  telemetry?: TelemetrySample[];
  batches?: BatchRecord[];
  cycles?: TreatmentCycleRecord[];
  events?: DeviceEvent[];
  command_acks?: CommandVerdict[];
}
