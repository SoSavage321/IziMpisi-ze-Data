/**
 * Hardware abstraction.
 *
 * Every pin in the system is named here, once. The control logic never touches
 * a GPIO directly, which is what lets the same state machine run on the ESP32
 * rig, on the Arduino Uno bench demo with potentiometers and servos, and in
 * the TypeScript simulator.
 *
 * PIN MAP — derived from the Uno bench build and remapped to ESP32-safe pins.
 * TODO: confirm every one of these against the actual board before energising
 * anything. GPIO 34/35/32 are input-only ADC1 pins, which is what we want for
 * the probes; ADC2 pins cannot be read while WiFi is active, so no analogue
 * input may move there.
 */

#ifndef WATERGUARD_HARDWARE_H
#define WATERGUARD_HARDWARE_H

#include <Arduino.h>

// ---------------------------------------------------------------- inputs ---
static const uint8_t PIN_PH_PROBE   = 34;  // ADC1_CH6, input only   (was A0 on the Uno)
static const uint8_t PIN_TDS_PROBE  = 35;  // ADC1_CH7, input only   (was A1)
static const uint8_t PIN_TANK_PH    = 32;  // ADC1_CH4, second probe (bench demo: modelled)
static const uint8_t PIN_NEUTRALISER_LOW = 33;  // float switch, INPUT_PULLUP (was D12)
static const uint8_t PIN_ACID_LOW   = 39;  // acid trim float switch,  input only
static const uint8_t PIN_ESTOP      = 36;  // physical E-stop, input only, INPUT (external pull-up)
static const uint8_t PIN_FLOW_METER = 4;   // optional pulse flow meter; leave unwired if not fitted

// --------------------------------------------------------------- outputs ---
static const uint8_t PIN_LED_GREEN  = 12;  // pass            (was D2)
static const uint8_t PIN_LED_RED    = 13;  // fail            (was D3)
static const uint8_t PIN_LED_YELLOW = 14;  // testing / empty (was D4)
static const uint8_t PIN_SUMP_PUMP  = 16;  // relay / MOSFET  (was D5)
static const uint8_t PIN_DOSE_PUMP  = 17;  // relay / MOSFET  (was D6)
static const uint8_t PIN_ACID_PUMP  = 5;   // acid trim       (was D7)
static const uint8_t PIN_SIREN      = 23;  // relay           (was D8)
static const uint8_t PIN_VALVE_V1   = 25;  // solenoid → river     (was D9)
static const uint8_t PIN_VALVE_V2   = 26;  // solenoid → tank      (was D10)
static const uint8_t PIN_VALVE_V3   = 27;  // solenoid tank → river(was D11)

/**
 * Probe calibration. Two-point, stored as slope and offset from the last
 * calibration and recorded in the dashboard's maintenance log.
 * TODO: replace with the values from your own buffer calibration.
 */
struct ProbeCal {
  float phSlope  = 14.0f / 4095.0f;   // raw ADC counts -> pH
  float phOffset = 0.0f;
  float tdsSlope = 2000.0f / 4095.0f; // raw ADC counts -> mg/L
  float tdsOffset = 0.0f;
};

struct SensorReading {
  float ph;
  float tds;
  float tankPh;
  float tankTds;
  float neutraliserPct;
  bool  neutraliserEmpty;
  bool  acidEmpty;
  bool  estopPressed;
};

namespace hw {

void begin();

/** Read every input once. Probes are oversampled to reject mains hum. */
SensorReading read();

void setValve(uint8_t pin, bool open);
void setPump(uint8_t pin, bool on);
void setLamps(bool green, bool red, bool yellow);
void setSiren(bool on);

/** Everything off, valves shut. Called on E-stop and at boot. */
void allSafe();

/** Litres seen by the flow meter since the last call, or -1 with none fitted. */
float flowLitres();
bool  hasFlowMeter();

}  // namespace hw

#endif
