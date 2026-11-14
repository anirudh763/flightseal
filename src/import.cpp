#include "import.h"

#include <openssl/evp.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iomanip>
#include <limits>
#include <map>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>

namespace fseal {
namespace {
constexpr uint64_t kRawPayloadMax = kMaxPayload - 18;
constexpr uint64_t kImportMaxBytes = 1ULL << 30;
constexpr size_t kInputBufferBytes = 1u << 20;
constexpr size_t kTelemetryLimit = 20000;
constexpr size_t kFormatLimit = 4096;
constexpr size_t kFieldLimit = 100000;
constexpr uint64_t kMessageLimit = 20000000;
constexpr unsigned char kUlogMagic[7] = {'U', 'L', 'o', 'g', 0x01, 0x12, 0x35};

uint64_t le(const unsigned char* p, size_t n) {
  uint64_t value = 0;
  for (size_t i = 0; i < n; ++i) value |= static_cast<uint64_t>(p[i]) << (8 * i);
  return value;
}

void append_le(std::string& out, uint64_t value, size_t n) {
  for (size_t i = 0; i < n; ++i) out.push_back(static_cast<char>((value >> (8 * i)) & 0xff));
}

struct Field {
  std::string type;
  std::string name;
  size_t count = 1;
  size_t offset = 0;
  size_t width = 0;
  bool numeric = false;
};

enum class TopicKind { None, GlobalPosition, GpsPosition, Battery };

struct TelemetryBinding {
  TopicKind kind = TopicKind::None;
  int timestamp = -1;
  int latitude = -1;
  int longitude = -1;
  int altitude = -1;
  int speed = -1;
  int speed_north = -1;
  int speed_east = -1;
  int battery = -1;
  bool initialized = false;
};

struct Format {
  std::string name;
  std::vector<Field> fields;
  size_t size = 0;
  size_t min_size = 0;
  bool resolved = false;
  bool resolving = false;
  int timestamp_index = -1;
  TelemetryBinding telemetry;
};

struct Subscription { std::string topic; };

size_t primitive_size(const std::string& type) {
  if (type == "int8_t" || type == "uint8_t" || type == "char" || type == "bool") return 1;
  if (type == "int16_t" || type == "uint16_t") return 2;
  if (type == "int32_t" || type == "uint32_t" || type == "float") return 4;
  if (type == "int64_t" || type == "uint64_t" || type == "double") return 8;
  return 0;
}

std::string trim(std::string s) {
  const auto first = s.find_first_not_of(" \t\r\n");
  if (first == std::string::npos) return {};
  const auto last = s.find_last_not_of(" \t\r\n");
  return s.substr(first, last - first + 1);
}

bool valid_identifier(std::string_view value, bool format_name = false) {
  if (value.empty()) return false;
  for (unsigned char c : value) {
    const bool alpha_num = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
    if (!alpha_num && c != '_' && !(format_name && (c == '-' || c == '/'))) return false;
  }
  return true;
}

Format parse_format(std::string_view text) {
  const size_t colon = text.find(':');
  if (colon == std::string_view::npos || colon == 0) throw std::runtime_error("ULog invalid format definition");
  Format result;
  result.name = trim(std::string(text.substr(0, colon)));
  if (result.name.size() > 200 || !valid_identifier(result.name, true)) throw std::runtime_error("ULog invalid format name");
  size_t pos = colon + 1;
  while (pos < text.size()) {
    const size_t semi = text.find(';', pos);
    if (semi == std::string_view::npos) throw std::runtime_error("ULog format field is missing a semicolon");
    std::string definition = trim(std::string(text.substr(pos, semi - pos)));
    if (definition.empty()) throw std::runtime_error("ULog empty format field");
    const size_t space = definition.find_first_of(" \t");
    if (space == std::string::npos) throw std::runtime_error("ULog invalid format field");
    std::string type = definition.substr(0, space);
    std::string name = trim(definition.substr(space + 1));
    if (name.size() > 200 || !valid_identifier(name))
      throw std::runtime_error("ULog invalid format field name");
    size_t count = 1;
    const size_t bracket = type.find('[');
    if (bracket != std::string::npos) {
      if (type.back() != ']' || bracket == 0 || bracket + 2 >= type.size())
        throw std::runtime_error("ULog invalid fixed array declaration");
      const std::string digits = type.substr(bracket + 1, type.size() - bracket - 2);
      uint64_t parsed = 0;
      for (char c : digits) {
        if (c < '0' || c > '9' || parsed > (4096 - static_cast<unsigned>(c - '0')) / 10)
          throw std::runtime_error("ULog array length exceeds parser limit");
        parsed = parsed * 10 + static_cast<unsigned>(c - '0');
      }
      if (parsed == 0 || parsed > 4096) throw std::runtime_error("ULog invalid fixed array length");
      count = static_cast<size_t>(parsed);
      type.resize(bracket);
    }
    if (std::any_of(result.fields.begin(), result.fields.end(), [&](const Field& f) { return f.name == name; }))
      throw std::runtime_error("ULog duplicate format field");
    if (result.fields.size() >= 512) throw std::runtime_error("ULog format field count exceeds parser limit");
    result.fields.push_back({type, name, count});
    pos = semi + 1;
  }
  if (result.fields.empty()) throw std::runtime_error("ULog format has no fields");
  return result;
}

void resolve_format(Format& format, std::map<std::string, Format>& formats, unsigned depth = 0) {
  if (format.resolved) return;
  if (format.resolving || depth > 16) throw std::runtime_error("ULog recursive or excessively nested format");
  format.resolving = true;
  size_t offset = 0, mandatory = 0;
  for (Field& field : format.fields) {
    size_t base = primitive_size(field.type);
    if (base == 0) {
      auto nested = formats.find(field.type);
      if (nested == formats.end()) throw std::runtime_error("ULog unresolved field type: " + field.type);
      resolve_format(nested->second, formats, depth + 1);
      base = nested->second.size;
    } else {
      field.numeric = field.type != "char" && field.type != "bool";
    }
    if (base == 0 || field.count > kMaxPayload / base || offset > kMaxPayload - base * field.count)
      throw std::runtime_error("ULog message format exceeds parser limit");
    field.offset = offset;
    field.width = base;
    if (field.name == "timestamp") format.timestamp_index = static_cast<int>(&field - format.fields.data());
    offset += base * field.count;
    if (field.name.rfind("_padding", 0) != 0) mandatory = offset;
  }
  format.size = offset;
  format.min_size = mandatory;
  format.resolving = false;
  format.resolved = true;
}

int field_index(const Format& format, std::string_view name) {
  for (size_t i = 0; i < format.fields.size(); ++i) {
    if (format.fields[i].name == name) return static_cast<int>(i);
  }
  return -1;
}

int bind_scalar(const Format& format, std::string_view name, std::string_view expected_type) {
  const int index = field_index(format, name);
  if (index < 0) return -1;
  const Field& field = format.fields[static_cast<size_t>(index)];
  return field.type == expected_type && field.count == 1 && field.numeric ? index : -1;
}

void bind_telemetry(Format& format, const std::string& topic) {
  if (format.telemetry.initialized) return;
  TelemetryBinding& binding = format.telemetry;
  binding.initialized = true;
  if (topic == "vehicle_global_position") binding.kind = TopicKind::GlobalPosition;
  else if (topic == "vehicle_gps_position") binding.kind = TopicKind::GpsPosition;
  else if (topic == "battery_status") binding.kind = TopicKind::Battery;
  else return;

  // These are PX4 ULog/uORB field-type and unit conventions, not evidence that the
  // vehicle's sensors or metadata are truthful. Mismatched fields stay raw and unset.
  binding.timestamp = bind_scalar(format, "timestamp", "uint64_t");
  if (binding.timestamp < 0) { binding.kind = TopicKind::None; return; }
  if (binding.kind == TopicKind::GlobalPosition) {
    binding.latitude = bind_scalar(format, "lat", "double");
    binding.longitude = bind_scalar(format, "lon", "double");
    binding.altitude = bind_scalar(format, "alt", "float");
    binding.speed_north = bind_scalar(format, "vel_n", "float");
    binding.speed_east = bind_scalar(format, "vel_e", "float");
  } else if (binding.kind == TopicKind::GpsPosition) {
    binding.latitude = bind_scalar(format, "lat", "int32_t");
    binding.longitude = bind_scalar(format, "lon", "int32_t");
    binding.altitude = bind_scalar(format, "alt", "int32_t");
    binding.speed = bind_scalar(format, "vel_m_s", "float");
  } else {
    binding.battery = bind_scalar(format, "voltage_v", "float");
  }
}

double numeric_value(const Field& field, const unsigned char* data, size_t size) {
  if (!field.numeric || field.count != 1 || field.offset + field.width > size) return NAN;
  const unsigned char* p = data + field.offset;
  const uint64_t raw = le(p, field.width);
  if (field.type == "float") {
    static_assert(sizeof(float) == 4 && std::numeric_limits<float>::is_iec559, "IEEE float required");
    const uint32_t bits = static_cast<uint32_t>(raw);
    float value;
    std::memcpy(&value, &bits, sizeof(value));
    return value;
  }
  if (field.type == "double") {
    static_assert(sizeof(double) == 8 && std::numeric_limits<double>::is_iec559, "IEEE double required");
    double value;
    std::memcpy(&value, &raw, sizeof(value));
    return value;
  }
  if (field.type == "int8_t") return static_cast<int8_t>(raw);
  if (field.type == "int16_t") return static_cast<int16_t>(raw);
  if (field.type == "int32_t") return static_cast<int32_t>(raw);
  if (field.type == "int64_t") return static_cast<double>(static_cast<int64_t>(raw));
  return static_cast<double>(raw);
}

bool finite(double value) { return std::isfinite(value); }

class UlogParser {
 public:
  void feed(const unsigned char* data, size_t size) {
    if (ended_) throw std::runtime_error("ULog parser already finalized");
    if (size > 2u * 1024u * 1024u || buffer_.size() > 2u * 1024u * 1024u - size)
      throw std::runtime_error("ULog parser buffer limit exceeded");
    buffer_.insert(buffer_.end(), data, data + size);
    parse_available();
  }

  void finish() {
    parse_available();
    if (!header_read_) throw std::runtime_error("ULog is shorter than its 16-byte header");
    if (!buffer_.empty()) throw std::runtime_error("ULog truncated final message");
    if (message_count_ == 0) throw std::runtime_error("ULog contains no messages");
    ended_ = true;
  }

  uint64_t timestamp() const { return last_timestamp_; }
  const std::vector<ImportPoint>& points() const { return points_; }
  uint64_t total_points() const { return total_points_; }

 private:
  void parse_available() {
    size_t consumed = 0;
    if (!header_read_) {
      if (buffer_.size() < 16) return;
      if (std::memcmp(buffer_.data(), kUlogMagic, sizeof(kUlogMagic)) != 0 || buffer_[7] > 1)
        throw std::runtime_error("unsupported or invalid ULog header (versions 0 and 1 are supported)");
      last_timestamp_ = le(buffer_.data() + 8, 8);
      consumed = 16;
      header_read_ = true;
    }
    while (buffer_.size() - consumed >= 3) {
      const auto* p = buffer_.data() + consumed;
      const size_t payload_size = static_cast<size_t>(le(p, 2));
      const size_t total = 3 + payload_size;
      if (payload_size == 0) throw std::runtime_error("ULog contains a zero-length message");
      if (buffer_.size() - consumed < total) break;
      parse_message(static_cast<char>(p[2]), p + 3, payload_size, base_offset_ + consumed);
      consumed += total;
      ++message_count_;
      if (message_count_ > kMessageLimit) throw std::runtime_error("ULog message count exceeds parser limit");
    }
    if (consumed) {
      buffer_.erase(buffer_.begin(), buffer_.begin() + static_cast<std::ptrdiff_t>(consumed));
      base_offset_ += consumed;
    }
    if (buffer_.size() > 65538) throw std::runtime_error("ULog message length exceeds framing limit");
  }

  void parse_message(char type, const unsigned char* p, size_t n, uint64_t message_offset) {
    if (first_message_) {
      first_message_ = false;
      if (type == 'B') {
        if (n < 40) throw std::runtime_error("ULog invalid flag-bits message length");
        for (size_t i = 8; i < 16; ++i) if (p[i] != 0) throw std::runtime_error("ULog unsupported incompatible flag");
        for (size_t i = 16; i < 40; ++i) if (p[i] != 0) throw std::runtime_error("ULog appended data is unsupported");
        return;
      }
    } else if (type == 'B') {
      throw std::runtime_error("ULog flag-bits message is not first");
    }
    switch (type) {
      case 'F': {
        if (data_phase_) throw std::runtime_error("ULog format definition follows data section");
        if (n > 16384) throw std::runtime_error("ULog format definition exceeds parser limit");
        const char* end = static_cast<const char*>(std::memchr(p, 0, n));
        const size_t text_size = end ? static_cast<size_t>(end - reinterpret_cast<const char*>(p)) : n;
        Format f = parse_format(std::string_view(reinterpret_cast<const char*>(p), text_size));
        if (formats_.size() >= kFormatLimit) throw std::runtime_error("ULog format count exceeds parser limit");
        if (f.fields.size() > kFieldLimit - format_fields_) throw std::runtime_error("ULog total field count exceeds parser limit");
        format_fields_ += f.fields.size();
        if (!formats_.emplace(f.name, std::move(f)).second) throw std::runtime_error("ULog duplicate format definition");
        break;
      }
      case 'I': case 'P': {
        if (n < 1 || static_cast<size_t>(p[0]) > n - 1) throw std::runtime_error("ULog invalid key/value message length");
        break;
      }
      case 'M': {
        if (n < 2 || p[1] > n - 2 || p[0] > 1) throw std::runtime_error("ULog invalid multi-info message length");
        break;
      }
      case 'Q': {
        if (n < 2 || p[1] > n - 2) throw std::runtime_error("ULog invalid default-parameter message length");
        break;
      }
      case 'A': {
        data_phase_ = true;
        if (n < 4) throw std::runtime_error("ULog invalid subscription message length");
        const uint16_t id = static_cast<uint16_t>(le(p + 1, 2));
        const char* name = reinterpret_cast<const char*>(p + 3);
        const std::string topic(name, n - 3);
        if (id_subscriptions_.count(id) || !valid_identifier(topic, true))
          throw std::runtime_error("ULog invalid or duplicate subscription");
        auto format = formats_.find(topic);
        if (format == formats_.end()) throw std::runtime_error("ULog subscription has no format: " + topic);
        resolve_format(format->second, formats_);
        bind_telemetry(format->second, topic);
        id_subscriptions_[id] = {topic};
        break;
      }
      case 'R': {
        data_phase_ = true;
        if (n != 2) throw std::runtime_error("ULog invalid unsubscribe message length");
        const uint16_t id = static_cast<uint16_t>(le(p, 2));
        if (id_subscriptions_.erase(id) != 1) throw std::runtime_error("ULog unsubscribes an unknown message id");
        break;
      }
      case 'D': {
        data_phase_ = true;
        if (n < 2) throw std::runtime_error("ULog data message is shorter than its message id");
        const uint16_t id = static_cast<uint16_t>(le(p, 2));
        auto subscription = id_subscriptions_.find(id);
        if (subscription == id_subscriptions_.end()) throw std::runtime_error("ULog data references unknown subscription");
        Format& f = formats_.at(subscription->second.topic);
        resolve_format(f, formats_);
        const size_t payload_size = n - 2;
        if (payload_size < f.min_size || payload_size > f.size)
          throw std::runtime_error("ULog data payload length does not match declared format");
        if (f.timestamp_index >= 0) {
          const Field& message_time = f.fields[static_cast<size_t>(f.timestamp_index)];
          if (message_time.type == "uint64_t" && message_time.count == 1 && message_time.offset + 8 <= payload_size)
            last_timestamp_ = le(p + 2 + message_time.offset, 8);
        }
        decode_point(subscription->second.topic, f, p + 2, payload_size, message_offset);
        break;
      }
      case 'O':
        if (n != 2) throw std::runtime_error("ULog invalid dropout message length");
        break;
      case 'S':
        if (n != 8) throw std::runtime_error("ULog invalid sync message length");
        break;
      case 'L':
        data_phase_ = true;
        if (n < 9) throw std::runtime_error("ULog invalid log-string message length");
        last_timestamp_ = le(p + 1, 8);
        break;
      case 'C':
        data_phase_ = true;
        if (n < 11) throw std::runtime_error("ULog invalid tagged log-string message length");
        last_timestamp_ = le(p + 3, 8);
        break;
      default:
        // ULog messages are length framed. Unknown message types can be skipped safely;
        // their full bytes still remain in the sealed raw-source chunks.
        break;
    }
  }

  void decode_point(const std::string& topic, const Format& f, const unsigned char* data,
                    size_t size, uint64_t source_offset) {
    (void)topic;
    const TelemetryBinding& binding = f.telemetry;
    if (binding.kind == TopicKind::None || binding.timestamp < 0) return;
    const Field& time = f.fields[static_cast<size_t>(binding.timestamp)];
    if (time.offset + 8 > size) return;
    const uint64_t ts = le(data + time.offset, 8);
    ImportPoint point;
    point.source_offset = source_offset;
    point.timestamp_us = ts;
    auto get = [&](int index) {
      if (index < 0) return std::numeric_limits<double>::quiet_NaN();
      return numeric_value(f.fields[static_cast<size_t>(index)], data, size);
    };
    if (binding.kind == TopicKind::GlobalPosition) {
      const double lat = get(binding.latitude), lon = get(binding.longitude), alt = get(binding.altitude);
      if (finite(lat) && lat >= -90 && lat <= 90) { point.latitude_deg = lat; point.has_latitude = true; }
      if (finite(lon) && lon >= -180 && lon <= 180) { point.longitude_deg = lon; point.has_longitude = true; }
      if (finite(alt)) { point.altitude_m = alt; point.has_altitude = true; }
      const double north = get(binding.speed_north), east = get(binding.speed_east);
      const double speed = finite(north) && finite(east) ? std::hypot(north, east) : NAN;
      if (finite(speed) && speed >= 0) { point.speed_mps = speed; point.has_speed = true; }
    } else if (binding.kind == TopicKind::GpsPosition) {
      const double lat = get(binding.latitude), lon = get(binding.longitude);
      const double alt = get(binding.altitude), speed = get(binding.speed);
      if (finite(lat) && lat >= -900000000 && lat <= 900000000) { point.latitude_deg = lat / 1.0e7; point.has_latitude = true; }
      if (finite(lon) && lon >= -1800000000 && lon <= 1800000000) { point.longitude_deg = lon / 1.0e7; point.has_longitude = true; }
      if (finite(alt)) { point.altitude_m = alt / 1000.0; point.has_altitude = true; }
      if (finite(speed) && speed >= 0) { point.speed_mps = speed; point.has_speed = true; }
    } else {
      const double battery = get(binding.battery);
      if (finite(battery) && battery >= 0) { point.battery_v = battery; point.has_battery = true; }
    }
    if (!point.has_altitude && !point.has_latitude && !point.has_longitude && !point.has_speed && !point.has_battery) return;
    ++total_points_;
    if (points_.size() < kTelemetryLimit) points_.push_back(point);
  }

  std::vector<unsigned char> buffer_;
  std::map<std::string, Format> formats_;
  std::map<uint16_t, Subscription> id_subscriptions_;
  std::vector<ImportPoint> points_;
  uint64_t base_offset_ = 0;
  uint64_t last_timestamp_ = 0;
  uint64_t message_count_ = 0;
  uint64_t total_points_ = 0;
  size_t format_fields_ = 0;
  bool header_read_ = false;
  bool first_message_ = true;
  bool data_phase_ = false;
  bool ended_ = false;
};

class Digest {
 public:
  Digest() : ctx_(EVP_MD_CTX_new()) {
    if (!ctx_ || EVP_DigestInit_ex(ctx_, EVP_sha256(), nullptr) != 1) throw CryptoError("OpenSSL SHA-256 initialization failed");
  }
  ~Digest() { EVP_MD_CTX_free(ctx_); }
  void update(const void* data, size_t size) {
    if (EVP_DigestUpdate(ctx_, data, size) != 1) throw CryptoError("OpenSSL SHA-256 update failed");
  }
  Hash finish() {
    Hash result{};
    unsigned length = 0;
    if (EVP_DigestFinal_ex(ctx_, result.data(), &length) != 1 || length != result.size())
      throw CryptoError("OpenSSL SHA-256 finalization failed");
    return result;
  }
 private:
  EVP_MD_CTX* ctx_;
};

void append_raw_record(Writer& writer, uint8_t kind, uint64_t offset,
                       const unsigned char* data, size_t size, uint64_t timestamp) {
  std::string payload("FSRAW001", 8);
  payload.push_back('\x01');
  payload.push_back(static_cast<char>(kind));
  append_le(payload, offset, 8);
  if (size) payload.append(reinterpret_cast<const char*>(data), size);
  writer.append(timestamp, payload);
}

std::string make_receipts(Writer& writer, const std::string& key_path, uint64_t& receipted) {
  writer.sync();
  const std::string line = to_line(sign_receipt(key_path, writer.count(), writer.head())) + '\n';
  receipted = writer.count();
  return line;
}
}  // namespace

ImportResult import_ulog(const std::string& source_path, const std::string& log_path,
                         const std::string& key_path, uint32_t receipt_interval) {
  if (receipt_interval == 0 || receipt_interval > 1000000)
    throw std::invalid_argument("receipt interval must be between 1 and 1,000,000 records");
  std::array<char, kInputBufferBytes> stream_buffer{};
  std::ifstream input;
  input.rdbuf()->pubsetbuf(stream_buffer.data(), static_cast<std::streamsize>(stream_buffer.size()));
  input.open(source_path, std::ios::binary);
  if (!input) throw std::runtime_error("cannot read ULog source");

  ImportResult result;
  UlogParser parser;
  Digest digest;
  std::vector<uint64_t> chunk_timestamps;
  std::array<unsigned char, static_cast<size_t>(kRawPayloadMax)> chunk{};
  while (input) {
    input.read(reinterpret_cast<char*>(chunk.data()), static_cast<std::streamsize>(chunk.size()));
    const size_t got = static_cast<size_t>(input.gcount());
    if (!got) break;
    if (result.bytes > UINT64_MAX - got) throw std::runtime_error("ULog source length overflow");
    result.bytes += got;
    if (result.bytes > kImportMaxBytes) throw std::runtime_error("ULog source exceeds the 1 GiB native import limit");
    digest.update(chunk.data(), got);
    parser.feed(chunk.data(), got);
    chunk_timestamps.push_back(parser.timestamp());
  }
  if (input.bad()) throw std::runtime_error("ULog source read failed");
  input.close();
  parser.finish();
  result.sha256 = digest.finish();
  result.telemetry_total = parser.total_points();
  result.telemetry = parser.points();
  result.telemetry_decimated = result.telemetry_total > result.telemetry.size();

  std::remove(log_path.c_str());
  std::remove(key_path.c_str());
  struct FailureCleanup {
    const std::string& log;
    const std::string& key;
    bool keep = false;
    ~FailureCleanup() { if (!keep) { std::remove(log.c_str()); std::remove(key.c_str()); } }
  } cleanup{log_path, key_path};
  result.public_key = generate_key(key_path);
  const Receipt probe = sign_receipt(key_path, 0, Hash{});
  if (!signature_ok(probe)) throw CryptoError("Ed25519 sign/verify self-test failed");
  Writer writer(log_path);
  std::string receipts;
  uint64_t receipted = 0;
  std::ifstream source;
  source.rdbuf()->pubsetbuf(stream_buffer.data(), static_cast<std::streamsize>(stream_buffer.size()));
  source.open(source_path, std::ios::binary);
  if (!source) throw std::runtime_error("cannot reopen ULog source");
  uint64_t offset = 0;
  Digest second_digest;
  size_t chunk_index = 0;
  for (;;) {
    source.read(reinterpret_cast<char*>(chunk.data()), static_cast<std::streamsize>(chunk.size()));
    const size_t got = static_cast<size_t>(source.gcount());
    if (got == 0) break;
    second_digest.update(chunk.data(), got);
    const uint64_t timestamp = chunk_index < chunk_timestamps.size() ? chunk_timestamps[chunk_index] : parser.timestamp();
    append_raw_record(writer, 0, offset, chunk.data(), got, timestamp);
    offset += got;
    ++chunk_index;
    if (writer.count() - receipted >= receipt_interval) {
      if (receipts.size() > (4u << 20) - 512) throw std::runtime_error("generated receipts exceed 4 MiB");
      receipts += make_receipts(writer, key_path, receipted);
    }
  }
  if (source.bad()) throw std::runtime_error("ULog source reread failed");
  if (offset != result.bytes || second_digest.finish() != result.sha256)
    throw std::runtime_error("ULog source changed while it was being imported");
  append_raw_record(writer, 1, result.bytes, result.sha256.data(), result.sha256.size(), parser.timestamp());
  if (writer.count() - receipted >= receipt_interval || writer.count() != receipted) {
    if (receipts.size() > (4u << 20) - 512) throw std::runtime_error("generated receipts exceed 4 MiB");
    receipts += make_receipts(writer, key_path, receipted);
  }
  result.records = writer.count();
  result.receipts = std::move(receipts);
  cleanup.keep = true;
  return result;
}

}  // namespace fseal
