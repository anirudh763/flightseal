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
