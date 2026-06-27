plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.ondevice.agent"
    // Compile against a modern SDK (Compose needs it) ...
    compileSdk = 34

    defaultConfig {
        applicationId = "com.ondevice.agent"
        minSdk = 26
        // ... but TARGET 28 on purpose: API 29+ enforces W^X (no execve() on files
        // in the app's writable data dir). targetSdk 28 keeps classic exec-from-data-dir
        // so the bundled Termux bootstrap + proot can launch. This is the single most
        // important build setting in the whole project (plan decision #2).
        targetSdk = 28
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
        debug {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    composeOptions {
        kotlinCompilerExtensionVersion = "1.5.14"
    }
    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
        // The bundled bootstrap tarball must NOT be compressed by aapt, or extraction
        // (and exec of native binaries) breaks.
        jniLibs.useLegacyPackaging = true
    }
    // NOTE: aapt2 gunzips `.gz` assets at package time (stripping the suffix), so the
    // bundled bootstrap/broker ship as plain `.tar`. We DELIBERATELY do NOT noCompress
    // "tar" here: the tarballs are extracted to disk before use (never mmap'd/exec'd
    // in place), so letting the zip DEFLATE them roughly halves the APK. Keep gz/xz/zst
    // listed so any future already-compressed payload isn't re-deflated.
    androidResources {
        noCompress += listOf("gz", "xz", "zst")
    }
    lint {
        // These lint "issues" are deliberate, documented decisions for a PERSONAL
        // SIDELOAD (not a Play Store app), so they are not errors here:
        //  - ExpiredTargetSdkVersion: targetSdk 28 is intentional — API 29+ forbids
        //    execve() from the app's writable data dir (W^X), which would break the
        //    bundled Termux bootstrap + proot (plan decision #2). Play's min-target
        //    rule doesn't apply to a sideload.
        //  - BatteryLife: the battery-optimization exemption is required so the
        //    foreground service + Metro survive Doze when you switch to the dev
        //    client to test (the plan's single most important piece of plumbing).
        disable += setOf("ExpiredTargetSdkVersion", "BatteryLife")
    }
}

// Bundle the broker SOURCE into assets as broker.tar.gz so the app can deliver it
// into the Debian guest with no separate repo/clone (node_modules are installed
// on-device by setup-guest.sh — the auto-provision route). Regenerated every build
// from ../broker; the artifact is gitignored.
val stageBroker by tasks.registering(Tar::class) {
    archiveFileName.set("broker.tar.gz")
    destinationDirectory.set(layout.projectDirectory.dir("src/main/assets"))
    compression = Compression.GZIP
    from(rootProject.layout.projectDirectory.dir("../broker")) {
        exclude("node_modules", "test", ".uishots", ".uitmp", "coverage", "**/*.log", ".uitmp/**")
    }
}
tasks.named("preBuild") { dependsOn(stageBroker) }

dependencies {
    // BOM 2024.06.00 (Compose 1.6.8) is solidly compatible with Kotlin 1.9.24 +
    // compose compiler 1.5.14. Nothing here needs Compose 1.7.
    val composeBom = platform("androidx.compose:compose-bom:2024.06.00")
    implementation(composeBom)

    implementation("androidx.core:core-ktx:1.13.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")
    implementation("androidx.activity:activity-compose:1.9.2")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.5")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.5")

    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    // material-icons-extended is intentionally NOT included: it adds ~40 MB to the
    // dex (every Material icon as a class) and the app uses none of them.

    // Lightweight WebSocket + HTTP for the native status client and health checks.
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    // Pure-Java XZ decompressor for the downloaded Debian rootfs (.tar.xz) — the
    // on-device toybox tar can't do xz.
    implementation("org.tukaani:xz:1.9")

    debugImplementation("androidx.compose.ui:ui-tooling")
}
