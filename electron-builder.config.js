/**
 * electron-builder configuration
 * macOS: .dmg (universal) | Windows: NSIS installer
 */
module.exports = {
  appId: 'com.transcribe.app',
  productName: 'Transcribe',
  copyright: `Copyright © ${new Date().getFullYear()}`,

  directories: {
    output: 'release',
    buildResources: 'assets',
  },

  files: [
    'dist/**/*',
    'sidecar/build/Release/*.node',  // native audio capture addons (Issue 03a/03b)
    'package.json',
  ],

  // Model files and build artifacts are excluded per ADR-001 / Issue 01
  // (also covered by .gitignore)

  mac: {
    target: [{ target: 'dmg', arch: ['universal'] }],
    category: 'public.app-category.productivity',
    minimumSystemVersion: '13.0', // macOS Ventura — ScreenCaptureKit requirement (ADR-001)
    entitlements: 'assets/entitlements.mac.plist',
    entitlementsInherit: 'assets/entitlements.mac.plist',
  },

  dmg: {
    title: '${productName} ${version}',
    contents: [
      { x: 130, y: 220 },
      { x: 410, y: 220, type: 'link', path: '/Applications' },
    ],
  },

  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
  },

  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
  },

  // Exclude large model files from the installer bundle
  // (model download script handles this at first launch — Issue 06)
  asarUnpack: ['**/*.node'],
};
