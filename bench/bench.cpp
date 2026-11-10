// Ingest, verify and recovery benchmark.
//
// Appends the same records three ways, under the same durability policy:
//   plain    length | timestamp | payload | crc32   (what you would write without tamper evidence)
//   fseal    FlightSeal records (adds the sequence number and the SHA-256 link)
//   sqlite   SQLite in WAL mode, synchronous=FULL, one row per record
// Policies: "batch" makes records durable every 1000 (fsync / COMMIT); "every" after each record.
//
// usage: fseal-bench RECORDS.tsv WORKDIR [runs]
//   RECORDS.tsv comes from tools/ulog_to_records.py; WORKDIR must be on the disk you want to measure.
#include <fcntl.h>
#include <sqlite3.h>
#include <sys/utsname.h>
#include <sys/vfs.h>
#include <unistd.h>

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <functional>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

#include "fseal.h"

namespace {

struct Rec {
  uint64_t ts;
  std::string payload;
};
constexpr size_t kBatch = 1000;
enum class Sync { Batch, Every };

std::vector<Rec> load(const std::string& path) {
  std::ifstream in(path);
  if (!in) throw std::runtime_error(path + ": cannot read");
  std::vector<Rec> out;
  for (std::string line; std::getline(in, line);) {
    size_t tab = line.find('\t');
    out.push_back({std::stoull(line.substr(0, tab)), line.substr(tab + 1)});
  }
  return out;
}

double seconds(const std::function<void()>& fn) {
  auto t0 = std::chrono::steady_clock::now();
  fn();
  return std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
}

double median(std::vector<double> v) {
  std::sort(v.begin(), v.end());
  return v[v.size() / 2];
}

long file_size(const std::string& p) {
  std::ifstream f(p, std::ios::binary | std::ios::ate);
  return f ? static_cast<long>(f.tellg()) : 0;
}

void put_le(std::string& out, uint64_t v, int n) {
  for (int i = 0; i < n; ++i) out.push_back(static_cast<char>((v >> (8 * i)) & 0xFF));
}

void write_all(int fd, const std::string& s) {
  for (size_t done = 0; done < s.size();) {
    ssize_t w = ::write(fd, s.data() + done, s.size() - done);
    if (w < 0) throw std::runtime_error("write failed");
    done += static_cast<size_t>(w);
  }
}

void run_plain(const std::vector<Rec>& recs, size_t n, Sync mode, const std::string& path) {
  ::unlink(path.c_str());
  int fd = ::open(path.c_str(), O_WRONLY | O_CREAT | O_APPEND, 0644);
  std::string buf;
  for (size_t i = 0; i < n; ++i) {
    size_t start = buf.size();
    put_le(buf, recs[i].payload.size(), 4);
    put_le(buf, recs[i].ts, 8);
    buf += recs[i].payload;
    put_le(buf, fseal::crc32(buf.data() + start, buf.size() - start), 4);
    if (mode == Sync::Every || (i + 1) % kBatch == 0) {
      write_all(fd, buf);
      buf.clear();
      ::fsync(fd);
    }
  }
  write_all(fd, buf);
  ::fsync(fd);
  ::close(fd);
}

void run_fseal(const std::vector<Rec>& recs, size_t n, Sync mode, const std::string& path) {
  ::unlink(path.c_str());
  fseal::Writer w(path);
  for (size_t i = 0; i < n; ++i) {
    w.append(recs[i].ts, recs[i].payload);
    if (mode == Sync::Every || (i + 1) % kBatch == 0) w.sync();
  }
}  // the destructor syncs the rest

void exec(sqlite3* db, const char* sql) {
  char* err = nullptr;
  if (sqlite3_exec(db, sql, nullptr, nullptr, &err) != SQLITE_OK) {
    std::string msg = err ? err : "sqlite error";
    sqlite3_free(err);
    throw std::runtime_error(msg);
  }
}

void run_sqlite(const std::vector<Rec>& recs, size_t n, Sync mode, const std::string& path) {
  for (const char* suffix : {"", "-wal", "-shm"}) ::unlink((path + suffix).c_str());
  sqlite3* db = nullptr;
  sqlite3_open(path.c_str(), &db);
  exec(db, "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;"
           "CREATE TABLE log(seq INTEGER PRIMARY KEY, ts INTEGER NOT NULL, payload BLOB NOT NULL);");
  sqlite3_stmt* ins = nullptr;
  sqlite3_prepare_v2(db, "INSERT INTO log(seq, ts, payload) VALUES (?, ?, ?)", -1, &ins, nullptr);
  if (mode == Sync::Batch) exec(db, "BEGIN");
  for (size_t i = 0; i < n; ++i) {
    sqlite3_bind_int64(ins, 1, static_cast<sqlite3_int64>(i));
    sqlite3_bind_int64(ins, 2, static_cast<sqlite3_int64>(recs[i].ts));
    sqlite3_bind_blob(ins, 3, recs[i].payload.data(), static_cast<int>(recs[i].payload.size()), SQLITE_STATIC);
    if (sqlite3_step(ins) != SQLITE_DONE) throw std::runtime_error(sqlite3_errmsg(db));
    sqlite3_reset(ins);
    if (mode == Sync::Batch && (i + 1) % kBatch == 0) exec(db, "COMMIT; BEGIN");
  }
  if (mode == Sync::Batch) exec(db, "COMMIT");
  sqlite3_finalize(ins);
  sqlite3_close(db);
}

std::string cpu_model() {
  std::ifstream in("/proc/cpuinfo");
  for (std::string line; std::getline(in, line);)
    if (line.rfind("model name", 0) == 0) return line.substr(line.find(':') + 2);
  return "unknown";
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 3) {
    std::cerr << "usage: fseal-bench RECORDS.tsv WORKDIR [runs]\n";
    return 2;
  }
  std::vector<Rec> recs = load(argv[1]);
  std::string dir = argv[2];
  int runs = argc > 3 ? std::atoi(argv[3]) : 5;
  size_t payload_bytes = 0;
  for (const Rec& r : recs) payload_bytes += r.payload.size();

  utsname u{};
  uname(&u);
  struct statfs fs {};
  statfs(dir.c_str(), &fs);
  std::cout << "Environment: " << cpu_model() << ", " << sysconf(_SC_NPROCESSORS_ONLN) << " CPUs, Linux " << u.release
            << ", filesystem magic 0x" << std::hex << fs.f_type << std::dec << ", SQLite " << sqlite3_libversion()
            << "\nInput: " << recs.size() << " records, " << payload_bytes << " payload bytes (mean "
            << payload_bytes / recs.size() << " B). Median of " << runs << " runs.\n\n";

  struct System {
    const char* name;
    void (*fn)(const std::vector<Rec>&, size_t, Sync, const std::string&);
    std::string file;
  };
  std::vector<System> systems = {{"plain append (CRC only)", run_plain, dir + "/bench.plain"},
                                 {"FlightSeal", run_fseal, dir + "/bench.fseal"},
                                 {"SQLite WAL, synchronous=FULL", run_sqlite, dir + "/bench.sqlite"}};
  std::cout << "| system | durable every | records | records/s | MB/s of payload | file size |\n|---|---|---|---|---|---|\n";
  for (Sync mode : {Sync::Batch, Sync::Every}) {
    size_t n = mode == Sync::Batch ? recs.size() : std::min<size_t>(recs.size(), 5000);
    size_t bytes = 0;
    for (size_t i = 0; i < n; ++i) bytes += recs[i].payload.size();
    for (const System& s : systems) {
      std::vector<double> t;
      for (int r = 0; r < runs; ++r) t.push_back(seconds([&] { s.fn(recs, n, mode, s.file); }));
      double m = median(t);
      long size = file_size(s.file) + file_size(s.file + "-wal");
      std::printf("| %s | %s | %zu | %.0f | %.1f | %.1f MB |\n", s.name, mode == Sync::Batch ? "1000 records" : "record",
                  n, n / m, bytes / m / 1e6, size / 1e6);
    }
  }

  // Verify and recovery on the full FlightSeal log.
  run_fseal(recs, recs.size(), Sync::Batch, dir + "/bench.fseal");
  std::vector<double> v, rec;
  for (int r = 0; r < runs; ++r) v.push_back(seconds([&] { fseal::scan(dir + "/bench.fseal"); }));
  std::string torn = dir + "/bench-torn.fseal";
  for (int r = 0; r < runs; ++r) {
    std::ifstream src(dir + "/bench.fseal", std::ios::binary);
    std::string data((std::istreambuf_iterator<char>(src)), std::istreambuf_iterator<char>());
    std::ofstream(torn, std::ios::binary | std::ios::trunc) << data.substr(0, data.size() - 7);
    uint64_t trimmed = 0;
    rec.push_back(seconds([&] { fseal::recover(torn, &trimmed); }));
  }
  std::printf("\nVerify all %zu records (checksums, sequence, SHA-256 chain): %.1f ms median\n", recs.size(), median(v) * 1e3);
  std::printf("Recover after a torn final record (scan + trim + fsync): %.1f ms median\n", median(rec) * 1e3);
  return 0;
}
