/**
 * Telemetry: a ring buffer and a JSON uploader.
 *
 * The device samples every 5 s and on every state change. If the network is
 * down the samples go into a 200-record ring buffer and the oldest are dropped
 * once it is full — telemetry is the data we can afford to lose. Batch and
 * treatment records are compliance data; they live in the controller's own
 * queue and are only dropped after the server has confirmed receipt.
 *
 * Uploads are idempotent: the server upserts on (device_id, ts), so replaying
 * a backlog twice cannot double-count a litre.
 */

#ifndef WATERGUARD_TELEMETRY_H
#define WATERGUARD_TELEMETRY_H

#include <Arduino.h>
#include "controller.h"

/** One sample. Around 48 bytes; 200 of them fit comfortably in RAM. */
struct Sample {
  uint32_t uptimeS;
  uint32_t epochS;        // 0 until NTP has run
  float    ph;
  float    tds;
  float    chamberL;
  float    tankL;
  float    tankPh;
  float    tankTds;
  float    neutraliserPct;
  int16_t  rssi;
  uint8_t  state;
  uint8_t  mode;
  uint8_t  flags;         // bit0 v1, 1 v2, 2 v3, 3 sump, 4 dose, 5 siren, 6 estop
  uint8_t  led;           // 0 off, 1 green, 2 red, 3 yellow
};

namespace telemetry {

void begin();

/** Capture the current state into the ring buffer. */
void capture(const Controller &c, const SensorReading &in, int rssi);

uint16_t buffered();
uint16_t dropped();

/** True once NTP has given us a wall clock we can timestamp with. */
bool haveClock();

/**
 * POST everything buffered, plus any batch and cycle records the controller is
 * holding, plus pending command acknowledgements. Returns true when the server
 * accepted it; on failure nothing is discarded.
 */
bool flush(Controller &c, const char *apiBase, const char *deviceKey,
           const char *firmwareVersion, bool flowMeter);

/** Queue a verdict to be uploaded with the next flush. */
void queueAck(const CommandVerdict &v);

/**
 * Build the body for POST /commands/ack without consuming the queue, and clear
 * it only once the server has taken them. The command client uses this so an
 * operator sees the verdict at once rather than on the next 5 s flush, while a
 * failed POST still leaves the verdicts to go out with the telemetry.
 */
String buildAckBody();
void clearAcks();

}  // namespace telemetry

#endif
