if(NOT EMSCRIPTEN)
  message(FATAL_ERROR "BUILD_WASM requires the Emscripten toolchain; use scripts/build_wasm.sh")
endif()
add_executable(fseal-wasm bridge.cpp)
target_link_libraries(fseal-wasm PRIVATE fseal)
target_compile_options(fseal PRIVATE -fexceptions)
target_compile_options(fseal-wasm PRIVATE -fexceptions)
set_target_properties(fseal-wasm PROPERTIES OUTPUT_NAME flightseal SUFFIX .mjs)
target_link_options(fseal-wasm PRIVATE
  --no-entry -fexceptions -O2
  "-sMODULARIZE=1" "-sEXPORT_ES6=1" "-sENVIRONMENT=web,worker,node"
  "-sALLOW_MEMORY_GROWTH=1" "-sINITIAL_MEMORY=33554432" "-sSTACK_SIZE=8388608" "-sMAXIMUM_MEMORY=268435456"
  "-sEXPORTED_FUNCTIONS=['_fseal_verify','_fseal_seal','_fseal_heap_bytes']"
  "-sEXPORTED_RUNTIME_METHODS=['ccall','FS','WORKERFS','NODEFS']"
  "-sFORCE_FILESYSTEM=1" "-sFILESYSTEM=1" -lworkerfs.js -lnodefs.js)
