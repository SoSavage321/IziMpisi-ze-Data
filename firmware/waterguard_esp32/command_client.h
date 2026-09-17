/**
 * Command client.
 *
 * Polls GET /commands every two seconds, hands each command to the controller
 * for validation, and acknowledges with accepted/rejected plus the reason the
 * controller gave. The server never decides; it only carries the request and
 * records the answer.
 *
 * A command older than its expiry is refused without being executed. A device
 * that has just come back from an outage must not act on an emergency
 * instruction that was issued ten minutes ago and has since been overtaken.
 */

#ifndef WATERGUARD_COMMAND_CLIENT_H
#define WATERGUARD_COMMAND_CLIENT_H

#include <Arduino.h>
#include "controller.h"

namespace command_client {

void begin(const char *apiBase, const char *deviceKey);

/**
 * Poll once. Non-blocking in the sense that it is only called on its own
 * cadence, never inside the control path. Returns the number of commands
 * handled.
 */
uint8_t poll(Controller &c, const SensorReading &in);

/** Latest configuration version the server says this device should run. */
uint32_t serverConfigVersion();

}  // namespace command_client

#endif
