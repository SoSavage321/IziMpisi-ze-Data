/* ============================================================================
   Kusile WaterGuard  --  batch "test before release" controller
   ----------------------------------------------------------------------------
   Mine water is caught in 100 L batches and tested BEFORE any of it reaches
   the river. A batch is released only if it sits inside the safe band:

        PASS  ==  6.5 <= pH <= 8.5   AND   TDS <= 1200 mg/L

   The upper pH limit is the change from the first build. Alkaline water is
   as much a pollution event as acid water, and without a ceiling an
   over-dosed treatment batch could walk straight out of valve V3 into the
   river. Every gate below is now two-sided.

   Demo build (Tinkercad):  Arduino Uno
     pH / TDS probes .... potentiometers
     valves V1 V2 V3 .... micro servos (0 deg shut, 90 deg open)
     sump / dosing ...... DC motors
     flow meter ......... litres counted in code
     WiFi + 3D twin ..... Serial Monitor (CSV telemetry, see emit())
   ==========================================================================*/

#include <Servo.h>

/* ---------------------------------------------------------------- pins --- */
const uint8_t PIN_PH        = A0;   // raw water pH probe        (pot)
const uint8_t PIN_TDS       = A1;   // raw water TDS probe       (pot)
const uint8_t PIN_ACID_LOW  = A2;   // acid trim level switch    (digital, pullup)
const uint8_t PIN_LED_GREEN = 2;    // pass
const uint8_t PIN_LED_RED   = 3;    // fail
const uint8_t PIN_LED_AMBER = 4;    // testing / reagent empty
const uint8_t PIN_SUMP      = 5;    // sump pump          (DC motor)
const uint8_t PIN_DOSE_BASE = 6;    // alkali dosing pump (DC motor)
const uint8_t PIN_DOSE_ACID = 7;    // acid trim pump     (DC motor)
const uint8_t PIN_SIREN     = 8;    // siren
const uint8_t PIN_V1        = 9;    // -> river
const uint8_t PIN_V2        = 10;   // -> treatment tank
const uint8_t PIN_V3        = 11;   // tank -> river
const uint8_t PIN_BASE_LOW  = 12;   // alkali level switch (digital, pullup)

/* -------------------------------------------------------------- limits --- */
const float PH_MIN  = 6.5;          // below this: acidic, fail
const float PH_MAX  = 8.5;          // above this: alkaline, fail   <-- NEW
const float TDS_MAX = 1200.0;       // mg/L

/* Dosing aims at the middle of the band, not at its edge. Aiming at 6.8 left
   no headroom: one slug of overshoot and the batch was out of spec again. */
const float PH_AIM_LO = 6.8;        // stop alkali dosing at or above this
const float PH_AIM_HI = 7.8;        // stop acid trim at or below this

/* ------------------------------------------------------------- timings --- */
const unsigned long AVG_MS        = 3000;  // average the probes for 3 s
const unsigned long STABLE_MS     = 3000;  // tank must hold the band for 3 s
const unsigned long DOSE_PULSE_MS = 400;   // dose ...
const unsigned long DOSE_MIX_MS   = 1600;  // ... then mix before re-reading
const unsigned long TELEMETRY_MS  = 500;

/* --------------------------------------------------------------- plant --- */
const float   BATCH_L    = 100.0;
const float   TANK_CAP_L = 300.0;
const float   FILL_LPS   = 20.0;    // demo rate; real build uses the flow meter
const float   DRAIN_LPS  = 25.0;
const uint8_t MAX_PULSES = 40;      // per batch, then lock out and alarm

const uint8_t SHUT = 0, OPEN = 90;

/* --------------------------------------------------------------- state --- */
enum State {
  ST_FILL, ST_TEST, ST_DISCHARGE, ST_DIVERT,
  ST_TREAT, ST_CONFIRM, ST_RELEASE, ST_HOLD, ST_LOCKOUT
};
const char *STATE_NAME[] = {
  "FILL", "TEST", "DISCHARGE", "DIVERT",
  "TREAT", "CONFIRM", "RELEASE", "HOLD", "LOCKOUT"
};

Servo v1, v2, v3;

State state = ST_FILL;
unsigned long tState  = 0;          // millis() when the state was entered
unsigned long tTick   = 0;          // last loop tick, for litre integration
unsigned long tStable = 0;          // when the tank last entered the band
unsigned long tPulse  = 0;
unsigned long tTelem  = 0;

float    chamberL = 0, tankL = 0;
float    ph = 7.0, tds = 0;         // averaged batch result
float    tankPh = 7.0;
uint16_t batchNo = 0, passCount = 0, failCount = 0;
uint8_t  pulses = 0;
bool     dosingBase = false, dosingAcid = false, siren = false;
char     alarmMsg[24] = "";

double   accPh = 0, accTds = 0;     // averaging accumulators
uint32_t accN  = 0;

/* ------------------------------------------------------------- helpers --- */
void valves(uint8_t a, uint8_t b, uint8_t c) { v1.write(a); v2.write(b); v3.write(c); }

float readPh()  { return analogRead(PIN_PH)  * (14.0 / 1023.0); }
float readTds() { return analogRead(PIN_TDS) * (2000.0 / 1023.0); }

bool baseEmpty() { return digitalRead(PIN_BASE_LOW) == LOW; }
bool acidEmpty() { return digitalRead(PIN_ACID_LOW) == LOW; }

/* The two-sided verdict. Everything that can send water to the river asks
   this one question, so the ceiling cannot be forgotten in one branch. */
bool inPhBand(float p) { return p >= PH_MIN && p <= PH_MAX; }
bool safeToRelease(float p, float t) { return inPhBand(p) && t <= TDS_MAX; }

void go(State s) { state = s; tState = millis(); }

void setAlarm(const char *msg) { strncpy(alarmMsg, msg, sizeof(alarmMsg) - 1); siren = true; }
void clearAlarm() { alarmMsg[0] = 0; siren = false; }

/* ---------------------------------------------------- tank pH model ------
   In the demo the tank has no second probe, so its pH is modelled: each
   alkali slug lifts it, each acid slug drops it, with a little overshoot so
   the ceiling logic is actually exercised on stage. On the real plant
   tankProbe() becomes a second ADC read. */
const bool DEMO_TANK_MODEL = true;

float tankProbe() {
  if (!DEMO_TANK_MODEL) return analogRead(A3) * (14.0 / 1023.0);
  return tankPh;
}

void dosePulseEffect(bool base) {
  tankPh += base ? 0.32 : -0.28;             // nominal step
  tankPh += (random(0, 100) - 40) / 500.0;   // mixing noise / overshoot
}

void dose(bool base, bool acid) {
  dosingBase = base; dosingAcid = acid;
  analogWrite(PIN_DOSE_BASE, base ? 180 : 0);
  analogWrite(PIN_DOSE_ACID, acid ? 180 : 0);
}

/* --------------------------------------------------------------- setup --- */
void setup() {
  Serial.begin(9600);
  pinMode(PIN_LED_GREEN, OUTPUT);  pinMode(PIN_LED_RED, OUTPUT);
  pinMode(PIN_LED_AMBER, OUTPUT);  pinMode(PIN_SIREN, OUTPUT);
  pinMode(PIN_SUMP, OUTPUT);       pinMode(PIN_DOSE_BASE, OUTPUT);
  pinMode(PIN_DOSE_ACID, OUTPUT);
  pinMode(PIN_BASE_LOW, INPUT_PULLUP);
  pinMode(PIN_ACID_LOW, INPUT_PULLUP);
  v1.attach(PIN_V1); v2.attach(PIN_V2); v3.attach(PIN_V3);
  valves(SHUT, SHUT, SHUT);
  tState = tTick = millis();
  Serial.println(F("#WG,boot,pass band 6.5-8.5 pH, TDS <= 1200 mg/L"));
  Serial.println(F("#COLS,ms,state,batch,chamberL,pH,TDS,v1,v2,v3,tankL,tankPh,pass,fail,alarm"));
}

/* ---------------------------------------------------------------- loop --- */
void loop() {
  unsigned long now = millis();
  float dt = (now - tTick) / 1000.0;
  tTick = now;

  serialCommands();

  switch (state) {

    /* ---- 1. FILL: the sump pump fills the check chamber to 100 L ------ */
    case ST_FILL:
      analogWrite(PIN_SUMP, 200);
      valves(SHUT, SHUT, SHUT);
      chamberL += FILL_LPS * dt;
      if (chamberL >= BATCH_L) {
        chamberL = BATCH_L;
        analogWrite(PIN_SUMP, 0);
        accPh = accTds = 0; accN = 0;
        batchNo++;
        go(ST_TEST);
      }
      break;

    /* ---- 2. TEST: average pH and TDS for 3 s, then decide ------------- */
    case ST_TEST:
      accPh += readPh(); accTds += readTds(); accN++;
      if (now - tState >= AVG_MS) {
        ph  = accPh  / accN;
        tds = accTds / accN;
        /* Two-sided: acidic AND alkaline batches are both diverted. */
        if (safeToRelease(ph, tds)) {
          passCount++;
          go(ST_DISCHARGE);
        } else {
          failCount++;
          if (tankL + BATCH_L > TANK_CAP_L) { setAlarm("TANK FULL - HELD"); go(ST_HOLD); }
          else                              { go(ST_DIVERT); }
        }
      }
      break;

    /* ---- 3a. PASS: V1 sends the batch to the river -------------------- */
    case ST_DISCHARGE:
      valves(OPEN, SHUT, SHUT);
      chamberL -= DRAIN_LPS * dt;
      if (chamberL <= 0) { chamberL = 0; valves(SHUT, SHUT, SHUT); go(ST_FILL); }
      break;

    /* ---- 3b. FAIL: V2 sends the batch to the treatment tank ----------- */
    case ST_DIVERT: {
      /* V3 stays shut here: the release valve never opens while failed
         water is still running into the tank. */
      valves(SHUT, OPEN, SHUT);
      float moved = min(DRAIN_LPS * dt, chamberL);
      if (tankL + moved > 0) tankPh = (tankPh * tankL + ph * moved) / (tankL + moved);
      chamberL -= moved; tankL += moved;
      if (chamberL <= 0.01) {
        chamberL = 0; valves(SHUT, SHUT, SHUT);
        pulses = 0; clearAlarm(); go(ST_TREAT);
      }
      break;
    }

    /* ---- 4. TREAT: dose toward the middle of the band ----------------- */
    case ST_TREAT: {
      tankPh = tankProbe();
      bool needBase = tankPh < PH_AIM_LO;
      bool needAcid = tankPh > PH_AIM_HI;   /* <-- over-dosed water is now
                                                  corrected, not released */
      if (!needBase && !needAcid) { dose(false, false); tStable = 0; go(ST_CONFIRM); break; }

      if (pulses >= MAX_PULSES)    { dose(false, false); setAlarm("DOSE LIMIT");   go(ST_LOCKOUT); break; }
      if (needBase && baseEmpty()) { dose(false, false); setAlarm("ALKALI EMPTY"); go(ST_LOCKOUT); break; }
      if (needAcid && acidEmpty()) { dose(false, false); setAlarm("ACID EMPTY");   go(ST_LOCKOUT); break; }

      /* Pulse-and-mix: dose a fixed slug, stop, let it mix, re-read.
         Continuous dosing was what pushed batches past 8.5 in testing. */
      if (dosingBase || dosingAcid) {
        if (now - tPulse >= DOSE_PULSE_MS) { dosePulseEffect(dosingBase); dose(false, false); tPulse = now; }
      } else if (now - tPulse >= DOSE_MIX_MS) {
        dose(needBase, needAcid); tPulse = now; pulses++;
      }
      break;
    }

    /* ---- 5. CONFIRM: the band must hold for 3 s before V3 moves ------- */
    case ST_CONFIRM:
      tankPh = tankProbe();
      if (!inPhBand(tankPh)) { tStable = 0; go(ST_TREAT); break; }
      if (tStable == 0) tStable = now;
      if (now - tStable >= STABLE_MS) { clearAlarm(); go(ST_RELEASE); }
      break;

    /* ---- 6. RELEASE: V3 lets the treated batch go --------------------- */
    case ST_RELEASE:
      /* Re-checked every tick: if the tank drifts out of the band mid
         release, V3 shuts again rather than finishing the discharge. */
      if (!inPhBand(tankProbe())) { valves(SHUT, SHUT, SHUT); setAlarm("pH DRIFT - SHUT"); go(ST_TREAT); break; }
      valves(SHUT, SHUT, OPEN);
      tankL -= DRAIN_LPS * dt;
      if (tankL <= 0) { tankL = 0; valves(SHUT, SHUT, SHUT); go(ST_FILL); }
      break;

    /* ---- holding states ---------------------------------------------- */
    case ST_HOLD:                       /* the chamber keeps the failed batch */
      analogWrite(PIN_SUMP, 0);
      valves(SHUT, SHUT, SHUT);
      if (tankL + BATCH_L <= TANK_CAP_L) { clearAlarm(); go(ST_DIVERT); }
      break;

    case ST_LOCKOUT:                    /* V3 stays locked, siren on */
      dose(false, false);
      valves(SHUT, SHUT, SHUT);
      if (inPhBand(tankProbe()) &&
          !(tankPh < PH_AIM_LO && baseEmpty()) &&
          !(tankPh > PH_AIM_HI && acidEmpty())) { clearAlarm(); pulses = 0; go(ST_TREAT); }
      break;
  }

  lamps();
  digitalWrite(PIN_SIREN, siren ? HIGH : LOW);
  if (now - tTelem >= TELEMETRY_MS) { tTelem = now; emit(now); }
}

/* -------------------------------------------------------------- output --- */
void lamps() {
  bool green = (state == ST_DISCHARGE || state == ST_RELEASE);
  bool red   = (state == ST_DIVERT || state == ST_HOLD || state == ST_LOCKOUT);
  bool amber = (state == ST_TEST || state == ST_TREAT || state == ST_CONFIRM ||
                baseEmpty() || acidEmpty());
  digitalWrite(PIN_LED_GREEN, green);
  digitalWrite(PIN_LED_RED,   red);
  digitalWrite(PIN_LED_AMBER, amber);
}

/* One CSV line per 500 ms. The dashboard reads exactly this. */
void emit(unsigned long now) {
  Serial.print(F("#WG,"));
  Serial.print(now);                 Serial.print(',');
  Serial.print(STATE_NAME[state]);   Serial.print(',');
  Serial.print(batchNo);             Serial.print(',');
  Serial.print(chamberL, 1);         Serial.print(',');
  Serial.print(ph, 2);               Serial.print(',');
  Serial.print(tds, 0);              Serial.print(',');
  Serial.print(v1.read() > 45);      Serial.print(',');
  Serial.print(v2.read() > 45);      Serial.print(',');
  Serial.print(v3.read() > 45);      Serial.print(',');
  Serial.print(tankL, 1);            Serial.print(',');
  Serial.print(tankProbe(), 2);      Serial.print(',');
  Serial.print(passCount);           Serial.print(',');
  Serial.print(failCount);           Serial.print(',');
  Serial.println(alarmMsg);
}

/* Demo keys in the Serial Monitor: o = force an over-dose spike,
   n = normalise the tank, r = reset the counters. */
void serialCommands() {
  if (!Serial.available()) return;
  switch (Serial.read()) {
    case 'o': tankPh = 9.4; break;
    case 'n': tankPh = 7.2; break;
    case 'r': batchNo = passCount = failCount = 0; break;
  }
}
