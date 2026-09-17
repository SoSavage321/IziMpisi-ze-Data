/**
 * How it works, and what it cannot do.
 *
 * The limitations section is not an apology. A monitoring system that hides
 * what it cannot measure is worse than one that says so plainly, because
 * somebody downstream will assume it was covered.
 */

import { Box, CheckCircle2, CircleDashed, Lock, ShieldCheck } from 'lucide-react';
import { Badge, Card, CardHead } from '../components/ui.tsx';

const STEPS = [
  { n: 1, title: 'Fill', body: 'The sump pump fills the check chamber to 100 L. Nothing has reached the river yet — that is the whole idea.' },
  { n: 2, title: 'Test', body: 'The pH and TDS probes are averaged over three seconds, so one noisy reading cannot decide the fate of a batch.' },
  { n: 3, title: 'Decide', body: 'A batch passes only if 6.5 ≤ pH ≤ 8.5 and TDS ≤ 1,200 mg/L. Both edges of the pH band are enforced.' },
  { n: 4, title: 'Pass → V1', body: 'Valve V1 opens and the batch goes to the river, with its readings recorded against its batch number.' },
  { n: 5, title: 'Fail → V2', body: 'Valve V2 sends it to the treatment tank instead. If the tank is full, the batch is held in the chamber rather than released.' },
  { n: 6, title: 'Treat', body: 'The dosing pump adds neutraliser in measured slugs, pausing between each so the tank mixes before it is read again. Dosing aims at the middle of the band, not at its edge.' },
  { n: 7, title: 'Release', body: 'Once the tank has held a safe pH for three continuous seconds, valve V3 releases it — and keeps checking while it drains.' },
];

const INTERLOCKS = [
  { title: 'V3 never opens while V2 is open', body: 'Failed water still running into the tank must not be able to run straight out of it.' },
  { title: 'Neutraliser empty locks V3', body: 'With nothing to dose, the plant cannot fix a bad batch, so it holds it, sounds the siren and shows yellow.' },
  { title: 'V1 refuses water that failed the test', body: 'Even a manual command to open V1 is rejected if the chamber water is out of band.' },
  { title: 'The ceiling is re-checked mid-release', body: 'If the tank drifts out of band while V3 is open, V3 shuts again rather than finishing the discharge.' },
  { title: 'Commands expire after 30 seconds', body: 'A controller that was offline must not wake up and execute a stale instruction.' },
];

const LIMITATIONS = [
  {
    status: 'closed' as const,
    title: 'No upper pH limit in the pass rule',
    was: 'The first build only checked pH ≥ 6.5, so over-dosed alkaline water could be released to the river.',
    now: 'The pass rule is now a band, 6.5 ≤ pH ≤ 8.5, enforced in the firmware. Alkaline batches are diverted like acid ones, dosing aims at the middle of the band with an acid trim for overshoot, and the ceiling is re-checked every tick during release. The dashboard still raises a warning above 8.5.',
  },
  {
    status: 'open' as const,
    title: 'The tank corrects pH, not TDS',
    was: 'A batch that failed on dissolved solids is neutralised but still salty when it is released.',
    now: 'The dashboard raises a warning whenever treated water leaves above 1,200 mg/L, and the compliance report lists every such release rather than hiding it. Fixing it properly needs reverse osmosis or an evaporation stage — out of scope for this prototype.',
  },
  {
    status: 'open' as const,
    title: 'Flow is counted in code, not measured',
    was: 'Litres are inferred from batch counts and nominal pump rates rather than from a flow meter.',
    now: 'Every volume in this dashboard is marked with an asterisk and labelled "estimated" until a device reports flow_sensor: true. Fit a pulse flow meter and the labels change on their own.',
  },
  {
    status: 'open' as const,
    title: 'One probe per measurement',
    was: 'A single fouled probe is a single point of failure for the decision.',
    now: 'The dashboard watches for a reading that has not moved in five minutes while pumps are running, and for readings outside what a probe can physically produce. Redundant probes with a voting rule would be the real fix.',
  },
];

export default function About() {
  return (
    <div className="max-w-3xl space-y-4">
      <header>
        <h1 className="font-display text-lg font-semibold text-ink">How WaterGuard works</h1>
        <p className="mt-1 text-sm text-ink-2">
          Acid mine drainage is caught in 100 L batches and tested before any of it reaches the river. Bad water
          is trapped in the chamber instead of being found downstream after it has already done damage.
        </p>
      </header>

      <Card>
        <CardHead title="The seven steps" hint="One batch, start to finish" />
        <ol className="space-y-4">
          {STEPS.map((s) => (
            <li key={s.n} className="flex gap-3">
              <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-line font-mono text-xs text-muted">
                {s.n}
              </span>
              <div>
                <p className="text-sm font-medium text-ink">{s.title}</p>
                <p className="text-sm text-ink-2">{s.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </Card>

      <Card className="border-accent/40">
        <CardHead title="Who is in charge of safety" hint="Not this dashboard" />
        <div className="flex gap-3">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-accent" aria-hidden />
          <div className="space-y-2 text-sm text-ink-2">
            <p>
              <span className="font-medium text-ink">The ESP32 controller is the authority.</span> It holds the
              interlocks, it reads the probes, and it decides. This dashboard can only ask.
            </p>
            <p>
              When you press a button here, a request is written to a queue. The controller picks it up, checks it
              against its own interlocks and its own current readings, and answers accepted or rejected with a
              reason — which is shown to you word for word, including the refusals.
            </p>
            <p>
              That means no action in this interface, by anyone, at any role, can put water in the river that the
              controller believes is unsafe. If the network drops, the plant carries on doing exactly this
              without us.
            </p>
          </div>
        </div>
      </Card>

      <Card>
        <CardHead title="Interlocks" hint="Enforced in firmware, displayed here" />
        <ul className="space-y-3">
          {INTERLOCKS.map((i) => (
            <li key={i.title} className="flex gap-3">
              <Lock className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden />
              <div>
                <p className="text-sm font-medium text-ink">{i.title}</p>
                <p className="text-sm text-ink-2">{i.body}</p>
              </div>
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <CardHead title="The 3D view" hint="A digital twin of the rig, not an illustration" />
        <div className="flex gap-3">
          <Box className="mt-0.5 h-5 w-5 shrink-0 text-accent" aria-hidden />
          <div className="space-y-2 text-sm text-ink-2">
            <p>
              The live view can be shown as a 3D model of the plant instead of the schematic. It is not a
              drawing that happens to look like the rig: it is a second rendering of the same live state.
              Water levels in the check chamber and the treatment tank follow the reported litres, the water
              takes its colour from the measured quality, valves light by their real state including V3&apos;s
              interlock, and flow only animates along a pipe that is actually carrying water.
            </p>
            <p>
              <span className="font-medium text-ink">Connecting it to the prototype takes no work.</span>{' '}
              Both views read one object built from whatever the data layer returns. Today that is the
              in-browser simulation. The moment the ESP32 starts posting to <span className="font-mono">/ingest</span>,
              the same object carries its real telemetry and the tanks on screen follow the tanks on the bench.
            </p>
            <p className="text-muted">
              Drag to orbit, scroll to zoom. It pauses when the tab is hidden or it is scrolled out of view,
              and it is only downloaded when you open it — an operator who stays on the schematic never pays
              for it.
            </p>
          </div>
        </div>
      </Card>

      <Card>
        <CardHead title="Status lights" hint="Mirrored from the panel on the device" />
        <ul className="space-y-2 text-sm text-ink-2">
          <li className="flex items-center gap-2.5">
            <span className="h-3 w-3 rounded-full bg-good" /> <span className="font-medium text-ink">Green</span> — a batch passed and is going to the river
          </li>
          <li className="flex items-center gap-2.5">
            <span className="h-3 w-3 rounded-full bg-crit" /> <span className="font-medium text-ink">Red</span> — a batch failed and is being diverted or held
          </li>
          <li className="flex items-center gap-2.5">
            <span className="h-3 w-3 rounded-full bg-warn" /> <span className="font-medium text-ink">Yellow</span> — testing or treating, or the neutraliser is empty
          </li>
        </ul>
        <p className="mt-3 text-xs text-muted">
          Colour is never the only cue anywhere in this dashboard: every state carries a word and an icon as well.
        </p>
      </Card>

      <Card>
        <CardHead title="Known limitations and roadmap" hint="What this system cannot do yet" />
        <div className="space-y-4">
          {LIMITATIONS.map((l) => (
            <div key={l.title} className="border-l-2 border-line pl-4">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <p className="text-sm font-medium text-ink">{l.title}</p>
                {l.status === 'closed'
                  ? <Badge tone="good"><CheckCircle2 className="h-3.5 w-3.5" />closed</Badge>
                  : <Badge tone="warn"><CircleDashed className="h-3.5 w-3.5" />open</Badge>}
              </div>
              <p className="text-sm text-muted">{l.was}</p>
              <p className="mt-1 text-sm text-ink-2">{l.now}</p>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <CardHead title="The prototype" hint="What the demo hardware stands in for" />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted">
                <th className="py-2 text-left">Real plant</th>
                <th className="py-2 text-left">Prototype</th>
              </tr>
            </thead>
            <tbody className="text-ink-2">
              {[
                ['ESP32 controller with WiFi', 'Same, or an Arduino Uno for the bench demo'],
                ['pH and TDS probes', 'Potentiometers on the bench build'],
                ['Solenoid valves V1, V2, V3', 'Micro servos, 0° shut and 90° open'],
                ['Sump and dosing pumps', 'DC motors'],
                ['Flow meter', 'Litres counted in code — volumes are marked estimated'],
                ['Treatment tank and neutraliser reservoir', '300 L tank, 20 L drum'],
              ].map(([a, b]) => (
                <tr key={a} className="border-b border-line">
                  <td className="py-2 pr-4">{a}</td>
                  <td className="py-2 text-muted">{b}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <p className="text-xs text-muted">
        Built for the MICTSETA Digital-to-Physical hackathon, Mpumalanga. Times are shown in each site&apos;s own
        timezone, default Africa/Johannesburg.
      </p>
    </div>
  );
}
