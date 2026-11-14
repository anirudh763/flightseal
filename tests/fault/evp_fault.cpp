// Test-only LD_PRELOAD shim: makes one OpenSSL call fail, to exercise fseal's error paths without touching the
// production code. Never linked into fseal; built as libfseal_evp_fault.so and used by tests/test_crypto_failures.py.
//
//   FSEAL_EVP_FAIL=EVP_DigestFinal_ex      fail the first call of that function
//   FSEAL_EVP_FAIL=EVP_DigestFinal_ex@3    fail only the third call
//   FSEAL_EVP_SHA256_ONLY=1              count only SHA-256 EVP_DigestFinal_ex calls
//
// A failing call returns what OpenSSL returns on error (0, -1 or NULL) without calling the real function, so
// nothing is allocated. Every other call goes to the real libcrypto through dlsym(RTLD_NEXT).
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include <dlfcn.h>
#include <openssl/evp.h>
#include <openssl/obj_mac.h>
#include <openssl/pem.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>

namespace {
bool should_fail(const char* name) {
  const char* spec = std::getenv("FSEAL_EVP_FAIL");
  if (!spec) return false;
  const char* at = std::strchr(spec, '@');
  size_t n = at ? static_cast<size_t>(at - spec) : std::strlen(spec);
  if (std::strlen(name) != n || std::strncmp(spec, name, n) != 0) return false;
  static thread_local long calls = 0;  // one counter is enough: only one function is targeted per run
  long target = at ? std::strtol(at + 1, nullptr, 10) : 1;
  return ++calls == target;
}
template <typename F>
F real(const char* name) {
  void* p = dlsym(RTLD_NEXT, name);
  if (!p) {
    std::fprintf(stderr, "evp_fault: no real %s\n", name);
    std::abort();
  }
  return reinterpret_cast<F>(p);
}
}  // namespace

#define FAULT(ret, name, fail_value, params, args)                     \
  extern "C" ret name params {                                         \
    if (should_fail(#name)) return fail_value;                         \
    static auto fn = real<ret(*) params>(#name);                       \
    return fn args;                                                    \
  }

FAULT(EVP_MD_CTX*, EVP_MD_CTX_new, nullptr, (void), ())
FAULT(int, EVP_DigestInit_ex, 0, (EVP_MD_CTX * c, const EVP_MD* t, ENGINE* e), (c, t, e))
FAULT(int, EVP_DigestUpdate, 0, (EVP_MD_CTX * c, const void* d, size_t n), (c, d, n))
extern "C" int EVP_DigestFinal_ex(EVP_MD_CTX* c, unsigned char* md, unsigned int* s) {
  // Ed25519's internal SHA-512 calls vary across OpenSSL versions; a later chain failure must count SHA-256.
  const char* filter = std::getenv("FSEAL_EVP_SHA256_ONLY");
  const bool eligible = !filter || std::strcmp(filter, "1") != 0 || EVP_MD_CTX_type(c) == NID_sha256;
  if (eligible && should_fail("EVP_DigestFinal_ex")) return 0;
  static auto fn = real<int (*)(EVP_MD_CTX*, unsigned char*, unsigned int*)>("EVP_DigestFinal_ex");
  return fn(c, md, s);
}
FAULT(int, EVP_PKEY_get_raw_public_key, 0, (const EVP_PKEY* k, unsigned char* p, size_t* n), (k, p, n))
FAULT(EVP_PKEY_CTX*, EVP_PKEY_CTX_new_id, nullptr, (int id, ENGINE* e), (id, e))
FAULT(int, EVP_PKEY_keygen_init, 0, (EVP_PKEY_CTX * c), (c))
FAULT(int, EVP_PKEY_keygen, 0, (EVP_PKEY_CTX * c, EVP_PKEY** k), (c, k))
FAULT(int, EVP_DigestSignInit, 0, (EVP_MD_CTX * c, EVP_PKEY_CTX** p, const EVP_MD* t, ENGINE* e, EVP_PKEY* k),
      (c, p, t, e, k))
FAULT(int, EVP_DigestSign, 0, (EVP_MD_CTX * c, unsigned char* s, size_t* sl, const unsigned char* m, size_t ml),
      (c, s, sl, m, ml))
FAULT(int, EVP_DigestVerifyInit, 0, (EVP_MD_CTX * c, EVP_PKEY_CTX** p, const EVP_MD* t, ENGINE* e, EVP_PKEY* k),
      (c, p, t, e, k))
FAULT(int, EVP_DigestVerify, -1, (EVP_MD_CTX * c, const unsigned char* s, size_t sl, const unsigned char* m, size_t ml),
      (c, s, sl, m, ml))
FAULT(EVP_PKEY*, EVP_PKEY_new_raw_public_key, nullptr, (int t, ENGINE* e, const unsigned char* k, size_t n),
      (t, e, k, n))
FAULT(int, PEM_write_PrivateKey, 0,
      (FILE * f, const EVP_PKEY* k, const EVP_CIPHER* c, const unsigned char* ks, int kl, pem_password_cb* cb, void* u),
      (f, k, c, ks, kl, cb, u))
