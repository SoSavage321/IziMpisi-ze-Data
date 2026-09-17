#include "telemetry.h"
#include "hardware.h"
#include <HTTPClient.h>
#include <time.h>
#include <string.h>

namespace {

const uint16_t CAPACITY = 200;
Sample ring[CAPACITY];
uint16_t head = 0;
uint16_t count = 0;
uint16_t droppedCount = 0;

const uint8_t ACK_CAPACITY = 8;
CommandVerdict acks[ACK_CAPACITY];
uint8_t ackCount = 0;

const char *ledName(uint8_t led) {
  switch (led) {
    case 1: return "green";
    case 2: return "red";
    case 3: return "yellow";
    default: return "off";
  }
}

uint8_t ledCode(const char *led) {
  if (!strcmp(led, "green")) return 1;
  if (!strcmp(led, "red")) return 2;
  if (!strcmp(led, "yellow")) return 3;
  return 0;
}

bool clockReady() { return time(nullptr) > 1600000000L; }

/** ISO-8601 from a Unix timestamp. */
void isoFromEpoch(uint32_t epochS, char *out, size_t n) {
  time_t t = (time_t)epochS;
  struct tm tmv;
  gmtime_r(&t, &tmv);
  strftime(out, n, "%Y-%m-%dT%H:%M:%SZ", &tmv);
}

/**
 * ISO-8601 from a millis() stamp, by anchoring it to the current wall clock.
 * Batch records carry millis() because they may have been created before NTP
 * ever succeeded; this converts them at upload time.
 */
void isoFromMillis(uint32_t stampMs, char *out, size_t n) {
  if (!clockReady()) { out[0] = '\0'; return; }
  const uint32_t agoMs = millis() - stampMs;
  isoFromEpoch((uint32_t)time(nullptr) - agoMs / 1000, out, n);
}

/** Escape a string for embedding in JSON. Reasons come from our own code, but
 *  a quote in one would corrupt the whole payload. */
String jsonEscape(const char *s) {
  String out;
  for (const char *p = s; *p; p++) {
    if (*p == '"' || *p == '\\') { out += '\\'; out += *p; }
    else if (*p == '\n') out += "\\n";
    else if ((uint8_t)*p >= 0x20) out += *p;
  }
  return out;
}

}  // namespace

namespace telemetry {

void begin() {
  head = count = droppedCount = 0;
  ackCount = 0;
  // Best-effort NTP. Everything works without it; the records simply wait for
  // a clock before they can be timestamped honestly.
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");
}

bool haveClock() { return clockReady(); }

void capture(const Controller &c, const SensorReading &in, int rssi) {
  Sample &s = ring[head];
  s.uptimeS = millis() / 1000;
  s.epochS  = clockReady() ? (uint32_t)time(nullptr) : 0;
  s.ph = in.ph;
  s.tds = in.tds;
  s.chamberL = c.chamberL();
  s.tankL = c.tankL();
  s.tankPh = in.tankPh;
  s.tankTds = c.tankTds();
  s.neutraliserPct = in.neutraliserPct;
  s.rssi = (int16_t)rssi;
  s.state = (uint8_t)c.state();
  s.mode = (uint8_t)c.mode();

  const Outputs &o = c.outputs();
  s.flags = (uint8_t)((o.v1 ? 1 : 0) | (o.v2 ? 2 : 0) | (o.v3 ? 4 : 0) |
                      (o.sumpPump ? 8 : 0) | ((o.dosePump || o.acidPump) ? 16 : 0) |
                      (o.siren ? 32 : 0) | (c.estop() ? 64 : 0));
  s.led = ledCode(o.led);

  head = (head + 1) % CAPACITY;
  if (count < CAPACITY) count++;
  else droppedCount++;      // the oldest sample just fell off the back
}

uint16_t buffered() { return count; }
uint16_t dropped() { return droppedCount; }

void queueAck(const CommandVerdict &v) {
  if (ackCount >= ACK_CAPACITY) {
    memmove(&acks[0], &acks[1], sizeof(CommandVerdict) * (ACK_CAPACITY - 1));
    ackCount = ACK_CAPACITY - 1;
  }
  acks[ackCount++] = v;
}

String buildAckBody() {
  if (ackCount == 0) return String();
  String body = "{\"acks\":[";
  for (uint8_t n = 0; n < ackCount; n++) {
    if (n) body += ',';
    body += "{\"id\":\"";       body += acks[n].id;
    body += "\",\"accepted\":"; body += acks[n].accepted ? "true" : "false";
    body += ",\"reason\":\"";   body += jsonEscape(acks[n].reason);
    body += "\"}";
  }
  body += "]}";
  return body;
}

void clearAcks() { ackCount = 0; }

bool flush(Controller &c, const char *apiBase, const char *deviceKey,
           const char *firmwareVersion, bool flowMeter) {
  if (count == 0 && ackCount == 0 && c.pendingBatches() == 0 && c.pendingCycles() == 0) return true;
  if (!clockReady()) return false;    // nothing can be timestamped yet; keep buffering

  String url = String(apiBase) + "/ingest";
  HTTPClient http;
  http.setTimeout(8000);
  if (!http.begin(url)) return false;
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-device-key", deviceKey);

  // Built as a String rather than through a JSON library: the payload shape is
  // fixed and known, and this avoids a heap allocation per field on a device
  // that has to stay up for months.
  String body;
  body.reserve((size_t)count * 230 + 1024);
  body += "{\"firmware_version\":\"";
  body += firmwareVersion;
  body += "\",\"flow_sensor\":";
  body += flowMeter ? "true" : "false";
  body += ",\"config_version\":";
  body += c.config().version;
  body += ",\"telemetry\":[";

  const uint16_t start = (head + CAPACITY - count) % CAPACITY;
  char ts[32];
  bool first = true;
  for (uint16_t n = 0; n < count; n++) {
    const Sample &s = ring[(start + n) % CAPACITY];
    if (s.epochS == 0) continue;            // captured before the clock; skip rather than fabricate
    isoFromEpoch(s.epochS, ts, sizeof(ts));

    if (!first) body += ',';
    first = false;
    body += "{\"ts\":\"";            body += ts;
    body += "\",\"state\":\"";       body += stateName((PlantState)s.state);
    body += "\",\"mode\":\"";        body += modeName((PlantMode)s.mode);
    body += "\",\"estop\":";         body += (s.flags & 64) ? "true" : "false";
    body += ",\"ph\":";              body += String(s.ph, 2);
    body += ",\"tds\":";             body += (int)(s.tds + 0.5f);
    body += ",\"chamber_l\":";       body += String(s.chamberL, 1);
    body += ",\"tank_l\":";          body += String(s.tankL, 1);
    body += ",\"tank_cap_l\":";      body += c.config().tankCapL;
    body += ",\"tank_ph\":";         body += String(s.tankPh, 2);
    body += ",\"tank_tds\":";        body += (int)(s.tankTds + 0.5f);
    body += ",\"neutraliser_pct\":"; body += String(s.neutraliserPct, 1);
    body += ",\"v1\":";              body += (s.flags & 1) ? "true" : "false";
    body += ",\"v2\":";              body += (s.flags & 2) ? "true" : "false";
    body += ",\"v3\":";              body += (s.flags & 4) ? "true" : "false";
    body += ",\"sump_pump\":";       body += (s.flags & 8) ? "true" : "false";
    body += ",\"dosing_pump\":";     body += (s.flags & 16) ? "true" : "false";
    body += ",\"siren\":";           body += (s.flags & 32) ? "true" : "false";
    body += ",\"led\":\"";           body += ledName(s.led);
    body += "\",\"wifi_rssi\":";     body += s.rssi;
    body += ",\"uptime_s\":";        body += s.uptimeS;
    body += "}";
  }

  // Compliance records are only PEEKED at here. They are dropped after the
  // server confirms, so a failed POST cannot lose the record of a decision.
  const uint8_t batchN = c.pendingBatches();
  const uint8_t cycleN = c.pendingCycles();

  body += "],\"batches\":[";
  first = true;
  for (uint8_t n = 0; n < batchN; n++) {
    const BatchRecord &b = c.batchAt(n);
    char startedAt[32], endedAt[32];
    isoFromMillis(b.startedAtMs, startedAt, sizeof(startedAt));
    isoFromMillis(b.endedAtMs, endedAt, sizeof(endedAt));
    if (!first) body += ',';
    first = false;
    body += "{\"batch_no\":";        body += b.batchNo;
    body += ",\"started_at\":\"";    body += startedAt;
    body += "\",\"ended_at\":\"";    body += endedAt;
    body += "\",\"avg_ph\":";        body += String(b.avgPh, 2);
    body += ",\"avg_tds\":";         body += b.avgTds;
    body += ",\"result\":\"";        body += b.result;
    body += "\",\"destination\":\""; body += b.destination;
    body += "\",\"volume_l\":";      body += b.volumeL;
    body += ",\"fail_reason\":";
    if (b.failReason[0]) { body += '"'; body += b.failReason; body += '"'; } else body += "null";
    body += "}";
  }

  body += "],\"cycles\":[";
  first = true;
  for (uint8_t n = 0; n < cycleN; n++) {
    const CycleRecord &cy = c.cycleAt(n);
    char startedAt[32], releasedAt[32];
    isoFromMillis(cy.startedAtMs, startedAt, sizeof(startedAt));
    isoFromMillis(cy.releasedAtMs, releasedAt, sizeof(releasedAt));
    if (!first) body += ',';
    first = false;
    body += "{\"cycle_no\":";        body += cy.cycleNo;
    body += ",\"started_at\":\"";    body += startedAt;
    body += "\",\"released_at\":\""; body += releasedAt;
    body += "\",\"start_ph\":";      body += String(cy.startPh, 2);
    body += ",\"end_ph\":";          body += String(cy.endPh, 2);
    body += ",\"end_tds\":";         body += cy.endTds;
    body += ",\"neutraliser_used_pct\":"; body += String(cy.neutraliserUsedPct, 2);
    body += ",\"volume_released_l\":";    body += cy.volumeReleasedL;
    body += "}";
  }

  body += "],\"command_acks\":[";
  for (uint8_t n = 0; n < ackCount; n++) {
    if (n) body += ',';
    body += "{\"id\":\"";       body += acks[n].id;
    body += "\",\"accepted\":"; body += acks[n].accepted ? "true" : "false";
    body += ",\"reason\":\"";   body += jsonEscape(acks[n].reason);
    body += "\"}";
  }
  body += "]}";

  const int code = http.POST(body);
  http.end();

  if (code >= 200 && code < 300) {
    count = 0;
    ackCount = 0;
    c.dropBatches(batchN);     // confirmed stored; safe to forget
    c.dropCycles(cycleN);
    return true;
  }

  Serial.printf("[telemetry] ingest failed with %d; keeping %u samples and %u records\n",
                code, (unsigned)count, (unsigned)(batchN + cycleN));
  return false;
}

}  // namespace telemetry
