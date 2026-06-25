# Prebuilt artifacts

- `app-debug.apk` — debug build of the Android shell (targetSdk 28). Sideload to a
  Pixel; runs in external-broker mode until the on-device proot bootstrap is
  provisioned. Rebuild with `cd ../android && ./gradlew assembleDebug`.
