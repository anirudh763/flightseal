// FlightSeal: an evidence seal for drone flight logs.
// Append-only records, each with a CRC-32 (catches accidental damage) and a SHA-256 link
// to the previous record (catches deliberate edits). Signed receipts (see below) catch a
// holder who rewrites the whole file.
#pragma once

// Release version; CMakeLists.txt project(VERSION) and the top CHANGELOG.md entry must match (tests/test_release.py).
#define FSEAL_VERSION "0.1.0"

#include <array>
#include <cstddef>
#include <cstdint>
#include <map>
#include <stdexcept>
#include <string>
#include <string_view>

namespace fseal {

using Hash = std::array<uint8_t, 32>;

// Thrown when an OpenSSL call fails. Nothing is hashed, signed or verified on such a failure, so a caller
// must stop and report an error (the CLI exits 2), never a result.
struct CryptoError : std::runtime_error {
  using std::runtime_error::runtime_error;
};

uint32_t crc32(const void* data, size_t n, uint32_t crc = 0);  // IEEE 802.3, same as zlib
Hash sha256(std::string_view data);
// link(i) = SHA-256(link(i-1) || seq || timestamp || length || payload), integers little-endian.
Hash link(const Hash& prev, uint64_t seq, uint64_t timestamp_us, std::string_view payload);
std::string hex(const uint8_t* p, size_t n);

// File layout: "FLTSEAL1", then records. Each record (integers little-endian):
//   u32 length | u64 seq | u64 timestamp_us | payload | link (32 bytes) | u32 crc32 of everything before it
constexpr std::string_view kMagic = "FLTSEAL1";
constexpr size_t kRecordHeader = 4 + 8 + 8;
constexpr size_t kRecordTrailer = 32 + 4;
constexpr uint32_t kMaxPayload = 1u << 20;

enum class Status { Ok, TornTail, BadHeader, BadLength, BadCrc, BadSeq, BadLink, IoError };
const char* describe(Status s);

struct ScanResult {
  Status status = Status::Ok;
  uint64_t records = 0;         // records that passed every check, counted from the start
  uint64_t good_bytes = 0;      // file offset just past the last good record
  Hash head{};                  // link of the last good record (all zero for an empty log)
  uint64_t time_reversals = 0;  // timestamps lower than the previous one: reported, never trusted
};

// Reads the log from the start and stops at the first problem. If `links_at` is given, each key
// is a record count and gets the link of the record that brings the log to that count.
ScanResult scan(const std::string& path, std::map<uint64_t, Hash>* links_at = nullptr);

// Trims a torn final record left by a crash. Anything else (a bad record in the middle, a
// complete final record with a bad checksum) is evidence: it is reported and never truncated.
ScanResult recover(const std::string& path, uint64_t* trimmed_bytes);

class Writer {
 public:
  // Creates the log, or opens it after recover(); throws if the log has any other problem.
  explicit Writer(const std::string& path);
  ~Writer();
  Writer(const Writer&) = delete;
  Writer& operator=(const Writer&) = delete;

  void append(uint64_t timestamp_us, std::string_view payload);
  void sync();  // writes buffered records, then fsync: records appended before sync() survive a crash
  uint64_t count() const { return count_; }
  const Hash& head() const { return head_; }
  uint64_t trimmed_bytes() const { return trimmed_; }

 private:
  int fd_ = -1;
  std::string buf_;
  uint64_t count_ = 0;
  Hash head_{};
  uint64_t trimmed_ = 0;
};

// ---- Receipts ------------------------------------------------------------------------------
// The holder of a log can rewrite it and recompute every link, so the chain alone proves little.
// A receipt is a signed statement "after N records the head link was H". It is handed to someone
// else (an investigator, the operator's company, a regulator) when it is made; their copy is what
// a later rewrite cannot match.
using PublicKey = std::array<uint8_t, 32>;  // Ed25519
using Signature = std::array<uint8_t, 64>;

struct Receipt {
  uint64_t count = 0;
  Hash head{};
  PublicKey key{};
  Signature sig{};
};

PublicKey generate_key(const std::string& pem_path);  // Ed25519 private key, PEM, file mode 0600; returns its public key
PublicKey public_key(const std::string& pem_path);
Receipt sign_receipt(const std::string& pem_path, uint64_t count, const Hash& head);
// Checks the signature against the key inside the receipt; throws CryptoError if OpenSSL fails (not a verdict).
bool signature_ok(const Receipt& r);
std::string to_line(const Receipt& r);
bool parse_line(const std::string& line, Receipt* out);
bool parse_hex(std::string_view text, uint8_t* out, size_t n);

enum class ReceiptCheck { Ok, WrongKey, BadSignature, LogShorter, HeadMismatch };
const char* describe(ReceiptCheck c);
// `links` comes from scan(path, &links) with the receipt's count as a key.
ReceiptCheck check_receipt(const Receipt& r, const PublicKey& trusted, const ScanResult& log,
                           const std::map<uint64_t, Hash>& links);

}  // namespace fseal
