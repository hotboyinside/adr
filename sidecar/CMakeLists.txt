# CMakeLists.txt — Native audio capture N-API addons
# Built with cmake-js: npm run build:native
# macOS: MacOSAudioCapture.node  (ScreenCaptureKit, Issue 03a)
# Windows: WindowsAudioCapture.node (WASAPI loopback, Issue 03b)
# Linux: Deferred to Issue 11 (PulseAudio/PipeWire)

cmake_minimum_required(VERSION 3.20)
project(transcribe_sidecar VERSION 0.1.0 LANGUAGES C CXX OBJCXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# cmake-js injects CMAKE_JS_INC and CMAKE_JS_LIB
include_directories(${CMAKE_JS_INC})

# Locate node-addon-api headers
execute_process(
  COMMAND node -p "require('node-addon-api').include"
  WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}/..
  OUTPUT_VARIABLE NODE_ADDON_API_DIR
  OUTPUT_STRIP_TRAILING_WHITESPACE
)
string(REPLACE "\"" "" NODE_ADDON_API_DIR "${NODE_ADDON_API_DIR}")
include_directories(${NODE_ADDON_API_DIR})

add_definitions(-DNAPI_VERSION=8 -DNAPI_DISABLE_CPP_EXCEPTIONS)

# ─────────────────────────────────────────────────────────────────────────────
# whisper.cpp — static library (Issue 06)
# Build only the library; skip examples, tests, and server.
# ─────────────────────────────────────────────────────────────────────────────
set(WHISPER_BUILD_TESTS    OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_SERVER   OFF CACHE BOOL "" FORCE)
set(WHISPER_ALL_WARNINGS   OFF CACHE BOOL "" FORCE)
set(WHISPER_FATAL_WARNINGS OFF CACHE BOOL "" FORCE)
set(BUILD_SHARED_LIBS      OFF CACHE BOOL "" FORCE)
# Disable GPU backends for now — CPU fallback is sufficient for development
set(GGML_METAL  OFF CACHE BOOL "" FORCE)
set(GGML_CUDA   OFF CACHE BOOL "" FORCE)
set(GGML_VULKAN OFF CACHE BOOL "" FORCE)
# Disable BLAS — Chromium already initialises Accelerate in Electron's main process,
# causing a SIGBUS when whisper.cpp tries to set up its own BLAS thread pool.
set(GGML_BLAS   OFF CACHE BOOL "" FORCE)

add_subdirectory(vendor/whisper.cpp)

# ─────────────────────────────────────────────────────────────────────────────
# Vendored speexdsp resampler (Issue 05)
# Compiled as a static library included into each platform addon.
# ─────────────────────────────────────────────────────────────────────────────
set(SPEEXDSP_DIR ${CMAKE_SOURCE_DIR}/vendor/speexdsp)

add_library(speexdsp_resampler STATIC
  ${SPEEXDSP_DIR}/resample.c
)

target_include_directories(speexdsp_resampler PUBLIC
  ${SPEEXDSP_DIR}          # config.h, arch.h, os_support.h, etc.
  ${SPEEXDSP_DIR}/speex    # speex_resampler.h, speexdsp_types.h
)

target_compile_definitions(speexdsp_resampler PUBLIC
  FLOATING_POINT=1
  OUTSIDE_SPEEX=1
  RANDOM_PREFIX=transcribe
)

# Suppress warnings in vendored code
if(MSVC)
  target_compile_options(speexdsp_resampler PRIVATE /W0)
else()
  target_compile_options(speexdsp_resampler PRIVATE -w)
endif()

# ─────────────────────────────────────────────────────────────────────────────
# Normalizer (Issue 05) — shared between all platform addons
# ─────────────────────────────────────────────────────────────────────────────
add_library(normalizer STATIC
  audio/Normalizer.cpp
)

target_include_directories(normalizer PUBLIC
  ${CMAKE_SOURCE_DIR}/audio
  ${SPEEXDSP_DIR}
  ${SPEEXDSP_DIR}/speex
)

target_link_libraries(normalizer PUBLIC speexdsp_resampler)

# ─────────────────────────────────────────────────────────────────────────────
# macOS — ScreenCaptureKit (Issue 03a)
# ─────────────────────────────────────────────────────────────────────────────
if(APPLE)
  set(CMAKE_OSX_DEPLOYMENT_TARGET "13.0" CACHE STRING "Minimum macOS version (ADR-001)")
  set(CMAKE_OSX_ARCHITECTURES "arm64;x86_64" CACHE STRING "Universal binary")

  add_library(MacOSAudioCapture SHARED
    platform/macos/MacOSAudioCapture.mm
    ${CMAKE_JS_SRC}
  )

  set_target_properties(MacOSAudioCapture PROPERTIES
    PREFIX ""
    SUFFIX ".node"
    MACOSX_RPATH TRUE
  )

  target_link_libraries(MacOSAudioCapture
    normalizer
    ${CMAKE_JS_LIB}
    "-framework ScreenCaptureKit"
    "-framework CoreMedia"
    "-framework CoreAudio"
    "-framework Foundation"
    "-framework CoreGraphics"
  )

  target_compile_options(MacOSAudioCapture PRIVATE
    -fobjc-arc          # Automatic Reference Counting for Objective-C objects
    -Wall -Wextra -Wno-unused-parameter
  )

# ─────────────────────────────────────────────────────────────────────────────
# Windows — WASAPI loopback (Issue 03b)
# ─────────────────────────────────────────────────────────────────────────────
elseif(WIN32)
  add_library(WindowsAudioCapture SHARED
    platform/windows/WindowsAudioCapture.cpp
    ${CMAKE_JS_SRC}
  )

  set_target_properties(WindowsAudioCapture PROPERTIES
    PREFIX ""
    SUFFIX ".node"
  )

  target_link_libraries(WindowsAudioCapture
    normalizer
    ${CMAKE_JS_LIB}
    ole32       # COM (CoCreateInstance, CoInitializeEx)
    oleaut32    # WASAPI
  )

  target_compile_options(WindowsAudioCapture PRIVATE /W3 /WX-)

# ─────────────────────────────────────────────────────────────────────────────
# Linux — Deferred (Issue 11)
# ─────────────────────────────────────────────────────────────────────────────
else()
  message(STATUS "Linux audio capture is deferred to Issue 11 (PulseAudio/PipeWire). "
                 "No native addon will be built for this platform.")
endif()

# ─────────────────────────────────────────────────────────────────────────────
# WhisperAddon — N-API addon wrapping WhisperTranscriber (Issue 06)
# ─────────────────────────────────────────────────────────────────────────────
add_library(WhisperAddon SHARED
  asr/WhisperTranscriber.cpp
  asr/WhisperAddon.cpp
  ${CMAKE_JS_SRC}
)

set_target_properties(WhisperAddon PROPERTIES
  PREFIX ""
  SUFFIX ".node"
)

target_include_directories(WhisperAddon PRIVATE
  ${CMAKE_SOURCE_DIR}/asr
  ${CMAKE_SOURCE_DIR}/vendor/whisper.cpp/include
  ${CMAKE_SOURCE_DIR}/vendor/whisper.cpp/ggml/include
)

target_link_libraries(WhisperAddon
  whisper
  ${CMAKE_JS_LIB}
)

if(APPLE)
  set_target_properties(WhisperAddon PROPERTIES MACOSX_RPATH TRUE)
  target_link_libraries(WhisperAddon
    "-framework Foundation"
    "-framework Accelerate"
  )
  target_compile_options(WhisperAddon PRIVATE -Wall -Wextra -Wno-unused-parameter)
elseif(WIN32)
  target_compile_options(WhisperAddon PRIVATE /W3 /WX-)
endif()

# ─────────────────────────────────────────────────────────────────────────────
# NormalizerAddon — standalone .node for the TypeScript integration test (Issue 05)
# Not used in production; exposes normalize() as a synchronous N-API function.
# ─────────────────────────────────────────────────────────────────────────────
add_library(NormalizerAddon SHARED
  audio/NormalizerAddon.cpp
  ${CMAKE_JS_SRC}
)

set_target_properties(NormalizerAddon PROPERTIES
  PREFIX ""
  SUFFIX ".node"
)

target_link_libraries(NormalizerAddon
  normalizer
  ${CMAKE_JS_LIB}
)

if(APPLE)
  set_target_properties(NormalizerAddon PROPERTIES MACOSX_RPATH TRUE)
  target_compile_options(NormalizerAddon PRIVATE -Wall -Wextra -Wno-unused-parameter)
elseif(WIN32)
  target_compile_options(NormalizerAddon PRIVATE /W3 /WX-)
endif()

# ─────────────────────────────────────────────────────────────────────────────
# C++ unit tests (Issue 05) — built on all platforms, no N-API dependency
# Run via: ctest --test-dir sidecar/build -R normalizer
# ─────────────────────────────────────────────────────────────────────────────
enable_testing()

add_executable(test_normalizer
  audio/tests/normalizer_test.cpp
)

target_include_directories(test_normalizer PRIVATE
  ${CMAKE_SOURCE_DIR}/audio
  ${SPEEXDSP_DIR}
  ${SPEEXDSP_DIR}/speex
)

target_link_libraries(test_normalizer PRIVATE normalizer)

add_test(NAME normalizer COMMAND test_normalizer)
