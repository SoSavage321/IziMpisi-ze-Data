import { describe, it, expect } from 'vitest';
import {
  DOSE_MS, FULL_CM, FULL_HOLD_MS, TANK_CAP_L,
  initialTreatment, isDosing, isReleasing, stepTreatment,
  type TreatmentState,
} from './treatment.ts';

const T0 = 1_000_000;

/** Feed n readings, `ms` apart, and return the resulting state. */
function run(s: TreatmentState, n: number, input: { contaminated: boolean; tankCm: number | null }, ms = 500, from = T0) {
  let out = s;
  for (let i = 0; i < n; i++) out = stepTreatment(out, { ...input, now: from + i * ms });
  return out;
}

describe('fullness is confirmed over time, not from one reading', () => {
  it('does not call the chamber full on a single reading below the mark', () => {
    const s = stepTreatment(initialTreatment(), { contaminated: true, tankCm: 3.0, now: T0 });
    expect(s.fullConfirmed).toBe(false);
  });

  it('confirms only once the depth has held below the mark long enough', () => {
    let s = stepTreatment(initialTreatment(), { contaminated: true, tankCm: 3.0, now: T0 });
    s = stepTreatment(s, { contaminated: true, tankCm: 3.0, now: T0 + FULL_HOLD_MS - 1 });
    expect(s.fullConfirmed).toBe(false);
    s = stepTreatment(s, { contaminated: true, tankCm: 3.0, now: T0 + FULL_HOLD_MS });
    expect(s.fullConfirmed).toBe(true);
  });

  it('restarts the timer if the depth comes back up before the hold elapses', () => {
    let s = stepTreatment(initialTreatment(), { contaminated: true, tankCm: 3.0, now: T0 });
    s = stepTreatment(s, { contaminated: true, tankCm: 9.0, now: T0 + 1000 });
    expect(s.fullSince).toBeNull();
    s = stepTreatment(s, { contaminated: true, tankCm: 3.0, now: T0 + 1500 });
    s = stepTreatment(s, { contaminated: true, tankCm: 3.0, now: T0 + 1500 + FULL_HOLD_MS - 1 });
    expect(s.fullConfirmed).toBe(false);
  });

  it('a null depth neither starts the timer nor clears a confirmed state', () => {
    let s = run(initialTreatment(), 8, { contaminated: true, tankCm: 3.0 });
    expect(s.fullConfirmed).toBe(true);
    // Step on without advancing far enough to finish the dose, so the only
    // thing under test is what the null reading did to the fullness state.
    s = stepTreatment(s, { contaminated: true, tankCm: null, now: T0 + 4000 });
    expect(s.fullConfirmed).toBe(true);        // a dead sensor cannot un-fill it
    expect(s.fullSince).not.toBeNull();

    const fresh = stepTreatment(initialTreatment(), { contaminated: true, tankCm: null, now: T0 });
    expect(fresh.fullSince).toBeNull();
    expect(fresh.fullConfirmed).toBe(false);
  });

  it('survives a nonsense depth without throwing or latching', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const s = stepTreatment(initialTreatment(), { contaminated: true, tankCm: bad, now: T0 });
      expect(s.fullConfirmed).toBe(false);
    }
  });
});

describe('the batch is dosed before any of it is released', () => {
  it('runs the pump the moment contaminated water enters the chamber', () => {
    const s = stepTreatment(initialTreatment(), { contaminated: true, tankCm: 12, now: T0 });
    expect(s.phase).toBe('filling');
    expect(isDosing(s)).toBe(true);           // the pump, from the first drop in
    expect(isReleasing(s)).toBe(false);       // and V3 stays shut
  });

  it('keeps V3 shut for the whole dose', () => {
    let s = stepTreatment(initialTreatment(), { contaminated: true, tankCm: 12, now: T0 });
    s = stepTreatment(s, { contaminated: false, tankCm: 12, now: T0 + 500 });
    expect(s.phase).toBe('dosing');
    s = stepTreatment(s, { contaminated: false, tankCm: 12, now: T0 + 500 + DOSE_MS - 1 });
    expect(isReleasing(s)).toBe(false);
    expect(isDosing(s)).toBe(true);
    s = stepTreatment(s, { contaminated: false, tankCm: 12, now: T0 + 500 + DOSE_MS });
    expect(s.phase).toBe('releasing');
    expect(s.treated).toBe(true);
    expect(isDosing(s)).toBe(false);          // the pump stops when V3 opens
  });

  it('drains to empty and returns to idle', () => {
    let s = stepTreatment(initialTreatment(), { contaminated: true, tankCm: 12, now: T0 });
    s = stepTreatment(s, { contaminated: false, tankCm: 12, now: T0 + 500 });
    s = stepTreatment(s, { contaminated: false, tankCm: 12, now: T0 + 500 + DOSE_MS });
    s = run(s, 60, { contaminated: false, tankCm: 12 }, 500, T0 + 20_000);
    expect(s.phase).toBe('idle');
    expect(s.litres).toBe(0);
  });
});

describe('a full chamber never stops the flow indefinitely', () => {
  it('treats and releases even while the node still reports FAIL', () => {
    // Contaminated without pause, and the chamber confirmed full.
    let s = run(initialTreatment(), 8, { contaminated: true, tankCm: FULL_CM - 1 });
    expect(s.fullConfirmed).toBe(true);
    expect(s.phase).toBe('dosing');            // filling ended on the full state

    s = stepTreatment(s, { contaminated: true, tankCm: FULL_CM - 1, now: T0 + 4000 + DOSE_MS });
    expect(s.phase).toBe('releasing');         // it discharges rather than stalling

    // Draining empties it, and because the node is still reporting FAIL the
    // next batch starts immediately: the cycle repeats rather than latching.
    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) {
      s = stepTreatment(s, { contaminated: true, tankCm: FULL_CM - 1, now: T0 + 40_000 + i * 500 });
      seen.add(s.phase);
    }
    expect(seen.has('idle')).toBe(true);       // it did reach empty
    // It took the next batch. With the depth pinned below the mark, that batch
    // re-confirms full within the hold and goes straight on to dosing, so the
    // point is that it is working again — not which of the two it is caught in.
    expect(['filling', 'dosing']).toContain(s.phase);
  });

  it('caps at the chamber capacity and treats rather than overfilling', () => {
    // No depth reading at all, so the capacity cap is the only thing that can
    // end the filling phase. It must still dose and discharge.
    let s = initialTreatment();
    const seen = new Set<string>();
    let peak = 0;
    for (let i = 0; i < 200; i++) {
      s = stepTreatment(s, { contaminated: true, tankCm: null, now: T0 + i * 500 });
      seen.add(s.phase);
      peak = Math.max(peak, s.litres);
    }
    expect(peak).toBeLessThanOrEqual(TANK_CAP_L);
    expect(seen.has('dosing')).toBe(true);
    expect(seen.has('releasing')).toBe(true);
  });
});

describe('the reagent is only drawn while dosing', () => {
  it('draws down during the dose and holds steady once released', () => {
    let s = stepTreatment(initialTreatment(), { contaminated: true, tankCm: 12, now: T0 });
    const afterFirst = s.reagentPct;
    expect(afterFirst).toBeLessThan(100);

    s = stepTreatment(s, { contaminated: false, tankCm: 12, now: T0 + 500 });
    s = stepTreatment(s, { contaminated: false, tankCm: 12, now: T0 + 500 + DOSE_MS });
    const atRelease = s.reagentPct;
    s = stepTreatment(s, { contaminated: false, tankCm: 12, now: T0 + 30_000 });
    expect(s.reagentPct).toBe(atRelease);
  });
});
