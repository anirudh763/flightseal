#!/usr/bin/env bash
# Checks that a release binary carries the hardening CMakeLists.txt asks for (FSEAL_HARDEN), using readelf:
#   PIE (ELF type DYN with the PIE flag), full RELRO (GNU_RELRO segment plus BIND_NOW), a non-executable stack,
#   and the stack protector (__stack_chk_fail). _FORTIFY_SOURCE cannot always be seen in the binary (fseal makes no
#   libc call that the compiler can turn into a __*_chk call), so it is checked in the build directory instead: either
#   the toolchain already defines it at 2 or higher, or CMake added -D_FORTIFY_SOURCE=2.
#   tools/check_hardening.sh BINARY BUILD_DIR
set -euo pipefail
BIN=${1:?usage: check_hardening.sh BINARY BUILD_DIR}
BUILD=${2:?usage: check_hardening.sh BINARY BUILD_DIR}
fail=0
check() {  # name, then a command that succeeds when the property holds
  local name=$1; shift
  if "$@" >/dev/null 2>&1; then echo "ok    $name"; else echo "FAIL  $name"; fail=1; fi
}
headers=$(readelf -W -h -l -d "$BIN")
dynsyms=$(readelf -W --dyn-syms "$BIN")
check "PIE (ELF type DYN, FLAGS_1 PIE)" sh -c 'echo "$1" | grep -Eq "Type: +DYN" && echo "$1" | grep -Eq "FLAGS_1.*PIE"' _ "$headers"
check "RELRO (GNU_RELRO segment)" sh -c 'echo "$1" | grep -q GNU_RELRO' _ "$headers"
check "BIND_NOW (full RELRO)" sh -c 'echo "$1" | grep -Eq "\(FLAGS\).*BIND_NOW|FLAGS_1.*NOW"' _ "$headers"
check "non-executable stack (GNU_STACK RW)" sh -c 'echo "$1" | grep -E "GNU_STACK" | grep -Eqv "RWE"' _ "$headers"
check "stack protector (__stack_chk_fail)" sh -c 'echo "$1" | grep -q __stack_chk_fail' _ "$dynsyms"
check "_FORTIFY_SOURCE >= 2 in the build (toolchain default or -D_FORTIFY_SOURCE=2)" sh -c \
  'grep -q "^CMAKE_BUILD_TYPE:STRING=Release" "$1/CMakeCache.txt" &&
   { grep -q "^FSEAL_TOOLCHAIN_FORTIFIES:INTERNAL=1" "$1/CMakeCache.txt" ||
     grep -q -- "-D_FORTIFY_SOURCE=2" "$1/CMakeFiles/fseal-cli.dir/flags.make"; }' _ "$BUILD"
if echo "$dynsyms" | grep -Eq "__[a-z_]+_chk@"; then echo "info  fortified calls: $(echo "$dynsyms" | grep -Eo "__[a-z_]+_chk" | sort -u | tr '\n' ' ')"
else echo "info  no __*_chk calls in the binary (no fortifiable libc call with a known size)"; fi
exit $fail
