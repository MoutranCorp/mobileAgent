package com.ondevice.agent.service

import android.content.Context
import android.os.Build
import com.ondevice.agent.RuntimeConfig
import com.ondevice.agent.secrets.KeystoreSecrets
import okhttp3.OkHttpClient
import okhttp3.Request
import org.tukaani.xz.XZInputStream
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * Option-1 runtime: run the broker inside a Debian guest via a bundled **proot**
 * (no Termux). This is how proot-distro works too, so the Debian environment the
 * broker/Claude/Node/Expo run in is the same — we just own the proot launch.
 *
 * Layout under filesDir/runtime:
 *   proot/proot, proot/libexec/proot/loader(32), proot/lib/   (bundled, staged once)
 *   debian/                                                 (downloaded rootfs)
 *   tmp/                                                    (proot scratch)
 *
 * proot binaries hardcode no app prefix (unlike the stock Termux userland), so
 * they run fine from our data dir under LD_LIBRARY_PATH; targetSdk 28 permits the
 * exec from the data dir.
 */
class ProotRuntime(private val ctx: Context) {

    val rootDir: File get() = File(ctx.filesDir, "runtime")
    private val prootDir: File get() = File(rootDir, "proot")
    val prootBin: File get() = File(prootDir, "proot")
    val rootfs: File get() = File(rootDir, "debian")
    private val tmpDir: File get() = File(rootDir, "tmp")
    private val rootfsMarker: File get() = File(rootDir, ".rootfs_ok")
    private val provisionedMarker: File get() = File(rootDir, ".provisioned")

    private val arch: String = when (Build.SUPPORTED_ABIS.firstOrNull()) {
        "arm64-v8a" -> "aarch64"
        "armeabi-v7a" -> "arm"
        "x86_64" -> "x86_64"
        "x86" -> "i686"
        else -> "aarch64"
    }
    private val assetRoot get() = "proot-$arch"

    private val http by lazy {
        OkHttpClient.Builder()
            .connectTimeout(30, TimeUnit.SECONDS)
            .readTimeout(120, TimeUnit.SECONDS)
            .build()
    }

    // ---- staging ----------------------------------------------------------

    fun hasBundledProot(): Boolean =
        runCatching { ctx.assets.list(assetRoot)?.contains("proot") == true }.getOrDefault(false)

    fun isProotStaged(): Boolean = prootBin.exists()
    fun isRootfsReady(): Boolean = rootfsMarker.exists()
    fun isProvisioned(): Boolean = provisionedMarker.exists()

    /** Recursively copy the proot-arch asset tree into runtime/proot, making binaries executable. */
    fun stageProot(log: (String) -> Unit) {
        log("Staging proot…")
        copyAssetDir(assetRoot, prootDir)
        prootBin.setExecutable(true, false)
        File(prootDir, "libexec/proot/loader").setExecutable(true, false)
        File(prootDir, "libexec/proot/loader32").setExecutable(true, false)
        tmpDir.mkdirs()
    }

    private fun copyAssetDir(assetPath: String, dest: File) {
        val entries = runCatching { ctx.assets.list(assetPath) }.getOrNull() ?: return
        if (entries.isEmpty()) { // a file
            dest.parentFile?.mkdirs()
            ctx.assets.open(assetPath).use { i -> dest.outputStream().use { i.copyTo(it) } }
            return
        }
        dest.mkdirs()
        for (e in entries) copyAssetDir("$assetPath/$e", File(dest, e))
    }

    // ---- rootfs download + extract ---------------------------------------

    /** Download the Debian arm64 rootfs (.tar.xz), xz-decompress, extract under proot. */
    fun downloadAndExtractRootfs(log: (String) -> Unit): Boolean {
        rootfs.mkdirs(); tmpDir.mkdirs()
        val url = resolveRootfsUrl(log) ?: run { log("ERROR: could not resolve a Debian rootfs URL"); return false }
        val xzFile = File(rootDir, "rootfs.tar.xz")
        log("Downloading Debian rootfs…")
        if (!download(url, xzFile, log)) { log("ERROR: rootfs download failed"); return false }

        val tarFile = File(rootDir, "rootfs.tar")
        log("Decompressing rootfs (xz)…")
        runCatching {
            XZInputStream(xzFile.inputStream().buffered()).use { i ->
                tarFile.outputStream().buffered().use { o -> i.copyTo(o) }
            }
        }.onFailure { log("ERROR: xz decompress: ${it.message}"); return false }
        xzFile.delete()

        log("Extracting rootfs (fake-root)…")
        // Extract under proot --root-id so device nodes / chown / setuid succeed
        // without real root; toybox tar does the actual unpacking.
        val tar = firstExisting("/system/bin/tar", "/system/xbin/tar") ?: run { log("ERROR: no system tar"); return false }
        val argv = prootHostBase() + listOf(tar, "-x", "-f", tarFile.absolutePath, "-C", rootfs.absolutePath)
        val ok = runProcess(argv, log)
        tarFile.delete()
        if (!ok) { log("ERROR: rootfs extraction failed"); return false }
        writeGuestConfig()
        rootfsMarker.writeText("ok")
        return true
    }

    /** Find the newest linuxcontainers Debian arm64 build and build its rootfs URL. */
    private fun resolveRootfsUrl(log: (String) -> Unit): String? {
        val lxcArch = if (arch == "aarch64") "arm64" else if (arch == "x86_64") "amd64" else arch
        val index = "https://images.linuxcontainers.org/images/debian/bookworm/$lxcArch/default/"
        return runCatching {
            val html = http.newCall(Request.Builder().url(index).build()).execute().use { it.body?.string() ?: "" }
            val build = Regex("""\d{8}_\d{2}:\d{2}""").findAll(html).map { it.value }.maxOrNull() ?: return null
            "$index${build.replace(":", "%3A")}/rootfs.tar.xz"
        }.onFailure { log("rootfs index error: ${it.message}") }.getOrNull()
    }

    private fun download(url: String, dest: File, log: (String) -> Unit): Boolean = runCatching {
        http.newCall(Request.Builder().url(url).build()).execute().use { resp ->
            if (!resp.isSuccessful) { log("download HTTP ${resp.code}"); return false }
            val total = resp.body?.contentLength() ?: -1L
            var done = 0L; var lastPct = -1
            resp.body!!.byteStream().use { input ->
                dest.outputStream().buffered().use { out ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buf); if (n < 0) break
                        out.write(buf, 0, n); done += n
                        if (total > 0) {
                            val pct = (done * 100 / total).toInt()
                            if (pct >= lastPct + 5) { lastPct = pct; log("  $pct% (${done / 1024 / 1024}MB)") }
                        }
                    }
                }
            }
        }
        true
    }.getOrElse { log("download error: ${it.message}"); false }

    // ---- provisioning + run ----------------------------------------------

    /** Install toolchain + the bundled broker into the guest. One-time. */
    fun provision(log: (String) -> Unit): Boolean {
        stageBrokerIntoGuest(log)
        val script = """
            set -e
            export DEBIAN_FRONTEND=noninteractive
            apt-get update -y
            apt-get install -y curl ca-certificates git xz-utils
            # Node from NodeSource (Debian's is too old for the broker's engines).
            curl -fsSL https://deb.nodesource.com/setup_22.x | bash - || echo "warn: nodesource setup failed, falling back to distro node"
            apt-get install -y nodejs || apt-get install -y nodejs npm
            mkdir -p /root/projects
            if [ -f /root/agent-broker.tar.gz ]; then
              rm -rf /root/agent-broker.new; mkdir -p /root/agent-broker.new
              tar xf /root/agent-broker.tar.gz -C /root/agent-broker.new
              rm -rf /root/agent-broker; mv /root/agent-broker.new /root/agent-broker
              rm -f /root/agent-broker.tar.gz
              cd /root/agent-broker && npm install --omit=dev
            fi
            npm install -g @anthropic-ai/claude-code || echo "warn: claude CLI install failed — install later for the real engine"
            node --version && npm --version
        """.trimIndent()
        val ok = runProcess(prootGuest(script), log)
        if (ok) provisionedMarker.writeText("ok")
        return ok
    }

    /** Copy the bundled broker tarball straight into the guest's /root (host-side). */
    private fun stageBrokerIntoGuest(log: (String) -> Unit) {
        val name = runCatching { ctx.assets.list("")?.firstOrNull { it.startsWith("broker.tar") } }.getOrNull() ?: return
        val out = File(rootfs, "root/agent-broker.tar.gz")
        out.parentFile?.mkdirs()
        ctx.assets.open(name).use { i -> out.outputStream().use { i.copyTo(it) } }
        log("Bundled broker delivered into the guest")
    }

    /** Argv to start the broker under proot. */
    fun brokerArgv(): List<String> = prootGuest(
        "cd /root/agent-broker && exec node src/index.js " +
            "--profile ${RuntimeConfig.defaultProfile(ctx)} --port ${RuntimeConfig.DEFAULT_PORT} --projects /root/projects --host 127.0.0.1"
    )

    // ---- proot command construction --------------------------------------

    /** proot WITHOUT a guest root — to run a host tool (tar) under fake-root. */
    private fun prootHostBase(): List<String> =
        listOf(prootBin.absolutePath, "--kill-on-exit", "--root-id", "--link2symlink")

    /** proot entering the Debian guest, running `sh -lc <script>`. */
    private fun prootGuest(script: String): List<String> {
        val a = prootHostBase().toMutableList()
        a += listOf("-r", rootfs.absolutePath)
        for (b in guestBinds()) a += listOf("-b", b)
        a += listOf("-w", "/root")
        a += listOf(
            "/usr/bin/env", "-i",
            "HOME=/root", "TERM=xterm-256color", "LANG=C.UTF-8",
            "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "TMPDIR=/tmp", "WATCHMAN_DISABLE=1", "EXPO_NO_TELEMETRY=1",
        )
        for ((k, v) in KeystoreSecrets(ctx).all()) a += "$k=$v"
        a += listOf("/bin/sh", "-lc", script)
        return a
    }

    /** Host:guest binds, mirroring the essentials proot-distro sets. Only existing hosts. */
    private fun guestBinds(): List<String> {
        File(rootfs, "tmp").mkdirs()
        val candidates = listOf(
            "/dev", "/proc", "/sys",
            "/dev/urandom:/dev/random",
            "/proc/self/fd:/dev/fd",
            "/proc/self/fd/0:/dev/stdin",
            "/proc/self/fd/1:/dev/stdout",
            "/proc/self/fd/2:/dev/stderr",
            "/sdcard", "/storage",
            "${rootfs.absolutePath}/tmp:/dev/shm",
        )
        return candidates.filter { val host = it.substringBefore(":"); File(host).exists() }
    }

    /** Host env every proot invocation needs (loader, libs, tmp). */
    fun applyEnv(env: MutableMap<String, String>) {
        env["PROOT_LOADER"] = File(prootDir, "libexec/proot/loader").absolutePath
        env["PROOT_LOADER_32"] = File(prootDir, "libexec/proot/loader32").absolutePath
        env["PROOT_TMP_DIR"] = tmpDir.absolutePath
        env["LD_LIBRARY_PATH"] = File(prootDir, "lib").absolutePath
        env["TMPDIR"] = tmpDir.absolutePath
        env["PATH"] = "/system/bin:/system/xbin:${env["PATH"] ?: ""}"
        env["PROOT_NO_SECCOMP"] = "1" // some devices' seccomp breaks proot; safe default
    }

    private fun writeGuestConfig() {
        runCatching {
            File(rootfs, "etc").mkdirs()
            File(rootfs, "etc/resolv.conf").writeText("nameserver 8.8.8.8\nnameserver 1.1.1.1\n")
            File(rootfs, "etc/hosts").writeText("127.0.0.1 localhost\n::1 localhost\n")
        }
    }

    // ---- process helper ---------------------------------------------------

    /** Run a process with proot env applied, streaming output to log; returns exit==0. */
    fun runProcess(argv: List<String>, log: (String) -> Unit): Boolean = runCatching {
        val pb = ProcessBuilder(argv).directory(rootDir).redirectErrorStream(true)
        applyEnv(pb.environment())
        val p = pb.start()
        p.inputStream.bufferedReader().forEachLine(log)
        p.waitFor() == 0
    }.getOrElse { log("process error: ${it.message}"); false }

    private fun firstExisting(vararg paths: String): String? = paths.firstOrNull { File(it).exists() }
}
