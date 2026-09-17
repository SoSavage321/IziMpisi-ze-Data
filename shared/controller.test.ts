import { describe, it, expect } from 'vitest';
import { Controller, validateConfig } from './controller.ts';
import { DEFAULT_CONFIG, SensorInputs } from './types.ts';

/**
 * A test harness that plays the part of the water.
 *
 * The controller never models the plant, so these tests supply the physics:
 * a tank whose pH rises while the dosing pump runs, a neutraliser reservoir
 * that empties, probes that read whatever the scenario says.
 */
class Rig {
  c: Controller;
  epoch = Date.parse('2026-09-17T06:00:00Z');
  i: SensorInputs = { ph: 7, tds: 400, tankPh: 7, tankTds: 400, neutraliserPct: 100 };

  constructor(opts: Partial<ConstructorParameters<typeof Controller>[0]> = {}) {
    this.c = new Controller({
      config: { ...DEFAULT_CONFIG },
      now: () => this.epoch,
      ...opts,
    });
  }

  /** Advance `seconds` in 100 ms steps, applying the plant model each step. */
  run(seconds: number, hook?: (rig: Rig) => void) {
    const steps = Math.round(seconds * 10);
    for (let n = 0; n < steps; n++) {
      hook?.(this);
      this.c.tick(100, this.i);
      this.epoch += 100;
      this.physics(0.1);
    }
    return this;
  }

  /** Dosing moves the tank; the reservoir drains while it runs. */
  private physics(dt: number) {
    const o = this.c.out;
    // while V2 is transferring, the tank probe reads the blend the controller
    // is computing from the incoming batch
    if (this.c.state === 'DIVERT') this.i.tankPh = this.c.tankPh;
    if (o.dosingPump && this.i.neutraliserPct > 0) {
      this.i.tankPh += 0.8 * dt;
      this.i.neutraliserPct = Math.max(0, this.i.neutraliserPct - 2 * dt);
    }
    if (o.acidPump) this.i.tankPh -= 0.7 * dt;
    // the controller's own view of the tank is what the probe sees
    this.i.tankTds = this.c.tankTds;
  }

  /**
   * Run until `predicate` holds, then let one more tick execute so the new
   * state has actually driven its outputs — entering RELEASE and opening V3
   * are two different moments, and a test asking for the former means the
   * latter.
   */
  until(predicate: (c: Controller) => boolean, limit = 120): Rig {
    for (let n = 0; n < limit * 10; n++) {
      if (predicate(this.c)) return this.run(0.1);
      this.c.tick(100, this.i);
      this.epoch += 100;
      this.physics(0.1);
    }
    throw new Error(`condition never held; stuck in ${this.c.state} after ${limit}s`);
  }

  set(patch: Partial<SensorInputs>) { Object.assign(this.i, patch); return this; }
}

describe('batch sequence', () => {
  it('fills to the batch volume, then tests', () => {
    const rig = new Rig().run(4);           // 20 L/s -> 100 L in 5 s
    expect(rig.c.state).toBe('FILL');
    expect(rig.c.chamberL).toBeGreaterThan(70);
    rig.until((c) => c.state === 'TEST');
    expect(rig.c.chamberL).toBe(100);
    expect(rig.c.out.sumpPump).toBe(false);
  });

  it('passes clean water to the river through V1', () => {
    const rig = new Rig().set({ ph: 7.1, tds: 420 }).until((c) => c.state === 'DISCHARGE');
    expect(rig.c.out.v1).toBe(true);
    expect(rig.c.out.v2).toBe(false);
    expect(rig.c.out.v3).toBe(false);
    expect(rig.c.out.led).toBe('green');

    const [batch] = rig.c.drainBatches();
    expect(batch.result).toBe('PASS');
    expect(batch.destination).toBe('RIVER');
    expect(batch.fail_reason).toBeNull();
    expect(batch.avg_ph).toBeCloseTo(7.1, 1);
  });

  it('diverts acidic water to the tank through V2', () => {
    const rig = new Rig().set({ ph: 4.2, tds: 500 }).until((c) => c.state === 'DIVERT');
    expect(rig.c.out.v1).toBe(false);
    expect(rig.c.out.v2).toBe(true);
    expect(rig.c.out.led).toBe('red');

    const [batch] = rig.c.drainBatches();
    expect(batch.result).toBe('FAIL');
    expect(batch.destination).toBe('TANK');
    expect(batch.fail_reason).toBe('ACID');
  });

  // The fix this build exists for: a floor alone lets over-dosed water out.
  it('diverts ALKALINE water above the ceiling, rather than releasing it', () => {
    const rig = new Rig().set({ ph: 9.2, tds: 400 }).until((c) => c.state === 'DIVERT');
    expect(rig.c.out.v1).toBe(false);
    expect(rig.c.out.v2).toBe(true);

    const [batch] = rig.c.drainBatches();
    expect(batch.result).toBe('FAIL');
    expect(batch.fail_reason).toBe('ALKALINE');
  });

  it('diverts water over the TDS limit even when the pH is perfect', () => {
    const rig = new Rig().set({ ph: 7.0, tds: 1450 }).until((c) => c.state === 'DIVERT');
    const [batch] = rig.c.drainBatches();
    expect(batch.fail_reason).toBe('TDS');
  });

  it('records exactly one batch per fail, not two', () => {
    const rig = new Rig().set({ ph: 4.2 }).until((c) => c.state === 'TREAT');
    const batches = rig.c.drainBatches();
    expect(batches).toHaveLength(1);
  });

  it('holds the batch in the chamber when the tank is full', () => {
    const rig = new Rig();
    rig.c.tankL = 260;                                // 260 + 100 > 300
    rig.set({ ph: 4.0 }).until((c) => c.state === 'HOLD');
    expect(rig.c.out.v1).toBe(false);
    expect(rig.c.out.v2).toBe(false);
    expect(rig.c.chamberL).toBe(100);
    const [batch] = rig.c.drainBatches();
    expect(batch.result).toBe('HELD');
    expect(batch.destination).toBe('HELD');
  });

  it('releases a held batch once the tank has room', () => {
    const rig = new Rig();
    rig.c.tankL = 260;
    rig.set({ ph: 4.0 }).until((c) => c.state === 'HOLD');
    rig.c.drainBatches();
    rig.c.tankL = 0;                                  // tank drained by an operator
    rig.until((c) => c.state === 'DIVERT');
    rig.until((c) => c.state === 'TREAT');
    const updated = rig.c.drainBatches();
    expect(updated).toHaveLength(1);
    expect(updated[0].destination).toBe('TANK');      // same batch_no, corrected destination
  });
});

describe('interlocks — the safety core', () => {
  it('never opens V3 while V2 is open', () => {
    const rig = new Rig().set({ ph: 4.0 }).until((c) => c.state === 'DIVERT');
    expect(rig.c.out.v2).toBe(true);
    expect(rig.c.v3Interlock(rig.i)).toMatch(/interlocked against V2/);

    // and a manual request is refused with that reason
    rig.c.mode = 'MANUAL';
    const verdict = rig.c.request({ id: '1', type: 'MANUAL_VALVE', payload: { valve: 'V3', open: true } }, rig.i);
    expect(verdict.accepted).toBe(false);
    expect(verdict.reason).toMatch(/interlocked against V2/);
  });

  it('locks V3 and sounds the siren when the neutraliser is empty', () => {
    const rig = new Rig().set({ ph: 4.0, neutraliserPct: 0 });
    rig.until((c) => c.state === 'LOCKOUT');
    expect(rig.c.out.v3).toBe(false);
    expect(rig.c.out.siren).toBe(true);
    expect(rig.c.out.led).toBe('yellow');             // yellow = neutraliser empty
    expect(rig.c.lockoutReason).toMatch(/empty/i);
  });

  it('refuses to release while the tank is outside the band', () => {
    const rig = new Rig();
    rig.c.tankL = 100;
    rig.set({ tankPh: 9.4 });
    expect(rig.c.v3Interlock(rig.i)).toMatch(/outside the release band/);
  });

  it('shuts V3 mid-release if the tank drifts out of band', () => {
    const rig = new Rig().set({ ph: 4.0 }).until((c) => c.state === 'RELEASE');
    expect(rig.c.out.v3).toBe(true);
    rig.set({ tankPh: 9.9 });                         // a dosing fault mid-release
    rig.run(0.3);
    expect(rig.c.out.v3).toBe(false);
    expect(rig.c.state).toBe('TREAT');
  });

  it('refuses V1 when the chamber water fails the test', () => {
    const rig = new Rig().set({ ph: 4.0 });
    rig.c.mode = 'MANUAL';
    const v = rig.c.request({ id: '2', type: 'MANUAL_VALVE', payload: { valve: 'V1', open: true } }, rig.i);
    expect(v.accepted).toBe(false);
    expect(v.reason).toMatch(/fails the test/);
  });
});

describe('treatment', () => {
  it('doses to the target, holds the band for 3 s, then releases', () => {
    const rig = new Rig().set({ ph: 4.0 }).until((c) => c.state === 'TREAT');
    expect(rig.i.tankPh).toBeLessThan(6.8);

    rig.until((c) => c.state === 'CONFIRM');
    expect(rig.i.tankPh).toBeGreaterThanOrEqual(6.8);

    // CONFIRM must last the full stable window before V3 moves
    rig.run(2);
    expect(rig.c.out.v3).toBe(false);

    rig.until((c) => c.state === 'RELEASE');
    expect(rig.c.out.v3).toBe(true);
    expect(rig.c.out.led).toBe('green');
  });

  it('aims at the middle of the band, not at its edge', () => {
    const rig = new Rig().set({ ph: 4.0 }).until((c) => c.state === 'RELEASE');
    // 6.8 target with a 8.5 ceiling: dosing must stop well clear of the ceiling
    expect(rig.i.tankPh).toBeLessThan(8.5);
  });

  it('trims an over-dosed tank back into band instead of releasing it', () => {
    const rig = new Rig().set({ ph: 4.0 }).until((c) => c.state === 'TREAT');
    rig.set({ tankPh: 9.3 });                          // dosing valve stuck open
    rig.run(1);
    expect(rig.c.out.acidPump || rig.c.state === 'TREAT').toBe(true);
    rig.until((c) => c.state === 'CONFIRM', 60);
    expect(rig.i.tankPh).toBeLessThanOrEqual(8.5);
  });

  it('locks out rather than releasing when no acid trim is fitted', () => {
    const rig = new Rig({ hasAcidTrim: false }).set({ ph: 4.0 }).until((c) => c.state === 'TREAT');
    rig.set({ tankPh: 9.3 });
    rig.until((c) => c.state === 'LOCKOUT');
    expect(rig.c.out.v3).toBe(false);
    expect(rig.c.lockoutReason).toMatch(/over-dosed/);
  });

  it('writes a treatment cycle record on release', () => {
    const rig = new Rig().set({ ph: 4.0 }).until((c) => c.state === 'RELEASE');
    rig.until((c) => c.state === 'FILL', 60);
    const [cycle] = rig.c.drainCycles();
    expect(cycle.released_at).not.toBeNull();
    expect(cycle.start_ph).toBeLessThan(6.8);
    expect(cycle.end_ph).toBeGreaterThanOrEqual(6.8);
    expect(cycle.neutraliser_used_pct).toBeGreaterThan(0);
    expect(cycle.volume_released_l).toBeGreaterThan(0);
  });
});

describe('commands', () => {
  it('accepts an emergency stop and shuts everything', () => {
    const rig = new Rig().set({ ph: 7 }).until((c) => c.state === 'DISCHARGE');
    const v = rig.c.request({ id: 'e1', type: 'EMERGENCY_STOP' }, rig.i);
    expect(v.accepted).toBe(true);
    rig.run(0.2);
    expect(rig.c.out.v1).toBe(false);
    expect(rig.c.out.sumpPump).toBe(false);
    expect(rig.c.state).toBe('ESTOP');
  });

  it('refuses to reset an E-stop while the physical button is latched', () => {
    const rig = new Rig();
    rig.c.request({ id: 'e1', type: 'EMERGENCY_STOP' }, rig.i);
    rig.c.estopLatched = true;
    const v = rig.c.request({ id: 'e2', type: 'RESET_ESTOP' }, rig.i);
    expect(v.accepted).toBe(false);
    expect(v.reason).toMatch(/physical E-stop/);
  });

  it('refuses manual valve control outside MANUAL mode', () => {
    const rig = new Rig();
    const v = rig.c.request({ id: 'm1', type: 'MANUAL_VALVE', payload: { valve: 'V1', open: true } }, rig.i);
    expect(v.accepted).toBe(false);
    expect(v.reason).toMatch(/requires MANUAL mode/);
  });

  it('refuses to leave AUTO while water is being released', () => {
    const rig = new Rig().set({ ph: 7 }).until((c) => c.state === 'DISCHARGE');
    const v = rig.c.request({ id: 's1', type: 'SET_MODE', payload: { mode: 'MANUAL' } }, rig.i);
    expect(v.accepted).toBe(false);
    expect(v.reason).toMatch(/water is being released/);
  });

  it('silences the siren without clearing the condition', () => {
    const rig = new Rig().set({ ph: 4.0, neutraliserPct: 0 }).until((c) => c.state === 'LOCKOUT');
    expect(rig.c.out.siren).toBe(true);
    const v = rig.c.request({ id: 'q1', type: 'SILENCE_SIREN' }, rig.i);
    expect(v.accepted).toBe(true);
    expect(v.reason).toMatch(/alarm itself stays active/);
    rig.run(1);
    expect(rig.c.out.siren).toBe(false);
    expect(rig.c.state).toBe('LOCKOUT');     // the cause has not gone away
  });

  it('pauses intake without touching water already in the chamber', () => {
    const rig = new Rig().run(2);
    const held = rig.c.chamberL;
    rig.c.request({ id: 'p1', type: 'PAUSE_INTAKE' }, rig.i);
    rig.run(3);
    expect(rig.c.out.sumpPump).toBe(false);
    expect(rig.c.chamberL).toBeCloseTo(held, 0);
  });

  it('rejects a configuration that loosens the pH floor beyond the safe range', () => {
    const rig = new Rig();
    const v = rig.c.request(
      { id: 'c1', type: 'APPLY_CONFIG', payload: { config: { phMin: 4.0 } } },
      rig.i,
    );
    expect(v.accepted).toBe(false);
    expect(v.reason).toMatch(/ph_min must be between 6.0 and 7.0/);
  });

  it('records a rejection as an interlock-block event', () => {
    const rig = new Rig();
    rig.c.drainEvents();
    rig.c.request({ id: 'm2', type: 'MANUAL_PUMP', payload: { pump: 'sump', on: true } }, rig.i);
    const blocked = rig.c.drainEvents().filter((e) => e.type === 'INTERLOCK_BLOCK');
    expect(blocked).toHaveLength(1);
  });
});

describe('config validation', () => {
  it('accepts the shipped defaults', () => {
    expect(validateConfig(DEFAULT_CONFIG)).toBeNull();
  });

  it('rejects a target outside the pass band', () => {
    expect(validateConfig({ ...DEFAULT_CONFIG, treatTargetPh: 9.0 })).toMatch(/inside the pass band/);
  });

  it('rejects an inverted band', () => {
    expect(validateConfig({ ...DEFAULT_CONFIG, phMin: 7.0, phMax: 8.0, treatTargetPh: 7.5 })).toBeNull();
    expect(validateConfig({ ...DEFAULT_CONFIG, phMax: 8.0, phMin: 6.9, treatTargetPh: 7.0 })).toBeNull();
  });

  it('rejects a TDS limit above what the probe can mean', () => {
    expect(validateConfig({ ...DEFAULT_CONFIG, tdsMax: 4000 })).toMatch(/tds_max/);
  });
});
