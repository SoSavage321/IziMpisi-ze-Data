#include "wifi_manager.h"
#include <WiFi.h>

namespace {
const char *ssid_ = nullptr;
const char *password_ = nullptr;

uint32_t nextAttempt_ = 0;
uint32_t backoffMs_ = 1000;                 // doubles to a ceiling
const uint32_t BACKOFF_MAX_MS = 60000;      // never stop trying, but stop hammering
uint32_t lastConnectedMs_ = 0;
bool wasConnected_ = false;
}  // namespace

namespace wifi_manager {

void begin(const char *ssid, const char *password) {
  ssid_ = ssid;
  password_ = password;
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  // Keeping the radio awake costs power but avoids latency spikes on the
  // command poll; a plant controller is mains-powered anyway.
  WiFi.setSleep(false);
  WiFi.begin(ssid_, password_);
  nextAttempt_ = millis() + backoffMs_;
  lastConnectedMs_ = millis();
}

void tick() {
  const uint32_t now = millis();

  if (WiFi.status() == WL_CONNECTED) {
    if (!wasConnected_) {
      Serial.printf("[wifi] connected, %s, %d dBm\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
      wasConnected_ = true;
    }
    lastConnectedMs_ = now;
    backoffMs_ = 1000;                      // reset the backoff for next time
    return;
  }

  if (wasConnected_) {
    Serial.println("[wifi] lost association; the plant keeps running");
    wasConnected_ = false;
  }

  if ((int32_t)(now - nextAttempt_) < 0) return;

  Serial.printf("[wifi] retrying in %lu ms steps\n", (unsigned long)backoffMs_);
  WiFi.disconnect();
  WiFi.begin(ssid_, password_);

  backoffMs_ = backoffMs_ * 2;
  if (backoffMs_ > BACKOFF_MAX_MS) backoffMs_ = BACKOFF_MAX_MS;
  nextAttempt_ = now + backoffMs_;
}

bool connected() { return WiFi.status() == WL_CONNECTED; }

int rssi() { return connected() ? WiFi.RSSI() : -127; }

uint32_t offlineSeconds() {
  if (connected()) return 0;
  return (millis() - lastConnectedMs_) / 1000;
}

}  // namespace wifi_manager
