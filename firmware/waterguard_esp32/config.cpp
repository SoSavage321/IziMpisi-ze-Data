#include "config.h"
#include <Preferences.h>

namespace {
Preferences prefs;
const char *NS = "waterguard";
}

namespace config {

void begin(PlantConfig &out) {
  out = DEFAULT_CONFIG;
  if (!prefs.begin(NS, true)) return;             // read-only; nothing stored yet

  if (prefs.isKey("version")) {
    out.version           = prefs.getUInt("version", DEFAULT_CONFIG.version);
    out.phMin             = prefs.getFloat("phMin", DEFAULT_CONFIG.phMin);
    out.phMax             = prefs.getFloat("phMax", DEFAULT_CONFIG.phMax);
    out.tdsMax            = prefs.getUShort("tdsMax", DEFAULT_CONFIG.tdsMax);
    out.treatTargetPh     = prefs.getFloat("target", DEFAULT_CONFIG.treatTargetPh);
    out.testWindowS       = prefs.getUChar("testW", DEFAULT_CONFIG.testWindowS);
    out.stableWindowS     = prefs.getUChar("stableW", DEFAULT_CONFIG.stableWindowS);
    out.batchL            = prefs.getUShort("batchL", DEFAULT_CONFIG.batchL);
    out.tankCapL          = prefs.getUShort("tankL", DEFAULT_CONFIG.tankCapL);
    out.phWarnMax         = prefs.getFloat("phWarn", DEFAULT_CONFIG.phWarnMax);
    out.neutraliserLowPct = prefs.getUChar("neutLow", DEFAULT_CONFIG.neutraliserLowPct);
  }
  prefs.end();

  // Anything that fails validation is discarded in favour of the defaults.
  // Corrupt NVS must never be able to widen a discharge limit.
  if (validate(out) != nullptr) out = DEFAULT_CONFIG;
}

bool save(const PlantConfig &cfg) {
  if (validate(cfg) != nullptr) return false;
  if (!prefs.begin(NS, false)) return false;
  prefs.putUInt("version", cfg.version);
  prefs.putFloat("phMin", cfg.phMin);
  prefs.putFloat("phMax", cfg.phMax);
  prefs.putUShort("tdsMax", cfg.tdsMax);
  prefs.putFloat("target", cfg.treatTargetPh);
  prefs.putUChar("testW", cfg.testWindowS);
  prefs.putUChar("stableW", cfg.stableWindowS);
  prefs.putUShort("batchL", cfg.batchL);
  prefs.putUShort("tankL", cfg.tankCapL);
  prefs.putFloat("phWarn", cfg.phWarnMax);
  prefs.putUChar("neutLow", cfg.neutraliserLowPct);
  prefs.end();
  return true;
}

const char *validate(const PlantConfig &c) {
  if (c.phMin < 6.0f || c.phMin > 7.0f)   return "ph_min must be between 6.0 and 7.0";
  if (c.phMax < 8.0f || c.phMax > 9.5f)   return "ph_max must be between 8.0 and 9.5";
  if (c.phMax <= c.phMin)                 return "ph_max must be above ph_min";
  if (c.tdsMax < 500 || c.tdsMax > 2000)  return "tds_max must be between 500 and 2000 mg/L";
  if (c.treatTargetPh <= c.phMin || c.treatTargetPh >= c.phMax)
                                          return "treat_target_ph must sit inside the pass band";
  if (c.testWindowS < 1 || c.testWindowS > 60)     return "test_window_s must be between 1 and 60 s";
  if (c.stableWindowS < 1 || c.stableWindowS > 60) return "stable_window_s must be between 1 and 60 s";
  if (c.batchL < 10)                      return "batch_l is too small to be a batch";
  if (c.tankCapL < 50)                    return "tank_cap_l is too small";
  if (c.phWarnMax < 7.0f || c.phWarnMax > 10.0f)   return "ph_warn_max must be between 7.0 and 10.0";
  if (c.neutraliserLowPct < 1 || c.neutraliserLowPct > 90)
                                          return "neutraliser_low_pct must be between 1 and 90";
  return nullptr;
}

}  // namespace config
