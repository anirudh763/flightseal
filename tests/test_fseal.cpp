// Minimal test runner: no framework needed for a few dozen checks.
#include "fseal.h"

#include <cstdio>
#include <string>
#include <vector>

static int failures = 0;
#define CHECK(c)                                                                    \
  do {                                                                              \
    if (!(c)) {                                                                     \
      std::fprintf(stderr, "%s:%d: CHECK failed: %s\n", __FILE__, __LINE__, #c);   \
      ++failures;                                                                   \
    }                                                                               \
  } while (0)
struct Test { const char* name; void (*fn)(); };
static std::vector<Test>& registry() { static std::vector<Test> t; return t; }
#define TEST(name)                                                       \
  static void name();                                                    \
  static const int reg_##name = (registry().push_back({#name, name}), 0); \
  static void name()

using namespace fseal;

TEST(crc32_matches_standard_check_value) {
  CHECK(crc32("123456789", 9) == 0xCBF43926u);  // the published CRC-32 check value
  CHECK(crc32("", 0) == 0u);
}

TEST(sha256_matches_fips_vector) {
  Hash h = sha256("abc");
  CHECK(hex(h.data(), h.size()) == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
}

TEST(link_depends_on_every_field) {
  Hash zero{};
  Hash a = link(zero, 0, 100, "alt=12.5");
  CHECK(a == link(zero, 0, 100, "alt=12.5"));
  CHECK(a != link(zero, 1, 100, "alt=12.5"));
  CHECK(a != link(zero, 0, 101, "alt=12.5"));
  CHECK(a != link(zero, 0, 100, "alt=12.6"));
  Hash other = zero;
  other[0] = 1;
  CHECK(a != link(other, 0, 100, "alt=12.5"));
}

// ---- helpers -------------------------------------------------------------------------------
#include <unistd.h>

#include <cstdlib>
#include <fstream>
#include <sstream>

static std::string temp_path(const char* tag) {
  static int n = 0;
  const char* dir = std::getenv("TMPDIR");
  return std::string(dir ? dir : "/tmp") + "/fseal-test-" + std::to_string(getpid()) + "-" + tag + "-" +
         std::to_string(n++) + ".fseal";
}
static std::string read_file(const std::string& p) {
  std::ifstream in(p, std::ios::binary);
  std::ostringstream s;
  s << in.rdbuf();
  return s.str();
}
static void write_file(const std::string& p, const std::string& data) {
  std::ofstream(p, std::ios::binary | std::ios::trunc) << data;
}
static uint32_t get_u32(const std::string& s, size_t off) {
  uint32_t v = 0;
  for (int i = 3; i >= 0; --i) v = (v << 8) | static_cast<uint8_t>(s[off + i]);
  return v;
}
static void put_u32(std::string& s, size_t off, uint32_t v) {
  for (int i = 0; i < 4; ++i) s[off + i] = static_cast<char>((v >> (8 * i)) & 0xFF);
}
// Byte offsets of each record, found by walking the length fields.
static std::vector<size_t> record_offsets(const std::string& s) {
  std::vector<size_t> offs;
  for (size_t off = kMagic.size(); off + kRecordHeader <= s.size();) {
    offs.push_back(off);
    off += kRecordHeader + get_u32(s, off) + kRecordTrailer;
  }
  return offs;
}
static std::string make_log(const char* tag, int n) {
  std::string p = temp_path(tag);
  Writer w(p);
  for (int i = 0; i < n; ++i) w.append(1000u * (i + 1), "{\"t\":\"vehicle_local_position\",\"z\":-" + std::to_string(10 + i) + ".5}");
  return p;
}
static std::string slice(const std::string& s, size_t from, size_t to) { return s.substr(from, to - from); }

// ---- log format ----------------------------------------------------------------------------

TEST(empty_log_scans_clean) {
  std::string p = temp_path("empty");
  { Writer w(p); }
  ScanResult r = scan(p);
  CHECK(r.status == Status::Ok);
  CHECK(r.records == 0);
  CHECK(r.good_bytes == kMagic.size());
  CHECK(r.head == Hash{});
}

TEST(records_scan_clean_and_head_is_the_chain) {
  std::string p = temp_path("chain");
  {
    Writer w(p);
    w.append(10, "a");
    w.append(20, "bb");
    w.append(30, "ccc");
  }
  ScanResult r = scan(p);
  CHECK(r.status == Status::Ok);
  CHECK(r.records == 3);
  CHECK(r.head == link(link(link(Hash{}, 0, 10, "a"), 1, 20, "bb"), 2, 30, "ccc"));
  CHECK(r.good_bytes == read_file(p).size());
}

TEST(reopening_continues_sequence_and_chain) {
  std::string p = temp_path("reopen");
  { Writer w(p); w.append(10, "a"); w.append(20, "bb"); }
  { Writer w(p); CHECK(w.count() == 2); w.append(30, "ccc"); }
  ScanResult r = scan(p);
  CHECK(r.status == Status::Ok);
  CHECK(r.records == 3);
  CHECK(r.head == link(link(link(Hash{}, 0, 10, "a"), 1, 20, "bb"), 2, 30, "ccc"));
}

TEST(links_at_reports_the_link_after_each_requested_count) {
  std::string p = temp_path("links");
  { Writer w(p); w.append(10, "a"); w.append(20, "bb"); w.append(30, "ccc"); }
  std::map<uint64_t, Hash> want{{1, {}}, {3, {}}};
  scan(p, &want);
  CHECK(want[1] == link(Hash{}, 0, 10, "a"));
  CHECK(want[3] == scan(p).head);
}

TEST(flipped_bit_is_a_checksum_error_at_that_record) {
  std::string p = make_log("flip", 5);
  std::string s = read_file(p);
  auto offs = record_offsets(s);
  s[offs[2] + kRecordHeader + 3] ^= 0x01;  // one bit inside record 2's payload
  write_file(p, s);
  ScanResult r = scan(p);
  CHECK(r.status == Status::BadCrc);
  CHECK(r.records == 2);
}

TEST(edit_with_recomputed_checksum_is_a_link_error) {
  std::string p = make_log("edit", 5);
  std::string s = read_file(p);
  auto offs = record_offsets(s);
  size_t start = offs[2], len = get_u32(s, start);
  s[start + kRecordHeader + len - 3] = '9';  // change one digit of the altitude
  size_t crc_at = start + kRecordHeader + len + 32;
  put_u32(s, crc_at, crc32(s.data() + start, crc_at - start));  // attacker fixes the checksum
  write_file(p, s);
  ScanResult r = scan(p);
  CHECK(r.status == Status::BadLink);
  CHECK(r.records == 2);
}

TEST(deleted_record_is_a_sequence_error) {
  std::string p = make_log("delete", 5);
  std::string s = read_file(p);
  auto offs = record_offsets(s);
  write_file(p, s.substr(0, offs[2]) + s.substr(offs[3]));
  ScanResult r = scan(p);
  CHECK(r.status == Status::BadSeq);
  CHECK(r.records == 2);
}

TEST(swapped_records_are_a_sequence_error) {
  std::string p = make_log("swap", 5);
  std::string s = read_file(p);
  auto offs = record_offsets(s);
  write_file(p, s.substr(0, offs[1]) + slice(s, offs[2], offs[3]) + slice(s, offs[1], offs[2]) + s.substr(offs[3]));
  ScanResult r = scan(p);
  CHECK(r.status == Status::BadSeq);
  CHECK(r.records == 1);
}

TEST(duplicated_record_is_a_sequence_error) {
  std::string p = make_log("dup", 5);
  std::string s = read_file(p);
  auto offs = record_offsets(s);
  write_file(p, s.substr(0, offs[3]) + slice(s, offs[2], offs[3]) + s.substr(offs[3]));
  ScanResult r = scan(p);
  CHECK(r.status == Status::BadSeq);
  CHECK(r.records == 3);
}

TEST(torn_final_record_is_trimmed_at_every_cut_point) {
  std::string p = make_log("torn", 4);
  std::string full = read_file(p);
  size_t last = record_offsets(full).back();
  for (size_t cut = last + 1; cut < full.size(); ++cut) {
    write_file(p, full.substr(0, cut));
    ScanResult r = scan(p);
    CHECK(r.status == Status::TornTail);
    CHECK(r.records == 3);
    uint64_t trimmed = 0;
    CHECK(recover(p, &trimmed).status == Status::Ok);
    CHECK(trimmed == cut - last);
    ScanResult after = scan(p);
    CHECK(after.status == Status::Ok && after.records == 3 && after.good_bytes == last);
  }
}

TEST(corruption_in_the_middle_is_reported_never_trimmed) {
  std::string p = make_log("mid", 5);
  std::string s = read_file(p);
  s[record_offsets(s)[1] + kRecordHeader] ^= 0x40;
  write_file(p, s);
  uint64_t trimmed = 0;
  CHECK(recover(p, &trimmed).status == Status::BadCrc);
  CHECK(trimmed == 0);
  CHECK(read_file(p) == s);
  bool threw = false;
  try { Writer w(p); } catch (const std::exception&) { threw = true; }
  CHECK(threw);
  CHECK(read_file(p) == s);
}

TEST(complete_final_record_with_bad_checksum_is_not_trimmed) {
  std::string p = make_log("lastcrc", 3);
  std::string s = read_file(p);
  s[s.size() - 1] ^= 0x01;  // last byte of the final record's checksum
  write_file(p, s);
  uint64_t trimmed = 0;
  CHECK(recover(p, &trimmed).status == Status::BadCrc);
  CHECK(read_file(p) == s);
}

TEST(wrong_magic_is_a_header_error) {
  std::string p = temp_path("magic");
  write_file(p, "NOTSEAL!");
  CHECK(scan(p).status == Status::BadHeader);
}

TEST(impossible_length_is_corruption_not_a_torn_tail) {
  std::string p = make_log("len", 2);
  std::string s = read_file(p);
  put_u32(s, record_offsets(s)[1], kMaxPayload + 1);
  write_file(p, s);
  ScanResult r = scan(p);
  CHECK(r.status == Status::BadLength);
  CHECK(r.records == 1);
}

TEST(timestamps_going_backwards_are_counted_not_rejected) {
  std::string p = temp_path("time");
  { Writer w(p); w.append(10, "a"); w.append(5, "b"); w.append(20, "c"); }
  ScanResult r = scan(p);
  CHECK(r.status == Status::Ok);
  CHECK(r.time_reversals == 1);
}

int main(int argc, char** argv) {
  for (const Test& t : registry()) {
    if (argc > 1 && std::string(argv[1]) != t.name) continue;
    int before = failures;
    t.fn();
    std::printf("%s %s\n", failures == before ? "ok  " : "FAIL", t.name);
  }
  std::printf("%d check(s) failed\n", failures);
  return failures ? 1 : 0;
}
