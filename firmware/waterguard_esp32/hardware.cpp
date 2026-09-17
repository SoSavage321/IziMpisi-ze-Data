#include "hardware.h"

namespace {

ProbeCal cal;
volatile uint32_t flowPulses = 0;
bool flowMeterPresent = false;

/** TODO: set from your flow meter's datasheet. YF-S201 is ~450 pulses/litre. */
const float PULSES_PER_LITRE = 450.0f;

void IRAM_ATTR onFlowPulse() { flowPulses++; }

/** Oversample an ADC pin. Mains hum and pump noise ride on these lines. */
float readAveraged(uint8_t pin, uint8_t samples = 32) {
  uint32_t total = 0;
  for (uint8_t n = 0; n < samples; n++) {
    total += analogRead(pin);
    delayMicroseconds(200);
  }
  return static_cast<float>(total) / samples;
}

float clampf(float v, float lo, float hi) { return v < lo ? lo : (v > hi ? hi : v); }

}  // namespace

namespace hw {

void begin() {
  pinMode(PIN_LED_GREEN, OUTPUT);
  pinMode(PIN_LED_RED, OUTPUT);
  pinMode(PIN_LED_YELLOW, OUTPUT);
  pinMode(PIN_SUMP_PUMP, OUTPUT);
  pinMode(PIN_DOSE_PUMP, OUTPUT);
  pinMode(PIN_ACID_PUMP, OUTPUT);
  pinMode(PIN_SIREN, OUTPUT);
  pinMode(PIN_VALVE_V1, OUTPUT);
  pinMode(PIN_VALVE_V2, OUTPUT);
  pinMode(PIN_VALVE_V3, OUTPUT);

  pinMode(PIN_NEUTRALISER_LOW, INPUT_PULLUP);
  pinMode(PIN_ACID_LOW, INPUT);        // input-only pin: needs an external pull-up
  pinMode(PIN_ESTOP, INPUT);           // input-only pin: needs an external pull-up

  // 12-bit ADC across the full 0-3.3 V range.
  analogReadResolution(12);
  analogSetPinAttenuation(PIN_PH_PROBE, ADC_11db);
  analogSetPinAttenuation(PIN_TDS_PROBE, ADC_11db);
  analogSetPinAttenuation(PIN_TANK_PH, ADC_11db);

  // Shut everything before anything else can happen.
  allSafe();

  // A flow meter is optional. If nothing pulses in the first few seconds of
  // pumping, the device reports flow_sensor:false and the dashboard labels
  // every volume "estimated".
  pinMode(PIN_FLOW_METER, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(PIN_FLOW_METER), onFlowPulse, FALLING);
}

SensorReading read() {
  SensorReading r;
  r.ph     = clampf(readAveraged(PIN_PH_PROBE) * cal.phSlope + cal.phOffset, 0.0f, 14.0f);
  r.tds    = clampf(readAveraged(PIN_TDS_PROBE) * cal.tdsSlope + cal.tdsOffset, 0.0f, 5000.0f);
  r.tankPh = clampf(readAveraged(PIN_TANK_PH) * cal.phSlope + cal.phOffset, 0.0f, 14.0f);

  // The bench build has no tank TDS probe; the tank inherits what went into it.
  // TODO: wire a second TDS probe if the plant gets one.
  r.tankTds = 0.0f;

  r.neutraliserEmpty = digitalRead(PIN_NEUTRALISER_LOW) == LOW;
  r.acidEmpty        = digitalRead(PIN_ACID_LOW) == LOW;
  r.estopPressed     = digitalRead(PIN_ESTOP) == LOW;

  // Level switch only: full or empty, with no middle. A continuous level
  // sender would replace this with a real percentage.
  r.neutraliserPct = r.neutraliserEmpty ? 0.0f : 100.0f;

  return r;
}

void setValve(uint8_t pin, bool open) { digitalWrite(pin, open ? HIGH : LOW); }
void setPump(uint8_t pin, bool on)    { digitalWrite(pin, on ? HIGH : LOW); }

void setLamps(bool green, bool red, bool yellow) {
  digitalWrite(PIN_LED_GREEN, green ? HIGH : LOW);
  digitalWrite(PIN_LED_RED, red ? HIGH : LOW);
  digitalWrite(PIN_LED_YELLOW, yellow ? HIGH : LOW);
}

void setSiren(bool on) { digitalWrite(PIN_SIREN, on ? HIGH : LOW); }

void allSafe() {
  setValve(PIN_VALVE_V1, false);
  setValve(PIN_VALVE_V2, false);
  setValve(PIN_VALVE_V3, false);
  setPump(PIN_SUMP_PUMP, false);
  setPump(PIN_DOSE_PUMP, false);
  setPump(PIN_ACID_PUMP, false);
}

float flowLitres() {
  noInterrupts();
  uint32_t pulses = flowPulses;
  flowPulses = 0;
  interrupts();
  if (pulses > 0) flowMeterPresent = true;
  return pulses / PULSES_PER_LITRE;
}

bool hasFlowMeter() { return flowMeterPresent; }

}  // namespace hw
