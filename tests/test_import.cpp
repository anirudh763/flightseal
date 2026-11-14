#include "import.h"

#include <cstdio>
#include <fstream>
#include <iostream>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
#define assert(condition) do { if (!(condition)) throw std::runtime_error("check failed at line " + std::to_string(__LINE__) + ": " #condition); } while (0)
using Bytes = std::vector<unsigned char>;
void put(Bytes& out, uint64_t value, size_t n) {
  for (size_t i = 0; i < n; ++i) out.push_back(static_cast<unsigned char>((value >> (8 * i)) & 0xff));
}
void message(Bytes& out, char type, const Bytes& payload) {
  put(out, payload.size(), 2);
  out.push_back(static_cast<unsigned char>(type));
  out.insert(out.end(), payload.begin(), payload.end());
}
void write_file(const std::string& path, const Bytes& bytes) {
  std::ofstream out(path, std::ios::binary);
  out.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
}
Bytes sample(unsigned char version = 1, bool with_flags = true) {
  Bytes out{'U','L','o','g',1,0x12,0x35,version};
  put(out, 100, 8);
  if (with_flags) { Bytes flags(40, 0); message(out, 'B', flags); }
  const std::string format = "vehicle_global_position:uint64_t timestamp;double lat;double lon;float alt;float vel_n;float vel_e;";
  message(out, 'F', Bytes(format.begin(), format.end()));
  const std::string topic = "vehicle_global_position";
  Bytes add{0}; put(add, 0, 2); add.insert(add.end(), topic.begin(), topic.end());
  message(out, 'A', add);
  Bytes data; put(data, 0, 2); put(data, 123456, 8);
  uint64_t lat = 0x404A400000000000ULL; // 52.5 degrees
  uint64_t lon = 0xC010800000000000ULL; // -4.125 degrees
  put(data, lat, 8); put(data, lon, 8);
  uint32_t alt = 0x41A00000; // 20.0f
  uint32_t north = 0x40400000; // 3.0f
  uint32_t east = 0x40800000; // 4.0f
  put(data, alt, 4); put(data, north, 4); put(data, east, 4);
  message(out, 'D', data);
  return out;
}
uint64_t read_le(const unsigned char* p, size_t n) {
  uint64_t value = 0;
  for (size_t i = 0; i < n; ++i) value |= static_cast<uint64_t>(p[i]) << (8 * i);
  return value;
}
std::string read_file(const std::string& path) {
  std::ifstream in(path, std::ios::binary);
  return {std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>()};
}
void cleanup() {
  std::remove("import-source.ulg");
  std::remove("import-log.fseal");
  std::remove("import-key.pem");
}

void valid_import_preserves_raw_bytes_and_receipts() {
  cleanup();
  const Bytes source = sample();
  write_file("import-source.ulg", source);
  fseal::ImportResult imported = fseal::import_ulog("import-source.ulg", "import-log.fseal", "import-key.pem", 1);
  assert(imported.bytes == source.size());
  assert(imported.records == 2); // one raw chunk, then digest envelope
  assert(imported.telemetry_total == 1 && imported.telemetry.size() == 1);
  assert(imported.telemetry[0].timestamp_us == 123456);
  assert(imported.telemetry[0].has_latitude && imported.telemetry[0].latitude_deg == 52.5);
  assert(imported.telemetry[0].has_longitude && imported.telemetry[0].longitude_deg == -4.125);
  assert(imported.telemetry[0].has_altitude && imported.telemetry[0].altitude_m == 20.0);
  assert(imported.telemetry[0].has_speed && imported.telemetry[0].speed_mps == 5.0);

  std::string sealed = read_file("import-log.fseal");
  assert(sealed.substr(0, 8) == fseal::kMagic);
  auto links = std::map<uint64_t, fseal::Hash>{{1, {}}, {2, {}}};
  fseal::ScanResult scan = fseal::scan("import-log.fseal", &links);
  assert(scan.status == fseal::Status::Ok && scan.records == 2);
  size_t cursor = fseal::kMagic.size();
  std::string rebuilt;
  bool saw_digest = false;
  for (uint64_t i = 0; i < scan.records; ++i) {
    const uint32_t len = static_cast<uint32_t>(read_le(reinterpret_cast<const unsigned char*>(sealed.data() + cursor), 4));
    const uint64_t seq = read_le(reinterpret_cast<const unsigned char*>(sealed.data() + cursor + 4), 8);
    const char* payload = sealed.data() + cursor + fseal::kRecordHeader;
    assert(seq == i && len >= 18);
    assert(std::string(payload, payload + 8) == "FSRAW001");
    assert(static_cast<unsigned char>(payload[8]) == 1);
    const uint64_t offset = read_le(reinterpret_cast<const unsigned char*>(payload + 10), 8);
    if (static_cast<unsigned char>(payload[9]) == 0) {
      assert(!saw_digest && offset == rebuilt.size());
      rebuilt.append(payload + 18, len - 18);
    } else {
      assert(static_cast<unsigned char>(payload[9]) == 1 && i == scan.records - 1);
      assert(offset == source.size() && len == 50);
      assert(std::string(payload + 18, 32) == std::string(reinterpret_cast<const char*>(imported.sha256.data()), 32));
      saw_digest = true;
    }
    cursor += fseal::kRecordHeader + len + fseal::kRecordTrailer;
  }
  assert(saw_digest && rebuilt == std::string(source.begin(), source.end()));
  const size_t split = imported.receipts.find('\n');
  const size_t end = imported.receipts.find('\n', split + 1);
  fseal::Receipt first, final;
  assert(split != std::string::npos);
  assert(fseal::parse_line(imported.receipts.substr(0, split), &first));
  assert(fseal::parse_line(imported.receipts.substr(split + 1, end - split - 1), &final));
  assert(first.count == 1 && final.count == scan.records);
  assert(fseal::check_receipt(first, imported.public_key, scan, links) == fseal::ReceiptCheck::Ok);
  assert(fseal::check_receipt(final, imported.public_key, scan, links) == fseal::ReceiptCheck::Ok);
  cleanup();
}

void malformed_ulog_is_rejected_without_output() {
  cleanup();
  Bytes bad = sample();
  bad[7] = 2;
  write_file("import-source.ulg", bad);
  bool rejected = false;
  try { (void)fseal::import_ulog("import-source.ulg", "import-log.fseal", "import-key.pem", 10); }
  catch (const std::exception&) { rejected = true; }
  assert(rejected);
  cleanup();

  write_file("import-source.ulg", Bytes{1, 2, 3});
  rejected = false;
  try { (void)fseal::import_ulog("import-source.ulg", "import-log.fseal", "import-key.pem", 10); }
  catch (const std::exception&) { rejected = true; }
  assert(rejected);
  cleanup();

  // Version 0 logs predate the optional flag-bits frame and remain a supported ULog variant.
  bad = sample(0, false);
  write_file("import-source.ulg", bad);
  auto legacy = fseal::import_ulog("import-source.ulg", "import-log.fseal", "import-key.pem", 10);
  assert(legacy.bytes == bad.size() && legacy.records == 2);
  cleanup();

  bad = sample();
  bad.pop_back();
  write_file("import-source.ulg", bad);
  rejected = false;
  try { (void)fseal::import_ulog("import-source.ulg", "import-log.fseal", "import-key.pem", 10); }
  catch (const std::exception&) { rejected = true; }
  assert(rejected);
  cleanup();
}

void invalid_receipt_intervals_are_rejected() {
  cleanup();
  const Bytes source = sample();
  write_file("import-source.ulg", source);
  for (uint32_t every : {0u, 1000001u}) {
    bool rejected = false;
    try { (void)fseal::import_ulog("import-source.ulg", "import-log.fseal", "import-key.pem", every); }
    catch (const std::invalid_argument&) { rejected = true; }
    assert(rejected);
  }
  cleanup();
}

void malformed_lengths_and_invalid_data_are_rejected() {
  cleanup();
  Bytes bad = sample();
  // The first ULog message begins at byte 16. Its declared payload cannot fit the file.
  bad[16] = 0xff; bad[17] = 0xff;
  write_file("import-source.ulg", bad);
  bool rejected = false;
  try { (void)fseal::import_ulog("import-source.ulg", "import-log.fseal", "import-key.pem", 10); }
  catch (const std::exception&) { rejected = true; }
  assert(rejected);
  cleanup();

  bad = sample();
  size_t pos = 16;
  while (pos + 3 <= bad.size()) {
    const size_t length = static_cast<size_t>(read_le(bad.data() + pos, 2));
    if (bad[pos + 2] == 'D') { bad[pos + 3] = 0x7f; bad[pos + 4] = 0x7f; break; }
    pos += 3 + length;
  }
  write_file("import-source.ulg", bad);
  rejected = false;
  try { (void)fseal::import_ulog("import-source.ulg", "import-log.fseal", "import-key.pem", 10); }
  catch (const std::exception&) { rejected = true; }
  assert(rejected);
  cleanup();
}

void multi_chunk_import_keeps_offsets_and_final_receipt() {
  cleanup();
  Bytes source = sample();
  for (unsigned i = 0; i < 18; ++i) {
    Bytes info;
    info.push_back(1); // one-byte key, remaining bytes are an opaque info value
    info.push_back('x');
    info.insert(info.end(), 60000, static_cast<unsigned char>('a'));
    message(source, 'I', info);
  }
  const size_t chunk_bytes = static_cast<size_t>(fseal::kMaxPayload - 18);
  assert(source.size() > chunk_bytes && source.size() < 2 * chunk_bytes);
  write_file("import-source.ulg", source);
  auto imported = fseal::import_ulog("import-source.ulg", "import-log.fseal", "import-key.pem", 2);
  assert(imported.records == 3 && imported.telemetry.size() == 1);

  const std::string sealed = read_file("import-log.fseal");
  std::map<uint64_t, fseal::Hash> links{{2, {}}, {3, {}}};
  const auto scan = fseal::scan("import-log.fseal", &links);
  assert(scan.status == fseal::Status::Ok && scan.records == 3);
  size_t cursor = fseal::kMagic.size();
  std::string rebuilt;
  std::vector<uint64_t> offsets;
  for (uint64_t i = 0; i < 2; ++i) {
    const size_t length = static_cast<size_t>(read_le(reinterpret_cast<const unsigned char*>(sealed.data() + cursor), 4));
    const char* payload = sealed.data() + cursor + fseal::kRecordHeader;
    offsets.push_back(read_le(reinterpret_cast<const unsigned char*>(payload + 10), 8));
    assert(static_cast<unsigned char>(payload[9]) == 0 && offsets.back() == rebuilt.size());
    rebuilt.append(payload + 18, length - 18);
    cursor += fseal::kRecordHeader + length + fseal::kRecordTrailer;
  }
  assert(offsets[0] == 0 && offsets[1] == chunk_bytes);
  assert(rebuilt == std::string(source.begin(), source.end()));
  const size_t first_line = imported.receipts.find('\n');
  const size_t second_line = imported.receipts.find('\n', first_line + 1);
  fseal::Receipt receipt;
  assert(fseal::parse_line(imported.receipts.substr(first_line + 1, second_line - first_line - 1), &receipt));
  assert(receipt.count == 3);
  assert(fseal::check_receipt(receipt, imported.public_key, scan, links) == fseal::ReceiptCheck::Ok);
  cleanup();
}

void trailing_padding_can_be_omitted_but_required_fields_cannot() {
  cleanup();
  Bytes source{'U','L','o','g',1,0x12,0x35,1};
  put(source, 1, 8);
  const std::string format = "test_topic:uint64_t timestamp;float value;uint8_t[4] _padding0;";
  message(source, 'F', Bytes(format.begin(), format.end()));
  const std::string topic = "test_topic";
  Bytes add{0}; put(add, 0, 2); add.insert(add.end(), topic.begin(), topic.end());
  message(source, 'A', add);
  Bytes sample_data; put(sample_data, 0, 2); put(sample_data, 5, 8); put(sample_data, 0x3f800000, 4);
  message(source, 'D', sample_data); // final four padding bytes are optional on the wire
  write_file("import-source.ulg", source);
  auto imported = fseal::import_ulog("import-source.ulg", "import-log.fseal", "import-key.pem", 10);
  assert(imported.bytes == source.size());
  cleanup();

  size_t data_start = 16;
  while (source[data_start + 2] != 'D') data_start += 3 + static_cast<size_t>(read_le(source.data() + data_start, 2));
  source.pop_back(); // cut one byte from the required float field
  const size_t shortened = static_cast<size_t>(read_le(source.data() + data_start, 2)) - 1;
  source[data_start] = static_cast<unsigned char>(shortened & 0xff);
  source[data_start + 1] = static_cast<unsigned char>(shortened >> 8);
  write_file("import-source.ulg", source);
  bool rejected = false;
  try { (void)fseal::import_ulog("import-source.ulg", "import-log.fseal", "import-key.pem", 10); }
  catch (const std::exception&) { rejected = true; }
  assert(rejected);
  cleanup();
}

void wrong_metric_types_are_preserved_but_never_decoded_as_units() {
  cleanup();
  Bytes source{'U','L','o','g',1,0x12,0x35,1};
  put(source, 1, 8);
  message(source, 'B', Bytes(40, 0));
  const std::string gps = "vehicle_gps_position:uint64_t timestamp;float lat;int32_t lon;float alt;double vel_m_s;";
  const std::string battery = "battery_status:uint64_t timestamp;int32_t voltage_v;";
  const std::string gps_topic = gps.substr(0, gps.find(':'));
  const std::string battery_topic = battery.substr(0, battery.find(':'));
  message(source, 'F', Bytes(gps.begin(), gps.end()));
  message(source, 'F', Bytes(battery.begin(), battery.end()));
  Bytes add_gps{0}; put(add_gps, 0, 2); add_gps.insert(add_gps.end(), gps_topic.begin(), gps_topic.end());
  Bytes add_battery{0}; put(add_battery, 1, 2); add_battery.insert(add_battery.end(), battery_topic.begin(), battery_topic.end());
  message(source, 'A', add_gps);
  message(source, 'A', add_battery);
  Bytes gps_data; put(gps_data, 0, 2); put(gps_data, 99, 8);
  put(gps_data, 0x42480000, 4); // float 50.0 is not PX4's int32 degrees * 1e7
  put(gps_data, static_cast<uint32_t>(-123456789), 4);
  put(gps_data, 0x41a00000, 4); // float altitude is not legacy GPS int32 millimetres
  put(gps_data, 0x4034000000000000ULL, 8); // double speed is not PX4 float m/s
  message(source, 'D', gps_data);
  Bytes battery_data; put(battery_data, 1, 2); put(battery_data, 100, 8); put(battery_data, 16000, 4);
  message(source, 'D', battery_data); // int32 voltage is not PX4 float volts
  write_file("import-source.ulg", source);
  const auto imported = fseal::import_ulog("import-source.ulg", "import-log.fseal", "import-key.pem", 10);
  assert(imported.sha256 == fseal::sha256(std::string(reinterpret_cast<const char*>(source.data()), source.size())));
  assert(imported.telemetry_total == 1 && imported.telemetry.size() == 1);
  const auto& point = imported.telemetry[0];
  assert(!point.has_latitude && point.has_longitude && point.longitude_deg == -12.3456789);
  assert(!point.has_altitude && !point.has_speed && !point.has_battery);
  cleanup();
}

void wrong_global_position_types_do_not_become_metrics() {
  cleanup();
  Bytes source{'U','L','o','g',1,0x12,0x35,1};
  put(source, 1, 8);
  message(source, 'B', Bytes(40, 0));
  const std::string format = "vehicle_global_position:uint64_t timestamp;float lat;float lon;int32_t alt;double vel_n;double vel_e;";
  message(source, 'F', Bytes(format.begin(), format.end()));
  const std::string topic = "vehicle_global_position";
  Bytes add{0}; put(add, 0, 2); add.insert(add.end(), topic.begin(), topic.end());
  message(source, 'A', add);
  Bytes data; put(data, 0, 2); put(data, 100, 8);
  put(data, 0x42480000, 4); put(data, 0xc0840000, 4); put(data, 20000, 4);
  put(data, 0x4008000000000000ULL, 8); put(data, 0x4010000000000000ULL, 8);
  message(source, 'D', data);
  write_file("import-source.ulg", source);
  const auto imported = fseal::import_ulog("import-source.ulg", "import-log.fseal", "import-key.pem", 10);
  assert(imported.bytes == source.size());
  assert(imported.telemetry_total == 0 && imported.telemetry.empty());
  cleanup();
}

void maximum_width_known_schema_uses_cached_metric_indices() {
  cleanup();
  Bytes source{'U','L','o','g',1,0x12,0x35,1};
  put(source, 1, 8);
  message(source, 'B', Bytes(40, 0));
  std::string format = "vehicle_global_position:uint64_t timestamp;";
  for (unsigned i = 0; i < 506; ++i) {
    std::string suffix = std::to_string(i);
    while (suffix.size() < 3) suffix.insert(suffix.begin(), '0');
    format += "uint8_t _padding" + suffix + ";";
  }
  format += "double lat;double lon;float alt;float vel_n;float vel_e;";
  message(source, 'F', Bytes(format.begin(), format.end()));
  const std::string topic = "vehicle_global_position";
  Bytes add{0}; put(add, 0, 2); add.insert(add.end(), topic.begin(), topic.end());
  message(source, 'A', add);
  for (uint64_t i = 0; i < 3000; ++i) {
    Bytes data; put(data, 0, 2); put(data, 1000 + i, 8); data.insert(data.end(), 506, 0);
    put(data, 0x404a400000000000ULL, 8); put(data, 0xc010800000000000ULL, 8);
    put(data, 0x41a00000, 4); put(data, 0x40400000, 4); put(data, 0x40800000, 4);
    message(source, 'D', data);
  }
  write_file("import-source.ulg", source);
  const auto imported = fseal::import_ulog("import-source.ulg", "import-log.fseal", "import-key.pem", 1000);
  assert(imported.telemetry_total == 3000 && imported.telemetry.size() == 3000);
  assert(imported.telemetry.front().has_latitude && imported.telemetry.front().latitude_deg == 52.5);
  assert(imported.telemetry.back().timestamp_us == 3999 && imported.telemetry.back().speed_mps == 5.0);
  assert(imported.bytes == source.size());
  cleanup();
}
}  // namespace

int main() {
  valid_import_preserves_raw_bytes_and_receipts();
  malformed_ulog_is_rejected_without_output();
  invalid_receipt_intervals_are_rejected();
  malformed_lengths_and_invalid_data_are_rejected();
  multi_chunk_import_keeps_offsets_and_final_receipt();
  trailing_padding_can_be_omitted_but_required_fields_cannot();
  wrong_metric_types_are_preserved_but_never_decoded_as_units();
  wrong_global_position_types_do_not_become_metrics();
  maximum_width_known_schema_uses_cached_metric_indices();
  std::cout << "native ULog import tests passed\n";
}
