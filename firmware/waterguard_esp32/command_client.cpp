#include "command_client.h"
#include "telemetry.h"
#include <HTTPClient.h>
#include <string.h>

namespace {

const char *apiBase_ = nullptr;
const char *deviceKey_ = nullptr;
uint32_t serverVersion_ = 0;

/**
 * Find the value of "key" inside the object starting at `obj`, without
 * allocating. Good enough for the small, known payloads this device receives;
 * a full parser would cost more RAM than the whole telemetry buffer.
 */
bool field(const char *obj, const char *key, char *out, size_t n) {
  char pattern[40];
  snprintf(pattern, sizeof(pattern), "\"%s\"", key);
  const char *p = strstr(obj, pattern);
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
  if (*p == '{') {
    // copy the nested object verbatim, so the controller can read its fields
    int depth = 0;
    size_t i = 0;
    while (*p && i < n - 1) {
      if (*p == '{') depth++;
      if (*p == '}') depth--;
      out[i++] = *p++;
      if (depth == 0) break;
    }
    out[i] = '\0';
    return true;
  }
  size_t i = 0;
  while (*p && *p != ',' && *p != '}' && i < n - 1) out[i++] = *p++;
  out[i] = '\0';
  return i > 0;
}

float fieldFloat(const char *obj, const char *key, float fallback) {
  char buf[24];
  if (!field(obj, key, buf, sizeof(buf))) return fallback;
  return atof(buf);
}

long fieldLong(const char *obj, const char *key, long fallback) {
  char buf[24];
  if (!field(obj, key, buf, sizeof(buf))) return fallback;
  return atol(buf);
}

/** Walk the objects inside a JSON array. Returns nullptr when done. */
const char *nextObject(const char *p) {
  int depth = 0;
  while (*p) {
    if (*p == '{') {
      if (depth == 0) return p;
      depth++;
    }
    p++;
  }
  return nullptr;
}

const char *endOfObject(const char *p) {
  int depth = 0;
  while (*p) {
    if (*p == '{') depth++;
    else if (*p == '}') { depth--; if (depth == 0) return p + 1; }
    p++;
  }
  return p;
}

}  // namespace

namespace command_client {

void begin(const char *apiBase, const char *deviceKey) {
  apiBase_ = apiBase;
  deviceKey_ = deviceKey;
}

uint32_t serverConfigVersion() { return serverVersion_; }

uint8_t poll(Controller &c, const SensorReading &in) {
  if (!apiBase_ || !deviceKey_) return 0;

  HTTPClient http;
  http.setTimeout(6000);
  String url = String(apiBase_) + "/commands";
  if (!http.begin(url)) return 0;
  http.addHeader("x-device-key", deviceKey_);

  const int code = http.GET();
  if (code != 200) { http.end(); return 0; }

  String payload = http.getString();
  http.end();

  const char *json = payload.c_str();

  // ---- configuration --------------------------------------------------
  char cfgObj[512];
  if (field(json, "config", cfgObj, sizeof(cfgObj)) && cfgObj[0] == '{') {
    const uint32_t version = (uint32_t)fieldLong(cfgObj, "version", 0);
    serverVersion_ = version;

    if (version > c.config().version) {
      PlantConfig next = c.config();
      next.version           = version;
      next.phMin             = fieldFloat(cfgObj, "ph_min", next.phMin);
      next.phMax             = fieldFloat(cfgObj, "ph_max", next.phMax);
      next.tdsMax            = (uint16_t)fieldLong(cfgObj, "tds_max", next.tdsMax);
      next.treatTargetPh     = fieldFloat(cfgObj, "treat_target_ph", next.treatTargetPh);
      next.testWindowS       = (uint8_t)fieldLong(cfgObj, "test_window_s", next.testWindowS);
      next.stableWindowS     = (uint8_t)fieldLong(cfgObj, "stable_window_s", next.stableWindowS);
      next.batchL            = (uint16_t)fieldLong(cfgObj, "batch_l", next.batchL);
      next.tankCapL          = (uint16_t)fieldLong(cfgObj, "tank_cap_l", next.tankCapL);
      next.phWarnMax         = fieldFloat(cfgObj, "ph_warn_max", next.phWarnMax);
      next.neutraliserLowPct = (uint8_t)fieldLong(cfgObj, "neutraliser_low_pct", next.neutraliserLowPct);

      const char *bad = c.applyConfig(next);
      if (bad) {
        // Refusing a bad configuration is the whole point of validating it on
        // the device as well as in the database.
        Serial.printf("[commands] refused config v%lu: %s\n", (unsigned long)version, bad);
      } else {
        Serial.printf("[commands] applied config v%lu\n", (unsigned long)version);
      }
    }
  }

  // ---- commands --------------------------------------------------------
  const char *cmds = strstr(json, "\"commands\"");
  if (!cmds) return 0;

  uint8_t handled = 0;
  const char *p = strchr(cmds, '[');
  if (!p) return 0;
  p++;

  while (handled < 8) {
    const char *obj = nextObject(p);
    if (!obj) break;
    const char *end = endOfObject(obj);

    char id[40] = {0};
    char type[40] = {0};
    char payloadObj[192] = {0};
    field(obj, "id", id, sizeof(id));
    field(obj, "type", type, sizeof(type));
    field(obj, "payload", payloadObj, sizeof(payloadObj));

    if (id[0] && type[0]) {
      CommandVerdict v = c.request(id, type, payloadObj, in);
      telemetry::queueAck(v);
      Serial.printf("[commands] %s -> %s: %s\n", type, v.accepted ? "ACCEPTED" : "REJECTED", v.reason);
      handled++;
    }

    p = end;
  }

  // Acknowledge straight away rather than waiting for the next telemetry
  // flush, so the operator watching the dashboard sees the answer at once.
  if (handled > 0) {
    const String ackBody = telemetry::buildAckBody();
    if (ackBody.length() > 0) {
      HTTPClient ack;
      ack.setTimeout(6000);
      String ackUrl = String(apiBase_) + "/commands/ack";
      if (ack.begin(ackUrl)) {
        ack.addHeader("Content-Type", "application/json");
        ack.addHeader("x-device-key", deviceKey_);
        const int ackCode = ack.POST(ackBody);
        ack.end();
        if (ackCode >= 200 && ackCode < 300) {
          telemetry::clearAcks();
        } else {
          // Leave them queued; the next telemetry flush carries them instead.
          // A command with no answer is worse than one answered late.
          Serial.printf("[commands] ack POST failed with %d; will retry on the next flush\n", ackCode);
        }
      }
    }
  }

  return handled;
}

}  // namespace command_client
