// Root build file. Plugin versions are pinned to a known-good combination so the
// project builds without surprises: AGP 8.5.x + Kotlin 1.9.24 + Compose compiler 1.5.14.
plugins {
    id("com.android.application") version "8.5.2" apply false
    id("org.jetbrains.kotlin.android") version "1.9.24" apply false
}
