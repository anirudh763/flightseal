#pragma once

#include "fseal.h"

#include <cstdint>
#include <string>
#include <vector>

namespace fseal {

struct ImportPoint {
  uint64_t source_offset = 0;
  uint64_t timestamp_us = 0;
  bool has_altitude = false;
  bool has_latitude = false;
  bool has_longitude = false;
  bool has_speed = false;
  bool has_battery = false;
  double altitude_m = 0;
  double latitude_deg = 0;
  double longitude_deg = 0;
  double speed_mps = 0;
  double battery_v = 0;
};

struct ImportResult {
  uint64_t bytes = 0;
  Hash sha256{};
  uint64_t records = 0;
  PublicKey public_key{};
  std::string receipts;
  uint64_t telemetry_total = 0;
  bool telemetry_decimated = false;
  std::vector<ImportPoint> telemetry;
};

// Validates a ULog stream, then seals its raw bytes in FSRAW001 envelopes and appends
// the source digest envelope. Output uses the ordinary FLTSEAL1 Writer and receipt v1.
ImportResult import_ulog(const std::string& source_path, const std::string& log_path,
                         const std::string& key_path, uint32_t receipt_interval);

}  // namespace fseal
