# Prebuilt artifacts

- `app-debug.apk` — self-contained debug build of the Android shell (targetSdk 28).
  It bundles proot, downloads/provisions the Debian guest on first launch, and
  should not require `adb reverse` on a fresh phone. Rebuild with
  `cd ../android && ./gradlew :app:assembleDebug`, copy the output back here, and
  verify it with `jar tf app-debug.apk | grep 'assets/proot-aarch64/proot'` (or
  PowerShell `jar tf app-debug.apk | Select-String 'assets/proot-aarch64/proot'`).
