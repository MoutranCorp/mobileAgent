package com.ondevice.agent.service

import android.content.Context
import java.io.File

/**
 * Manages the Termux/proot userland that lives in the app's private data dir.
 *
 * The heavy bootstrap (the arm64 Termux bootstrap tarball + the Debian guest) is
 * provisioned by the scripts under /provisioning. This class is the on-device
 * coordinator: it knows where things live, copies the provisioning scripts out
 * of assets on first run, and reports whether the userland is ready.
 *
 * NOTE: the prebuilt bootstrap tarball is a large binary asset that must be
 * dropped into `app/src/main/assets/bootstrap-aarch64.tar.gz` (see
 * provisioning/README.md). Until it is present, the app runs in
 * BOOTSTRAP_MISSING state and the UI can still drive an external broker (e.g.
 * one on a laptop reached via `adb reverse`).
 */
class BootstrapManager(private val ctx: Context) {

    val rootDir: File get() = File(ctx.filesDir, "runtime")
    val usrDir: File get() = File(rootDir, "usr")
    val scriptsDir: File get() = File(rootDir, "scripts")
    private val marker: File get() = File(rootDir, ".bootstrap_ok")

    /** The proot-distro launcher inside the extracted bootstrap. */
    val prootDistro: File get() = File(usrDir, "bin/proot-distro")

    /** True once the userland + Debian guest + broker have been provisioned. */
    fun isReady(): Boolean = marker.exists()

    /** Is the raw Termux bootstrap (not the Debian guest) extracted? */
    fun isBootstrapExtracted(): Boolean = File(usrDir, "bin").exists()

    /** Is a bootstrap tarball bundled in assets? (Placeholder check.) */
    fun hasBundledBootstrap(): Boolean =
        runCatching { ctx.assets.list("")?.any { it.startsWith("bootstrap-") } == true }
            .getOrDefault(false)

    /** Copy provisioning scripts shipped in assets/scripts into the runtime dir. */
    fun installScripts() {
        scriptsDir.mkdirs()
        val names = runCatching { ctx.assets.list("scripts") }.getOrNull() ?: return
        for (name in names) {
            val out = File(scriptsDir, name)
            ctx.assets.open("scripts/$name").use { input ->
                out.outputStream().use { input.copyTo(it) }
            }
            out.setExecutable(true, false)
        }
    }

    /**
     * Extract the bundled bootstrap tarball using the platform's toybox `tar`.
     * toybox `tar` transparently handles .tar and .tar.gz, but NOT .xz/.zst — so
     * only those are accepted here (use a .gz bootstrap; see assets/README.md).
     */
    fun extractBootstrap(onLog: (String) -> Unit): Boolean {
        val asset = runCatching { ctx.assets.list("") }
            .getOrNull()?.firstOrNull { it.startsWith("bootstrap-") } ?: return false
        if (asset.endsWith(".xz") || asset.endsWith(".zst")) {
            onLog("ERROR: $asset uses xz/zstd which the on-device toybox tar can't decompress. Ship a .tar.gz bootstrap instead.")
            return false
        }
        usrDir.mkdirs()
        val tmp = File(rootDir, asset)
        ctx.assets.open(asset).use { input -> tmp.outputStream().use { input.copyTo(it) } }
        onLog("Extracting $asset …")
        val tar = firstExisting("/system/bin/tar", "/system/xbin/tar") ?: run {
            onLog("ERROR: no system tar available to extract bootstrap")
            return false
        }
        // 'z' forces gzip; toybox also auto-detects, but being explicit is clearer.
        val flags = if (asset.endsWith(".gz") || asset.endsWith(".tgz")) "xzf" else "xf"
        val pb = ProcessBuilder(tar, flags, tmp.absolutePath, "-C", usrDir.absolutePath)
            .redirectErrorStream(true)
        val proc = pb.start()
        proc.inputStream.bufferedReader().forEachLine(onLog)
        val ok = proc.waitFor() == 0
        tmp.delete()
        if (ok) onLog("Bootstrap extracted to ${usrDir.absolutePath}")
        return ok
    }

    fun markReady() {
        rootDir.mkdirs()
        marker.writeText("ok")
    }

    private fun firstExisting(vararg paths: String): String? = paths.firstOrNull { File(it).exists() }
}
