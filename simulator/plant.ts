/**
 * The physics the controller deliberately does not model.
 *
 * This is a crude but honest model of a sump, a check chamber, a dosing
 * reservoir and a treatment tank. It exists so the whole system — firmware
 * logic, API, alarm rules, dashboard — can be exercised end to end before the
 * hardware is built, and so a demo can be driven into a specific fault on cue.
 */

import { Outputs } from '../shared/controller.ts';
import { SensorInputs } from '../shared/types.ts';

export type ScenarioName =
  | 'normal'
  | 'acid_event'
  | 'high_tds'
  | 'tank_full'
  | 'neutraliser_empty'
  | 'sensor_stuck'
  | 'offline';

export interface PlantOptions {
  scenario: ScenarioName;
  /** Litres in the neutraliser drum, for turning % into litres. */
  reservoirLitres?: number;
  seed?: number;
}

/** Deterministic noise, so two runs of the same scenario tell the same story. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Plant {
  /** What the probes read. */
  i: SensorInputs = { ph: 6.9, tds: 480, tankPh: 7.0, tankTds: 480, neutraliserPct: 92 };

  /** True inflow quality, before probe noise. */
  private inflowPh = 6.9;
  private inflowTds = 480;
  private rnd: () => number;
  private t = 0;
  private stuckAt: { ph: number; tds: number } | null = null;

  constructor(private opts: PlantOptions) {
    this.rnd = mulberry32(opts.seed ?? 42);
    this.applyScenarioStart();
  }

  private applyScenarioStart() {
    switch (this.opts.scenario) {
      case 'acid_event':
        this.inflowPh = 3.6;          // an AMD slug arrives at the sump
        this.inflowTds = 900;
        break;
      case 'high_tds':
        this.inflowTds = 1550;        // salty water the tank cannot fix
        break;
      case 'neutraliser_empty':
        this.i.neutraliserPct = 1.5;  // about to run out mid-treatment
        this.inflowPh = 4.0;
        break;
      case 'tank_full':
        this.inflowPh = 4.2;          // every batch fails; the tank backs up
        break;
      case 'sensor_stuck':
        this.stuckAt = { ph: 7.02, tds: 511 };
        break;
    }
  }

  /**
   * Advance the water by dt seconds given what the controller is driving.
   * `chamberL` and `tankL` come from the controller, which is counting litres.
   */
  step(dt: number, out: Outputs, tankL: number, chamberL: number) {
    this.t += dt;

    // Inflow quality wanders slowly; mine water is not a constant.
    if (this.opts.scenario === 'normal' || this.opts.scenario === 'offline') {
      this.inflowPh += (this.rnd() - 0.5) * 0.06 * dt;
      this.inflowTds += (this.rnd() - 0.5) * 14 * dt;
      // Every so often the sump throws a genuinely bad batch.
      if (this.rnd() < 0.0015 * dt * 60) {
        this.inflowPh = 4 + this.rnd() * 1.6;
        this.inflowTds = 700 + this.rnd() * 900;
      }
      // ...and drifts back toward something typical.
      this.inflowPh += (6.9 - this.inflowPh) * 0.02 * dt;
      this.inflowTds += (520 - this.inflowTds) * 0.02 * dt;
    }

    this.inflowPh = clamp(this.inflowPh, 2.5, 10.5);
    this.inflowTds = clamp(this.inflowTds, 120, 2200);

    // ---- dosing moves the tank -------------------------------------------
    const reservoir = this.opts.reservoirLitres ?? 20;
    if (out.dosingPump && this.i.neutraliserPct > 0) {
      const litres = 0.05 * dt;                       // dosing pump ~3 L/min
      this.i.neutraliserPct = Math.max(0, this.i.neutraliserPct - (litres / reservoir) * 100);
      // A given slug shifts a small tank more than a large one.
      const strength = tankL > 0 ? (litres * 900) / Math.max(20, tankL) : 0;
      this.i.tankPh += strength;
    }
    if (out.acidPump) {
      const litres = 0.04 * dt;
      const strength = tankL > 0 ? (litres * 900) / Math.max(20, tankL) : 0;
      this.i.tankPh -= strength;
    }

    // Mixing drags the tank gently toward uniform; TDS never improves.
    this.i.tankPh += (this.rnd() - 0.5) * 0.01 * dt;
    this.i.tankPh = clamp(this.i.tankPh, 1, 13);
    if (tankL <= 0.01) {
      // empty tank: the probe sits in air, reading its last value
      this.i.tankTds = this.i.tankTds;
    }

    // ---- what the probes report ------------------------------------------
    if (this.stuckAt) {
      // A fouled probe: a plausible value that never moves again.
      this.i.ph = this.stuckAt.ph;
      this.i.tds = this.stuckAt.tds;
    } else {
      this.i.ph = clamp(this.inflowPh + (this.rnd() - 0.5) * 0.04, 0, 14);
      this.i.tds = Math.max(0, this.inflowTds + (this.rnd() - 0.5) * 12);
    }

    // The controller blends the tank as water arrives; mirror that here so the
    // probe agrees with the contents.
    if (out.v2 && chamberL > 0) {
      const moved = Math.min(25 * dt, chamberL);
      const total = tankL + moved;
      if (total > 0) {
        this.i.tankPh = (this.i.tankPh * tankL + this.i.ph * moved) / total;
        this.i.tankTds = (this.i.tankTds * tankL + this.i.tds * moved) / total;
      }
    }
  }

  /** Operator refills the drum. */
  refill(pct = 100) { this.i.neutraliserPct = pct; }

  /** Scenario hooks the CLI can fire mid-run. */
  injectAcid(ph = 3.8) { this.inflowPh = ph; }
  injectAlkaline(ph = 9.3) { this.inflowPh = ph; }
  injectSalt(tds = 1600) { this.inflowTds = tds; }
  /**
   * Clean feed: water that is already inside the release band. The batch
   * passes, V1 opens and it goes to the river untreated — the other half of
   * the story, which the fault buttons alone never show.
   */
  cleanInflow(ph = 7.1, tds = 430) { this.inflowPh = ph; this.inflowTds = tds; }
  stickProbe() { this.stuckAt = { ph: this.i.ph, tds: this.i.tds }; }
  unstickProbe() { this.stuckAt = null; }
}

function clamp(v: number, a: number, b: number) { return Math.max(a, Math.min(b, v)); }
