# Milestone 5B: private HTTPS and device testing

The development server is for online UI work. The installable offline application is the **production build**, served with the API proxy by Vite preview for private testing. Service workers register only in production on a secure origin. A phone visiting `http://<LAN-IP>:5173` is not on a secure origin; ordinary LAN HTTP cannot test offline startup. `http://localhost` is a development exception on the computer itself. See [MDN service-worker setup](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers).

## Private HTTPS on your Mac and phone

This setup exposes only the frontend HTTPS port to your trusted home Wi-Fi. FastAPI stays on `127.0.0.1:8000`; Voicebox stays on loopback. No public tunnel, cloud deployment, router forwarding, unrestricted hosts/CORS, or firewall disabling is needed. The reader still has no authentication: devices that can reach this port can use its API.

One-time setup on the Mac, from the repository root (Homebrew is required for the first command):

```sh
brew install mkcert
mkcert -install
networksetup -listallhardwareports
```

Find the **Wi-Fi** device in the last command’s output. It is often `en0`; substitute the actual interface below. `mkcert -install` creates a local certificate authority and installs its trust on the Mac. Then create a certificate containing your current Wi-Fi address:

```sh
reader_wifi_ip=$(ipconfig getifaddr en0)
mkdir -p .certs
mkcert -cert-file .certs/reader.pem -key-file .certs/reader-key.pem localhost 127.0.0.1 "$reader_wifi_ip"
cp "$(mkcert -CAROOT)/rootCA.pem" .certs/reader-rootCA.crt
```

Check that `reader_wifi_ip` is nonempty before generating the certificate (`echo "$reader_wifi_ip"`). Certificate files live in ignored `.certs/`, outside Vite's served directories. Keep `reader-key.pem` and especially mkcert’s `rootCA-key.pem` private; transfer **only** `reader-rootCA.crt`. The CA can issue certificates trusted by your devices. The [mkcert documentation](https://github.com/FiloSottile/mkcert) explains local/mobile certificate trust.

On an iPhone/iPad:

1. AirDrop `.certs/reader-rootCA.crt` to your phone and accept it.
2. In Settings, open **Profile Downloaded** (or General → VPN & Device Management), select the certificate profile, and install it with your passcode.
3. Go to **Settings → General → About → Certificate Trust Settings** and enable full trust for this mkcert root. Verify its name matches your Mac’s generated CA. See [Apple’s certificate trust instructions](https://support.apple.com/en-us/102390).
4. Open the HTTPS URL below in Safari. It must load normally, without a certificate warning. If it warns, fix CA trust, device time, or the certificate’s IP before continuing. Bypassing a warning is not the test solution.

On Android, transfer the same root certificate privately and install it as a **CA certificate** in the device’s security/credential settings; labels vary by manufacturer and managed devices can prohibit it. Check your device’s certificate-installation instructions. Use a browser that trusts the installed user CA. If a warning remains, resolve trust before testing.

Terminal 1, from the repository root:

```sh
cd backend
uv sync --locked
uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Terminal 2, from the repository root:

```sh
cd frontend
npm ci
npm run build
npm run preview:https
```

On your phone’s same Wi-Fi, open **`https://<MAC_WIFI_IP>:4173`**. Preview reads `.certs/reader.pem` and `.certs/reader-key.pem`; missing files fail startup clearly. Only frontend HTTPS is exposed. API and audio requests stay relative to this origin and proxy to FastAPI. Voicebox is required only to generate new audio.

Keep this **exact origin** (scheme, IP/hostname and port) stable. A DHCP reservation for the Mac helps. If its IP changes, regenerate the certificate with the new address; browser downloads at the old origin will not appear at the new one. Development `:5173`, HTTP preview, HTTPS preview and another browser have separate storage. Install first, then download inside the installed app; some platforms isolate installed-app storage from browser tabs.

`mkcert` was not installed in the inspected workspace environment, so certificate generation/trust and actual phone HTTPS installation are manual steps. No system trust settings or certificates were changed automatically. You can remove the test CA/profile later in device settings; `mkcert -uninstall` removes its Mac trust. Do not remove trust while you still need this HTTPS test origin.

## Laptop-only production check

```sh
cd frontend
npm run build
npm run preview
```

Open `http://127.0.0.1:4173` on the Mac. Loopback is a secure-origin exception, so this can test service workers. It does not prove phone HTTPS trust or installation. Preview now proxies `/api` to the existing loopback backend. Do not run the development server on the production preview port, where an installed production worker would control the origin.

## Installation and airplane-mode checklist

1. Open the trusted HTTPS production URL online. Expand **Install / offline setup** and wait for **Offline app shell ready**. If setup fails, check HTTPS trust, browser storage permissions, available space and connection.
2. In Safari on iPhone/iPad, use Share → **Add to Home Screen** and enable **Open as Web App** if offered. In supported Android/desktop browsers, use their **Install app** or **Add to Home screen** menu. Prompts and menu labels vary; the reader does not promise an automatic install prompt.
3. Open the installed app. While connected to the laptop, browse a book, select a chapter/voice/model, and generate it if needed. Choose a ready saved audio version and click **Download for offline**. Wait for **Available offline** and its size/version. Nothing downloads the entire library automatically.
4. Open **Device downloads** and the downloaded chapter. Confirm the text is complete. Load it into the player, seek forward and backward, change speed, play briefly, then pause. The player should say **On device**. Request persistent device storage if desired; permission is not guaranteed.
5. Close the app completely. Enable airplane mode **and make sure Wi-Fi is off**, then reopen the installed app. The shell and Device downloads should open without the laptop. Read the saved text and resume the exact audio version/offset/speed without unwanted autoplay. Press Play and test seeking again. Undownloaded content must be clearly unavailable.
6. Try previous/next downloaded reading links and player chapter controls. Reading links browse downloaded versions; automatic audio continuation follows the next section in the book and stops with an explanation if that section is not downloaded for the voice/model. It never silently skips a missing section or generates audio offline.
7. Rewind intentionally, play/pause, then close/reopen offline. Confirm the rewind was saved rather than replaced by the furthest position. Rotate the phone and check controls/safe areas; test backgrounding and screen lock separately. Uninterrupted lock-screen playback is not promised.
8. Reconnect to Wi-Fi with the laptop servers running. Bring the app to the foreground. Pending progress should sync without background-sync support. For differing audio-version conflicts, explicitly choose device or server position. The current player never jumps during sync; reload the desired chapter to restore a chosen saved position.
9. Remove one device download. Its device library entry disappears and it is no longer available after reopening offline. Server book/chapter audio must remain available. A currently loaded Blob may finish playing from memory until you switch/reload; removal clears persistent storage only. Listening progress is retained independently.
10. Simulate a failed/interrupted download (disconnect mid-transfer or close the app). It must not appear Ready; reconnect and retry. Remove downloads to free space after quota errors. If site storage is cleared/evicted, reconnect and download again.
11. Build a changed frontend while the app is open, then foreground the app. When **Update available** appears, confirm playback is not reloaded. Finish listening, close **all** reader tabs/windows for this origin, then reopen to activate the update. Downloads/progress remain in IndexedDB. This deliberately avoids a forced update button that could interrupt another tab’s player.

## Progress rules and device limitations

- Every listening edit is saved locally first, with exact book/section/audio version, seconds offset, speed, and a monotonically increasing device edit timestamp. Saves run periodically during playback, on pause/seek/speed change, and best-effort when hidden/leaving. Force quit or power loss can prevent the final asynchronous save.
- Pending edits retry when online, on foreground entry, every 30 seconds while visible, and with **Retry sync**. Network or server errors leave the local position pending; foreground retry is required if the browser suspends timers.
- For the **same audio version**, the newer edit timestamp wins; ties use the server result. A newer rewind wins over an older later position. Offsets are never compared to choose a winner. Keep device clocks reasonably synchronized; wall-clock skew can bias cross-device ordering.
- A response cannot overwrite an edit made locally after that request began. An intentional switch from a previously synchronized chapter/version can sync normally if the server has not advanced since that baseline. If the server independently points to a different version, the app holds the conflict for **Keep device position** / **Use server position**. No offset is transferred between versions. If the server has lost that version, local playback still works and sync remains pending with an error.
- Sync does not change the loaded player or force seeking. Version replacement on the server never mutates a downloaded version; versions remain separately identified. Server-generated books are the backup, not the device cache.
- IndexedDB stores chapter text/metadata and WAV Blobs. Object URLs allow the browser’s media engine to seek within local WAV data without networking or a range-response service-worker workaround. Large WAVs consume substantial storage; expected size is checked when known, and failed/quota-aborted transactions never publish Ready.
- Browser storage is origin-specific and may be evicted or cleared, including the entire offline shell. Missing chapter assets are detected when opened and require redownload. If all site data is removed, the app cannot cold-start offline until you reconnect. Private browsing, storage restrictions and platform policy may limit persistence. See [browser quotas and eviction](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria).
- This is private testing, not hosting. There is no direct Kokoro integration, cloud storage, public deployment, or background whole-library download.

## Automated verification

From `frontend/`:

```sh
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

The browser test starts a temporary loopback production preview on port 4175 with synthetic metadata and a silent PCM WAV served by mocked API routes. Unit tests use fake IndexedDB and network mocks. Tests never generate speech or modify your server library. Playwright installs its own testing browser; its bundled media tooling is not a backend audio-processing dependency.

Run `uv run pytest` from `backend/` for the existing generation/cache/assembly/restart/progress tests. Automated results are recorded in README. Actual phone installation, certificate trust, iOS/Android storage retention, audible speech, airplane mode, and screen lock require the manual checklist above.


**Recorded result (2026-09-13):** 31 unit/DOM tests, 5 Chromium browser tests, 58 backend tests and the production build passed. The Chromium suite verified fresh-process offline startup, downloaded text and native WAV seeking, pause/speed/resume, reconnect synchronization, failed-download retry, removal, and update waiting/activation with downloaded data retained. Offline-page horizontal-overflow checks passed at 320, 390, 430 and 1280 CSS pixels; mobile/desktop screenshots were reviewed. These are simulated offline tests on the Mac, not tests of an installed phone app. Certificate trust setup was not performed automatically.

## Download and player regression checklist

1. With the trusted HTTPS production preview running, download chapters 1, 2 and 4 of a book with at least four sections. Leave chapter 3 undownloaded. During a larger download, verify received bytes increase, navigate to another screen, and confirm activity remains visible. Known totals show a percentage; without a Content-Length the bar is indeterminate. Wait through verification/saving until Available offline.
2. Interrupt one transfer by disconnecting. It must not become Available offline. Reconnect and retry from Device downloads. Closing the app during transfer requires the same explicit retry. Removing a device copy must leave the server version intact.
3. Close every reader tab/window to activate the updated service worker. Reopen online once, then fully close the installed app, enable airplane mode and reopen. Load chapter 1 from Device downloads. Its text and audio must work without the laptop.
4. While paused, use the player's Next control: both text and playing label should become chapter 2, still paused. Next again must explain that chapter 3 is not downloaded and retain chapter 2. Previous returns to chapter 1. The selector can explicitly jump to chapter 4 across the gap.
5. Seek chapter 1 to a recognizable position and change speed. Switch to chapter 2 and back: chapter 1 should restore its own position/speed. Repeat while playing and verify playback continues on selection (or a browser rejection asks you to press Play). Pause, refresh/reopen, and verify passive resume without autoplay.
6. Open another chapter's text without loading its audio: player labels must still identify the actual playing audio. Tap its title to reveal the complete chapter/book/voice/version. Test long titles, rotation, and 320–430 CSS-pixel widths; controls should remain usable without horizontal overflow.
7. For a developer eviction test, use browser storage tools to delete one audio Blob from IndexedDB while retaining its downloads entry. Select that version: expect an unavailable error, its removal from the available selector, and the previous audio retained. Reconnect and explicitly download it again.
8. Reconnect/foreground and check pending progress synchronization. Backgrounding, screen lock, audio output and retention on your actual phone remain device-specific manual tests. No uninterrupted lock-screen playback is promised.

Local history now retains positions for previously selected audio versions; the server still synchronizes one latest position per book. No offset is copied to a regenerated audio version. The additive browser storage upgrade preserves prior downloads; close other old reader windows if an upgrade is blocked.

Follow-up verification: stream tests cover known/unknown totals, partial transfer failure and retry. The multi-chapter Chromium test covers adjacent chapters, gaps, exact local text, per-version position/speed, playing/paused selection, rejected playback, missing Blobs and long titles. These use synthetic audio and simulated offline conditions, not an installed phone in airplane mode.

## 5B.1 batch checks on a phone

Use the private HTTPS startup and update steps above. In a book, expand Chapter audio → Whole book audio. Generate all uses the selected voice/model. Download all available audio snapshots only currently ready versions; Download audiobook appears when every section is ready.

Download a chapter individually first, then start the book download. Confirm it is skipped and progress remains visible after navigation. Expand the global batch summary for known remaining size, per-chapter errors, cancellation and Continue download. Cancel after the current chapter, reopen and continue: completed copies should not transfer again. Closing mid-file requires that file to restart on Continue.

Generate another chapter during a partial download: it must not enter the existing plan automatically. A subsequent explicit book download action picks it up. Regenerated versions are saved separately and old copies remain. Finish downloading before airplane-mode cold-start, seeking, speed, resume and reconnect checks. Actual phone suspension, memory/storage limits and lock-screen behavior are not verified by desktop Chromium automation.

5B.1 automated result: 62 backend tests, 39 frontend tests, six production Chromium tests and the build passed. The added browser case verifies the whole-book controls, reuse of an individually downloaded copy, a fixed ready-version snapshot across navigation, a later batch picking up newly ready audio, and offline playback at 320 CSS pixels. This is mocked API/synthetic WAV testing on the laptop, not actual phone airplane-mode testing.
