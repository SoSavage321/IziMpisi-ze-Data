/* ============================================================================
   WaterGuard — ESP32 controller
   Acid mine drainage, test-before-release
   ----------------------------------------------------------------------------
   Mine water is caught in 100 L batches and tested BEFORE any of it reaches
   the river.

        PASS  ==  6.5 <= pH <= 8.5   AND   TDS <= 1200 mg/L

   Both edges of the pH band are enforced here, in firmware. Alkaline water is
   a pollution event in the same way acid water is, and an over-dosed batch
   must not be able to walk out of valve V3 just because it is no longer acidic.

   THE CONTROL LOOP DOES NOT DEPEND ON THE NETWORK.
   WiFi, telemetry and commands all run on their own cadence, outside the
   control path. If the server is unreachable the plant still fills, tests,
   decides, treats and releases exactly as it should, buffers what it did, and
   sends the backlog when the network returns.

   Modules
     hardware.*        pins and probes           (change pins in ONE place)
     config.*          thresholds, NVS-persisted, validated on the device
     controller.*      the state machine and every interlock
     wifi_manager.*    connect with exponential backoff, never blocking
     telemetry.*       200-sample ring buffer and the JSON uploader
     command_client.*  poll, validate, acknowledge with a reason

   Board: ESP32 Dev Module. Libraries: all bundled with the ESP32 core.
   Copy secrets.h.example to secrets.h and fill it in before flashing.
   ==========================================================================*/

#include "secrets.h"
#include "hardware.h"
#include "config.h"
#include "controller.h"
#include "wifi_manager.h"
#include "telemetry.h"
#include "command_client.h"

// ---------------------------------------------------------------- cadence ---
const uint32_t CONTROL_INTERVAL_MS   = 100;    // the plant is decided at 10 Hz
const uint32_t SAMPLE_INTERVAL_MS    = 5000;   // telemetry sample
const uint32_t UPLOAD_INTERVAL_MS    = 5000;   // ingest POST
const uint32_t POLL_INTERVAL_MS      = 2000;   // command poll
const uint32_t STATUS_INTERVAL_MS    = 10000;  // serial line, for the bench

Controller controller;
PlantConfig cfg;

uint32_t lastControl = 0;
uint32_t lastSample  = 0;
uint32_t lastUpload  = 0;
uint32_t lastPoll    = 0;
uint32_t lastStatus  = 0;

PlantState lastState = ST_BOOT;
SensorReading reading;

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println();
  Serial.println(F("WaterGuard ESP32 controller"));
  Serial.println(F("pass band 6.5-8.5 pH, TDS <= 1200 mg/L"));

  // Hardware first: this shuts every valve and stops every pump before
  // anything else has a chance to run.
  hw::begin();

  // Then the configuration it will enforce, from NVS. A controller that
  // will not enforce a limit until a server tells it to is not a safety device.
  config::begin(cfg);
  Serial.printf("config v%lu: pH %.2f-%.2f, TDS <= %u mg/L, target pH %.2f\n",
                (unsigned long)cfg.version, cfg.phMin, cfg.phMax, cfg.tdsMax, cfg.treatTargetPh);

  controller.begin(cfg);

  // Network last, and never in the way.
  telemetry::begin();
  command_client::begin(API_BASE, DEVICE_KEY);
  wifi_manager::begin(WIFI_SSID, WIFI_PASSWORD);

  reading = hw::read();
  lastControl = millis();
}

void loop() {
  const uint32_t now = millis();

  // ---------------------------------------------------------- 1. control ---
  // This runs first and is never skipped, whatever the network is doing.
  if (now - lastControl >= CONTROL_INTERVAL_MS) {
    const uint32_t dt = now - lastControl;
    lastControl = now;

    reading = hw::read();
    controller.tick(dt, reading);

    // A state change is worth a sample of its own: the dashboard should not
    // have to interpolate between two five-second samples to see that a batch
    // was diverted.
    if (controller.state() != lastState) {
      lastState = controller.state();
      telemetry::capture(controller, reading, wifi_manager::rssi());
      Serial.printf("[state] %s  batch %lu  pH %.2f  TDS %.0f  tank %.0f L @ pH %.2f\n",
                    stateName(controller.state()), (unsigned long)controller.batchNo(),
                    reading.ph, reading.tds, controller.tankL(), reading.tankPh);
    }
  }

  // ---------------------------------------------------------- 2. network ---
  wifi_manager::tick();

  if (now - lastSample >= SAMPLE_INTERVAL_MS) {
    lastSample = now;
    telemetry::capture(controller, reading, wifi_manager::rssi());
  }

  if (wifi_manager::connected()) {
    if (now - lastPoll >= POLL_INTERVAL_MS) {
      lastPoll = now;
      command_client::poll(controller, reading);
    }

    if (now - lastUpload >= UPLOAD_INTERVAL_MS) {
      lastUpload = now;
      telemetry::flush(controller, API_BASE, DEVICE_KEY, FIRMWARE_VERSION, hw::hasFlowMeter());
    }
  }

  // ----------------------------------------------------------- 3. status ---
  if (now - lastStatus >= STATUS_INTERVAL_MS) {
    lastStatus = now;
    const Outputs &o = controller.outputs();
    Serial.printf(
      "[%s] %s  pH %.2f  TDS %.0f  chamber %.0f L  tank %.0f L @ pH %.2f  "
      "V1%d V2%d V3%d  neut %.0f%%  wifi %s(%d)  buffered %u%s\n",
      modeName(controller.mode()), stateName(controller.state()),
      reading.ph, reading.tds, controller.chamberL(), controller.tankL(), reading.tankPh,
      o.v1, o.v2, o.v3, reading.neutraliserPct,
      wifi_manager::connected() ? "up" : "down", wifi_manager::rssi(),
      telemetry::buffered(),
      telemetry::dropped() ? " (ring buffer has wrapped)" : "");

    const char *lock = controller.v3Interlock(reading);
    if (lock && !o.v3) Serial.printf("       V3 locked: %s\n", lock);
  }

  // A short yield keeps the WiFi stack happy without delaying control: the
  // next control tick is scheduled by wall clock, not by this delay.
  delay(2);
}
