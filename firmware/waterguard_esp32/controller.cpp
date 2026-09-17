#include "controller.h"
#include <string.h>

namespace {
// Nominal rates, used when no flow meter is fitted. Volumes derived from these
// are reported as estimates, never as measurements.
const float FILL_LPS  = 20.0f;   // TODO: measure your sump pump
const float DRAIN_LPS = 25.0f;   // TODO: measure your gravity drain
const uint32_t DOSE_PULSE_MS = 400;
const uint32_t DOSE_MIX_MS   = 1600;
const uint16_t MAX_PULSES    = 40;

void copyStr(char *dst, size_t n, const char *src) {
  strncpy(dst, src ? src : "", n - 1);
  dst[n - 1] = '\0';
}

/** Minimal JSON field reader — enough for our own small payloads. */
bool jsonStr(const char *json, const char *key, char *out, size_t n) {
  if (!json) return false;
  char pattern[32];
  snprintf(pattern, sizeof(pattern), "\"%s\"", key);
  const char *p = strstr(json, pattern);
  if (!p) return false;
  p = strchr(p + strlen(pattern), ':');
  if (!p) return false;
  p++;
  while (*p == ' ') p++;
  if (*p == '"') {
    p++;
    size_t i = 0;
    while (*p && *p != '"' && i < n - 1) out[i++] = *p++;
    out[i] = '\0';
    return true;
  }
  size_t i = 0;
  while (*p && *p != ',' && *p != '}' && i < n - 1) out[i++] = *p++;
  out[i] = '\0';
  return i > 0;
}

bool jsonBool(const char *json, const char *key, bool fallback) {
  char buf[16];
  if (!jsonStr(json, key, buf, sizeof(buf))) return fallback;
  return strncmp(buf, "true", 4) == 0;
}
}  // namespace

const char *stateName(PlantState s) {
  switch (s) {
    case ST_BOOT: return "BOOT";
    case ST_FILL: return "FILL";
    case ST_TEST: return "TEST";
    case ST_DISCHARGE: return "DISCHARGE";
    case ST_DIVERT: return "DIVERT";
    case ST_TREAT: return "TREAT";
    case ST_CONFIRM: return "CONFIRM";
    case ST_RELEASE: return "RELEASE";
    case ST_HOLD: return "HOLD";
    case ST_LOCKOUT: return "LOCKOUT";
    case ST_ESTOP: return "ESTOP";
    default: return "MAINTENANCE";
  }
}

const char *modeName(PlantMode m) {
  return m == MODE_AUTO ? "AUTO" : m == MODE_MANUAL ? "MANUAL" : "MAINTENANCE";
}

void Controller::begin(const PlantConfig &cfg) {
  cfg_ = cfg;
  state_ = ST_BOOT;
  allOff();
  applyOutputs();
}

// ------------------------------------------------------------- the rule ---

const char *Controller::failReason(float ph, float tds) const {
  if (ph < cfg_.phMin) return "ACID";
  if (ph > cfg_.phMax) return "ALKALINE";   // enforced, not merely warned about
  if (tds > cfg_.tdsMax) return "TDS";
  return nullptr;
}

bool Controller::inReleaseBand(float ph) const {
  return ph >= cfg_.treatTargetPh && ph <= cfg_.phMax;
}

// ----------------------------------------------------------- interlocks ---

const char *Controller::v3Interlock(const SensorReading &in) const {
  static char buf[160];
  if (estop_) return "Emergency stop is active";
  if (out_.v2) return "V3 is interlocked against V2: failed water is still entering the tank";
  if (in.neutraliserEmpty || in.neutraliserPct <= 0) return "Neutraliser reservoir is empty";
  if (tankL_ <= 0) return "Treatment tank is empty";
  if (!inReleaseBand(in.tankPh)) {
    snprintf(buf, sizeof(buf),
             "Tank pH %.2f is outside the release band %.1f-%.1f",
             in.tankPh, cfg_.treatTargetPh, cfg_.phMax);
    return buf;
  }
  return nullptr;
}

// ------------------------------------------------------------- commands ---

CommandVerdict Controller::request(const char *id, const char *type,
                                   const char *payloadJson, const SensorReading &in) {
  CommandVerdict v;
  copyStr(v.id, sizeof(v.id), id);
  v.accepted = false;
  copyStr(v.reason, sizeof(v.reason), "Unknown command");

  auto ok = [&](const char *reason) { v.accepted = true; copyStr(v.reason, sizeof(v.reason), reason); };
  auto no = [&](const char *reason) { v.accepted = false; copyStr(v.reason, sizeof(v.reason), reason); };

  if (!strcmp(type, "EMERGENCY_STOP")) {
    estop_ = true;
    allOff();
    applyOutputs();
    state_ = ST_ESTOP;
    ok("Emergency stop engaged: all valves shut, all pumps stopped");

  } else if (!strcmp(type, "RESET_ESTOP")) {
    if (!estop_) no("Emergency stop is not active");
    else if (in.estopPressed) no("The physical E-stop button is still engaged; release it at the panel first");
    else { estop_ = false; go(ST_FILL); ok("Emergency stop reset; returning to AUTO fill"); }

  } else if (!strcmp(type, "SET_MODE")) {
    char mode[16] = {0};
    jsonStr(payloadJson, "mode", mode, sizeof(mode));
    if (estop_) no("Emergency stop is active; reset it before changing mode");
    else if (strcmp(mode, "AUTO") && (state_ == ST_DISCHARGE || state_ == ST_RELEASE))
      no("Cannot leave AUTO while water is being released");
    else if (!strcmp(mode, "AUTO")) { mode_ = MODE_AUTO; if (state_ == ST_MAINTENANCE) go(ST_FILL); ok("Mode set to AUTO"); }
    else if (!strcmp(mode, "MANUAL")) { mode_ = MODE_MANUAL; ok("Mode set to MANUAL"); }
    else if (!strcmp(mode, "MAINTENANCE")) { mode_ = MODE_MAINTENANCE; allOff(); applyOutputs(); go(ST_MAINTENANCE); ok("Mode set to MAINTENANCE"); }
    else no("Unknown mode");

  } else if (!strcmp(type, "MANUAL_VALVE")) {
    char valve[8] = {0};
    jsonStr(payloadJson, "valve", valve, sizeof(valve));
    bool open = jsonBool(payloadJson, "open", false);

    if (mode_ != MODE_MANUAL) no("Manual valve control requires MANUAL mode");
    else if (!open) {
      if (!strcmp(valve, "V1")) out_.v1 = false;
      else if (!strcmp(valve, "V2")) out_.v2 = false;
      else if (!strcmp(valve, "V3")) out_.v3 = false;
      applyOutputs();
      ok("Valve closed");
    } else if (estop_) no("Emergency stop is active");
    else if (!strcmp(valve, "V3")) {
      const char *blocked = v3Interlock(in);
      if (blocked) no(blocked);
      else { out_.v3 = true; applyOutputs(); ok("V3 opened"); }
    } else if (!strcmp(valve, "V1")) {
      if (out_.v2) no("V1 and V2 cannot be open together");
      else {
        const char *reason = failReason(in.ph, in.tds);
        if (reason) {
          char msg[160];
          snprintf(msg, sizeof(msg), "Chamber water fails the test (%s); V1 may not open to the river", reason);
          no(msg);
        } else { out_.v1 = true; applyOutputs(); ok("V1 opened"); }
      }
    } else if (!strcmp(valve, "V2")) {
      if (out_.v1) no("V1 and V2 cannot be open together");
      else { out_.v2 = true; applyOutputs(); ok("V2 opened"); }
    } else no("Unknown valve");

  } else if (!strcmp(type, "MANUAL_PUMP")) {
    char pump[16] = {0};
    jsonStr(payloadJson, "pump", pump, sizeof(pump));
    bool on = jsonBool(payloadJson, "on", false);
    if (mode_ != MODE_MANUAL) no("Manual pump control requires MANUAL mode");
    else if (estop_ && on) no("Emergency stop is active");
    else if (!strcmp(pump, "sump")) { out_.sumpPump = on; applyOutputs(); ok(on ? "Sump pump started" : "Sump pump stopped"); }
    else if (!strcmp(pump, "dosing")) {
      if (on && (in.neutraliserEmpty || in.neutraliserPct <= 0)) no("Neutraliser reservoir is empty");
      else { out_.dosePump = on; applyOutputs(); ok(on ? "Dosing pump started" : "Dosing pump stopped"); }
    } else no("Unknown pump");

  } else if (!strcmp(type, "START_BATCH")) {
    if (estop_) no("Emergency stop is active");
    else if (mode_ != MODE_AUTO) no("START_BATCH requires AUTO mode");
    else if (state_ != ST_FILL) no("A batch is already in progress");
    else { intakePaused_ = false; ok("Intake running; the batch will test when the chamber is full"); }

  } else if (!strcmp(type, "PAUSE_INTAKE")) {
    intakePaused_ = true;
    out_.sumpPump = false;
    applyOutputs();
    ok("Intake paused; the sump pump is stopped. Water already in the chamber is unaffected");

  } else if (!strcmp(type, "RESUME_INTAKE")) {
    if (estop_) no("Emergency stop is active");
    else { intakePaused_ = false; ok("Intake resumed"); }

  } else if (!strcmp(type, "SILENCE_SIREN")) {
    sirenSilencedUntil_ = clock_ + 5UL * 60UL * 1000UL;
    out_.siren = false;
    hw::setSiren(false);
    ok("Siren silenced for 5 minutes. The alarm itself stays active until the cause clears");

  } else if (!strcmp(type, "REQUEST_CALIBRATION_MODE")) {
    if (state_ == ST_DISCHARGE || state_ == ST_RELEASE) no("Cannot enter calibration while water is being released");
    else { mode_ = MODE_MAINTENANCE; allOff(); applyOutputs(); go(ST_MAINTENANCE); ok("Calibration mode: plant stopped, valves shut"); }

  } else {
    no("Unknown command");
  }

  return v;
}

const char *Controller::applyConfig(const PlantConfig &cfg) {
  const char *bad = config::validate(cfg);
  if (bad) return bad;
  cfg_ = cfg;
  config::save(cfg);
  return nullptr;
}

// ----------------------------------------------------------------- tick ---

void Controller::tick(uint32_t dtMs, const SensorReading &in) {
  clock_ += dtMs;
  const float dt = dtMs / 1000.0f;

  // The physical button wins over everything, including the network.
  if (in.estopPressed && !estop_) {
    estop_ = true;
    allOff();
    state_ = ST_ESTOP;
  }

  if (state_ == ST_BOOT) go(ST_FILL);

  if (estop_) { allOff(); state_ = ST_ESTOP; applyOutputs(); updateIndicators(in); return; }

  if (mode_ == MODE_MAINTENANCE) { allOff(); state_ = ST_MAINTENANCE; applyOutputs(); updateIndicators(in); return; }

  if (mode_ == MODE_MANUAL) {
    // Interlocks keep running in manual: if V3 is open and its interlock goes
    // bad, it shuts itself without waiting to be told.
    if (out_.v3 && v3Interlock(in) != nullptr) { out_.v3 = false; }
    applyOutputs();
    updateIndicators(in);
    return;
  }

  switch (state_) {
    case ST_FILL: {
      shutAll();
      if (intakePaused_) { out_.sumpPump = false; break; }
      out_.sumpPump = true;
      chamberL_ += FILL_LPS * dt;
      if (chamberL_ >= cfg_.batchL) {
        chamberL_ = cfg_.batchL;
        out_.sumpPump = false;
        accPh_ = accTds_ = 0; accN_ = 0;
        batchNo_++;
        batchStartedAt_ = millis();
        go(ST_TEST);
      }
      break;
    }

    case ST_TEST: {
      shutAll();
      accPh_ += in.ph; accTds_ += in.tds; accN_++;
      if (clock_ - tStateEnter_ >= (uint32_t)cfg_.testWindowS * 1000UL) {
        const float avgPh = accN_ ? (float)(accPh_ / accN_) : in.ph;
        const float avgTds = accN_ ? (float)(accTds_ / accN_) : in.tds;
        const char *reason = failReason(avgPh, avgTds);

        if (!reason) {
          recordBatch(avgPh, avgTds, "PASS", "RIVER", "");
          go(ST_DISCHARGE);
        } else if (tankL_ + cfg_.batchL > cfg_.tankCapL) {
          recordBatch(avgPh, avgTds, "HELD", "HELD", reason);
          heldPending_ = true;
          go(ST_HOLD);
        } else {
          recordBatch(avgPh, avgTds, "FAIL", "TANK", reason);
          heldPending_ = false;
          go(ST_DIVERT);
        }
      }
      break;
    }

    case ST_DISCHARGE: {
      out_.v1 = true; out_.v2 = false; out_.v3 = false;
      chamberL_ -= DRAIN_LPS * dt;
      if (chamberL_ <= 0) { chamberL_ = 0; shutAll(); go(ST_FILL); }
      break;
    }

    case ST_DIVERT: {
      out_.v1 = false; out_.v2 = true; out_.v3 = false;   // V3 is interlocked shut
      float moved = DRAIN_LPS * dt;
      if (moved > chamberL_) moved = chamberL_;
      const float total = tankL_ + moved;
      if (total > 0) {
        tankPh_ = (tankPh_ * tankL_ + in.ph * moved) / total;
        tankTds_ = (tankTds_ * tankL_ + in.tds * moved) / total;
      }
      chamberL_ -= moved;
      tankL_ = total;
      if (chamberL_ <= 0.01f) {
        chamberL_ = 0;
        shutAll();
        pulses_ = 0;
        cycleNo_++;
        cycleOpen_ = true;
        cycleStartPh_ = in.tankPh;
        cycleStartPct_ = in.neutraliserPct;
        cycleStartedAt_ = millis();
        tPulse_ = clock_;
        go(ST_TREAT);
      }
      break;
    }

    case ST_TREAT: {
      shutAll();
      const bool needBase = in.tankPh < aimLo();
      const bool needAcid = in.tankPh > aimHi();

      if (!needBase && !needAcid) {
        out_.dosePump = false; out_.acidPump = false;
        tStable_ = 0;
        go(ST_CONFIRM);
        break;
      }
      if (pulses_ >= MAX_PULSES) { lockout("Dose limit reached without reaching the target pH"); break; }
      if (needBase && (in.neutraliserEmpty || in.neutraliserPct <= 0)) { lockout("Neutraliser reservoir is empty"); break; }
      if (needAcid && in.acidEmpty) { lockout("Tank over-dosed and the acid trim reservoir is empty"); break; }

      // Dose in slugs with a mixing pause. Continuous dosing overshoots the
      // ceiling, which is what used to put alkaline water in the river.
      if (out_.dosePump || out_.acidPump) {
        if ((int32_t)(clock_ - dosingUntil_) >= 0) {
          out_.dosePump = false; out_.acidPump = false;
          tPulse_ = clock_;
        }
      } else if (clock_ - tPulse_ >= DOSE_MIX_MS) {
        out_.dosePump = needBase;
        out_.acidPump = needAcid;
        dosingUntil_ = clock_ + DOSE_PULSE_MS;
        pulses_++;
      }
      break;
    }

    case ST_CONFIRM: {
      shutAll();
      if (!inReleaseBand(in.tankPh)) { tStable_ = 0; go(ST_TREAT); break; }

      // The band is only one of V3's conditions. If something else is holding
      // it shut, say so now rather than counting down to a valve that was
      // never going to open.
      const char *blockedC = v3Interlock(in);
      if (blockedC) { tStable_ = 0; lockout(blockedC); break; }

      if (tStable_ == 0) tStable_ = clock_;
      if (clock_ - tStable_ >= (uint32_t)cfg_.stableWindowS * 1000UL) go(ST_RELEASE);
      break;
    }

    case ST_RELEASE: {
      // Re-checked every tick: a mid-release drift shuts V3 rather than
      // finishing the discharge.
      const char *blocked = v3Interlock(in);
      if (blocked && tankL_ > 0) {
        out_.v3 = false;
        // If the tank is already inside the band, dosing cannot clear this
        // block (an empty reservoir, say). Going back to TREAT would
        // oscillate forever and never tell anyone. Lock out instead.
        if (inReleaseBand(in.tankPh)) lockout(blocked);
        else go(ST_TREAT);
        break;
      }
      if (!out_.v3) tankAtRelease_ = tankL_;
      out_.v1 = false; out_.v2 = false; out_.v3 = true;
      tankL_ -= DRAIN_LPS * dt;
      if (tankL_ <= 0) {
        tankL_ = 0;
        shutAll();
        closeCycle(in);
        go(ST_FILL);
      }
      break;
    }

    case ST_HOLD: {
      shutAll();
      out_.sumpPump = false;
      if (tankL_ + cfg_.batchL <= cfg_.tankCapL) go(ST_DIVERT);
      break;
    }

    case ST_LOCKOUT: {
      shutAll();
      out_.dosePump = false; out_.acidPump = false;

      // Can the tank be released as it stands?
      if (tankL_ > 0 && v3Interlock(in) == nullptr) {
        pulses_ = 0;
        tStable_ = 0;
        go(ST_CONFIRM);
        break;
      }

      // Or can dosing move it back into the band?
      const bool canDoseUp = in.tankPh < aimLo() && !in.neutraliserEmpty && in.neutraliserPct > 0;
      const bool canDoseDown = in.tankPh > aimHi() && !in.acidEmpty;
      if ((canDoseUp || canDoseDown) && pulses_ < MAX_PULSES) { go(ST_TREAT); break; }

      // Otherwise stay locked, siren on, and wait for a person.
      break;
    }

    default: break;
  }

  applyOutputs();
  updateIndicators(in);
}

// ------------------------------------------------------------- plumbing ---

void Controller::go(PlantState next) {
  if (next == state_) return;
  state_ = next;
  tStateEnter_ = clock_;
}

void Controller::shutAll() { out_.v1 = out_.v2 = out_.v3 = false; }

void Controller::allOff() {
  shutAll();
  out_.sumpPump = out_.dosePump = out_.acidPump = false;
}

void Controller::lockout(const char *reason) {
  (void)reason;   // the dashboard derives the reason from the alarm rules
  allOff();
  go(ST_LOCKOUT);
}

void Controller::applyOutputs() {
  hw::setValve(PIN_VALVE_V1, out_.v1);
  hw::setValve(PIN_VALVE_V2, out_.v2);
  hw::setValve(PIN_VALVE_V3, out_.v3);
  hw::setPump(PIN_SUMP_PUMP, out_.sumpPump);
  hw::setPump(PIN_DOSE_PUMP, out_.dosePump);
  hw::setPump(PIN_ACID_PUMP, out_.acidPump);
}

void Controller::updateIndicators(const SensorReading &in) {
  const bool empty = in.neutraliserEmpty || in.neutraliserPct <= 0;

  // An empty reservoir shows yellow even in a red state: the panel lamp is how
  // the person on the ground is told to go and refill the drum.
  bool green = false, red = false, yellow = false;
  if (empty) yellow = true;
  else if (state_ == ST_DISCHARGE || state_ == ST_RELEASE) green = true;
  else if (state_ == ST_DIVERT || state_ == ST_HOLD || state_ == ST_LOCKOUT || state_ == ST_ESTOP) red = true;
  else if (state_ == ST_TEST || state_ == ST_TREAT || state_ == ST_CONFIRM) yellow = true;

  copyStr(out_.led, sizeof(out_.led), green ? "green" : red ? "red" : yellow ? "yellow" : "off");
  hw::setLamps(green, red, yellow);

  const bool shouldSound = (state_ == ST_LOCKOUT || state_ == ST_ESTOP || empty);
  out_.siren = shouldSound && (int32_t)(clock_ - sirenSilencedUntil_) >= 0;
  hw::setSiren(out_.siren);
}

void Controller::recordBatch(float ph, float tds, const char *result,
                             const char *dest, const char *fail) {
  if (batchCount_ >= QUEUE) {
    // Compliance records must not be silently lost; drop the oldest only when
    // there is genuinely nowhere left to put them.
    memmove(&batchQ_[0], &batchQ_[1], sizeof(BatchRecord) * (QUEUE - 1));
    batchCount_ = QUEUE - 1;
  }
  BatchRecord &b = batchQ_[batchCount_++];
  b.batchNo = batchNo_;
  b.startedAtMs = batchStartedAt_;
  b.endedAtMs = millis();
  b.avgPh = ph;
  b.avgTds = (uint16_t)(tds + 0.5f);
  b.volumeL = cfg_.batchL;
  copyStr(b.result, sizeof(b.result), result);
  copyStr(b.destination, sizeof(b.destination), dest);
  copyStr(b.failReason, sizeof(b.failReason), fail);
}

void Controller::closeCycle(const SensorReading &in) {
  if (!cycleOpen_) return;
  if (cycleCount_ >= QUEUE) {
    memmove(&cycleQ_[0], &cycleQ_[1], sizeof(CycleRecord) * (QUEUE - 1));
    cycleCount_ = QUEUE - 1;
  }
  CycleRecord &c = cycleQ_[cycleCount_++];
  c.cycleNo = cycleNo_;
  c.startedAtMs = cycleStartedAt_;
  c.releasedAtMs = millis();
  c.startPh = cycleStartPh_;
  c.endPh = in.tankPh;
  c.endTds = (uint16_t)(in.tankTds + 0.5f);
  c.neutraliserUsedPct = cycleStartPct_ - in.neutraliserPct;
  if (c.neutraliserUsedPct < 0) c.neutraliserUsedPct = 0;
  c.volumeReleasedL = (uint16_t)(tankAtRelease_ + 0.5f);
  cycleOpen_ = false;
  tankAtRelease_ = 0;
}

void Controller::dropBatches(uint8_t n) {
  if (n > batchCount_) n = batchCount_;
  if (n == 0) return;
  memmove(&batchQ_[0], &batchQ_[n], sizeof(BatchRecord) * (batchCount_ - n));
  batchCount_ -= n;
}

void Controller::dropCycles(uint8_t n) {
  if (n > cycleCount_) n = cycleCount_;
  if (n == 0) return;
  memmove(&cycleQ_[0], &cycleQ_[n], sizeof(CycleRecord) * (cycleCount_ - n));
  cycleCount_ -= n;
}
