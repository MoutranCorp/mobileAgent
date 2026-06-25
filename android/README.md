# Android shell

The Kotlin/Jetpack-Compose app (Phase 2 + Phase 3). It owns the Android plumbing
that the broker can't — the foreground service, wake lock, battery-optimization
exemption, proot/broker launch, and Keystore secret injection — and hosts the
agent UI.

> **Build setting that matters most:** `targetSdk 28`. API 29+ forbids `execve()`
> on files in the app's writable data dir (W^X). Targeting 28 keeps classic
> exec-from-data-dir so the bundled Termux bootstrap + proot can launch — even on
> Android 16. `compileSdk` is 34 (Compose needs it); AGP allows target < compile.

## WebView ↔ native bridge

A WebView is not a full browser, so the web UI feature-detects a native bridge
(`window.AndroidAgent`, injected by [`WebAppBridge`](app/src/main/java/com/ondevice/agent/ui/WebAppBridge.kt))
and routes the things a WebView can't do to Kotlin, with web-API fallbacks on
desktop:

| Web UI feature | In a WebView | Native bridge |
|---|---|---|
| `confirm()` / `alert()` | suppressed → would silently cancel | `onJsConfirm`/`onJsAlert` → native `AlertDialog` |
| Image attach (📎) | `<input type=file>` does nothing | `pickImage()` → system picker → base64 → `onPickedImage` |
| Export to Markdown | `blob:` download doesn't fire | `saveFile()` → `FileProvider` share sheet |
| Voice input (🎤) | Web Speech API unavailable | `startVoice()` → `SpeechRecognizer` → `onVoiceResult` |
| Turn notifications | Web Notifications unavailable | `notify()` → Android notification |
| Command palette | `Ctrl-K` (no key on touch) | the ⌘ button in the top bar |

The activity uses `windowSoftInputMode="adjustResize"` so the soft keyboard
doesn't cover the composer. Adds `RECORD_AUDIO` (voice) and a `FileProvider`
(export sharing).

## UI architecture

A native Compose shell with two tabs:

- **Agent** — hosts the broker's web UI (the verified canonical-protocol client)
  in a `WebView`. `exp://` / `intent://` navigations are launched as external
  intents, which is how the **Test** button deep-links into the Expo dev client
  on the same phone. (The broker is UI-agnostic; this reuses the tested web UI
  rather than reimplementing tool cards/diffs/approvals natively — the plan's
  blessed fast path.)
- **Runtime** — start/stop the service, request the battery exemption, set the
  broker URL, pick the default engine profile, manage Keystore-encrypted provider
  secrets, and watch live runtime logs.

## Build

Requires JDK 17 + an Android SDK (platform `android-34`, build-tools). The Gradle
wrapper is committed, so:

```bash
# Create local.properties with the SDK path (Android Studio writes this for you):
echo "sdk.dir=/path/to/Android/sdk" > local.properties
# Accept SDK licenses once: <sdk>/cmdline-tools/latest/bin/sdkmanager --licenses

./gradlew assembleDebug      # → app/build/outputs/apk/debug/app-debug.apk (~16 MB)
./gradlew lintDebug          # passes (targetSdk-28 + battery-exemption lint disabled — intentional)
./gradlew installDebug       # sideload to a connected device (adb)
```

> **Verified:** the project compiles to a debug APK and passes lint with the SDK
> at `compileSdk 34` / `targetSdk 28`. (Android Studio: File ▸ Open this folder ▸
> Run ▶ also works.)

## First run

The app installs and launches with **no bootstrap** present and runs in
*external-broker mode* — perfect for trying the full UI immediately:

1. Run the broker on your computer: `cd ../broker && npm run dev`
2. `adb reverse tcp:8765 tcp:8765`
3. In the app, open the **Agent** tab and tap **Load agent UI anyway**.

For the real on-device runtime, provision proot + the broker (see
[`../provisioning`](../provisioning)) and drop the bootstrap tarball into
`app/src/main/assets/` (see [`app/src/main/assets/README.md`](app/src/main/assets/README.md)).

## Key files

```
app/src/main/
  AndroidManifest.xml                      targetSdk 28, FGS + wakelock + battery perms
  java/com/ondevice/agent/
    MainActivity.kt                        Compose host + MainActions impl
    RuntimeConfig.kt                       broker URL / profile prefs
    service/
      AgentForegroundService.kt            FGS + partial wake lock + sticky restart
      RuntimeLauncher.kt                   launches proot + broker, streams logs, health poll
      BootstrapManager.kt                  userland extraction + script staging
      RuntimeController.kt                 observable runtime state for the UI
    net/BrokerHealth.kt                    HTTP health probe
    secrets/KeystoreSecrets.kt             AES/GCM in AndroidKeyStore → env injection
    ui/  MainScreen.kt · AgentWebView.kt · Theme.kt
  assets/  scripts/ · README (bootstrap placeholder)
```
