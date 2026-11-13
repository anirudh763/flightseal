// fseal: command-line front end for FlightSeal.
#include "fseal.h"

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

using namespace fseal;

namespace {

const char* kUsage =
    "usage:\n"
    "  fseal keygen KEYFILE\n"
    "      create an Ed25519 signing key and print its public key\n"
    "  fseal append LOG [--key KEYFILE --receipts FILE [--every N]] [--sync every|batch]\n"
    "      seal records read from stdin, one per line: timestamp_us<TAB>payload\n"
    "  fseal verify LOG [--receipts FILE --pubkey HEX]\n"
    "      check every record, and every receipt against the key you trust\n"
    "      exit status: 0 intact, 1 tampered or incomplete, 2 usage or read error,\n"
    "      3 unverified (receipts not validly signed by the key you trust)\n"
    "  fseal recover LOG\n"
    "      trim a torn final record left by a crash (and nothing else)\n";

int usage() {
  std::fputs(kUsage, stderr);
  return 2;
}

// Options after the positional arguments: --name value pairs.
bool parse_options(int argc, char** argv, int first, std::vector<std::pair<std::string, std::string>>* out) {
  for (int i = first; i < argc; i += 2) {
    if (std::strncmp(argv[i], "--", 2) != 0 || i + 1 >= argc) return false;
    out->emplace_back(argv[i] + 2, argv[i + 1]);
  }
  return true;
}
std::string option(const std::vector<std::pair<std::string, std::string>>& opts, const std::string& name) {
  for (const auto& [k, v] : opts)
    if (k == name) return v;
  return "";
}

const char* token(Status s) {
  switch (s) {
    case Status::TornTail: return "torn-tail";
    case Status::BadHeader: return "bad-header";
    case Status::BadLength: return "bad-length";
    case Status::BadCrc: return "bad-crc";
    case Status::BadSeq: return "bad-seq";
    case Status::BadLink: return "bad-link";
    default: return "error";
  }
}

int keygen(const std::string& path) {
  generate_key(path);
  PublicKey pub = public_key(path);
  std::cout << hex(pub.data(), pub.size()) << "\n";
  return 0;
}

int append(const std::string& log, const std::vector<std::pair<std::string, std::string>>& opts) {
  std::string key = option(opts, "key"), receipts = option(opts, "receipts"), mode = option(opts, "sync");
  if (key.empty() != receipts.empty() || (mode != "" && mode != "every" && mode != "batch")) return usage();
  uint64_t every = option(opts, "every").empty() ? 1000 : std::strtoull(option(opts, "every").c_str(), nullptr, 10);
  if (every == 0) return usage();

  // Open the receipts file before touching the log: sealing without anywhere to put receipts would leave
  // records that no witness ever covered.
  std::ofstream out;
  if (!receipts.empty()) {
    out.open(receipts, std::ios::app);
    if (!out) throw std::runtime_error("cannot write receipts to " + receipts);
  }
  Writer w(log);
  if (w.trimmed_bytes() > 0)
    std::cerr << "recovered: trimmed " << w.trimmed_bytes() << " bytes of a torn final record\n";
  uint64_t start = w.count(), receipted = w.count(), issued = 0;
  // A receipt is issued only after the records it covers are on disk, and counted only once it was written.
  auto issue = [&] {
    w.sync();
    out << to_line(sign_receipt(key, w.count(), w.head())) << "\n" << std::flush;
    if (!out) throw std::runtime_error("cannot write receipts to " + receipts + " (receipt for " + std::to_string(w.count()) +
                                       " records not saved)");
    receipted = w.count();
    ++issued;
  };

  std::string line;
  for (uint64_t n = 1; std::getline(std::cin, line); ++n) {
    size_t tab = line.find('\t');
    char* end = nullptr;
    uint64_t ts = std::strtoull(line.c_str(), &end, 10);
    if (tab == std::string::npos || end != line.c_str() + tab || tab == 0) {
      std::cerr << "line " << n << ": expected timestamp_us<TAB>payload\n";
      return 2;
    }
    w.append(ts, std::string_view(line).substr(tab + 1));
    if (mode == "every") w.sync();
    else if ((w.count() - start) % 1000 == 0) w.sync();
    if (!key.empty() && w.count() - receipted >= every) issue();
  }
  w.sync();
  if (!key.empty() && w.count() != receipted) issue();
  std::cerr << "sealed " << (w.count() - start) << " records (log now has " << w.count() << ")";
  if (!key.empty()) std::cerr << ", issued " << issued << " receipt(s) to " << receipts;
  std::cerr << "\n";
  return 0;
}

int verify(const std::string& log, const std::vector<std::pair<std::string, std::string>>& opts) {
  std::string receipts = option(opts, "receipts"), pub_hex = option(opts, "pubkey");
  PublicKey trusted{};
  if (!receipts.empty() && !parse_hex(pub_hex, trusted.data(), trusted.size())) {
    std::cerr << "verify: --receipts needs --pubkey with the 64-hex-digit key you trust\n";
    return 2;
  }
  std::vector<Receipt> list;
  if (!receipts.empty()) {
    std::ifstream in(receipts);
    if (!in) {
      std::cerr << receipts << ": cannot read\n";
      return 2;
    }
    std::string line;
    for (int n = 1; std::getline(in, line); ++n) {
      Receipt r;
      if (!parse_line(line, &r)) {
        std::cerr << receipts << ":" << n << ": not a receipt\n";
        return 2;
      }
      list.push_back(r);
    }
  }
  std::map<uint64_t, Hash> links;
  for (const Receipt& r : list) links[r.count] = Hash{};
  ScanResult s = scan(log, &links);
  if (s.status == Status::IoError) {
    std::cerr << log << ": cannot read\n";
    return 2;
  }

  std::cout << "FlightSeal verify: " << log << "\n";
  std::cout << "  records      " << s.records << (s.status == Status::Ok ? " intact" : " intact before the problem") << "\n";
  std::cout << "  head         " << hex(s.head.data(), s.head.size()) << "\n";
  std::cout << "  time order   " << s.time_reversals << " backward timestamp(s)\n";
  bool bad = s.status != Status::Ok;
  if (bad)
    std::cout << "  first problem  record " << s.records << ", byte " << s.good_bytes << ": " << describe(s.status) << " ["
              << token(s.status) << "]\n";
  uint64_t untrusted = 0;
  if (!list.empty()) {
    uint64_t covered = 0, failed = 0, unchecked = 0;
    size_t first_untrusted = 0;
    ReceiptCheck untrusted_check = ReceiptCheck::WrongKey;
    for (size_t i = 0; i < list.size(); ++i) {
      if (s.status != Status::Ok && list[i].count > s.records) {  // the log is already broken before this point
        ++unchecked;
        continue;
      }
      ReceiptCheck c = check_receipt(list[i], trusted, s, links);
      if (c == ReceiptCheck::Ok) {
        covered = std::max(covered, list[i].count);
        continue;
      }
      // A receipt that is not validly signed by the key you trust is not evidence either way: anyone can make one.
      if (c == ReceiptCheck::WrongKey || c == ReceiptCheck::BadSignature) {
        if (untrusted++ == 0) first_untrusted = i, untrusted_check = c;
        continue;
      }
      if (failed++ == 0)
        std::cout << "  receipt " << (i + 1) << " (count " << list[i].count << "): " << describe(c) << "\n";
    }
    if (untrusted)
      std::cout << "  receipt " << (first_untrusted + 1) << " (count " << list[first_untrusted].count
                << "): " << describe(untrusted_check) << " (not evidence either way)\n";
    std::cout << "  receipts     " << list.size() - failed - unchecked - untrusted << " of " << list.size() << " match";
    if (untrusted) std::cout << "; " << untrusted << " not validly signed by the key you trust";
    if (unchecked) std::cout << "; " << unchecked << " cannot be checked past the first problem";
    else if (failed == 0 && untrusted == 0) std::cout << "; " << s.records - covered << " record(s) after the last receipt are not covered";
    std::cout << "\n";
    bad = bad || failed > 0;
  }
  if (!bad && untrusted) {  // exit status 3: nothing wrong was proved, but the receipts prove nothing either
    std::cout << "RESULT: UNVERIFIED (receipts not validly signed by the key you trust)\n";
    return 3;
  }
  std::cout << "RESULT: "
            << (!bad ? "INTACT" : s.status == Status::TornTail && list.empty() ? "INCOMPLETE (if the writer crashed, run: fseal recover)"
                                                                               : "TAMPERED")
            << "\n";
  return bad ? 1 : 0;
}

int recover_cmd(const std::string& log) {
  uint64_t trimmed = 0;
  ScanResult s = recover(log, &trimmed);
  if (s.status != Status::Ok) {
    std::cout << "refusing to change " << log << ": " << describe(s.status) << " at record " << s.records << "\n";
    return s.status == Status::IoError ? 2 : 1;
  }
  if (trimmed) std::cout << "trimmed " << trimmed << " bytes of a torn final record; " << s.records << " records remain\n";
  else std::cout << "nothing to recover; " << s.records << " records intact\n";
  return 0;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 3) return usage();
  std::string cmd = argv[1], path = argv[2];
  std::vector<std::pair<std::string, std::string>> opts;
  if (!parse_options(argc, argv, 3, &opts)) return usage();
  try {
    if (cmd == "keygen" && opts.empty()) return keygen(path);
    if (cmd == "append") return append(path, opts);
    if (cmd == "verify") return verify(path, opts);
    if (cmd == "recover" && opts.empty()) return recover_cmd(path);
  } catch (const std::exception& e) {
    std::cerr << "fseal: " << e.what() << "\n";
    return 2;
  }
  return usage();
}
