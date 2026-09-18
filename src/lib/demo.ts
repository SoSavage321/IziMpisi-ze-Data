/**
 * In-browser demo backend.
 *
 * Used when no Supabase project is configured. It is not a mock in the usual
 * sense: it runs the real controller from /shared and the real alarm rules,
 * so a command you send here is validated against the same interlocks the
 * firmware enforces and comes back accepted or rejected for the same reasons.
 *
 * The seven days of history are generated once, at load, so the dashboard is
 * full the moment it opens.
 */

import { Controller } from '@shared/controller.ts';
import { DEFAULT_CONFIG } from '@shared/types.ts';
import { evaluateAlarms, reconcile, type ExistingAlarm } from '@shared/alarms.ts';
import { PROTOTYPE_DEVICE_ID, latestReading, readingHistory } from './prototype.ts';
import {
  TANK_CAP_L, initialTreatment, isDosing, isReleasing, stepTreatment,
  type TreatmentState,
} from './treatment.ts';
import { Plant } from '../../simulator/plant.ts';
import type {
  Alarm, AuditRow, Batch, Command, DeviceConfig, DeviceEventRow, FleetRow,
  InventoryItem, InventoryMovement, MaintenanceItem, MaintenanceLog, Profile,
  ShiftLog, Site, Telemetry, TreatmentCycle,
} from './types.ts';

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const uid = (() => { let n = 0; return (p: string) => `${p}-${(++n).toString(36)}-demo`; })();
const iso = (ms: number) => new Date(ms).toISOString();

export const DEMO_USERS: Array<Profile & { password: string }> = [
  { user_id: 'u-admin', org_id: 'org-1', full_name: 'Thandi Mokoena', phone: '+27 82 000 0001', role: 'admin', email: 'admin@waterguard.demo', password: 'demo1234' },
  { user_id: 'u-operator', org_id: 'org-1', full_name: 'Sipho Dlamini', phone: '+27 82 000 0002', role: 'operator', email: 'operator@waterguard.demo', password: 'demo1234' },
  { user_id: 'u-viewer', org_id: 'org-1', full_name: 'Elmarie van Wyk', phone: '+27 82 000 0003', role: 'viewer', email: 'viewer@waterguard.demo', password: 'demo1234' },
];

export const DEMO_SITES: Site[] = [
  {
    id: 'site-1', org_id: 'org-1', name: 'Kusile — sump 3',
    location: 'Wilge outfall, Mpumalanga', latitude: -25.9861, longitude: 29.0919,
    mine_owner: 'Eskom / Kusile Power Station', timezone: 'Africa/Johannesburg',
  },
  {
    id: 'site-2', org_id: 'org-1', name: 'Phola colliery — north pit',
    location: 'Ogies, Mpumalanga', latitude: -26.0516, longitude: 29.0722,
    mine_owner: 'Phola Coal', timezone: 'Africa/Johannesburg',
  },
];

interface DemoDevice {
  id: string;
  site_id: string;
  name: string;
  firmware_version: string;
  flow_sensor: boolean;
  config_version: number;
  last_seen: string;
  controller: Controller;
  plant: Plant;
  telemetry: Telemetry[];
  clock: number;
  live: boolean;      // site-2 device 3 is deliberately offline
  /** Real bench hardware: its telemetry is polled, never simulated. */
  proto?: boolean;
}

class DemoStore {
  devices: DemoDevice[] = [];
  batches: Batch[] = [];
  cycles: TreatmentCycle[] = [];
  alarms: Alarm[] = [];
  events: DeviceEventRow[] = [];
  commands: Command[] = [];
  configs: DeviceConfig[] = [];
  maintenance: MaintenanceItem[] = [];
  maintenanceLogs: MaintenanceLog[] = [];
  inventory: InventoryItem[] = [];
  movements: InventoryMovement[] = [];
  shifts: ShiftLog[] = [];
  audit: AuditRow[] = [];
  private listeners = new Set<() => void>();
  private timer: number | null = null;

  constructor() {
    this.build();
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    this.start();
    return () => {
      this.listeners.delete(fn);
      if (this.listeners.size === 0) this.stop();
    };
  }

  private emit() { for (const fn of this.listeners) fn(); }

  private start() {
    if (this.timer !== null) return;
    // 500 ms of simulated time per 500 ms of wall time: real-time plant.
    this.timer = window.setInterval(() => { this.tick(500); this.emit(); }, 500);
    this.startPrototypePolling();
  }

  private stop() {
    if (this.timer !== null) { window.clearInterval(this.timer); this.timer = null; }
    if (this.protoTimer !== null) { window.clearInterval(this.protoTimer); this.protoTimer = null; }
  }

  // ----------------------------------------------------- bench prototype ---

  private protoTimer: number | null = null;
  private protoBackfilled = false;

  /**
   * The bench rig tests and diverts for real, but it has no dosing pump and no
   * release valve, and by agreement the neutralising step is simulated. This
   * acts out the rest of the process around a real reading.
   *
   * It never decides that water is dirty. The rig's own verdict starts the
   * sequence and the rig's own verdict ends it; everything here is what
   * happens afterwards. All of it is flagged so the screen can say which half
   * is measured and which half is acted.
   *
   *   SUMP PUMP -> the check chamber fills
   *              -> full: the batch is tested
   *        PASS  -> straight out to the river
   *        FAIL  -> red, V2 opens, V1 shuts, the batch crosses to treatment
   *              -> neutraliser doses it (green)
   *              -> V3 opens and the treated batch goes to the river
   */
  private protoTreat: TreatmentState = initialTreatment();

  /**
   * Sequence the simulated stages around a real reading.
   *
   * The rules live in ./treatment.ts and are unit tested there; this only
   * feeds the node's verdict in and paints the result onto the telemetry the
   * dashboard already understands.
   */
  private simulateProcess(sample: Telemetry, now: number): Telemetry {
    const contaminated = sample.extra?.contaminated === true;
    const tankCm = typeof sample.extra?.tankCm === 'number' ? sample.extra.tankCm : null;

    this.protoTreat = stepTreatment(this.protoTreat, { contaminated, tankCm, now });
    const t = this.protoTreat;
    const dosing = isDosing(t);
    const releasing = isReleasing(t);

    const extra = { ...(sample.extra ?? {}) };
    extra.treatmentPhase = t.phase;
    extra.treatmentChamberFull = t.fullConfirmed;
    if (t.phase !== 'idle') extra.treatmentSimulated = true;

    // The sump feeds the check chamber whenever the check chamber has room.
    const chamberFull = sample.extra?.chamberFull === true;
    const chamberKnown = typeof sample.extra?.chamberCm === 'number';

    return {
      ...sample,
      state: t.phase === 'dosing' ? 'TREAT' : releasing ? 'RELEASE' : sample.state,
      sump_pump: chamberKnown ? !chamberFull : true,
      tank_l: t.litres,
      tank_cap_l: TANK_CAP_L,
      // Acid going in, neutral coming out — the visible point of dosing.
      tank_ph: t.litres === 0 ? 7 : t.treated ? 7.1 : 4.2,
      // A pump, not a valve: it treats what is already in the chamber and
      // never moves water between stages.
      dosing_pump: dosing,
      // V3 opens only once the batch has been dosed, never during it.
      v3: releasing,
      neutraliser_pct: t.reagentPct,
      tank_receiving: dosing,
      unmeasured: (sample.unmeasured ?? []).filter(
        (f) => f !== 'neutraliser_pct' && !(t.phase !== 'idle' && f === 'tank_l')),
      extra,
    };
  }

  /**
   * Poll the bench API. Kept apart from tick() on purpose: tick() is
   * synchronous and must stay that way, and a bench that is switched off must
   * not be able to stall the simulated devices.
   */
  private startPrototypePolling() {
    if (this.protoTimer !== null) return;
    const poll = () => { void this.pollPrototype(); };
    poll();
    this.protoTimer = window.setInterval(poll, 2000);
  }

  private async pollPrototype() {
    const device = this.devices.find((d) => d.proto);
    if (!device) return;

    const sample = await latestReading();

    // One backfill so the charts open with a line rather than a single dot.
    // After latestReading, so the clock offset it measures applies here too.
    if (!this.protoBackfilled && sample) {
      this.protoBackfilled = true;
      const past = await readingHistory(200);
      if (past.length) {
        device.telemetry = past as Telemetry[];
        device.last_seen = iso(Date.now());
      }
    }
    // No sample means off, unreachable or CORS-blocked. Leave last_seen where
    // it is and the offline rule will say so on its own.
    if (!sample) return;

    const previous = device.telemetry[device.telemetry.length - 1];
    if (previous && previous.ts === sample.ts) return;   // same reading again

    device.telemetry.push(this.simulateProcess(sample, Date.now()));
    if (device.telemetry.length > 2400) device.telemetry.shift();
    // Liveness is when the reading ARRIVED, not the clock stamped on it. The
    // bridge sends a local time with no offset; if that clock is wrong, or is
    // ever switched to UTC, trusting it would park the node permanently in
    // the past and report a healthy rig as offline.
    device.last_seen = iso(Date.now());
    this.runAlarms(device, Date.now());
    this.emit();
  }

  // --------------------------------------------------------------- build ---

  private build() {
    const now = Date.now();
    const specs = [
      { id: 'dev-1', site: 'site-1', name: 'WG-01 sump 3 controller', scenario: 'normal' as const, live: true, flow: false },
      { id: 'dev-2', site: 'site-1', name: 'WG-02 settling pond', scenario: 'acid_event' as const, live: true, flow: true },
      { id: 'dev-3', site: 'site-2', name: 'WG-03 north pit', scenario: 'neutraliser_empty' as const, live: false, flow: false },
      // Real hardware on the bench. Same row shape as the rest so every screen
      // treats it as an ordinary device; only its telemetry source differs.
      { id: PROTOTYPE_DEVICE_ID, site: 'site-1', name: 'AcidShield prototype (live bench)', scenario: 'normal' as const, live: true, flow: false, proto: true },
    ];

    for (const [n, spec] of specs.entries()) {
      const controller = new Controller({ config: { ...DEFAULT_CONFIG }, now: () => Date.now() });
      const plant = new Plant({ scenario: spec.scenario, seed: 7 + n * 31 });
      if (spec.scenario === 'neutraliser_empty') plant.i.neutraliserPct = 0;

      const proto = 'proto' in spec && spec.proto === true;
      this.devices.push({
        id: spec.id, site_id: spec.site, name: spec.name,
        firmware_version: proto ? 'bench' : '1.0.0',
        flow_sensor: spec.flow, config_version: n === 0 ? 2 : 1,
        // The prototype starts stale on purpose: until the bench answers it is
        // offline, rather than claiming a reading it has not made.
        last_seen: proto || !spec.live ? iso(now - 7 * 60_000) : iso(now),
        controller, plant, telemetry: [], clock: now, live: spec.live, proto,
      });

      this.configs.push({
        id: uid('cfg'), device_id: spec.id, version: 1,
        ph_min: 6.5, ph_max: 8.5, tds_max: 1200, treat_target_ph: 6.8,
        test_window_s: 3, stable_window_s: 3, batch_l: 100, tank_cap_l: 300,
        ph_warn_max: 8.5, neutraliser_low_pct: 20,
        reason: 'Initial configuration at registration', created_by: 'u-admin',
        created_by_name: 'Thandi Mokoena',
        created_at: iso(now - 7 * 86400_000), applied_at: iso(now - 7 * 86400_000 + 60_000),
      });

      this.maintenance.push(
        { id: uid('mi'), device_id: spec.id, component: 'pH probe', task: 'calibrate', interval_days: 30, last_done_at: iso(now - (n === 1 ? 41 : 9) * 86400_000), next_due_at: iso(now - (n === 1 ? 11 : -21) * 86400_000) },
        { id: uid('mi'), device_id: spec.id, component: 'TDS probe', task: 'calibrate', interval_days: 90, last_done_at: iso(now - 20 * 86400_000), next_due_at: iso(now + 70 * 86400_000) },
        { id: uid('mi'), device_id: spec.id, component: 'Dosing pump', task: 'service', interval_days: 180, last_done_at: iso(now - 60 * 86400_000), next_due_at: iso(now + 120 * 86400_000) },
      );
    }

    // one config change in the period, for the compliance report
    this.configs.push({
      id: uid('cfg'), device_id: 'dev-1', version: 2,
      ph_min: 6.5, ph_max: 8.5, tds_max: 1200, treat_target_ph: 6.8,
      test_window_s: 3, stable_window_s: 3, batch_l: 100, tank_cap_l: 300,
      ph_warn_max: 8.5, neutraliser_low_pct: 25,
      reason: 'Raised the neutraliser reorder level to 25% after the drum ran dry on the night shift',
      created_by: 'u-admin', created_by_name: 'Thandi Mokoena',
      created_at: iso(now - 3 * 86400_000), applied_at: iso(now - 3 * 86400_000 + 120_000),
    });

    this.buildHistory(now);
    this.buildOps(now);
  }

  /** Seven days of batches, treatment cycles and incidents. */
  private buildHistory(now: number) {
    const rand = rng(20260917);
    for (const device of this.devices) {
      // The bench rig has no seven-day past. Inventing batches, litres to the
      // river and a pass rate for real hardware would be the one dishonest
      // thing on the screen, so it starts with an empty record and fills up
      // from what it actually reports.
      if (device.proto) continue;
      let batchNo = 0;
      let cycleNo = 0;
      const start = now - 7 * 86400_000;

      for (let t = start; t < now - 60_000; t += 6 * 60_000) {
        // night shift runs dirtier than day shift — a real pattern on site
        const hour = new Date(t).getUTCHours();
        const dirty = hour >= 22 || hour <= 4 ? 0.42 : 0.2;
        batchNo += 1;

        const bad = rand() < dirty;
        let avgPh = 6.7 + rand() * 1.4;
        let avgTds = 380 + rand() * 420;
        let reason: string | null = null;

        if (bad) {
          const kind = rand();
          if (kind < 0.55) { avgPh = 3.2 + rand() * 3.1; reason = 'ACID'; }
          else if (kind < 0.8) { avgPh = 8.6 + rand() * 1.1; reason = 'ALKALINE'; }
          else { avgTds = 1250 + rand() * 700; reason = 'TDS'; }
        }

        const pass = reason === null;
        this.batches.push({
          id: uid('b'), device_id: device.id, batch_no: batchNo,
          started_at: iso(t), ended_at: iso(t + 190_000),
          avg_ph: round2(avgPh), avg_tds: Math.round(avgTds),
          result: pass ? 'PASS' : 'FAIL',
          destination: pass ? 'RIVER' : 'TANK',
          volume_l: 100, fail_reason: reason,
        });

        if (!pass) {
          cycleNo += 1;
          const startPh = avgPh;
          this.cycles.push({
            id: uid('c'), device_id: device.id, cycle_no: cycleNo,
            started_at: iso(t + 200_000), released_at: iso(t + 200_000 + (160 + rand() * 220) * 1000),
            start_ph: round2(startPh), end_ph: round2(6.85 + rand() * 0.5),
            end_tds: Math.round(reason === 'TDS' ? avgTds * 0.95 : avgTds),
            neutraliser_used_pct: round2(0.4 + rand() * 1.6),
            volume_released_l: 100,
          });
        }
      }

      // a handful of resolved incidents across the week
      const incidents: Array<[string, any, string, number]> = [
        ['neutraliser_low', 'warning', 'Neutraliser down to 18% — below the 20% reorder level', 5.4],
        ['ph_high_chamber', 'warning', 'Chamber pH 9.05 is above the 8.5 alkaline limit — check for over-dosing upstream', 3.2],
        ['neutraliser_empty', 'critical', 'Neutraliser reservoir is empty — V3 is locked and the siren is sounding', 2.8],
        ['calibration_overdue', 'warning', 'pH probe calibration is 11 days overdue — readings may be drifting', 1.1],
      ];
      for (const [type, severity, message, daysAgo] of incidents) {
        if (device.id === 'dev-3' && type === 'neutraliser_empty') continue;   // still open, added below
        const raised = now - daysAgo * 86400_000;
        this.alarms.push({
          id: uid('al'), device_id: device.id, type, severity, message, details: {},
          raised_at: iso(raised),
          acknowledged_by: 'u-operator', acknowledged_at: iso(raised + 4 * 60_000),
          ack_note: type === 'neutraliser_empty' ? 'Refilled the drum from the store, 20 L' : 'Seen, monitoring',
          cleared_at: iso(raised + 46 * 60_000), escalated: false,
        });
      }
    }

    // the two conditions that are open right now
    this.alarms.push({
      id: uid('al'), device_id: 'dev-3', type: 'device_offline', severity: 'critical',
      message: 'WG-03 north pit has been offline for 421 s',
      details: { threshold_s: 60 }, raised_at: iso(now - 6 * 60_000),
      acknowledged_by: null, acknowledged_at: null, ack_note: null, cleared_at: null, escalated: false,
    });
    this.alarms.push({
      id: uid('al'), device_id: 'dev-2', type: 'calibration_overdue', severity: 'warning',
      message: 'pH probe calibration is 11 days overdue — readings may be drifting',
      details: { component: 'pH probe', days_overdue: 11 }, raised_at: iso(now - 40 * 60_000),
      acknowledged_by: null, acknowledged_at: null, ack_note: null, cleared_at: null, escalated: false,
    });
  }

  private buildOps(now: number) {
    this.inventory = [
      { id: 'inv-1', site_id: 'site-1', item: 'neutraliser (hydrated lime slurry)', unit: 'L', stock: 340, reorder_level: 120, supplier: 'Mpumalanga Chemical Supplies', cost_per_unit: 48, updated_at: iso(now - 86400_000) },
      { id: 'inv-2', site_id: 'site-2', item: 'neutraliser (hydrated lime slurry)', unit: 'L', stock: 85, reorder_level: 120, supplier: 'Mpumalanga Chemical Supplies', cost_per_unit: 48, updated_at: iso(now - 3 * 86400_000) },
    ];
    this.movements = [
      { id: uid('mv'), inventory_id: 'inv-1', delta: 200, kind: 'delivery', note: 'PO 4471, delivered to the store', created_by: 'u-operator', created_by_name: 'Sipho Dlamini', created_at: iso(now - 4 * 86400_000) },
      { id: uid('mv'), inventory_id: 'inv-1', delta: -20, kind: 'usage', note: 'Drum refill at WG-01', created_by: 'u-operator', created_by_name: 'Sipho Dlamini', created_at: iso(now - 2 * 86400_000) },
      { id: uid('mv'), inventory_id: 'inv-2', delta: -20, kind: 'usage', note: 'Drum refill at WG-03', created_by: 'u-operator', created_by_name: 'Sipho Dlamini', created_at: iso(now - 86400_000) },
    ];
    this.shifts = [
      {
        id: uid('sh'), site_id: 'site-1', author: 'u-operator', author_name: 'Sipho Dlamini',
        shift_start: iso(now - 14 * 3600_000), shift_end: iso(now - 6 * 3600_000),
        notes: 'Night shift. Inflow turned acid around 01:00, twelve batches diverted in a row. Tank kept up. Refilled the neutraliser drum at 03:20.',
        handover_to: 'u-admin', handover_to_name: 'Thandi Mokoena', created_at: iso(now - 6 * 3600_000),
      },
    ];
    this.maintenanceLogs = [
      {
        id: uid('ml'), item_id: this.maintenance[0].id, device_id: 'dev-1', performed_by: 'u-operator',
        performed_by_name: 'Sipho Dlamini', performed_at: iso(now - 9 * 86400_000),
        notes: 'Two-point calibration with pH 4.01 and pH 7.00 buffers. Probe cleaned, membrane intact.',
        before_values: { ph_4: 4.18, ph_7: 7.14 }, after_values: { ph_4: 4.01, ph_7: 7.0 },
      },
    ];
    this.audit = [
      { id: uid('au'), actor: 'u-admin', actor_name: 'Thandi Mokoena', action: 'INSERT', target_table: 'device_config', target_id: 'dev-1', before: null, after: { version: 2, neutraliser_low_pct: 25 }, ts: iso(now - 3 * 86400_000) },
      { id: uid('au'), actor: 'u-operator', actor_name: 'Sipho Dlamini', action: 'ACK', target_table: 'alarms', target_id: 'al-1', before: null, after: { note: 'Refilled the drum from the store, 20 L' }, ts: iso(now - 2.8 * 86400_000) },
    ];
  }

  // ---------------------------------------------------------------- tick ---

  private tick(dtMs: number) {
    const now = Date.now();
    for (const device of this.devices) {
      if (!device.live) continue;
      // The bench rig reports what it actually measured; stepping a model on
      // top of it would overwrite real readings with invented ones.
      if (device.proto) { this.runAlarms(device, now); continue; }

      device.plant.step(dtMs / 1000, device.controller.out, device.controller.tankL, device.controller.chamberL);
      device.controller.tick(dtMs, device.plant.i);
      device.last_seen = iso(now);

      // answer any pending commands, exactly as the firmware would
      for (const cmd of this.commands.filter((c) => c.device_id === device.id && c.status === 'pending')) {
        if (Date.parse(cmd.expires_at) < now) {
          cmd.status = 'expired';
          cmd.reason = 'No acknowledgement from the device within 30 s';
          cmd.resolved_at = iso(now);
          continue;
        }
        const verdict = device.controller.request(
          { id: cmd.id, type: cmd.type as any, payload: cmd.payload },
          device.plant.i,
        );
        cmd.status = verdict.accepted ? 'accepted' : 'rejected';
        cmd.reason = verdict.reason;
        cmd.resolved_at = iso(now);
      }
      device.controller.drainVerdicts();

      const sample = device.controller.telemetry({ wifi_rssi: -55 - Math.round(Math.random() * 20), uptime_s: Math.floor((now - (now - 86400_000)) / 1000) });
      device.telemetry.push(sample as Telemetry);
      if (device.telemetry.length > 2400) device.telemetry.shift();   // ~20 min at 2 Hz

      for (const b of device.controller.drainBatches()) {
        this.batches.push({
          id: uid('b'), device_id: device.id,
          ...b,
          avg_ph: b.avg_ph, avg_tds: b.avg_tds,
        } as Batch);
      }
      for (const c of device.controller.drainCycles()) {
        this.cycles.push({ id: uid('c'), device_id: device.id, ...c } as TreatmentCycle);
      }
      for (const e of device.controller.drainEvents()) {
        this.events.push({ id: uid('ev'), device_id: device.id, ...e });
      }
      if (this.events.length > 800) this.events.splice(0, this.events.length - 800);

      this.runAlarms(device, now);
    }
  }

  /** The neutraliser held in the store for a site, for the stock alarms. */
  private stockFor(siteId: string) {
    const item = this.inventory.find((i) => i.site_id === siteId && i.item.includes('neutraliser'));
    return item
      ? { item: item.item, stock: item.stock, reorder_level: item.reorder_level, unit: item.unit }
      : null;
  }

  private runAlarms(device: DemoDevice, now: number) {
    const config = device.controller.config;
    const latest = device.telemetry[device.telemetry.length - 1];
    if (!latest) return;

    const active = evaluateAlarms({
      now,
      device: { id: device.id, name: device.name, last_seen: device.last_seen, flow_sensor: device.flow_sensor },
      config,
      latest: latest as any,
      window: device.telemetry.slice(-600) as any,
      recentBatches: this.batches.filter((b) => b.device_id === device.id).slice(-20).reverse(),
      heldSince: latest.state === 'HOLD' ? iso(now - 60_000) : null,
      lastCycle: this.cycles.filter((c) => c.device_id === device.id).slice(-1)[0] ?? null,
      siteStock: this.stockFor(device.site_id),
    });

    const open = this.alarms.filter((a) => a.device_id === device.id && !a.cleared_at && a.severity !== 'info');
    const { toRaise, toClear } = reconcile(active, open as unknown as ExistingAlarm[]);

    for (const a of toClear) {
      const row = this.alarms.find((x) => x.id === a.id);
      if (row) row.cleared_at = iso(now);
    }
    for (const a of toRaise) {
      this.alarms.push({
        id: uid('al'), device_id: device.id, type: a.type, severity: a.severity,
        message: a.message, details: a.details, raised_at: iso(now),
        acknowledged_by: null, acknowledged_at: null, ack_note: null, cleared_at: null, escalated: false,
      });
    }
  }

  // --------------------------------------------------------------- reads ---

  fleet(): FleetRow[] {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    return this.devices.map((d) => {
      const site = DEMO_SITES.find((s) => s.id === d.site_id)!;
      const t = d.telemetry[d.telemetry.length - 1];
      const todays = this.batches.filter((b) => b.device_id === d.id && new Date(b.started_at) >= today);
      const alarms = this.alarms.filter((a) => a.device_id === d.id && !a.cleared_at && a.severity !== 'info');
      const offline = Date.now() - Date.parse(d.last_seen) > 60_000;
      const un = (field: string) => t?.unmeasured?.includes(field) ?? false;

      return {
        device_id: d.id, device_name: d.name, site_id: site.id, site_name: site.name,
        location: site.location, latitude: site.latitude, longitude: site.longitude, timezone: site.timezone,
        last_seen: d.last_seen, firmware_version: d.firmware_version, flow_sensor: d.flow_sensor,
        config_version: d.config_version, offline,
        state: offline ? null : t?.state ?? null,
        mode: t?.mode ?? 'AUTO', estop: t?.estop ?? false,
        // A device that does not carry a probe reports unknown, not a number.
        ph: un('ph') ? null : t?.ph ?? null,
        tds: un('tds') ? null : t?.tds ?? null,
        neutraliser_pct: un('neutraliser_pct') ? null : t?.neutraliser_pct ?? null,
        tank_l: un('tank_l') ? null : t?.tank_l ?? null,
        tank_cap_l: t?.tank_cap_l ?? 300,
        v1: t?.v1 ?? false, v2: t?.v2 ?? false, v3: t?.v3 ?? false,
        siren: t?.siren ?? false, led: t?.led ?? 'off',
        active_alarms: alarms.length,
        critical_alarms: alarms.filter((a) => a.severity === 'critical').length,
        batches_today: todays.length,
        passed_today: todays.filter((b) => b.result === 'PASS').length,
        litres_to_river_today: todays.filter((b) => b.destination === 'RIVER').reduce((s, b) => s + b.volume_l, 0),
        litres_blocked_today: todays.filter((b) => b.destination !== 'RIVER').reduce((s, b) => s + b.volume_l, 0),
      };
    });
  }

  device(id: string) { return this.devices.find((d) => d.id === id); }

  telemetryFor(id: string, minutes: number): Telemetry[] {
    const cutoff = Date.now() - minutes * 60_000;
    return (this.device(id)?.telemetry ?? []).filter((t) => Date.parse(t.ts) >= cutoff);
  }

  v3Lock(id: string): string | null {
    const d = this.device(id);
    if (!d) return null;
    return d.controller.v3LockReason;
  }
}

export const demoStore = new DemoStore();

function round2(n: number) { return Math.round(n * 100) / 100; }
