package com.ondevice.agent.service

import android.content.Context
import android.os.Build
import android.system.Os
import com.ondevice.agent.RuntimeConfig
import com.ondevice.agent.secrets.KeystoreSecrets
import okhttp3.OkHttpClient
import okhttp3.Request
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.apache.commons.compress.compressors.xz.XZCompressorInputStream
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
    private val brokerSourceMarker: File get() = File(rootDir, ".broker_source")

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
    // Version-stamp the markers so a stale/incomplete extraction (e.g. one written
    // by an older build whose tar dropped hardlinks) is discarded on install-over —
    // app data survives a reinstall, so a bare exists() check would reuse a broken
    // rootfs. Bump ROOTFS_VERSION whenever the extraction logic changes.
    fun isRootfsReady(): Boolean = runCatching { rootfsMarker.readText().trim() == ROOTFS_VERSION }.getOrDefault(false)
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

    /** Download the Debian arm64 rootfs (.tar.xz) and extract it in pure Java. */
    fun downloadAndExtractRootfs(log: (String) -> Unit): Boolean {
        rootfs.mkdirs(); tmpDir.mkdirs()
        val xzFile = File(rootDir, "rootfs.tar.xz")
        // Cache the download so a failed extraction retry skips the ~90MB fetch.
        if (!xzFile.exists()) {
            val url = resolveRootfsUrl(log) ?: run { log("ERROR: could not resolve a Debian rootfs URL"); return false }
            log("Downloading Debian rootfs…")
            if (!download(url, xzFile, log)) { log("ERROR: rootfs download failed"); xzFile.delete(); return false }
        } else {
            log("Reusing cached rootfs.tar.xz from a previous attempt")
        }

        log("Extracting rootfs…")
        // Pure-Java extraction (commons-compress) instead of system/toybox tar:
        //  - toybox tar can't decompress xz, and
        //  - more importantly, Android blocks hardlinks (link(2)) in app storage, so
        //    a real tar dies on the many hardlinked binaries (perl, coreutils, …).
        // We stream the .tar.xz, turn every hardlink into a relative symlink, skip
        // device nodes (the linuxcontainers image has none), and preserve perms.
        // No fake-root/proot needed: there are no device nodes to mknod and we fake
        // uid 0 at run time.
        val extracted = runCatching { extractTarXz(xzFile, rootfs, log) }
            .onFailure { log("ERROR: rootfs extract: ${it.message}") }
            .getOrDefault(false) &&
            (File(rootfs, "bin/bash").exists() || File(rootfs, "usr/bin/bash").exists() || File(rootfs, "bin/sh").exists())
        if (!extracted) { log("ERROR: rootfs extraction failed (no shell found)"); return false }
        xzFile.delete()
        writeGuestConfig()
        rootfsMarker.writeText(ROOTFS_VERSION)
        return true
    }

    /** Stream-extract a .tar.xz into [dest], converting hardlinks→relative symlinks
     *  and skipping device nodes. Returns true if any regular file was written. */
    private fun extractTarXz(xzFile: File, dest: File, log: (String) -> Unit): Boolean {
        var files = 0; var links = 0; var skipped = 0
        TarArchiveInputStream(XZCompressorInputStream(xzFile.inputStream().buffered())).use { tin ->
            while (true) {
                val e = tin.nextTarEntry ?: break
                val name = e.name.removePrefix("./").trimStart('/')
                if (name.isEmpty() || name == ".") continue
                // Guard against path traversal LEXICALLY — reject any '..' component.
                // (Don't use canonicalPath: it resolves symlinks, so legitimate
                // absolute symlinks — systemd masks → /dev/null, alternatives →
                // /usr/bin/*, etc. — would be false-flagged and dropped.)
                if (name.split('/').any { it == ".." }) { log("  skip unsafe path: $name"); skipped++; continue }
                val out = File(dest, name)
                when {
                    e.isDirectory -> out.mkdirs()
                    e.isSymbolicLink -> {
                        out.parentFile?.mkdirs(); out.delete()
                        runCatching { Os.symlink(e.linkName, out.absolutePath) }
                            .onFailure { log("  symlink fail $name -> ${e.linkName}: ${it.message}") }
                        links++
                    }
                    e.isLink -> { // hardlink → relative symlink to the target within the rootfs
                        out.parentFile?.mkdirs(); out.delete()
                        val rel = relativeLink(name, e.linkName.removePrefix("./").trimStart('/'))
                        runCatching { Os.symlink(rel, out.absolutePath) }
                            .onFailure { log("  hardlink fail $name -> $rel: ${it.message}") }
                        links++
                    }
                    e.isCharacterDevice || e.isBlockDevice || e.isFIFO -> skipped++
                    else -> { // regular file
                        out.parentFile?.mkdirs(); out.delete()
                        out.outputStream().buffered().use { o -> tin.copyTo(o) }
                        runCatching { Os.chmod(out.absolutePath, e.mode and 0xFFF) }
                        files++
                    }
                }
            }
        }
        log("  extracted $files files, $links links, skipped $skipped special")
        return files > 0
    }

    /** Relative symlink target from [entryName] (a file) to [targetRootRel] (a path
     *  relative to the rootfs root), e.g. ("usr/bin/perl5.36.0","usr/bin/perl")→"perl". */
    private fun relativeLink(entryName: String, targetRootRel: String): String {
        val fromDir = entryName.trim('/').split("/").dropLast(1)
        val to = targetRootRel.trim('/').split("/")
        var i = 0
        while (i < fromDir.size && i < to.size && fromDir[i] == to[i]) i++
        val rel = (List(fromDir.size - i) { ".." } + to.drop(i)).joinToString("/")
        return rel.ifEmpty { "." }
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

    /** Install the toolchain (apt + Node + Claude CLI + Codex CLI) into the guest. One-time.
     *  Broker SOURCE delivery is separate — see ensureBrokerSource(). */
    fun provision(log: (String) -> Unit): Boolean {
        // Idempotent — ensures the apt-no-sandbox + resolv.conf config is present even
        // on a rootfs extracted by an older build (before that config was written).
        writeGuestConfig(log)
        val script = """
            export DEBIAN_FRONTEND=noninteractive
            set -e
            # -o APT::Sandbox::User=root: apt's download method drops privileges to the
            # `_apt` user via setresuid(2), which proot can't honor — passing it on the
            # command line is belt-and-suspenders alongside /etc/apt/apt.conf.d/99proot.
            APT="apt-get -o APT::Sandbox::User=root -o Acquire::Check-Valid-Until=false"
            ${'$'}APT update -y
            ${'$'}APT install -y curl ca-certificates git xz-utils
            # Node from NodeSource (Debian's is too old for the broker's engines).
            curl -fsSL https://deb.nodesource.com/setup_22.x | bash - || echo "warn: nodesource setup failed, falling back to distro node"
            ${'$'}APT install -y nodejs || ${'$'}APT install -y nodejs npm
            mkdir -p /root/projects
            npm install -g @anthropic-ai/claude-code || echo "warn: claude CLI install failed — install later for the real engine"
            npm install -g @openai/codex || echo "warn: codex CLI install failed - install later for the Codex engine"
            node --version && npm --version
        """.trimIndent()
        val ok = runProcess(prootGuest(script), log)
        if (ok) provisionedMarker.writeText("ok")
        return ok
    }

    /**
     * Deliver the broker SOURCE into the guest as a real **git clone** so the in-app
     * Update (git pull) works for broker + UI. Falls back to the bundled tarball when
     * a clone isn't possible (offline / private repo with no token). Re-runs whenever
     * BROKER_SOURCE_VERSION changes, so an already-provisioned install migrates from a
     * bundled copy to a clone WITHOUT wiping app data or re-downloading the rootfs.
     *
     * Private-repo clone: set a GITHUB_TOKEN (or GIT_TOKEN) secret in Runtime; it's
     * injected into the guest env and stored as a git credential so `git pull` keeps
     * working without baking the token into the remote URL.
     */
    fun ensureBrokerSource(log: (String) -> Unit): Boolean {
        stageBrokerIntoGuest(log) // copy the bundled tarball as the offline fallback
        val ok = runProcess(prootGuest(brokerSourceScript()), log)
        if (ok) brokerSourceMarker.writeText(BROKER_SOURCE_VERSION)
        return ok
    }

    fun isBrokerSourceReady(): Boolean =
        runCatching { brokerSourceMarker.readText().trim() == BROKER_SOURCE_VERSION }.getOrDefault(false)

    private fun brokerSourceScript(): String = """
        set -e
        broker_ok() {
          DIR="${'$'}1"
          [ -f "${'$'}DIR/src/index.js" ] || return 1
          [ -f "${'$'}DIR/package.json" ] || return 1
          ( cd "${'$'}DIR" && node -e 'require("ws")' >/dev/null 2>&1 )
        }
        git config --global --add safe.directory '*' || true
        REPO_URL="${'$'}{BROKER_REPO_URL:-https://github.com/MoutranCorp/mobileAgent.git}"
        TOKEN="${'$'}{GITHUB_TOKEN:-${'$'}{GIT_TOKEN:-}}"
        if [ -n "${'$'}TOKEN" ]; then
          git config --global credential.helper store
          printf 'https://x-access-token:%s@github.com\n' "${'$'}TOKEN" > /root/.git-credentials
          chmod 600 /root/.git-credentials
        fi
        CLONE_OK=0
        rm -rf /root/mobileAgent.new
        if git clone --depth 1 "${'$'}REPO_URL" /root/mobileAgent.new; then
          if grep -q 'mergeBuiltInProfiles' /root/mobileAgent.new/broker/src/profiles.js 2>/dev/null &&
             grep -q 'codex-app-server' /root/mobileAgent.new/broker/src/profiles.js 2>/dev/null; then
            rm -rf /root/mobileAgent; mv /root/mobileAgent.new /root/mobileAgent
            if ( cd /root/mobileAgent/broker && npm install --omit=dev ) && broker_ok /root/mobileAgent/broker; then
              CLONE_OK=1
            else
              echo "cloned broker dependency install failed - using bundled broker"
              rm -rf /root/mobileAgent
            fi
          else
            echo "cloned broker is older than the APK bundle - using bundled broker"
          fi
        fi
        rm -rf /root/mobileAgent.new
        if [ "${'$'}CLONE_OK" = 1 ]; then
          rm -rf /root/agent-broker; rm -f /root/agent-broker.tar.gz
          echo "Broker is a git checkout at /root/mobileAgent — in-app Update (git pull) is live"
        else
          echo "git clone unavailable — using bundled broker (set a GITHUB_TOKEN secret to enable in-app Update on a private repo)"
          if [ -f /root/agent-broker.tar.gz ]; then
            rm -rf /root/agent-broker.new; mkdir -p /root/agent-broker.new
            tar xf /root/agent-broker.tar.gz -C /root/agent-broker.new
            [ -d /root/agent-broker/node_modules ] && mv /root/agent-broker/node_modules /root/agent-broker.new/ 2>/dev/null || true
            rm -rf /root/agent-broker; mv /root/agent-broker.new /root/agent-broker
            rm -f /root/agent-broker.tar.gz
            ( cd /root/agent-broker && npm install --omit=dev )
            rm -rf /root/mobileAgent
          fi
        fi
        if broker_ok /root/mobileAgent/broker || broker_ok /root/agent-broker; then
          exit 0
        fi
        echo "ERROR: broker source is not runnable - missing Node dependencies such as ws"
        exit 1
    """.trimIndent()

    /** Start an interactive command inside the guest in its OWN proot process,
     *  returning the Process so the caller can read stdout and write stdin. Used by
     *  the native Claude sign-in flow (drives `claude setup-token` in a PTY). The
     *  rootfs is shared with the running broker, so credentials it writes to
     *  /root/.claude are picked up by the broker's claude engine on the next turn. */
    fun startGuestCommand(guestScript: String): Process {
        val pb = ProcessBuilder(prootGuest(guestScript)).directory(rootDir).redirectErrorStream(true)
        applyEnv(pb.environment())
        return pb.start()
    }

    /** Copy the bundled broker tarball straight into the guest's /root (host-side). */
    private fun stageBrokerIntoGuest(log: (String) -> Unit) {
        val name = runCatching { ctx.assets.list("")?.firstOrNull { it.startsWith("broker.tar") } }.getOrNull() ?: return
        val out = File(rootfs, "root/agent-broker.tar.gz")
        out.parentFile?.mkdirs()
        ctx.assets.open(name).use { i -> out.outputStream().use { i.copyTo(it) } }
        log("Bundled broker staged into the guest (fallback seed)")
    }

    /** Where the broker runs from: the git checkout if present, else the bundled copy. */
    private fun brokerGuestDir(): String =
        if (
            File(rootfs, "root/mobileAgent/broker/src/index.js").exists() &&
            File(rootfs, "root/mobileAgent/broker/node_modules/ws/package.json").exists()
        ) "/root/mobileAgent/broker" else "/root/agent-broker"

    /** Argv to start the broker under proot. */
    fun brokerArgv(): List<String> = prootGuest(
        "cd ${brokerGuestDir()} && exec node src/index.js " +
            "--profile ${RuntimeConfig.defaultProfile(ctx)} --port ${RuntimeConfig.DEFAULT_PORT} --projects /root/projects --host 127.0.0.1"
    )

    // ---- proot command construction --------------------------------------

    /** proot base flags — mirrors proot-distro (which runs fine on this device).
     *  We deliberately keep seccomp acceleration ON: disabling it (PROOT_NO_SECCOMP)
     *  forces proot to ptrace-emulate every syscall, which returned ENOSYS for some
     *  reads (e.g. /proc/sys/crypto/fips_enabled, breaking libgcrypt/apt). */
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
        ensureFakeProc()
        val fake = fakeProcDir.absolutePath
        val candidates = listOf(
            "/dev", "/proc", "/sys",
            "/dev/urandom:/dev/random",
            "/proc/self/fd:/dev/fd",
            "/proc/self/fd/0:/dev/stdin",
            "/proc/self/fd/1:/dev/stdout",
            "/proc/self/fd/2:/dev/stderr",
            "/sdcard", "/storage",
            "${rootfs.absolutePath}/tmp:/dev/shm",
            // Fake /proc entries Android's kernel doesn't expose. Bound AFTER /proc so
            // they override. Critically, libgcrypt (gpgv + apt's http hash check) reads
            // /proc/sys/crypto/fips_enabled and FATALs on ENOSYS, aborting apt with
            // SIGABRT; the rest mirror proot-distro so other tools don't choke.
            "$fake/fips_enabled:/proc/sys/crypto/fips_enabled",
            "$fake/cap_last_cap:/proc/sys/kernel/cap_last_cap",
            "$fake/loadavg:/proc/loadavg",
            "$fake/stat:/proc/stat",
            "$fake/uptime:/proc/uptime",
            "$fake/version:/proc/version",
            "$fake/vmstat:/proc/vmstat",
        )
        return candidates.filter { val host = it.substringBefore(":"); File(host).exists() }
    }

    private val fakeProcDir: File get() = File(rootDir, "fakeproc")

    /** Write the fake /proc files bound into the guest (idempotent). */
    private fun ensureFakeProc() {
        val d = fakeProcDir
        if (!d.exists()) d.mkdirs()
        fun w(name: String, body: String) { val f = File(d, name); if (!f.exists()) runCatching { f.writeText(body) } }
        w("fips_enabled", "0\n")
        w("cap_last_cap", "40\n")
        w("loadavg", "0.10 0.20 0.15 1/100 1000\n")
        w("stat", "cpu  0 0 0 0 0 0 0 0 0 0 0 0\nbtime 1700000000\n")
        w("uptime", "100.00 100.00\n")
        w("version", "Linux version 6.2.0 (proot) #1 SMP PREEMPT\n")
        w("vmstat", "nr_free_pages 100000\n")
    }

    /** Host env every proot invocation needs (loader, libs, tmp). */
    fun applyEnv(env: MutableMap<String, String>) {
        env["PROOT_LOADER"] = File(prootDir, "libexec/proot/loader").absolutePath
        env["PROOT_LOADER_32"] = File(prootDir, "libexec/proot/loader32").absolutePath
        env["PROOT_TMP_DIR"] = tmpDir.absolutePath
        env["LD_LIBRARY_PATH"] = File(prootDir, "lib").absolutePath
        env["TMPDIR"] = tmpDir.absolutePath
        env["PATH"] = "/system/bin:/system/xbin:${env["PATH"] ?: ""}"
        // NOTE: PROOT_NO_SECCOMP deliberately NOT set — see prootHostBase(). Disabling
        // seccomp made traced reads (e.g. /proc/sys/crypto/fips_enabled) return ENOSYS
        // and crash libgcrypt/apt. proot-distro runs with seccomp on, on this device.
    }

    private fun writeGuestConfig(log: (String) -> Unit = {}) {
        // Each write is INDEPENDENT: in the linuxcontainers image /etc/resolv.conf is
        // a (often dangling) symlink, and File.writeText follows it — a single shared
        // runCatching would let that throw abort the apt-config write that follows.
        // Delete-then-write so a pre-existing symlink can't redirect or block us.
        fun put(rel: String, body: String): Boolean = runCatching {
            val f = File(rootfs, rel)
            f.parentFile?.mkdirs()
            f.delete()
            f.writeText(body)
            true
        }.getOrElse { log("  warn: write $rel failed: ${it.message}"); false }

        put("etc/resolv.conf", "nameserver 8.8.8.8\nnameserver 1.1.1.1\n")
        put("etc/hosts", "127.0.0.1 localhost\n::1 localhost\n")
        // apt's http/https methods drop privileges to the `_apt` user via setresuid(2),
        // which proot can't honor (Operation not permitted) — the download method then
        // dies. Tell apt not to sandbox (proot-distro does the same). Check-Valid-Until
        // off tolerates a clock skewed in the guest.
        val apt = put("etc/apt/apt.conf.d/99proot",
            "APT::Sandbox::User \"root\";\nAcquire::Check-Valid-Until \"false\";\n")
        log(if (apt) "  apt no-sandbox config written" else "  WARN: apt no-sandbox config NOT written")
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

    companion object {
        // Bump when the rootfs extraction logic changes so a stale extraction from an
        // older build is discarded (app data survives install-over).
        private const val ROOTFS_VERSION = "2-symlink-extract"
        // Bump to re-run broker-source delivery (e.g. to migrate an existing bundled
        // install to a git clone) without re-running the toolchain/rootfs steps.
        private const val BROKER_SOURCE_VERSION = "5-engine-start-wait"
    }
}
