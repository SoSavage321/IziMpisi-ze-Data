/**
 * The control logic — a port of shared/controller.ts.
 *
 * Keep the two in step. The TypeScript version is the one with the test suite
 * (78 tests); if you change a rule here, change it there and run `npm test`.
 *
 * Nothing in this file talks to WiFi, to a server, or to a clock it does not
 * own. It reads sensors, it drives actuators, and it answers commands. That is
 * why the plant keeps working correctly when the network is gone.
 */

#ifndef WATERGUARD_CONTROLLER_H
#define WATERGUARD_CONTROLLER_H

#include <Arduino.h>
#include "config.h"
#include "hardware.h"

enum PlantState : uint8_t {
  ST_BOOT, ST_FILL, ST_TEST, ST_DISCHARGE, ST_DIVERT,
  ST_TREAT, ST_CONFIRM, ST_RELEASE, ST_HOLD, ST_LOCKOUT,
  ST_ESTOP, ST_MAINTENANCE
};

enum PlantMode : uint8_t { MODE_AUTO, MODE_MANUAL, MODE_MAINTENANCE };

const char *stateName(PlantState s);
const char *modeName(PlantMode m);

struct Outputs {
  bool v1, v2, v3;
  bool sumpPump, dosePump, acidPump;
  bool siren;
  char led[8];          // "green" | "red" | "yellow" | "off"
};

struct BatchRecord {
  uint32_t batchNo;
  uint32_t startedAtMs;
  uint32_t endedAtMs;
  float    avgPh;
  uint16_t avgTds;
  char     result[6];        // PASS | FAIL | HELD
  char     destination[6];   // RIVER | TANK | HELD
  uint16_t volumeL;
  char     failReason[9];    // ACID | ALKALINE | TDS | ""
};

struct CycleRecord {
  uint32_t cycleNo;
  uint32_t startedAtMs;
  uint32_t releasedAtMs;
  float    startPh;
  float    endPh;
  uint16_t endTds;
  float    neutraliserUsedPct;
  uint16_t volumeReleasedL;
};

struct CommandVerdict {
  char id[40];
  bool accepted;
  char reason[160];
};

class Controller {
 public:
  void begin(const PlantConfig &cfg);

  /** One control step. dtMs is real elapsed time. */
  void tick(uint32_t dtMs, const SensorReading &in);

  /**
   * Validate and act on a command. Always produces a verdict; a rejection is a
   * normal answer and its reason is sent to the dashboard verbatim.
   */
  CommandVerdict request(const char *id, const char *type, const char *payloadJson,
                         const SensorReading &in);

  /** null when V3 may open, or the reason it may not. */
  const char *v3Interlock(const SensorReading &in) const;

  PlantState state() const { return state_; }
  PlantMode  mode() const { return mode_; }
  bool       estop() const { return estop_; }
  const Outputs &outputs() const { return out_; }
  const PlantConfig &config() const { return cfg_; }
  uint32_t   batchNo() const { return batchNo_; }
  float      chamberL() const { return chamberL_; }
  float      tankL() const { return tankL_; }
  float      tankPh() const { return tankPh_; }
  float      tankTds() const { return tankTds_; }

  /**
   * Records waiting to be uploaded. The network layer peeks at them, sends
   * them, and only drops them once the server has confirmed. A failed upload
   * must never consume the record of a batch decision.
   */
  uint8_t pendingBatches() const { return batchCount_; }
  uint8_t pendingCycles() const { return cycleCount_; }
  const BatchRecord &batchAt(uint8_t i) const { return batchQ_[i]; }
  const CycleRecord &cycleAt(uint8_t i) const { return cycleQ_[i]; }
  void dropBatches(uint8_t n);
  void dropCycles(uint8_t n);

  /** Applied after validation; returns the rejection reason or nullptr. */
  const char *applyConfig(const PlantConfig &cfg);

 private:
  PlantConfig cfg_;
  PlantState  state_ = ST_BOOT;
  PlantMode   mode_  = MODE_AUTO;
  Outputs     out_{};
  bool        estop_ = false;
  bool        intakePaused_ = false;

  uint32_t clock_ = 0;
  uint32_t tStateEnter_ = 0;
  uint32_t tStable_ = 0;
  uint32_t tPulse_ = 0;
  uint32_t dosingUntil_ = 0;
  uint32_t sirenSilencedUntil_ = 0;
  uint16_t pulses_ = 0;

  uint32_t batchNo_ = 0;
  uint32_t cycleNo_ = 0;
  float    chamberL_ = 0;
  float    tankL_ = 0;
  float    tankPh_ = 7.0f;
  float    tankTds_ = 0;

  double   accPh_ = 0;
  double   accTds_ = 0;
  uint32_t accN_ = 0;
  uint32_t batchStartedAt_ = 0;

  // Small queues; the network layer drains them. Compliance records matter
  // more than telemetry, so they get their own space.
  static const uint8_t QUEUE = 8;
  BatchRecord batchQ_[QUEUE];
  CycleRecord cycleQ_[QUEUE];
  uint8_t batchCount_ = 0;
  uint8_t cycleCount_ = 0;

  bool  cycleOpen_ = false;
  float cycleStartPh_ = 0;
  float cycleStartPct_ = 0;
  uint32_t cycleStartedAt_ = 0;
  float tankAtRelease_ = 0;
  bool  heldPending_ = false;

  float aimLo() const { return cfg_.treatTargetPh; }
  float aimHi() const { return (cfg_.treatTargetPh + cfg_.phMax) / 2.0f; }
  const char *failReason(float ph, float tds) const;
  bool  inReleaseBand(float ph) const;

  void go(PlantState next);
  void shutAll();
  void allOff();
  void lockout(const char *reason);
  void updateIndicators(const SensorReading &in);
  void recordBatch(float ph, float tds, const char *result, const char *dest, const char *fail);
  void closeCycle(const SensorReading &in);
  void applyOutputs();
};

#endif
