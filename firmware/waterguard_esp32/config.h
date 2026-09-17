/**
 * Configuration, persisted in NVS.
 *
 * The device keeps the last configuration it successfully applied. On boot it
 * runs that, before it has any network at all — a controller that will not
 * enforce a discharge limit until a server tells it to is not a safety device.
 *
 * A new version arrives on the command poll. It is validated here, against the
 * same ranges the database and the dashboard use, and only then written to NVS
 * and acknowledged.
 */

#ifndef WATERGUARD_CONFIG_H
#define WATERGUARD_CONFIG_H

#include <Arduino.h>

struct PlantConfig {
  uint32_t version;
  float    phMin;            // below this: acidic, divert
  float    phMax;            // above this: alkaline, divert  <-- enforced, not just warned
  uint16_t tdsMax;           // mg/L
  float    treatTargetPh;    // dosing aims here
  uint8_t  testWindowS;
  uint8_t  stableWindowS;
  uint16_t batchL;
  uint16_t tankCapL;
  float    phWarnMax;        // dashboard warning threshold
  uint8_t  neutraliserLowPct;
};

/** Shipped defaults. Used until a server configuration has been applied. */
const PlantConfig DEFAULT_CONFIG = {
  1,        // version
  6.5f,     // phMin
  8.5f,     // phMax
  1200,     // tdsMax
  6.8f,     // treatTargetPh
  3,        // testWindowS
  3,        // stableWindowS
  100,      // batchL
  300,      // tankCapL   TODO: confirm against the real vessel
  8.5f,     // phWarnMax
  20        // neutraliserLowPct
};

namespace config {

/** Load from NVS, falling back to DEFAULT_CONFIG. Call once in setup(). */
void begin(PlantConfig &out);

/** Persist. Only call after validate() has passed. */
bool save(const PlantConfig &cfg);

/**
 * Returns nullptr when the configuration is acceptable, or a human-readable
 * reason when it is not. The reason is sent back to the server as the command
 * rejection, so it is written for an operator, not for a log file.
 */
const char *validate(const PlantConfig &cfg);

}  // namespace config

#endif
