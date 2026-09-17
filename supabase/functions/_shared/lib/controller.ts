// GENERATED FILE — do not edit.
// Copied from /shared by scripts/sync-shared.mjs. Edit the original and run
// `npm run sync:shared`.

/**
 * WaterGuard controller — the batch test-before-release state machine.
 *
 * This is the reference implementation. The ESP32 firmware in /firmware is a
 * line-for-line port of it, and the simulator in /simulator runs this exact
 * file, so a test that passes here describes what the hardware does.
 *
 * Division of labour:
 *   - This class decides. It reads sensors and drives actuators.
 *   - It never models water. The physics (how pH responds to dosing, how fast
 *     a tank fills) lives in the simulator or in the real world.
 *   - It is the authority on safety. Every command is validated against the
 *     interlocks below and answered with accepted/rejected + a reason. The
 *     dashboard cannot bypass this; it can only ask.
 *
 * Pass rule:   phMin <= pH <= phMax  AND  TDS <= tdsMax
 * The upper pH bound is enforced, not merely warned about: an over-dosed
 * alkaline batch is a pollution event in the same way an acid one is.
 */

import {
  ControllerConfig,
  DEFAULT_CONFIG,
  BatchRecord,
  BatchDestination,
  BatchResult,
  CommandVerdict,
  DeviceCommand,
  DeviceEvent,
  FailReason,
  Led,
  PlantMode,
  PlantState,
  SensorInputs,
  TelemetrySample,
  TreatmentCycleRecord,
} from './types.ts';

export interface ControllerOptions {
  config?: ControllerConfig;
  /** Nominal sump fill rate, L/s. Used when no flow meter is fitted. */
  fillLps?: number;
  /** Nominal transfer/discharge rate, L/s. */
  drainLps?: number;
  /** How long the dosing pump runs per slug. */
  dosePulseMs?: number;
  /** Quiet time after a slug so the tank mixes before it is read again. */
  doseMixMs?: number;
  /** Slugs per batch before the controller gives up and locks out. */
  maxPulses?: number;
  /**
   * Whether an acid trim pump is fitted. With one, an over-dosed tank is
   * pulled back into band. Without one, the controller can only lock V3 and
   * raise the alarm — which is still safe, just not self-healing.
   */
  hasAcidTrim?: boolean;
  /** Injectable clock so tests are deterministic. */
  now?: () => number;
}

export interface Outputs {
  v1: boolean;
  v2: boolean;
  v3: boolean;
  sumpPump: boolean;
  dosingPump: boolean;
  acidPump: boolean;
  siren: boolean;
  led: Led;
}

const MS = 1;

export class Controller {
  config: ControllerConfig;
  state: PlantState = 'BOOT';
  mode: PlantMode = 'AUTO';
  estop = false;
  /** Set by the physical E-stop button; RESET_ESTOP is refused while true. */
  estopLatched = false;
  intakePaused = false;

  batchNo = 0;
  cycleNo = 0;
  chamberL = 0;
  tankL = 0;
  tankPh = 7;
  tankTds = 0;

  out: Outputs = {
    v1: false, v2: false, v3: false,
    sumpPump: false, dosingPump: false, acidPump: false,
    siren: false, led: 'off',
  };

  /** Why V3 is currently refusing to open. Surfaced in the UI. */
  v3LockReason: string | null = null;
  lockoutReason: string | null = null;

  private opts: Required<Omit<ControllerOptions, 'config' | 'now'>>;
  private now: () => number;

  private clock = 0;             // internal ms, advanced by tick()
  private tStateEnter = 0;
  private tStable = 0;
  private tPulse = 0;
  private sirenSilencedUntil = 0;
  private pulses = 0;
  private dosingUntil = 0;

  private acc = { ph: 0, tds: 0, n: 0 };
  private batchStartedAt = 0;
  private lastInputs: SensorInputs = {
    ph: 7, tds: 0, tankPh: 7, tankTds: 0, neutraliserPct: 100,
  };
  private cycleStart: { at: number; ph: number; pct: number } | null = null;
  /** Litres in the tank when V3 opened, captured for the cycle record. */
  private tankAtRelease = 0;
  private heldBatch: { no: number; ph: number; tds: number; reason: FailReason; at: number } | null = null;

  private events: DeviceEvent[] = [];
  private batches: BatchRecord[] = [];
  private cycles: TreatmentCycleRecord[] = [];
  private verdicts: CommandVerdict[] = [];

  constructor(options: ControllerOptions = {}) {
    this.config = options.config ?? { ...DEFAULT_CONFIG };
    this.now = options.now ?? (() => Date.now());
    this.opts = {
      fillLps: options.fillLps ?? 20,
      drainLps: options.drainLps ?? 25,
      dosePulseMs: options.dosePulseMs ?? 400,
      doseMixMs: options.doseMixMs ?? 1600,
      maxPulses: options.maxPulses ?? 40,
      hasAcidTrim: options.hasAcidTrim ?? true,
    };
  }

  // ------------------------------------------------------------ verdicts ---

  /** Middle of the band — dosing aims here, not at the edge. */
  private get aimLo() { return this.config.treatTargetPh; }
  private get aimHi() { return (this.config.treatTargetPh + this.config.phMax) / 2; }

  /** The one place the pass rule is written down. */
  failReason(ph: number, tds: number): FailReason {
    if (ph < this.config.phMin) return 'ACID';
    if (ph > this.config.phMax) return 'ALKALINE';
    if (tds > this.config.tdsMax) return 'TDS';
    return null;
  }

  inReleaseBand(ph: number): boolean {
    return ph >= this.config.treatTargetPh && ph <= this.config.phMax;
  }

  // ------------------------------------------------------------ interlocks ---

  /**
   * The safety core. Returns null when V3 may open, or the reason it may not.
   * Both the automatic sequence and every manual command go through here.
   */
  v3Interlock(i: SensorInputs): string | null {
    if (this.estop) return 'Emergency stop is active';
    if (this.out.v2) return 'V3 is interlocked against V2: failed water is still entering the tank';
    if (i.neutraliserPct <= 0) return 'Neutraliser reservoir is empty';
    if (this.tankL <= 0) return 'Treatment tank is empty';
    if (!this.inReleaseBand(i.tankPh)) {
      return `Tank pH ${i.tankPh.toFixed(2)} is outside the release band ` +
             `${this.config.treatTargetPh.toFixed(1)}–${this.config.phMax.toFixed(1)}`;
    }
    return null;
  }

  private valveInterlock(valve: 'V1' | 'V2' | 'V3', open: boolean, i: SensorInputs): string | null {
    if (!open) return null;                       // closing is always allowed
    if (this.estop) return 'Emergency stop is active';
    if (valve === 'V3') return this.v3Interlock(i);
    if (valve === 'V1' && this.out.v2) return 'V1 and V2 cannot be open together';
    if (valve === 'V2' && this.out.v1) return 'V1 and V2 cannot be open together';
    if (valve === 'V1') {
      const reason = this.failReason(i.ph, i.tds);
      if (reason) return `Chamber water fails the test (${reason}); V1 may not open to the river`;
    }
    return null;
  }

  // -------------------------------------------------------------- commands ---

  /**
   * Validate a dashboard request. Always returns a verdict — a rejection is a
   * normal, expected outcome and the reason is shown to the operator verbatim.
   */
  request(cmd: DeviceCommand, i: SensorInputs = this.lastInputs): CommandVerdict {
    const verdict = this.evaluate(cmd, i);
    this.verdicts.push(verdict);
    this.emit('COMMAND', { type: cmd.type, payload: cmd.payload ?? {}, ...verdict });
    if (!verdict.accepted) {
      this.emit('INTERLOCK_BLOCK', { command: cmd.type, reason: verdict.reason });
    }
    return verdict;
  }

  private evaluate(cmd: DeviceCommand, i: SensorInputs): CommandVerdict {
    const ok = (reason: string): CommandVerdict => ({ id: cmd.id, accepted: true, reason });
    const no = (reason: string): CommandVerdict => ({ id: cmd.id, accepted: false, reason });
    const p = (cmd.payload ?? {}) as Record<string, any>;

    switch (cmd.type) {
      case 'EMERGENCY_STOP':
        this.enterEstop('Emergency stop requested from the dashboard');
        return ok('Emergency stop engaged: all valves shut, all pumps stopped');

      case 'RESET_ESTOP':
        if (!this.estop) return no('Emergency stop is not active');
        if (this.estopLatched) return no('The physical E-stop button is still engaged; release it at the panel first');
        this.estop = false;
        this.go('FILL');
        return ok('Emergency stop reset; returning to AUTO fill');

      case 'SET_MODE': {
        const mode = String(p.mode) as PlantMode;
        if (!['AUTO', 'MANUAL', 'MAINTENANCE'].includes(mode)) return no(`Unknown mode "${p.mode}"`);
        if (this.estop) return no('Emergency stop is active; reset it before changing mode');
        if (mode !== 'AUTO' && (this.state === 'DISCHARGE' || this.state === 'RELEASE')) {
          return no(`Cannot leave AUTO while water is being released (state ${this.state})`);
        }
        this.mode = mode;
        this.emit('MODE_CHANGE', { mode });
        if (mode === 'MAINTENANCE') { this.allOff(); this.go('MAINTENANCE'); }
        else if (this.state === 'MAINTENANCE') this.go('FILL');
        return ok(`Mode set to ${mode}`);
      }

      case 'MANUAL_VALVE': {
        if (this.mode !== 'MANUAL') return no(`Manual valve control requires MANUAL mode (currently ${this.mode})`);
        const valve = String(p.valve).toUpperCase() as 'V1' | 'V2' | 'V3';
        if (!['V1', 'V2', 'V3'].includes(valve)) return no(`Unknown valve "${p.valve}"`);
        const open = Boolean(p.open);
        const blocked = this.valveInterlock(valve, open, i);
        if (blocked) return no(blocked);
        if (valve === 'V1') this.setValve('v1', open);
        if (valve === 'V2') this.setValve('v2', open);
        if (valve === 'V3') this.setValve('v3', open);
        return ok(`${valve} ${open ? 'opened' : 'closed'}`);
      }

      case 'MANUAL_PUMP': {
        if (this.mode !== 'MANUAL') return no(`Manual pump control requires MANUAL mode (currently ${this.mode})`);
        if (this.estop) return no('Emergency stop is active');
        const pump = String(p.pump).toLowerCase();
        const on = Boolean(p.on);
        if (pump === 'sump') { this.out.sumpPump = on; return ok(`Sump pump ${on ? 'started' : 'stopped'}`); }
        if (pump === 'dosing') {
          if (on && i.neutraliserPct <= 0) return no('Neutraliser reservoir is empty');
          this.out.dosingPump = on;
          return ok(`Dosing pump ${on ? 'started' : 'stopped'}`);
        }
        return no(`Unknown pump "${p.pump}"`);
      }

      case 'START_BATCH':
        if (this.estop) return no('Emergency stop is active');
        if (this.mode !== 'AUTO') return no(`START_BATCH requires AUTO mode (currently ${this.mode})`);
        if (this.state !== 'FILL') return no(`A batch is already in progress (state ${this.state})`);
        this.intakePaused = false;
        return ok('Intake running; the batch will test when the chamber reaches 100 L');

      case 'PAUSE_INTAKE':
        this.intakePaused = true;
        this.out.sumpPump = false;
        return ok('Intake paused; the sump pump is stopped. Water already in the chamber is unaffected');

      case 'RESUME_INTAKE':
        if (this.estop) return no('Emergency stop is active');
        this.intakePaused = false;
        return ok('Intake resumed');

      case 'SILENCE_SIREN':
        this.sirenSilencedUntil = this.clock + 5 * 60 * 1000;
        this.out.siren = false;
        return ok('Siren silenced for 5 minutes. The alarm itself stays active until the cause clears');

      case 'APPLY_CONFIG': {
        const next = p.config as Partial<ControllerConfig> | undefined;
        if (!next) return no('APPLY_CONFIG carried no configuration');
        const bad = validateConfig({ ...this.config, ...next });
        if (bad) return no(`Rejected: ${bad}`);
        this.config = { ...this.config, ...next } as ControllerConfig;
        this.emit('CONFIG_APPLIED', { version: this.config.version });
        return ok(`Configuration version ${this.config.version} applied`);
      }

      case 'REQUEST_CALIBRATION_MODE':
        if (this.state === 'DISCHARGE' || this.state === 'RELEASE') {
          return no(`Cannot enter calibration while water is being released (state ${this.state})`);
        }
        this.mode = 'MAINTENANCE';
        this.allOff();
        this.go('MAINTENANCE');
        return ok('Calibration mode: plant stopped, valves shut, probes free for buffer solutions');

      default:
        return no(`Unknown command "${(cmd as DeviceCommand).type}"`);
    }
  }

  // ------------------------------------------------------------------ tick ---

  tick(dtMs: number, i: SensorInputs): void {
    this.clock += dtMs;
    this.lastInputs = i;
    const dt = dtMs / 1000;

    if (this.state === 'BOOT') {
      this.emit('BOOT', { config_version: this.config.version });
      this.go('FILL');
    }

    if (this.estop) { this.allOff(); this.state = 'ESTOP'; this.updateIndicators(i); return; }
    if (this.mode === 'MAINTENANCE') { this.allOff(); this.state = 'MAINTENANCE'; this.updateIndicators(i); return; }
    if (this.mode === 'MANUAL') {
      // Manual mode holds the automatic sequence. Outputs are whatever the
      // last accepted command left them as, but the interlocks still run:
      // if V3 is open and its interlock goes bad, it shuts itself.
      if (this.out.v3) {
        const blocked = this.v3Interlock(i);
        if (blocked) { this.setValve('v3', false); this.v3LockReason = blocked; this.emit('INTERLOCK_BLOCK', { valve: 'V3', reason: blocked }); }
      }
      this.integrateManual(dt, i);
      this.updateIndicators(i);
      return;
    }

    switch (this.state) {
      case 'FILL': this.stFill(dt, i); break;
      case 'TEST': this.stTest(dt, i); break;
      case 'DISCHARGE': this.stDischarge(dt, i); break;
      case 'DIVERT': this.stDivert(dt, i); break;
      case 'TREAT': this.stTreat(dt, i); break;
      case 'CONFIRM': this.stConfirm(dt, i); break;
      case 'RELEASE': this.stRelease(dt, i); break;
      case 'HOLD': this.stHold(dt, i); break;
      case 'LOCKOUT': this.stLockout(dt, i); break;
    }

    this.updateIndicators(i);
  }

  // 1. FILL ------------------------------------------------------------------
  private stFill(dt: number, i: SensorInputs) {
    this.shutAll();
    if (this.intakePaused) { this.out.sumpPump = false; return; }
    this.out.sumpPump = true;
    this.chamberL = i.measuredChamberL ?? this.chamberL + this.opts.fillLps * dt;
    if (this.chamberL >= this.config.batchL) {
      this.chamberL = this.config.batchL;
      this.out.sumpPump = false;
      this.acc = { ph: 0, tds: 0, n: 0 };
      this.batchNo += 1;
      this.batchStartedAt = this.now();
      this.go('TEST');
    }
  }

  // 2. TEST ------------------------------------------------------------------
  private stTest(_dt: number, i: SensorInputs) {
    this.shutAll();
    this.acc.ph += i.ph; this.acc.tds += i.tds; this.acc.n += 1;

    if (this.clock - this.tStateEnter < this.config.testWindowS * 1000 * MS) return;

    const avgPh = this.acc.ph / this.acc.n;
    const avgTds = this.acc.tds / this.acc.n;
    const reason = this.failReason(avgPh, avgTds);

    if (!reason) {
      this.recordBatch(avgPh, avgTds, 'PASS', 'RIVER', null);
      this.go('DISCHARGE');
      return;
    }

    if (this.tankL + this.config.batchL > this.config.tankCapL) {
      this.recordBatch(avgPh, avgTds, 'HELD', 'HELD', reason);
      this.heldBatch = { no: this.batchNo, ph: avgPh, tds: avgTds, reason, at: this.batchStartedAt };
      this.go('HOLD');
      return;
    }

    this.recordBatch(avgPh, avgTds, 'FAIL', 'TANK', reason);
    this.heldBatch = null;
    this.go('DIVERT');
  }

  // 3a. PASS -> river --------------------------------------------------------
  private stDischarge(dt: number, i: SensorInputs) {
    this.setValve('v1', true);
    this.chamberL = i.measuredChamberL ?? this.chamberL - this.opts.drainLps * dt;
    if (this.chamberL <= 0) {
      this.chamberL = 0;
      this.setValve('v1', false);
      this.go('FILL');
    }
  }

  // 3b. FAIL -> tank ---------------------------------------------------------
  private stDivert(dt: number, i: SensorInputs) {
    this.setValve('v2', true);                 // V3 is interlocked shut while this runs
    const moved = Math.min(this.opts.drainLps * dt, this.chamberL);
    const total = this.tankL + moved;
    if (total > 0) {
      this.tankPh = (this.tankPh * this.tankL + i.ph * moved) / total;
      this.tankTds = (this.tankTds * this.tankL + i.tds * moved) / total;
    }
    this.chamberL -= moved;
    this.tankL = i.measuredTankL ?? total;

    if (this.chamberL <= 0.01) {
      this.chamberL = 0;
      this.setValve('v2', false);
      if (this.heldBatch && this.heldBatch.no === this.batchNo) {
        // A batch that was HELD has now actually reached the tank. Ingest
        // upserts on (device_id, batch_no), so this updates the same row.
        this.recordBatch(this.heldBatch.ph, this.heldBatch.tds, 'FAIL', 'TANK', this.heldBatch.reason, this.heldBatch.no, this.heldBatch.at);
        this.heldBatch = null;
      }
      this.pulses = 0;
      this.cycleNo += 1;
      this.cycleStart = { at: this.now(), ph: i.tankPh, pct: i.neutraliserPct };
      this.tPulse = this.clock;
      this.go('TREAT');
    }
  }

  // 4. TREAT -----------------------------------------------------------------
  private stTreat(_dt: number, i: SensorInputs) {
    this.shutAll();
    const needBase = i.tankPh < this.aimLo;
    const needAcid = i.tankPh > this.aimHi;

    if (!needBase && !needAcid) {
      this.out.dosingPump = false; this.out.acidPump = false;
      this.tStable = 0;
      this.go('CONFIRM');
      return;
    }

    if (this.pulses >= this.opts.maxPulses) return this.lockout('Dose limit reached without reaching the target pH');
    if (needBase && i.neutraliserPct <= 0) return this.lockout('Neutraliser reservoir is empty');
    if (needAcid && !this.opts.hasAcidTrim) {
      return this.lockout(`Tank over-dosed to pH ${i.tankPh.toFixed(2)} and no acid trim is fitted`);
    }

    // Dose in slugs with a mixing pause. Continuous dosing overshoots the
    // ceiling, which is what put alkaline water in the river in the first place.
    if (this.out.dosingPump || this.out.acidPump) {
      if (this.clock - this.dosingUntil >= 0) { this.out.dosingPump = false; this.out.acidPump = false; this.tPulse = this.clock; }
    } else if (this.clock - this.tPulse >= this.opts.doseMixMs) {
      this.out.dosingPump = needBase;
      this.out.acidPump = needAcid;
      this.dosingUntil = this.clock + this.opts.dosePulseMs;
      this.pulses += 1;
      this.emit('PUMP', { pump: needBase ? 'dosing' : 'acid_trim', slug: this.pulses, tank_ph: round2(i.tankPh) });
    }
  }

  // 5. CONFIRM ---------------------------------------------------------------
  private stConfirm(_dt: number, i: SensorInputs) {
    this.shutAll();
    if (!this.inReleaseBand(i.tankPh)) { this.tStable = 0; this.go('TREAT'); return; }
    if (this.tStable === 0) this.tStable = this.clock;
    if (this.clock - this.tStable >= this.config.stableWindowS * 1000 * MS) this.go('RELEASE');
  }

  // 6. RELEASE ---------------------------------------------------------------
  private stRelease(dt: number, i: SensorInputs) {
    const blocked = this.v3Interlock(i);
    if (blocked && this.tankL > 0) {
      this.setValve('v3', false);
      this.v3LockReason = blocked;
      this.emit('INTERLOCK_BLOCK', { valve: 'V3', reason: blocked });
      this.go('TREAT');
      return;
    }
    if (!this.out.v3) this.tankAtRelease = this.tankL;   // volume this cycle will release
    this.setValve('v3', true);
    this.tankL = i.measuredTankL ?? Math.max(0, this.tankL - this.opts.drainLps * dt);
    if (this.tankL <= 0) {
      this.tankL = 0;
      this.setValve('v3', false);
      this.closeCycle(i);
      this.go('FILL');
    }
  }

  // holding states -----------------------------------------------------------
  private stHold(_dt: number, _i: SensorInputs) {
    this.shutAll();
    this.out.sumpPump = false;
    if (this.tankL + this.config.batchL <= this.config.tankCapL) this.go('DIVERT');
  }

  private stLockout(_dt: number, i: SensorInputs) {
    this.shutAll();
    this.out.dosingPump = false; this.out.acidPump = false;
    const stillBad =
      (i.tankPh < this.aimLo && i.neutraliserPct <= 0) ||
      (i.tankPh > this.aimHi && !this.opts.hasAcidTrim) ||
      this.pulses >= this.opts.maxPulses;
    if (!stillBad) { this.lockoutReason = null; this.pulses = 0; this.go('TREAT'); }
  }

  // ------------------------------------------------------------- plumbing ---

  private integrateManual(dt: number, i: SensorInputs) {
    if (this.out.sumpPump) this.chamberL = Math.min(this.config.batchL, this.chamberL + this.opts.fillLps * dt);
    if (this.out.v1) this.chamberL = Math.max(0, this.chamberL - this.opts.drainLps * dt);
    if (this.out.v2) {
      const moved = Math.min(this.opts.drainLps * dt, this.chamberL);
      this.chamberL -= moved;
      this.tankL = Math.min(this.config.tankCapL, this.tankL + moved);
    }
    if (this.out.v3) this.tankL = Math.max(0, this.tankL - this.opts.drainLps * dt);
    if (i.measuredChamberL !== undefined) this.chamberL = i.measuredChamberL;
    if (i.measuredTankL !== undefined) this.tankL = i.measuredTankL;
  }

  private go(next: PlantState) {
    if (next === this.state) return;
    const from = this.state;
    this.state = next;
    this.tStateEnter = this.clock;
    this.emit('STATE_CHANGE', { from, to: next, batch_no: this.batchNo });
  }

  private lockout(reason: string) {
    this.lockoutReason = reason;
    this.v3LockReason = reason;
    this.allOff();
    this.go('LOCKOUT');
    this.emit('INTERLOCK_BLOCK', { valve: 'V3', reason });
  }

  private enterEstop(reason: string) {
    this.estop = true;
    this.allOff();
    this.state = 'ESTOP';
    this.emit('STATE_CHANGE', { from: this.state, to: 'ESTOP', reason });
  }

  private setValve(v: 'v1' | 'v2' | 'v3', open: boolean) {
    if (this.out[v] === open) return;
    this.out[v] = open;
    this.emit('VALVE', { valve: v.toUpperCase(), open, state: this.state });
  }

  private shutAll() { this.setValve('v1', false); this.setValve('v2', false); this.setValve('v3', false); }

  private allOff() {
    this.shutAll();
    this.out.sumpPump = false; this.out.dosingPump = false; this.out.acidPump = false;
  }

  private updateIndicators(i: SensorInputs) {
    const empty = i.neutraliserPct <= 0;
    // green = pass, red = fail, yellow = testing or neutraliser empty
    // An empty reservoir shows yellow even in a red state: the panel light is
    // how the operator on the ground is told to go and refill the drum.
    let led: Led = 'off';
    if (empty) led = 'yellow';
    else if (this.state === 'DISCHARGE' || this.state === 'RELEASE') led = 'green';
    else if (this.state === 'DIVERT' || this.state === 'HOLD' || this.state === 'LOCKOUT' || this.state === 'ESTOP') led = 'red';
    else if (this.state === 'TEST' || this.state === 'TREAT' || this.state === 'CONFIRM') led = 'yellow';
    this.out.led = led;

    const shouldSound = this.state === 'LOCKOUT' || this.state === 'ESTOP' || empty;
    this.out.siren = shouldSound && this.clock >= this.sirenSilencedUntil;

    this.v3LockReason = this.out.v3 ? null : this.v3Interlock(i);
  }

  private recordBatch(
    ph: number, tds: number, result: BatchResult, destination: BatchDestination,
    fail: FailReason, batchNo = this.batchNo, startedAt = this.batchStartedAt,
  ) {
    this.batches.push({
      batch_no: batchNo,
      started_at: new Date(startedAt).toISOString(),
      ended_at: new Date(this.now()).toISOString(),
      avg_ph: round2(ph),
      avg_tds: Math.round(tds),
      result,
      destination,
      volume_l: this.config.batchL,
      fail_reason: fail,
    });
  }

  private closeCycle(i: SensorInputs) {
    if (!this.cycleStart) return;
    this.cycles.push({
      cycle_no: this.cycleNo,
      started_at: new Date(this.cycleStart.at).toISOString(),
      released_at: new Date(this.now()).toISOString(),
      start_ph: round2(this.cycleStart.ph),
      end_ph: round2(i.tankPh),
      end_tds: Math.round(i.tankTds),
      neutraliser_used_pct: round2(Math.max(0, this.cycleStart.pct - i.neutraliserPct)),
      volume_released_l: round2(this.tankAtRelease),
    });
    this.cycleStart = null;
    this.tankAtRelease = 0;
  }

  private emit(type: DeviceEvent['type'], details: Record<string, unknown>) {
    this.events.push({ ts: new Date(this.now()).toISOString(), type, details });
    if (this.events.length > 500) this.events.shift();
  }

  // ------------------------------------------------------------- reporting ---

  telemetry(extra: { wifi_rssi?: number; uptime_s?: number } = {}): TelemetrySample {
    const i = this.lastInputs;
    return {
      ts: new Date(this.now()).toISOString(),
      state: this.state,
      mode: this.mode,
      estop: this.estop,
      ph: round2(i.ph),
      tds: Math.round(i.tds),
      chamber_l: round2(this.chamberL),
      tank_l: round2(this.tankL),
      tank_cap_l: this.config.tankCapL,
      tank_ph: round2(i.tankPh),
      tank_tds: Math.round(i.tankTds),
      neutraliser_pct: round2(i.neutraliserPct),
      v1: this.out.v1, v2: this.out.v2, v3: this.out.v3,
      sump_pump: this.out.sumpPump,
      dosing_pump: this.out.dosingPump || this.out.acidPump,
      siren: this.out.siren,
      led: this.out.led,
      wifi_rssi: extra.wifi_rssi ?? -60,
      uptime_s: extra.uptime_s ?? Math.floor(this.clock / 1000),
    };
  }

  drainEvents(): DeviceEvent[] { const e = this.events; this.events = []; return e; }
  drainBatches(): BatchRecord[] { const b = this.batches; this.batches = []; return b; }
  drainCycles(): TreatmentCycleRecord[] { const c = this.cycles; this.cycles = []; return c; }
  drainVerdicts(): CommandVerdict[] { const v = this.verdicts; this.verdicts = []; return v; }
}

/** Shared by the controller, the edge functions and the Settings form. */
export function validateConfig(c: ControllerConfig): string | null {
  if (!(c.phMin >= 6.0 && c.phMin <= 7.0)) return 'ph_min must be between 6.0 and 7.0';
  if (!(c.phMax >= 8.0 && c.phMax <= 9.5)) return 'ph_max must be between 8.0 and 9.5';
  if (c.phMax <= c.phMin) return 'ph_max must be above ph_min';
  if (!(c.tdsMax >= 500 && c.tdsMax <= 2000)) return 'tds_max must be between 500 and 2000 mg/L';
  if (!(c.treatTargetPh > c.phMin && c.treatTargetPh < c.phMax)) return 'treat_target_ph must sit inside the pass band';
  if (!(c.testWindowS >= 1 && c.testWindowS <= 60)) return 'test_window_s must be between 1 and 60 s';
  if (!(c.stableWindowS >= 1 && c.stableWindowS <= 60)) return 'stable_window_s must be between 1 and 60 s';
  if (!(c.batchL >= 10 && c.batchL <= 10000)) return 'batch_l must be between 10 and 10000 L';
  if (!(c.tankCapL >= 50 && c.tankCapL <= 100000)) return 'tank_cap_l must be between 50 and 100000 L';
  if (!(c.phWarnMax >= 7.0 && c.phWarnMax <= 10.0)) return 'ph_warn_max must be between 7.0 and 10.0';
  if (!(c.neutraliserLowPct >= 1 && c.neutraliserLowPct <= 90)) return 'neutraliser_low_pct must be between 1 and 90';
  return null;
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
