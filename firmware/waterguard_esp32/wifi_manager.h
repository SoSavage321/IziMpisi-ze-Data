/**
 * WiFi with exponential backoff.
 *
 * The important property here is what it does NOT do: it never blocks the
 * control loop. Connecting, retrying and giving up all happen in slices, so a
 * plant with no network still fills, tests, decides and enforces every
 * interlock on time.
 */

#ifndef WATERGUARD_WIFI_MANAGER_H
#define WATERGUARD_WIFI_MANAGER_H

#include <Arduino.h>

namespace wifi_manager {

void begin(const char *ssid, const char *password);

/** Call every loop. Non-blocking; drives reconnection. */
void tick();

bool connected();
int  rssi();

/** Seconds since the radio last had an association. */
uint32_t offlineSeconds();

}  // namespace wifi_manager

#endif
