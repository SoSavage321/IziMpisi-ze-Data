#!/usr/bin/env tsx
/**
 * WaterGuard device simulator.
 *
 *   npm run sim                                   # one device, printing locally
 *   npm run sim -- --devices 3 --speed 10         # three devices, ten times real time
 *   npm run sim -- --scenario acid_event --verbose
 *   npm run sim -- --key wg_live_xxx --api https://PROJ.supabase.co/functions/v1
 *
 * With no API key it runs entirely offline and prints each device's state to
 * the terminal, which is enough to demonstrate the plant. With a key it talks
 * to the real endpoints, so the dashboard fills up exactly as it would from
 * hardware.
 */

import { VirtualDevice } from './device.ts';
import type { ScenarioName } from './plant.ts';

const SCENARIOS: ScenarioName[] = [
  'normal', 'acid_event', 'high_tds', 'tank_full', 'neutraliser_empty', 'sensor_stuck', 'offline',
];

interface Args {
  devices: number;
  speed: number;
  scenario: ScenarioName;
  api: string | null;
  key: string | null;
  verbose: boolean;
  minutes: number | null;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(`--${flag}`);
    if (i === -1) return undefined;
    const v = argv[i + 1];
    return v && !v.startsWith('--') ? v : 'true';
  };

  const scenario = (get('scenario') ?? 'normal') as ScenarioName;
  if (!SCENARIOS.includes(scenario)) {
    console.error(`Unknown scenario "${scenario}".\nAvailable: ${SCENARIOS.join(', ')}`);
    process.exit(1);
  }

  return {
    devices: Number(get('devices') ?? 1),
    speed: Number(get('speed') ?? 1),
    scenario,
    api: get('api') ?? process.env.WATERGUARD_API_BASE ?? null,
    key: get('key') ?? process.env.WATERGUARD_DEVICE_KEY ?? null,
    verbose: get('verbose') === 'true' || argv.includes('-v'),
    minutes: get('minutes') ? Number(get('minutes')) : null,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.devices > 1 && args.key) {
    console.error(
      'One API key identifies one device. Register a device per simulated controller and\n' +
      'run a process per key, or drop --key to run several devices locally.',
    );
    process.exit(1);
  }

  const devices = Array.from({ length: args.devices }, (_, n) =>
    new VirtualDevice({
      name: args.devices === 1 ? 'WG-SIM' : `WG-SIM-${n + 1}`,
      apiBase: args.api,
      apiKey: args.key,
      // spread scenarios across a fleet so a multi-device run shows variety
      scenario: args.devices === 1 ? args.scenario : SCENARIOS[n % SCENARIOS.length],
      seed: 1000 + n * 17,
      speed: args.speed,
      verbose: args.verbose,
    }),
  );

  console.log(
    `WaterGuard simulator — ${devices.length} device${devices.length === 1 ? '' : 's'}, ` +
    `${args.speed}x speed, scenario "${args.devices === 1 ? args.scenario : 'mixed'}"\n` +
    (args.key ? `posting to ${args.api}\n` : 'no device key: running locally, printing to the terminal\n'),
  );

  const STEP_MS = 200;                       // simulated step
  const wallStep = STEP_MS / args.speed;     // real time between steps
  const started = Date.now();
  let stopping = false;

  process.on('SIGINT', () => {
    if (stopping) process.exit(0);
    stopping = true;
    console.log('\n--- stopping ---');
    for (const d of devices) console.log(d.stats());
    process.exit(0);
  });

  for (;;) {
    const t0 = Date.now();
    await Promise.all(devices.map((d) => d.tick(STEP_MS)));

    if (args.minutes && Date.now() - started > args.minutes * 60_000) {
      console.log('\n--- finished ---');
      for (const d of devices) console.log(d.stats());
      return;
    }

    const elapsed = Date.now() - t0;
    if (elapsed < wallStep) await sleep(wallStep - elapsed);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
