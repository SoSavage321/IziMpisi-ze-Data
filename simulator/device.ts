/**
 * One virtual WaterGuard controller.
 *
 * It runs the same state machine as the firmware (shared/controller.ts), keeps
 * the same 200-record offline ring buffer, posts to the same endpoints, and
 * answers commands with the same accepted/rejected verdicts. If the dashboard
 * can be driven correctly against this, it can be driven against the hardware.
 */

import { Controller } from '../shared/controller.ts';
import { DEFAULT_CONFIG, TelemetrySample, BatchRecord, TreatmentCycleRecord, DeviceEvent, CommandVerdict } from '../shared/types.ts';
import { Plant, ScenarioName } from './plant.ts';

const RING_CAPACITY = 200;      // same as the ESP32 ring buffer
const TELEMETRY_EVERY_MS = 5000;
const POLL_EVERY_MS = 2000;

export interface DeviceOptions {
  name: string;
  apiBase: string | null;
  apiKey: string | null;
  scenario: ScenarioName;
  seed: number;
  /** Wall-clock multiplier: 10 means one simulated minute per six seconds. */
  speed: number;
  verbose: boolean;
  firmwareVersion?: string;
}

export class VirtualDevice {
  readonly controller: Controller;
  private plant: Plant;
  private clock: number;

  // offline buffers (the firmware's ring buffer, in TypeScript)
  private telemetryRing: TelemetrySample[] = [];
  private batchQueue: BatchRecord[] = [];
  private cycleQueue: TreatmentCycleRecord[] = [];
  private eventQueue: DeviceEvent[] = [];
  private ackQueue: CommandVerdict[] = [];

  private lastTelemetry = 0;
  private lastPoll = 0;
  private online = true;
  private offlineUntil = 0;
  private uptimeS = 0;
  private rssi = -58;
  private droppedSamples = 0;

  constructor(private opts: DeviceOptions) {
    this.clock = Date.now();
    this.plant = new Plant({ scenario: opts.scenario, seed: opts.seed });
    this.controller = new Controller({
      config: { ...DEFAULT_CONFIG },
      now: () => this.clock,
    });

    if (opts.scenario === 'tank_full') {
      // start with a tank that is nearly full so the HELD path is reached fast
      this.controller.tankL = 240;
      this.plant.i.tankPh = 5.4;
    }
    if (opts.scenario === 'offline') {
      this.online = false;
      this.offlineUntil = this.clock + 90_000;   // ninety seconds in the dark
    }
  }

  get name() { return this.opts.name; }
  get state() { return this.controller.state; }

  /** One simulation step. dtMs is simulated time, not wall time. */
  async tick(dtMs: number) {
    this.clock += dtMs;
    this.uptimeS += dtMs / 1000;

    this.plant.step(dtMs / 1000, this.controller.out, this.controller.tankL, this.controller.chamberL);
    this.controller.tick(dtMs, this.plant.i);

    // Collect whatever the controller produced.
    this.push(this.controller.drainBatches(), this.batchQueue);
    this.push(this.controller.drainCycles(), this.cycleQueue);
    this.push(this.controller.drainEvents(), this.eventQueue);
    this.push(this.controller.drainVerdicts(), this.ackQueue);

    // WiFi comes and goes. The control loop never stops for it.
    if (!this.online && this.clock >= this.offlineUntil) {
      this.online = true;
      this.log(`WiFi back after an outage — flushing ${this.telemetryRing.length} buffered samples`);
    }
    this.rssi = Math.round(-55 - Math.abs(Math.sin(this.clock / 90_000)) * 30);

    if (this.clock - this.lastTelemetry >= TELEMETRY_EVERY_MS) {
      this.lastTelemetry = this.clock;
      this.capture();
      if (this.online) await this.flush();
    }

    if (this.online && this.clock - this.lastPoll >= POLL_EVERY_MS) {
      this.lastPoll = this.clock;
      await this.poll();
    }
  }

  /** Take a telemetry sample into the ring buffer. */
  private capture() {
    const sample = this.controller.telemetry({
      wifi_rssi: this.rssi,
      uptime_s: Math.floor(this.uptimeS),
    });
    this.telemetryRing.push(sample);
    if (this.telemetryRing.length > RING_CAPACITY) {
      this.telemetryRing.shift();
      this.droppedSamples += 1;     // oldest data is the data we can afford to lose
    }
  }

  private push<T>(items: T[], queue: T[]) {
    for (const item of items) queue.push(item);
    // Batch and cycle records are compliance data — keep far more of them than
    // telemetry, and only ever drop the oldest under extreme pressure.
    if (queue.length > 500) queue.splice(0, queue.length - 500);
  }

  // ------------------------------------------------------------- transport ---

  private get canTalk() { return Boolean(this.opts.apiBase && this.opts.apiKey); }

  private async flush() {
    if (!this.canTalk) { this.printLocal(); this.telemetryRing = []; this.clearQueues(); return; }

    const body = {
      device_id: 'from-key',
      firmware_version: this.opts.firmwareVersion ?? 'sim-1.0.0',
      flow_sensor: false,
      config_version: this.controller.config.version,
      telemetry: this.telemetryRing,
      batches: this.batchQueue,
      cycles: this.cycleQueue,
      events: this.eventQueue,
      command_acks: this.ackQueue,
    };

    try {
      const res = await fetch(`${this.opts.apiBase}/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-device-key': this.opts.apiKey as string },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        this.log(`ingest rejected (${res.status}) — keeping the buffer`, true);
        return;                                  // keep everything; retry next time
      }

      const json = await res.json();
      if (json.alarms_raised?.length) {
        for (const a of json.alarms_raised) this.log(`server raised ${a.severity} alarm: ${a.type}`);
      }
      this.telemetryRing = [];
      this.clearQueues();
    } catch (e) {
      this.log(`ingest failed (${(e as Error).message}) — buffering`, true);
    }
  }

  private clearQueues() {
    this.batchQueue = [];
    this.cycleQueue = [];
    this.eventQueue = [];
    this.ackQueue = [];
  }

  private async poll() {
    if (!this.canTalk) return;
    try {
      const res = await fetch(`${this.opts.apiBase}/commands`, {
        headers: { 'x-device-key': this.opts.apiKey as string },
      });
      if (!res.ok) return;
      const json = await res.json();

      // Apply a newer configuration if the server has one.
      if (json.config && json.config.version > this.controller.config.version) {
        const c = json.config;
        const verdict = this.controller.request({
          id: `cfg-${c.version}`,
          type: 'APPLY_CONFIG',
          payload: {
            config: {
              version: c.version,
              phMin: c.ph_min, phMax: c.ph_max, tdsMax: c.tds_max,
              treatTargetPh: c.treat_target_ph,
              testWindowS: c.test_window_s, stableWindowS: c.stable_window_s,
              batchL: c.batch_l, tankCapL: c.tank_cap_l,
              phWarnMax: c.ph_warn_max, neutraliserLowPct: c.neutraliser_low_pct,
            },
          },
        }, this.plant.i);
        this.log(`config v${c.version}: ${verdict.reason}`);
      }

      const acks: CommandVerdict[] = [];
      for (const cmd of json.commands ?? []) {
        // The firmware, not the server, decides. A rejection is a normal answer.
        const verdict = this.controller.request({ id: cmd.id, type: cmd.type, payload: cmd.payload }, this.plant.i);
        acks.push(verdict);
        this.log(`${cmd.type} -> ${verdict.accepted ? 'ACCEPTED' : 'REJECTED'}: ${verdict.reason}`);
      }

      if (acks.length) {
        await fetch(`${this.opts.apiBase}/commands/ack`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-device-key': this.opts.apiKey as string },
          body: JSON.stringify({ acks }),
        });
        // they have been delivered; do not send them again with the next ingest
        this.ackQueue = this.ackQueue.filter((a) => !acks.find((b) => b.id === a.id));
      }
    } catch {
      /* the plant keeps running; polling resumes when the network does */
    }
  }

  // --------------------------------------------------------------- output ---

  private printLocal() {
    const t = this.telemetryRing[this.telemetryRing.length - 1];
    if (!t) return;
    const flags = [t.v1 && 'V1', t.v2 && 'V2', t.v3 && 'V3', t.sump_pump && 'SUMP', t.dosing_pump && 'DOSE', t.siren && 'SIREN']
      .filter(Boolean).join(' ');
    console.log(
      `${this.opts.name}  ${t.state.padEnd(9)} pH ${t.ph.toFixed(2).padStart(5)}  ` +
      `TDS ${String(t.tds).padStart(4)}  chamber ${String(Math.round(t.chamber_l)).padStart(3)} L  ` +
      `tank ${String(Math.round(t.tank_l)).padStart(3)} L @ pH ${t.tank_ph.toFixed(2)}  ` +
      `neut ${t.neutraliser_pct.toFixed(0)}%  ${flags}`,
    );
  }

  log(message: string, always = false) {
    if (this.opts.verbose || always) console.log(`[${this.opts.name}] ${message}`);
  }

  stats() {
    return {
      name: this.opts.name,
      state: this.controller.state,
      batches: this.controller.batchNo,
      buffered: this.telemetryRing.length,
      dropped: this.droppedSamples,
      online: this.online,
    };
  }
}
