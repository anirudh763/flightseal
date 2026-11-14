#include "fseal.h"
#include <emscripten/emscripten.h>
#include <emscripten/heap.h>
#include <algorithm>
#include <cstdio>
#include <fstream>
#include <limits>
#include <sstream>
#include <vector>

namespace {
std::string response;
std::string json_quote(std::string_view value) {
  std::string out = "\"";
  for (unsigned char c : value) {
    if (c == '"' || c == '\\') { out += '\\'; out += static_cast<char>(c); }
    else if (c < 32) { char escaped[7]; std::snprintf(escaped, sizeof(escaped), "\\u%04x", c); out += escaped; }
    else out += static_cast<char>(c);
  }
  return out + '"';
}
const char* fail(const std::exception& e) { response = "{\"error\":" + json_quote(e.what()) + "}"; return response.c_str(); }
const char* token(fseal::Status status) {
  switch (status) {
    case fseal::Status::Ok: return "intact";
    case fseal::Status::TornTail: return "torn-tail";
    case fseal::Status::BadHeader: return "bad-header";
    case fseal::Status::BadLength: return "bad-length";
    case fseal::Status::BadCrc: return "bad-crc";
    case fseal::Status::BadSeq: return "bad-seq";
    case fseal::Status::BadLink: return "bad-link";
    case fseal::Status::IoError: return "io-error";
  }
  return "error";
}
const char* check_token(fseal::ReceiptCheck check) {
  switch (check) {
    case fseal::ReceiptCheck::Ok: return "ok";
    case fseal::ReceiptCheck::WrongKey: return "wrong-key";
    case fseal::ReceiptCheck::BadSignature: return "bad-signature";
    case fseal::ReceiptCheck::LogShorter: return "log-shorter";
    case fseal::ReceiptCheck::HeadMismatch: return "head-mismatch";
  }
  return "error";
}
}

extern "C" {
EMSCRIPTEN_KEEPALIVE size_t fseal_heap_bytes() { return emscripten_get_heap_size(); }
EMSCRIPTEN_KEEPALIVE const char* fseal_verify(const char* path, const char* receipt_text, const char* public_hex) {
  try {
    std::string receipts_text(receipt_text), key(public_hex);
    if (receipts_text.size() > (4u << 20)) throw std::invalid_argument("receipts exceed the 4 MiB browser limit");
    if (receipts_text.empty() != key.empty()) throw std::invalid_argument("receipts and independently trusted public key must be supplied together");
    fseal::PublicKey trusted{};
    if (!key.empty() && !fseal::parse_hex(key, trusted.data(), trusted.size())) throw std::invalid_argument("trusted key must contain 64 lowercase hexadecimal digits");
    std::vector<fseal::Receipt> receipts;
    std::map<uint64_t, fseal::Hash> links;
    std::istringstream lines(receipts_text);
    std::string line;
    while (std::getline(lines, line)) {
      if (!line.empty() && line.back() == '\r') line.pop_back();
      fseal::Receipt receipt;
      if (!fseal::parse_line(line, &receipt)) throw std::invalid_argument("invalid receipt at line " + std::to_string(receipts.size() + 1));
      if (receipts.size() >= 10000) throw std::invalid_argument("receipts exceed the 10,000 receipt browser limit");
      receipts.push_back(receipt);
      links.emplace(receipt.count, fseal::Hash{});
    }
    if (!key.empty() && receipts.empty()) throw std::invalid_argument("receipt file contains no receipts");
    const fseal::ScanResult scan = fseal::scan(path, &links);
    if (scan.status == fseal::Status::IoError) throw std::runtime_error("cannot read the log");
    uint64_t covered = 0, untrusted = 0, failed = 0;
    bool authenticated = false;
    std::ostringstream checks;
    for (size_t i = 0; i < receipts.size(); ++i) {
      const auto& receipt = receipts[i];
      const auto check = fseal::check_receipt(receipt, trusted, scan, links);
      const bool trusted_receipt = check != fseal::ReceiptCheck::WrongKey && check != fseal::ReceiptCheck::BadSignature;
      authenticated = authenticated || trusted_receipt;
      if (!trusted_receipt) ++untrusted;
      else if (check == fseal::ReceiptCheck::Ok) covered = std::max(covered, receipt.count);
      else if (scan.status == fseal::Status::Ok || receipt.count <= scan.records) ++failed;
      if (i) checks << ',';
      checks << "{\"count\":" << json_quote(std::to_string(receipt.count)) << ",\"head\":" << json_quote(fseal::hex(receipt.head.data(), receipt.head.size()))
             << ",\"key\":" << json_quote(fseal::hex(receipt.key.data(), receipt.key.size()))
             << ",\"check\":" << json_quote(check_token(check)) << ",\"description\":" << json_quote(fseal::describe(check)) << '}';
    }
    const bool bad = scan.status != fseal::Status::Ok || failed != 0;
    const char* verdict = bad ? (scan.status == fseal::Status::TornTail && !authenticated ? "incomplete" : "tampered") : untrusted ? "unverified" : "intact";
    std::ostringstream out;
    out << "{\"engine\":\"C++ / OpenSSL / WebAssembly\",\"verdict\":" << json_quote(verdict)
        << ",\"status\":" << json_quote(token(scan.status)) << ",\"description\":" << json_quote(fseal::describe(scan.status))
        << ",\"records\":" << scan.records << ",\"goodBytes\":" << scan.good_bytes
        << ",\"head\":" << json_quote(fseal::hex(scan.head.data(), scan.head.size()))
        << ",\"timeReversals\":" << scan.time_reversals << ",\"covered\":" << covered
        << ",\"uncovered\":" << scan.records - covered << ",\"receipts\":[" << checks.str() << "]}";
    response = out.str();
    return response.c_str();
  } catch (const std::exception& e) { return fail(e); }
}

EMSCRIPTEN_KEEPALIVE const char* fseal_seal(const char* path, unsigned int every) {
  struct RemoveKey { ~RemoveKey() { std::remove("/ephemeral.pem"); } } remove_key;
  try {
    if (every == 0 || every > 1000000) throw std::invalid_argument("receipt interval must be between 1 and 1,000,000 records");
    std::ifstream input(path, std::ios::binary);
    if (!input) throw std::runtime_error("cannot read source records");
    std::remove("/sealed.fseal");
    std::remove("/ephemeral.pem");
    const auto key = fseal::generate_key("/ephemeral.pem");
    const auto probe = fseal::sign_receipt("/ephemeral.pem", 0, fseal::Hash{});
    if (!fseal::signature_ok(probe)) throw fseal::CryptoError("Ed25519 sign/verify self-test failed");
    fseal::Writer writer("/sealed.fseal");
    std::string receipts, line;
    uint64_t output_bytes = fseal::kMagic.size();
    uint64_t receipted = 0;
    size_t issued = 0;
    auto issue = [&] {
      if (++issued > 10000) throw std::invalid_argument("generated receipts exceed 10,000; use a larger receipt interval");
      writer.sync();
      receipts += fseal::to_line(fseal::sign_receipt("/ephemeral.pem", writer.count(), writer.head())) + '\n';
      if (receipts.size() > (4u << 20)) throw std::invalid_argument("generated receipts exceed the 4 MiB browser limit; use a larger receipt interval");
      receipted = writer.count();
    };
    size_t line_number = 0;
    while (std::getline(input, line)) {
      ++line_number;
      if (!line.empty() && line.back() == '\r') line.pop_back();
      const auto tab = line.find('\t');
      uint64_t timestamp = 0;
      if (tab == std::string::npos || tab == 0) throw std::invalid_argument("line " + std::to_string(line_number) + ": expected timestamp_us<TAB>payload");
      for (size_t i = 0; i < tab; ++i) {
        if (line[i] < '0' || line[i] > '9' || timestamp > (UINT64_MAX - static_cast<unsigned>(line[i] - '0')) / 10)
          throw std::invalid_argument("line " + std::to_string(line_number) + ": invalid unsigned timestamp");
        timestamp = timestamp * 10 + static_cast<unsigned>(line[i] - '0');
      }
      const size_t payload_bytes = line.size() - tab - 1;
      if (output_bytes + fseal::kRecordHeader + payload_bytes + fseal::kRecordTrailer > (64u << 20))
        throw std::invalid_argument("sealed output exceeds the 64 MiB sandbox limit");
      writer.append(timestamp, std::string_view(line).substr(tab + 1));
      output_bytes += fseal::kRecordHeader + payload_bytes + fseal::kRecordTrailer;
      if (writer.count() - receipted >= every) issue();
    }
    if (input.bad()) throw std::runtime_error("source read failed");
    if (writer.count() == 0) throw std::invalid_argument("source contains no records");
    if (writer.count() != receipted) issue();
    response = "{\"records\":" + std::to_string(writer.count()) + ",\"publicKey\":" + json_quote(fseal::hex(key.data(), key.size())) + ",\"receipts\":" + json_quote(receipts) + "}";
    return response.c_str();
  } catch (const std::exception& e) { std::remove("/sealed.fseal"); return fail(e); }
}
}
