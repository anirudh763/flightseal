cmake_minimum_required(VERSION 3.16)
project(flightseal VERSION 0.1.0 LANGUAGES CXX)
include(GNUInstallDirs)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()
add_compile_options(-Wall -Wextra -Wpedantic)

option(FSEAL_SANITIZE "Build with AddressSanitizer and UndefinedBehaviorSanitizer" OFF)
if(FSEAL_SANITIZE)
  add_compile_options(-fsanitize=address,undefined -fno-omit-frame-pointer -fno-sanitize-recover=all)
  add_link_options(-fsanitize=address,undefined)
endif()

# Hardening flags set here rather than left to the toolchain's defaults, so every compiler gets them.
option(FSEAL_HARDEN "Build with -fstack-protector-strong, _FORTIFY_SOURCE (optimized builds), PIE and full RELRO" ON)
if(FSEAL_HARDEN)
  include(CheckCXXCompilerFlag)
  include(CheckCXXSourceCompiles)
  include(CheckPIESupported)
  check_pie_supported()  # with POSITION_INDEPENDENT_CODE, executables get -fPIE and -pie
  set(CMAKE_POSITION_INDEPENDENT_CODE ON)
  check_cxx_compiler_flag(-fstack-protector-strong FSEAL_HAS_STACK_PROTECTOR_STRONG)
  if(FSEAL_HAS_STACK_PROTECTOR_STRONG)
    add_compile_options(-fstack-protector-strong)
  endif()
  # _FORTIFY_SOURCE needs optimization, so only Release and RelWithDebInfo. Add -D_FORTIFY_SOURCE=2 unless the
  # toolchain already defines it at 2 or higher (Ubuntu's GCC defaults to 3; redefining it would lower it).
  set(CMAKE_REQUIRED_FLAGS "-O2")
  check_cxx_source_compiles("#include <cstdio>
#if !defined(_FORTIFY_SOURCE) || _FORTIFY_SOURCE < 2
#error no _FORTIFY_SOURCE
#endif
int main() { return 0; }" FSEAL_TOOLCHAIN_FORTIFIES)
  unset(CMAKE_REQUIRED_FLAGS)
  if(NOT FSEAL_TOOLCHAIN_FORTIFIES)
    add_compile_options($<$<OR:$<CONFIG:Release>,$<CONFIG:RelWithDebInfo>>:-D_FORTIFY_SOURCE=2>)
  endif()
  set(CMAKE_REQUIRED_LINK_OPTIONS "-Wl,-z,relro,-z,now")
  check_cxx_source_compiles("int main() { return 0; }" FSEAL_HAS_RELRO_NOW)
  unset(CMAKE_REQUIRED_LINK_OPTIONS)
  if(FSEAL_HAS_RELRO_NOW)
    add_link_options(-Wl,-z,relro,-z,now)
  endif()
endif()

find_package(OpenSSL 1.1.1 REQUIRED)

add_library(fseal src/fseal.cpp)
target_include_directories(fseal PUBLIC src)
target_link_libraries(fseal PUBLIC OpenSSL::Crypto)

add_executable(fseal-cli src/main.cpp)
set_target_properties(fseal-cli PROPERTIES OUTPUT_NAME fseal)
target_link_libraries(fseal-cli fseal)
install(TARGETS fseal-cli RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR})

enable_testing()
add_executable(fseal-tests tests/test_fseal.cpp)
target_link_libraries(fseal-tests fseal)
add_test(NAME unit COMMAND fseal-tests)

# Test-only LD_PRELOAD shim that makes one chosen OpenSSL call fail (tests/test_crypto_failures.py). Not installed.
if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  add_library(fseal_evp_fault SHARED tests/fault/evp_fault.cpp)
  target_link_libraries(fseal_evp_fault PRIVATE OpenSSL::Crypto ${CMAKE_DL_LIBS})
endif()
add_test(NAME version COMMAND fseal-cli --version)  # must exit 0
add_test(NAME version-text COMMAND fseal-cli --version)  # and print exactly the project version
set_tests_properties(version-text PROPERTIES PASS_REGULAR_EXPRESSION "^fseal ${PROJECT_VERSION}\n$")
add_test(NAME install COMMAND ${CMAKE_COMMAND} -DBUILD_DIR=${CMAKE_BINARY_DIR} -DSOURCE_DIR=${CMAKE_SOURCE_DIR}
                                -P ${CMAKE_SOURCE_DIR}/tests/install_test.cmake)
set_tests_properties(install PROPERTIES DEPENDS version)

find_package(SQLite3)
if(SQLite3_FOUND)
  add_executable(fseal-bench bench/bench.cpp)
  target_link_libraries(fseal-bench fseal SQLite::SQLite3)
endif()
