# Kusile WaterGuard

Mine water is caught in 100 L batches and tested **before** any of it reaches the river.
Bad water is trapped in the check chamber instead of being found after it has already
caused damage.

## The pass rule

A batch is released to the river only if it is inside the band on **both** sides:

| Measurement | Pass condition |
|---|---|
| pH | **6.5 ≤ pH ≤ 8.5** |
| TDS | ≤ 1,200 mg/L |

The upper pH limit is new. The first build only had a floor, so alkaline water — including
water the plant itself had over-dosed during treatment — could walk straight out of valve V1
or V3. Alkaline discharge is a pollution event in the same way acid discharge is, so every
gate in the controller is now two-sided. One function, `inPhBand()`, answers the question
everywhere, so the ceiling cannot be enforced in one branch and forgotten in another.

## How it works

1. **Fill** — the sump pump fills the check chamber to 100 L.
2. **Test** — the controller averages pH and TDS over 3 seconds.
3. **Decide** —
   - inside the band → **V1** sends the batch to the river.
   - outside the band, either side → **V2** sends it to the treatment tank. If the tank is
     full, the batch is held in the chamber.
4. **Treat** — dosing aims at the **middle** of the band (6.8–7.8), not at its edge. Alkali
   is added in fixed slugs with a mixing pause between each, and an acid trim pump pulls the
   tank back down if it overshoots. Aiming at 6.8 with continuous dosing was exactly what
   pushed batches past 8.5.
5. **Release** — **V3** opens only after the tank has held a pH inside 6.5–8.5 for 3 seconds,
   and it re-checks every tick: a mid-release drift shuts the valve again.

## Built-in safety

- If a reagent runs out, the release valve stays locked and the siren sounds.
- V3 never opens while failed water is still flowing into the tank (V2 open ⇒ V3 shut).
- A dose limit per batch trips a lockout rather than dosing forever.
- Status lights: green = pass, red = fail or lockout, yellow = testing, treating, or reagent empty.

## Real device vs demo

| Real device | Demo replacement |
|---|---|
| ESP32 controller | Arduino Uno |
| pH and TDS probes | Potentiometers |
| Solenoid valves V1, V2, V3 | Micro servos (0° shut, 90° open) |
| Sump, dosing and acid trim pumps | DC motors |
| Flow meter | Litres counted in code |
| WiFi and 3D twin | Serial Monitor + the dashboard |

## Repository

- [`firmware/waterguard/waterguard.ino`](firmware/waterguard/waterguard.ino) — the controller.
  Serial Monitor keys during a demo: `o` forces an over-dose, `n` normalises the tank, `r`
  resets the counters.
- [`dashboard/index.html`](dashboard/index.html) — the control-room dashboard. It runs the
  same state machine in the browser, so it demonstrates the plant with no hardware attached,
  and it will replay real telemetry pasted from the Serial Monitor.

## Telemetry format

The controller prints one CSV line every 500 ms. The dashboard parses exactly this:

```
#WG,ms,state,batch,chamberL,pH,TDS,v1,v2,v3,tankL,tankPh,pass,fail,alarm
#WG,12500,TEST,19,100.0,9.12,388,0,0,0,0.0,7.20,14,4,
```

## Known limits

- The treatment tank corrects pH only. A batch that fails on TDS is diverted and held — the
  plant traps it, but cannot fix it.
- Flow is counted in code, not measured by a sensor, so the 100 L batch is nominal.
- The tank pH in the demo build is modelled rather than probed (`DEMO_TANK_MODEL`); the real
  build reads a second probe.
