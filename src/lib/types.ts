/** Row shapes as the dashboard consumes them. These mirror the SQL schema. */

export type Role = 'admin' | 'operator' | 'viewer';
export type Severity = 'info' | 'warning' | 'critical';
export type CommandStatus = 'pending' | 'accepted' | 'rejected' | 'expired';

export interface Site {
  id: string;
  org_id: string;
  name: string;
  location: string | null;
  latitude: number | null;
  longitude: number | null;
  mine_owner: string | null;
  timezone: string;
}

export interface Profile {
  user_id: string;
  org_id: string;
  full_name: string;
  phone: string | null;
  role: Role;
  email?: string | null;
}

export interface FleetRow {
  device_id: string;
  device_name: string;
  site_id: string;
  site_name: string;
  location: string | null;
  latitude: number | null;
  longitude: number | null;
  timezone: string;
  last_seen: string | null;
  firmware_version: string | null;
  flow_sensor: boolean;
  config_version: number;
  offline: boolean;
  state: string | null;
  mode: string | null;
  estop: boolean | null;
  ph: number | null;
  tds: number | null;
  neutraliser_pct: number | null;
  tank_l: number | null;
  tank_cap_l: number | null;
  v1: boolean | null;
  v2: boolean | null;
  v3: boolean | null;
  siren: boolean | null;
  led: string | null;
  active_alarms: number;
  critical_alarms: number;
  batches_today: number;
  passed_today: number;
  litres_to_river_today: number;
  litres_blocked_today: number;
}

export interface Telemetry {
  ts: string;
  state: string;
  mode: string;
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
  led: string;
  wifi_rssi: number;
  uptime_s: number;
  /**
   * Fields this device does not physically measure. The values above still
   * carry a number because the control logic needs one, but anything listed
   * here must be shown as unknown rather than reported as a reading.
   */
  unmeasured?: string[];
  /**
   * Readings a device takes that this schema has no column for — the bench
   * rig's contamination score, probe temperature and tank depth. Shown as
   * themselves rather than forced into a field that means something else.
   */
  extra?: Record<string, number | string | boolean>;
}

export interface Batch {
  id: string;
  device_id: string;
  batch_no: number;
  started_at: string;
  ended_at: string | null;
  avg_ph: number | null;
  avg_tds: number | null;
  result: 'PASS' | 'FAIL' | 'HELD';
  destination: 'RIVER' | 'TANK' | 'HELD';
  volume_l: number;
  fail_reason: string | null;
}

export interface TreatmentCycle {
  id: string;
  device_id: string;
  cycle_no: number;
  started_at: string;
  released_at: string | null;
  start_ph: number | null;
  end_ph: number | null;
  end_tds: number | null;
  neutraliser_used_pct: number | null;
  volume_released_l: number | null;
}

export interface Alarm {
  id: string;
  device_id: string;
  type: string;
  severity: Severity;
  message: string;
  details: Record<string, unknown>;
  raised_at: string;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  ack_note: string | null;
  cleared_at: string | null;
  escalated: boolean;
  escalated_at?: string | null;
  device_name?: string;
  site_name?: string;
}

export interface DeviceEventRow {
  id: number | string;
  device_id: string;
  ts: string;
  type: string;
  details: Record<string, unknown>;
}

export interface Command {
  id: string;
  device_id: string;
  requested_by: string | null;
  requested_by_name?: string;
  type: string;
  payload: Record<string, unknown>;
  status: CommandStatus;
  reason: string | null;
  created_at: string;
  expires_at: string;
  resolved_at: string | null;
}

export interface DeviceConfig {
  id: string;
  device_id: string;
  version: number;
  ph_min: number;
  ph_max: number;
  tds_max: number;
  treat_target_ph: number;
  test_window_s: number;
  stable_window_s: number;
  batch_l: number;
  tank_cap_l: number;
  ph_warn_max: number;
  neutraliser_low_pct: number;
  reason: string | null;
  created_by: string | null;
  created_by_name?: string;
  created_at: string;
  applied_at: string | null;
}

export interface MaintenanceItem {
  id: string;
  device_id: string;
  component: string;
  task: string;
  interval_days: number | null;
  last_done_at: string | null;
  next_due_at: string | null;
}

export interface MaintenanceLog {
  id: string;
  item_id: string | null;
  device_id: string;
  performed_by: string | null;
  performed_by_name?: string;
  performed_at: string;
  notes: string | null;
  before_values: Record<string, unknown>;
  after_values: Record<string, unknown>;
}

export interface InventoryItem {
  id: string;
  site_id: string;
  item: string;
  unit: string;
  stock: number;
  reorder_level: number;
  supplier: string | null;
  cost_per_unit: number | null;
  updated_at: string;
}

export interface InventoryMovement {
  id: string;
  inventory_id: string;
  delta: number;
  kind: string;
  note: string | null;
  created_by: string | null;
  created_by_name?: string;
  created_at: string;
}

export interface ShiftLog {
  id: string;
  site_id: string;
  author: string | null;
  author_name?: string;
  shift_start: string;
  shift_end: string | null;
  notes: string | null;
  handover_to: string | null;
  handover_to_name?: string;
  created_at: string;
}

export interface AuditRow {
  id: number | string;
  actor: string | null;
  actor_name?: string;
  action: string;
  target_table: string;
  target_id: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ts: string;
}

export interface DutyCounters {
  sump_run_hours: number;
  dosing_run_hours: number;
  v1_cycles: number;
  v2_cycles: number;
  v3_cycles: number;
}
