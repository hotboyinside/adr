# Issue 04 — Cross-Platform CI Matrix

**Type:** AFK
**Blocked by:** Issue 02 (project structure must exist)
**Best merged after:** Issues 03a and 03b are open (CI validates them as they land)
**Priority:** Critical path

---

## Description

Set up a CI pipeline with a build-and-test matrix covering macOS and Windows. Every PR that touches native code or the Electron shell must pass on both platforms before merging. Linux is excluded from the matrix at this stage (deferred to Issue 11).

The CI matrix must:
- Build the native C++ sidecar addon on each platform
- Run the TypeScript compiler check (`tsc --noEmit`)
- Run unit tests (Jest)
- Produce a smoke-test binary artifact that can be downloaded and manually verified

---

## CI Matrix Definition

```yaml
# .github/workflows/ci.yml  (or .gitlab-ci.yml — adapt syntax as needed)

strategy:
  matrix:
    os: [macos-14, windows-2022]
    node: [20]

steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-node@v4
    with:
      node-version: ${{ matrix.node }}
      cache: npm

  # Native build dependencies
  - name: Install CMake (macOS)
    if: runner.os == 'macOS'
    run: brew install cmake

  - name: Install CMake (Windows)
    if: runner.os == 'Windows'
    uses: lukka/get-cmake@latest

  # Build
  - run: npm ci
  - run: npm run build:native   # cmake-js build
  - run: npm run build:ts       # tsc --noEmit

  # Test
  - run: npm test -- --ci

  # Artifact
  - uses: actions/upload-artifact@v4
    with:
      name: sidecar-${{ matrix.os }}
      path: build/Release/sidecar.*
```

---

## npm Scripts to Add

```json
{
  "scripts": {
    "build:native": "cmake-js build",
    "build:ts": "tsc --noEmit",
    "build": "npm run build:native && npm run build:ts",
    "test": "jest",
    "test:ci": "jest --ci --coverage",
    "dev": "electron-forge start",
    "package:mac": "electron-builder --mac",
    "package:win": "electron-builder --win"
  }
}
```

---

## CMake Integration

```cmake
# sidecar/CMakeLists.txt

cmake_minimum_required(VERSION 3.20)
project(aura_sidecar)

# Platform-specific sources
if(APPLE)
    set(PLATFORM_SOURCES platform/macos/MacOSAudioCapture.mm)
    set(PLATFORM_LIBS "-framework ScreenCaptureKit" "-framework CoreAudio" "-framework CoreMedia")
elseif(WIN32)
    set(PLATFORM_SOURCES platform/windows/WindowsAudioCapture.cpp)
    set(PLATFORM_LIBS ole32 oleaut32 avrt)
endif()

add_library(sidecar SHARED
    main.cpp
    ${PLATFORM_SOURCES}
)

target_link_libraries(sidecar ${PLATFORM_LIBS})
```

---

## Tasks

- [ ] Create `.github/workflows/ci.yml` with the matrix defined above (or `.gitlab-ci.yml` if using GitLab)
- [ ] Add `cmake-js` as a dev dependency: `npm install --save-dev cmake-js`
- [ ] Add all `scripts` entries to `package.json`
- [ ] Configure `sidecar/CMakeLists.txt` with platform conditionals
- [ ] Add a `.npmrc` with `node_modules/.cache` excluded from CI artifacts
- [ ] Confirm `macos-14` runner has Xcode 15+ (required for ScreenCaptureKit headers)
- [ ] Confirm `windows-2022` runner has MSVC 2022 toolchain available
- [ ] Add branch protection rule: CI must pass on both platforms before merge to `main`/`develop`
- [ ] Add a `README` badge showing CI status

---

## Acceptance Criteria

- CI runs automatically on every PR and push to `main`/`develop`
- The matrix covers `macos-14` and `windows-2022`
- `build:native` succeeds on both platforms (even if the sidecar is a stub at this stage)
- `build:ts` and `test` steps pass on both platforms
- A failing native build on either platform blocks the PR — no merging a broken platform
- Sidecar binary artifacts are uploaded and downloadable from each CI run
