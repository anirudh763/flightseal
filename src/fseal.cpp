#include "fseal.h"

#include <fcntl.h>
#include <openssl/evp.h>
#include <openssl/pem.h>
#include <sys/stat.h>
#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iterator>
#include <memory>
#include <sstream>
#include <stdexcept>

namespace fseal {

uint32_t crc32(const void* data, size_t n, uint32_t crc) {
  static const auto table = [] {
    std::array<uint32_t, 256> t{};
    for (uint32_t i = 0; i < 256; ++i) {
      uint32_t c = i;
      for (int k = 0; k < 8; ++k) c = (c & 1) ? 0xEDB88320u ^ (c >> 1) : c >> 1;
      t[i] = c;
    }
    return t;
  }();
  const auto* p = static_cast<const uint8_t*>(data);
  crc = ~crc;
  for (size_t i = 0; i < n; ++i) crc = table[(crc ^ p[i]) & 0xFF] ^ (crc >> 8);
  return ~crc;
}

namespace {
// One-shot SHA-256 over several pieces, so link() never copies the payload.
Hash sha256_parts(std::initializer_list<std::string_view> parts) {
  EVP_MD_CTX* ctx = EVP_MD_CTX_new();
  if (!ctx || EVP_DigestInit_ex(ctx, EVP_sha256(), nullptr) != 1) throw std::runtime_error("sha256 init failed");
  for (std::string_view p : parts) EVP_DigestUpdate(ctx, p.data(), p.size());
  Hash h{};
  unsigned int len = 0;
  EVP_DigestFinal_ex(ctx, h.data(), &len);
  EVP_MD_CTX_free(ctx);
  return h;
}

template <typename T>
std::string_view le_bytes(const T& v, char (&buf)[sizeof(T)]) {
  for (size_t i = 0; i < sizeof(T); ++i) buf[i] = static_cast<char>((static_cast<uint64_t>(v) >> (8 * i)) & 0xFF);
  return {buf, sizeof(T)};
}
}  // namespace

Hash sha256(std::string_view data) { return sha256_parts({data}); }

Hash link(const Hash& prev, uint64_t seq, uint64_t timestamp_us, std::string_view payload) {
  char s[8], t[8], l[4];
  return sha256_parts({{reinterpret_cast<const char*>(prev.data()), prev.size()},
                       le_bytes(seq, s),
                       le_bytes(timestamp_us, t),
                       le_bytes(static_cast<uint32_t>(payload.size()), l),
                       payload});
}

const char* describe(Status s) {
  switch (s) {
    case Status::Ok: return "intact";
    case Status::TornTail: return "torn final record (the writer stopped mid-record, e.g. a crash)";
    case Status::BadHeader: return "not a FlightSeal log (bad file header)";
    case Status::BadLength: return "impossible record length (corruption)";
    case Status::BadCrc: return "checksum mismatch (bytes were changed or damaged)";
    case Status::BadSeq: return "sequence break (a record was deleted, reordered or duplicated)";
    case Status::BadLink: return "hash-chain break (a record's contents changed after sealing)";
    case Status::IoError: return "cannot read the file";
  }
  return "unknown";
}

namespace {
uint64_t get_le(const char* p, int n) {
  uint64_t v = 0;
  for (int i = n - 1; i >= 0; --i) v = (v << 8) | static_cast<uint8_t>(p[i]);
  return v;
}
void put_le(std::string& out, uint64_t v, int n) {
  for (int i = 0; i < n; ++i) out.push_back(static_cast<char>((v >> (8 * i)) & 0xFF));
}
// shortcut: reads the whole log into memory, fine for flight logs of a few hundred MB; stream it beyond that.
bool read_all(const std::string& path, std::string* out) {
  std::ifstream in(path, std::ios::binary);
  if (!in) return false;
  try {  // libstdc++ throws from the iterator on a read error (e.g. a directory); scan() reports IoError instead
    out->assign(std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>());
  } catch (const std::exception&) {
    return false;
  }
  return !in.bad();
}
// True if a complete record with sequence number `seq` and a valid checksum starts somewhere in
// (from, from + kRecordHeader + kMaxPayload + kRecordTrailer]. Used when a record's length runs past the end of
// the file: if the next record is intact after it, the length was corrupted and this is not a crash's torn tail.
bool complete_record_follows(const std::string& s, size_t from, uint64_t seq) {
  size_t last = std::min(s.size(), from + kRecordHeader + kMaxPayload + kRecordTrailer);
  for (size_t p = from + 1; p + kRecordHeader + kRecordTrailer <= s.size() && p <= last; ++p) {
    if (get_le(s.data() + p + 4, 8) != seq) continue;  // cheap filter before the checksum
    uint64_t len = get_le(s.data() + p, 4);
    if (len > kMaxPayload || p + kRecordHeader + len + kRecordTrailer > s.size()) continue;
    size_t total = kRecordHeader + len + kRecordTrailer;
    if (crc32(s.data() + p, total - 4) == get_le(s.data() + p + total - 4, 4)) return true;
  }
  return false;
}
void write_all(int fd, const char* p, size_t n) {
  while (n > 0) {
    ssize_t w = ::write(fd, p, n);
    if (w < 0 && errno == EINTR) continue;
    if (w < 0) throw std::runtime_error(std::string("write failed: ") + std::strerror(errno));
    p += w;
    n -= static_cast<size_t>(w);
  }
}
}  // namespace

ScanResult scan(const std::string& path, std::map<uint64_t, Hash>* links_at) {
  ScanResult r;
  std::string s;
  if (!read_all(path, &s)) {
    r.status = Status::IoError;
    return r;
  }
  if (s.size() < kMagic.size()) {  // empty, or the header itself was torn
    r.status = (s.empty() || kMagic.substr(0, s.size()) == s) ? (s.empty() ? Status::Ok : Status::TornTail) : Status::BadHeader;
    return r;
  }
  if (std::string_view(s).substr(0, kMagic.size()) != kMagic) {
    r.status = Status::BadHeader;
    return r;
  }
  size_t off = kMagic.size();
  r.good_bytes = off;
  uint64_t last_ts = 0;
  while (off < s.size()) {
    size_t left = s.size() - off;
    if (left < kRecordHeader) { r.status = Status::TornTail; break; }
    const char* rec = s.data() + off;
    uint32_t len = static_cast<uint32_t>(get_le(rec, 4));
    if (len > kMaxPayload) { r.status = Status::BadLength; break; }
    size_t total = kRecordHeader + len + kRecordTrailer;
    if (left < total) {
      r.status = complete_record_follows(s, off, r.records + 1) ? Status::BadLength : Status::TornTail;
      break;
    }
    if (crc32(rec, total - 4) != get_le(rec + total - 4, 4)) { r.status = Status::BadCrc; break; }
    uint64_t seq = get_le(rec + 4, 8), ts = get_le(rec + 12, 8);
    if (seq != r.records) { r.status = Status::BadSeq; break; }
    std::string_view payload(rec + kRecordHeader, len);
    Hash h = link(r.head, seq, ts, payload);
    if (std::memcmp(h.data(), rec + kRecordHeader + len, h.size()) != 0) { r.status = Status::BadLink; break; }
    if (r.records > 0 && ts < last_ts) ++r.time_reversals;
    last_ts = ts;
    r.head = h;
    ++r.records;
    off += total;
    r.good_bytes = off;
    if (links_at) {
      auto it = links_at->find(r.records);
      if (it != links_at->end()) it->second = h;
    }
  }
  return r;
}

ScanResult recover(const std::string& path, uint64_t* trimmed_bytes) {
  *trimmed_bytes = 0;
  ScanResult r = scan(path);
  if (r.status != Status::TornTail) return r;
  struct stat st {};
  if (::stat(path.c_str(), &st) != 0 || ::truncate(path.c_str(), static_cast<off_t>(r.good_bytes)) != 0) {
    r.status = Status::IoError;
    return r;
  }
  int fd = ::open(path.c_str(), O_RDWR);
  if (fd >= 0) {
    ::fsync(fd);
    ::close(fd);
  }
  *trimmed_bytes = static_cast<uint64_t>(st.st_size) - r.good_bytes;
  return scan(path);
}

Writer::Writer(const std::string& path) {
  ScanResult r = recover(path, &trimmed_);
  if (r.status == Status::IoError && ::access(path.c_str(), F_OK) != 0) r = ScanResult{};  // new log
  if (r.status != Status::Ok)
    throw std::runtime_error(path + ": " + describe(r.status) + " after record " + std::to_string(r.records) +
                             "; refusing to append to a damaged log");
  fd_ = ::open(path.c_str(), O_WRONLY | O_CREAT | O_APPEND, 0644);
  if (fd_ < 0) throw std::runtime_error(path + ": " + std::strerror(errno));
  if (r.good_bytes == 0) {
    write_all(fd_, kMagic.data(), kMagic.size());
    ::fsync(fd_);
  }
  count_ = r.records;
  head_ = r.head;
}

Writer::~Writer() {
  try {
    sync();
  } catch (...) {
  }
  ::close(fd_);
}

void Writer::append(uint64_t timestamp_us, std::string_view payload) {
  if (payload.size() > kMaxPayload) throw std::invalid_argument("payload larger than kMaxPayload");
  head_ = link(head_, count_, timestamp_us, payload);
  size_t start = buf_.size();
  put_le(buf_, payload.size(), 4);
  put_le(buf_, count_, 8);
  put_le(buf_, timestamp_us, 8);
  buf_.append(payload);
  buf_.append(reinterpret_cast<const char*>(head_.data()), head_.size());
  put_le(buf_, crc32(buf_.data() + start, buf_.size() - start), 4);
  ++count_;
  if (buf_.size() >= (64u << 10)) {  // hand full 64 KiB batches to the OS; durability still needs sync()
    write_all(fd_, buf_.data(), buf_.size());
    buf_.clear();
  }
}

void Writer::sync() {
  write_all(fd_, buf_.data(), buf_.size());
  buf_.clear();
  if (::fsync(fd_) != 0) throw std::runtime_error(std::string("fsync failed: ") + std::strerror(errno));
}

// ---- receipts ----------------------------------------------------------------------------

namespace {
struct PkeyDeleter { void operator()(EVP_PKEY* k) const { EVP_PKEY_free(k); } };
struct MdCtxDeleter { void operator()(EVP_MD_CTX* c) const { EVP_MD_CTX_free(c); } };
using Pkey = std::unique_ptr<EVP_PKEY, PkeyDeleter>;
using MdCtx = std::unique_ptr<EVP_MD_CTX, MdCtxDeleter>;

Pkey load_private_key(const std::string& pem_path) {
  FILE* f = std::fopen(pem_path.c_str(), "r");
  if (!f) throw std::runtime_error(pem_path + ": " + std::strerror(errno));
  Pkey k(PEM_read_PrivateKey(f, nullptr, nullptr, nullptr));
  std::fclose(f);
  if (!k || EVP_PKEY_id(k.get()) != EVP_PKEY_ED25519) throw std::runtime_error(pem_path + ": not an Ed25519 private key");
  return k;
}

// The signed bytes: a fixed label, then count and head, so a signature can't be reused elsewhere.
std::string signed_message(uint64_t count, const Hash& head) {
  std::string m = "fseal-receipt v1";
  put_le(m, count, 8);
  m.append(reinterpret_cast<const char*>(head.data()), head.size());
  return m;
}
}  // namespace

void generate_key(const std::string& pem_path) {
  EVP_PKEY_CTX* ctx = EVP_PKEY_CTX_new_id(EVP_PKEY_ED25519, nullptr);
  EVP_PKEY* raw = nullptr;
  bool ok = ctx && EVP_PKEY_keygen_init(ctx) == 1 && EVP_PKEY_keygen(ctx, &raw) == 1;
  EVP_PKEY_CTX_free(ctx);
  Pkey k(raw);
  if (!ok) throw std::runtime_error("Ed25519 key generation failed");
  int fd = ::open(pem_path.c_str(), O_WRONLY | O_CREAT | O_EXCL, 0600);  // never overwrite a key
  if (fd < 0) throw std::runtime_error(pem_path + ": " + std::strerror(errno));
  FILE* f = ::fdopen(fd, "w");
  ok = f && PEM_write_PrivateKey(f, k.get(), nullptr, nullptr, 0, nullptr, nullptr) == 1;
  if (f) std::fclose(f); else ::close(fd);
  if (!ok) throw std::runtime_error(pem_path + ": could not write key");
}

PublicKey public_key(const std::string& pem_path) {
  Pkey k = load_private_key(pem_path);
  PublicKey pub{};
  size_t len = pub.size();
  EVP_PKEY_get_raw_public_key(k.get(), pub.data(), &len);
  return pub;
}

Receipt sign_receipt(const std::string& pem_path, uint64_t count, const Hash& head) {
  Pkey k = load_private_key(pem_path);
  Receipt r;
  r.count = count;
  r.head = head;
  size_t len = r.key.size();
  EVP_PKEY_get_raw_public_key(k.get(), r.key.data(), &len);
  std::string m = signed_message(count, head);
  MdCtx ctx(EVP_MD_CTX_new());
  size_t sig_len = r.sig.size();
  if (!ctx || EVP_DigestSignInit(ctx.get(), nullptr, nullptr, nullptr, k.get()) != 1 ||
      EVP_DigestSign(ctx.get(), r.sig.data(), &sig_len, reinterpret_cast<const uint8_t*>(m.data()), m.size()) != 1)
    throw std::runtime_error("signing failed");
  return r;
}

bool signature_ok(const Receipt& r) {
  Pkey k(EVP_PKEY_new_raw_public_key(EVP_PKEY_ED25519, nullptr, r.key.data(), r.key.size()));
  MdCtx ctx(EVP_MD_CTX_new());
  std::string m = signed_message(r.count, r.head);
  return k && ctx && EVP_DigestVerifyInit(ctx.get(), nullptr, nullptr, nullptr, k.get()) == 1 &&
         EVP_DigestVerify(ctx.get(), r.sig.data(), r.sig.size(), reinterpret_cast<const uint8_t*>(m.data()), m.size()) == 1;
}

std::string to_line(const Receipt& r) {
  return "fseal-receipt v1 count=" + std::to_string(r.count) + " head=" + hex(r.head.data(), r.head.size()) +
         " key=" + hex(r.key.data(), r.key.size()) + " sig=" + hex(r.sig.data(), r.sig.size());
}

bool parse_hex(std::string_view text, uint8_t* out, size_t n) {
  if (text.size() != 2 * n) return false;
  auto nibble = [](char c) { return c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : -1; };
  for (size_t i = 0; i < n; ++i) {
    int hi = nibble(text[2 * i]), lo = nibble(text[2 * i + 1]);
    if (hi < 0 || lo < 0) return false;
    out[i] = static_cast<uint8_t>(hi << 4 | lo);
  }
  return true;
}

bool parse_line(const std::string& line, Receipt* out) {
  std::istringstream in(line);
  std::string tag, version, count, head, key, sig;
  if (!(in >> tag >> version >> count >> head >> key >> sig) || tag != "fseal-receipt" || version != "v1") return false;
  auto value = [](const std::string& field, const char* name) -> std::string_view {
    std::string_view f(field), n(name);
    return f.substr(0, n.size()) == n ? f.substr(n.size()) : std::string_view();
  };
  std::string_view c = value(count, "count=");
  if (c.empty() || c.find_first_not_of("0123456789") != std::string_view::npos) return false;
  uint64_t n = 0;  // not std::stoull: it throws on a count above 2^64-1, and this returns false on bad input
  for (char d : c) {
    if (n > (UINT64_MAX - static_cast<uint64_t>(d - '0')) / 10) return false;
    n = n * 10 + static_cast<uint64_t>(d - '0');
  }
  out->count = n;
  return parse_hex(value(head, "head="), out->head.data(), out->head.size()) &&
         parse_hex(value(key, "key="), out->key.data(), out->key.size()) &&
         parse_hex(value(sig, "sig="), out->sig.data(), out->sig.size());
}

const char* describe(ReceiptCheck c) {
  switch (c) {
    case ReceiptCheck::Ok: return "matches the log";
    case ReceiptCheck::WrongKey: return "signed by a different key than the one you trust";
    case ReceiptCheck::BadSignature: return "signature invalid (the receipt itself was altered)";
    case ReceiptCheck::LogShorter: return "log is shorter than the receipt (records were removed from the end)";
    case ReceiptCheck::HeadMismatch:
      return "log does not match this receipt: it was rewritten after the receipt was issued, or these receipts belong to "
             "another log sealed with the same key";
  }
  return "unknown";
}

ReceiptCheck check_receipt(const Receipt& r, const PublicKey& trusted, const ScanResult& log,
                           const std::map<uint64_t, Hash>& links) {
  if (r.key != trusted) return ReceiptCheck::WrongKey;
  if (!signature_ok(r)) return ReceiptCheck::BadSignature;
  if (r.count > log.records) return ReceiptCheck::LogShorter;
  auto it = links.find(r.count);
  Hash at = r.count == 0 ? Hash{} : (it == links.end() ? Hash{} : it->second);
  return at == r.head ? ReceiptCheck::Ok : ReceiptCheck::HeadMismatch;
}

std::string hex(const uint8_t* p, size_t n) {
  static const char* digits = "0123456789abcdef";
  std::string out(2 * n, '0');
  for (size_t i = 0; i < n; ++i) {
    out[2 * i] = digits[p[i] >> 4];
    out[2 * i + 1] = digits[p[i] & 0xF];
  }
  return out;
}

}  // namespace fseal
