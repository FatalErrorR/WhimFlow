<div align="center">
  <img src="assets/logo.png" width="128" alt="WhimFlow logo">
  <h1>WhimFlow</h1>
  <p>A calm, live-preview Markdown workspace for thinking, drafting, and organizing ideas.</p>
  <p>
    <a href="https://github.com/FatalErrorR/WhimFlow/releases/latest">Download the latest release</a>
    ·
    <a href="https://github.com/FatalErrorR/WhimFlow/issues">Report an issue</a>
  </p>
</div>

![WhimFlow editor with live final view](assets/showcase.png)

WhimFlow is a desktop Markdown editor built with Electron and CodeMirror 6. It keeps writing, structure, and rendered output close together so you can focus on the document instead of the tooling around it.

## Highlights

- Live Markdown editing with a focused, distraction-free layout
- Editor and final view that stay in sync while you type
- Tables, task lists, footnotes, code blocks, syntax highlighting, and images
- KaTeX math and Mermaid diagrams
- Multiple documents, search, history, recovery, and export tools
- Native file associations for Markdown documents
- macOS and Windows desktop builds, plus an iPhone / iPad app (iOS 16.4+)

## Preview

The final view can sit beside the editor while you write, and the document structure can open as a mind map when you need a wider view:

![WhimFlow mind map](assets/mindmap.png)

## Download

Prebuilt installers are published on the [Releases](https://github.com/FatalErrorR/WhimFlow/releases) page.

| Platform | Packages |
| --- | --- |
| macOS | `.dmg` and `.zip` for Apple Silicon and Intel |
| Windows | `.exe` installer and `.zip` portable package for x64 |

The current builds are unsigned. macOS and Windows may show a first-run security warning until the application is signed with platform certificates.

## Run from source

Requirements: Node.js 20 or newer.

```bash
npm ci
npm start
```

## Build installers

```bash
# macOS: Apple Silicon and Intel
npm run dist:mac

# Windows: x64 installer and portable ZIP
npm run dist:win
```

Build output is written to `dist/`. Release artifacts are kept out of Git by `.gitignore` and uploaded to GitHub Releases instead.

## iPhone and iPad

The iOS app lives in `mobile/` (Capacitor) and shares the desktop interface code: editor, final view, highlighting, and conflict detection. Documents are stored in the app's own folder, visible in the Files app under *On My iPhone › WhimFlow*. Requires iOS / iPadOS 16.4 or newer.

On a Mac with Xcode:

```bash
# install the iOS dependencies once
cd mobile && npm ci && cd ..

# build the web app and sync it into the Xcode project
npm run build:mobile

# open in Xcode, pick a simulator or device, and run
cd mobile && npx cap open ios
```

To run on a real device or publish, choose your Apple developer team under *Signing & Capabilities* in Xcode.

## Tests

```bash
npm test
```

To test the iPhone and iPad layouts in an emulated browser (no Mac needed):

```bash
npm run test:mobile
```

The test suite covers editor behavior, rendering, document safety, recovery, preview synchronization, and layout checks.

## Project layout

| Path | Purpose |
| --- | --- |
| `src/main.js`, `src/main/` | Electron main process, file operations, history, recovery, search, and export |
| `src/preload.js` | Secure bridge between the main process and the renderer |
| `src/renderer/` | Editor, live preview, panels, themes, and UI behavior |
| `src/renderer/js/mobile/`, `src/renderer/js/platform/` | iPhone / iPad interface and the Capacitor-backed file API |
| `mobile/` | Capacitor project and Xcode workspace for iOS |
| `scripts/build.js` | Builds the renderer bundle (desktop, or `mobile` for iOS) |
| `docs/` | Markdown reference material |
| `test/` | Automated tests |
| `build/` | Application artwork and platform icons |

## Fonts and third-party notices

The application includes Source Serif 4, DM Sans, and JetBrains Mono. Their license files are kept in `src/renderer/fonts/`.

## License

WhimFlow is licensed under the [Apache License 2.0](LICENSE).
