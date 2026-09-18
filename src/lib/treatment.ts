/**
 * The treatment cycle for a node whose neutralising stage is simulated.
 *
 * Kept pure and separate from the store so the timing rules — how long a
 * depth must hold before the chamber counts as full, and that a batch is
 * fully dosed before any of it is released — can be tested directly rather
 * than watched on screen.
 *
 * It decides nothing about water quality. The contamination verdict arrives
 * from the node; this only sequences what happens afterwards.
 */

/** Depth to the surface, in cm, below which the chamber counts as full. */
export const FULL_CM = 4.5;
/** The depth must hold below FULL_CM this long before the state is believed. */
export const FULL_HOLD_MS = 2000;
/** How long a batch is dosed before V3 may open. */
export const DOSE_MS = 8000;
export const TANK_CAP_L = 300;

const FILL_RATE_L = 6;
const DRAIN_RATE_L = 12;
const DOSE_DRAW_PCT = 0.6;

export type Phase = 'idle' | 'filling' | 'dosing' | 'releasing';

export interface TreatmentState {
  phase: Phase;
  /** When the current phase began. */
  since: number;
  litres: number;
  treated: boolean;
  reagentPct: number;
  /** When the depth first went below the full mark, or null if it has not. */
  fullSince: number | null;
  /** Latched once the depth has held below the mark long enough. */
  fullConfirmed: boolean;
}

export function initialTreatment(): TreatmentState {
  return {
    phase: 'idle', since: 0, litres: 0, treated: false,
    reagentPct: 100, fullSince: null, fullConfirmed: false,
  };
}

/**
 * Fullness, confirmed over time rather than from one sample.
 *
 * An ultrasonic head returns the occasional wild figure, and `pulseIn` timing
 * out sends null, so a single reading is not evidence. A null is treated as
 * "no information": it neither starts the timer nor clears a state already
 * confirmed, so a sensor dropping out mid-batch cannot silently un-fill the
 * chamber. The confirmation is cleared when the batch finishes draining.
 */
function trackFullness(s: TreatmentState, tankCm: number | null, now: number) {
  if (tankCm === null || !Number.isFinite(tankCm) || tankCm <= 0) return;

  if (tankCm < FULL_CM) {
    if (s.fullSince === null) s.fullSince = now;
    if (now - s.fullSince >= FULL_HOLD_MS) s.fullConfirmed = true;
  } else {
    s.fullSince = null;
    s.fullConfirmed = false;
  }
}

/**
 * Advance the cycle by one reading.
 *
 *   filling    V2 across, the failed batch arriving, the pump dosing it
 *   dosing     nothing more arriving; finish the dose before releasing
 *   releasing  V3 open, treated water to the river, the chamber draining
 *
 * A confirmed-full chamber ends the filling phase even while the node still
 * reports FAIL. Waiting for clean water before treating would leave a full
 * chamber with nowhere to put the next batch, which is the one way this can
 * deadlock.
 */
export function stepTreatment(
  prev: TreatmentState,
  input: { contaminated: boolean; tankCm: number | null; now: number },
): TreatmentState {
  const s: TreatmentState = { ...prev };
  const { contaminated, tankCm, now } = input;

  trackFullness(s, tankCm, now);

  switch (s.phase) {
    case 'idle':
      if (contaminated) { s.phase = 'filling'; s.since = now; s.treated = false; }
      break;

    case 'filling':
      s.litres = Math.min(TANK_CAP_L, s.litres + FILL_RATE_L);
      if (s.fullConfirmed || !contaminated || s.litres >= TANK_CAP_L) {
        s.phase = 'dosing';
        s.since = now;
      }
      break;

    case 'dosing':
      if (now - s.since >= DOSE_MS) {
        s.treated = true;
        s.phase = 'releasing';
        s.since = now;
      }
      break;

    case 'releasing':
      s.litres = Math.max(0, s.litres - DRAIN_RATE_L);
      if (s.litres === 0) {
        s.phase = 'idle';
        s.treated = false;
        // The chamber is empty, so whatever the sensor last said, it is not
        // full. Clearing it here rather than from a reading is what stops a
        // dead sensor latching the cycle shut.
        s.fullConfirmed = false;
        s.fullSince = null;
      }
      break;
  }

  if (isDosing(s)) s.reagentPct = Math.max(0, s.reagentPct - DOSE_DRAW_PCT);
  return s;
}

/**
 * The dosing pump runs from the moment contaminated water enters the chamber,
 * through the dose itself. It is a pump, not a valve: it never moves water
 * between stages, it only treats what is already there.
 */
export function isDosing(s: TreatmentState): boolean {
  return s.phase === 'filling' || s.phase === 'dosing';
}

/** V3 opens only once the batch has been dosed, never during it. */
export function isReleasing(s: TreatmentState): boolean {
  return s.phase === 'releasing';
}
