# Tab Manager

Tab Manager is a Manifest V3 extension that closes duplicate tabs, groups tabs by hostname, moves stale tabs aside, and sorts tabs within a window. Desktop Google Chrome and desktop Mozilla Firefox run the same source code.

The toolbar button organizes the current window. It does not open a popup. Settings and the action log are on the options page. The extension does not register keyboard shortcuts.

Chrome uses a background service worker. Firefox uses a background event page. Listeners are registered while the background script first evaluates, so both browsers can wake the extension after the background is suspended. Settings, the action log, and last-access records live in `storage.sync` and `storage.local`.

## Supported browsers

- Google Chrome, desktop, Manifest V3
- Mozilla Firefox 140 and newer, desktop, Manifest V3

Firefox 140 is the minimum on desktop because the extension uses the `tabGroups` API and Firefox's data-collection manifest field. The package also sets Firefox for Android 142 as its minimum, which is when that field exists on Android. Android is not a tested target. Firefox does not run this extension's background as a service worker. The Firefox bundle loads `background.js` as a module event page (`background.scripts`).

Tab URLs are read to find duplicates, groups, and stale tabs. Settings and logs stay in the browser. The Firefox manifest declares `data_collection_permissions.required: ["none"]` because the extension does not transmit that data.

## Build

Install dependencies once, including the Firefox linter:

```bash
npm install
```

Build both bundles, or one browser:

```bash
npm run build
npm run build:chrome
npm run build:firefox
```

Output:

```text
dist/
  chrome/
    manifest.json
  firefox/
    manifest.json
```

`npm run build` writes both directories. `manifest.json` in the repository root is the Chrome manifest, and `dist/chrome/manifest.json` is a copy of it. The Firefox manifest is generated from that file during the Firefox build.

Check the source and the Firefox package:

```bash
npm test
npm run check
npm run smoke
npm run lint:firefox
```

`npm run lint:firefox` rebuilds `dist/firefox` and runs `web-ext lint`.

## Install in Chrome

1. Run `npm run build:chrome`.
2. Open `chrome://extensions`.
3. Turn on Developer mode.
4. Choose **Load unpacked**.
5. Select the `dist/chrome` directory.

For Chrome development, loading the repository root is equivalent: the root manifest is the Chrome manifest.

Open settings from the extension's options entry in the extensions menu, or by right-clicking the toolbar button. Click the toolbar button to organize the current window.

## Install in Firefox

Firefox Release and Firefox Beta only keep extensions that Mozilla has signed. This repository does not submit the extension to addons.mozilla.org, and it does not publish a signed package.

A temporary unsigned install works in every desktop Firefox channel:

1. Run `npm run build:firefox`.
2. Open `about:debugging`.
3. Choose **This Firefox**.
4. Choose **Load Temporary Add-on…**.
5. Select `dist/firefox/manifest.json`.

Firefox removes temporary add-ons when the browser exits. Load the same folder again to install it for another session. The manifest ID is `tab-manager@tab-manager.invalid`, so storage from the previous temporary install is still available after you load it again.

A permanent install on Firefox Release or Beta requires signing through addons.mozilla.org. Signing can be unlisted; the extension still has to be submitted for signing. Firefox Nightly and Firefox Developer Edition can load an unsigned extension permanently when `xpinstall.signatures.required` is set to `false` in `about:config`.

Open settings from the extension's Preferences entry in the extensions menu. Click the toolbar button to organize the current window.

## Browser smoke test

`npm run smoke:browsers` builds both bundles and loads them in temporary profiles.

When Google Chrome is installed, the command checks deduplication in one window and across two windows, pinned tabs, hostname grouping, sorting, that a tracking parameter stays on the real tab URL, the options page, and settings after Chrome restarts.

When Firefox is installed, `FIREFOX_BINARY` points at a Firefox executable, or a `Firefox.app` is present under the gitignored `firefox/` directory, the command loads `dist/firefox` as a temporary add-on and runs those same checks. A machine without Firefox skips that part.
