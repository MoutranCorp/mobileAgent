package com.ondevice.agent.service

import android.content.Context
import com.ondevice.agent.RuntimeConfig
import com.ondevice.agent.net.BrokerHealth
import com.ondevice.agent.secrets.KeystoreSecrets
import java.io.File

/**
 * Launches and supervises the proot + Node broker process from the foreground
 * service. Streams all output into RuntimeController.logs and flips the runtime
 * state to RUNNING once the broker answers an HTTP health check.
 */
class RuntimeLauncher(private val ctx: Context) {

    @Volatile private var process: Process? = null
    @Volatile private var pumpThread: Thread? = null
    @Volatile private var pollThread: Thread? = null
    @Volatile private var polling = false

    fun launch() {
        RuntimeController.setState(RuntimeState.STARTING, "Preparing runtime…")
        val bm = BootstrapManager(ctx)
        runCatching { bm.installScripts() }

        if (!bm.isBootstrapExtracted()) {
            if (!bm.hasBundledBootstrap()) {
                RuntimeController.setState(
                    RuntimeState.BOOTSTRAP_MISSING,
                    "No on-device bootstrap. Provision it (see provisioning/README) or point the UI at an external broker."
                )
                RuntimeController.log("[runtime] bootstrap not present — running in external-broker mode")
                // Still poll: a dev may have started a broker via `adb reverse`.
                pollHealth()
                return
            }
            val ok = runCatching { bm.extractBootstrap { RuntimeController.log(it) } }.getOrDefault(false)
            if (!ok) {
                RuntimeController.setState(RuntimeState.ERROR, "Bootstrap extraction failed")
                return
            }
        }

        // The Debian guest + toolchain must be provisioned once before the first
        // `proot-distro login debian` will work. Run setup-guest.sh and mark ready.
        if (!bm.isReady()) {
            RuntimeController.setState(RuntimeState.STARTING, "Provisioning Debian guest (one-time, minutes)…")
            val provisioned = runCatching { provisionGuest(bm) }.getOrDefault(false)
            if (!provisioned) {
                RuntimeController.setState(RuntimeState.ERROR, "Guest provisioning failed — see logs")
                return
            }
            bm.markReady()
        }

        val cmd = buildLaunchCommand(bm)
        RuntimeController.log("[runtime] launching: ${cmd.joinToString(" ")}")
        try {
            val pb = ProcessBuilder(cmd).directory(bm.rootDir).redirectErrorStream(true)
            applyEnv(pb, bm)
            val p = pb.start()
            process = p
            pumpThread = Thread { pump(p) }.also { it.isDaemon = true; it.start() }
            pollHealth()
        } catch (t: Throwable) {
            RuntimeController.setState(RuntimeState.ERROR, t.message ?: "launch failed")
            RuntimeController.log("[runtime] launch error: ${t.message}")
        }
    }

    /**
     * proot-distro login into the Debian guest, then run the broker. The guest
     * already has node + the broker checked out under ~/agent-broker (the
     * provisioning script puts it there).
     *
     * IMPORTANT: invoke the interpreter EXPLICITLY ("$usr/bin/sh" <script>) rather
     * than relying on proot-distro's shebang — its shebang points at the Termux
     * package path (/data/data/com.termux/...) which does not exist in this app's
     * own data dir, so a bare exec would fail with ENOENT.
     */
    private fun buildLaunchCommand(bm: BootstrapManager): List<String> {
        val sh = File(bm.usrDir, "bin/sh").absolutePath
        val profile = RuntimeConfig.defaultProfile(ctx)
        val brokerCmd =
            "cd \$HOME && node \$HOME/agent-broker/src/index.js " +
                "--profile $profile --port ${RuntimeConfig.DEFAULT_PORT} --projects \$HOME/projects"
        return listOf(
            sh, bm.prootDistro.absolutePath,
            "login", "debian", "--",
            "bash", "-lc", brokerCmd
        )
    }

    /** Run the one-time provisioning script (proot-distro install debian + toolchain). */
    private fun provisionGuest(bm: BootstrapManager): Boolean {
        val sh = File(bm.usrDir, "bin/sh")
        val script = File(bm.scriptsDir, "setup-guest.sh")
        if (!sh.exists() || !script.exists()) {
            RuntimeController.log("[runtime] missing sh or setup-guest.sh — cannot provision")
            return false
        }
        val pb = ProcessBuilder(sh.absolutePath, script.absolutePath)
            .directory(bm.rootDir).redirectErrorStream(true)
        applyEnv(pb, bm)
        val p = pb.start()
        p.inputStream.bufferedReader().forEachLine { RuntimeController.log(it) }
        return runCatching { p.waitFor() == 0 }.getOrDefault(false)
    }

    /** Termux-style exec environment + injected provider secrets. */
    private fun applyEnv(pb: ProcessBuilder, bm: BootstrapManager) {
        val env = pb.environment()
        val usr = bm.usrDir.absolutePath
        val home = File(bm.rootDir, "home")
        val tmp = File(bm.usrDir, "tmp")
        // proot/node fail to start with a missing HOME/TMPDIR — ensure they exist.
        home.mkdirs(); tmp.mkdirs()
        env["PREFIX"] = usr
        env["HOME"] = home.absolutePath
        env["TMPDIR"] = tmp.absolutePath
        env["PATH"] = "$usr/bin:${env["PATH"] ?: "/system/bin"}"
        env["LD_LIBRARY_PATH"] = "$usr/lib"
        env["TERM"] = "xterm-256color"
        env["WATCHMAN_DISABLE"] = "1"
        // Inject provider keys from the Android Keystore so they never touch disk
        // in plaintext or a project .env.
        for ((k, v) in KeystoreSecrets(ctx).all()) env[k] = v
    }

    private fun pump(p: Process) {
        runCatching {
            p.inputStream.bufferedReader().forEachLine { RuntimeController.log(it) }
        }
        val code = runCatching { p.waitFor() }.getOrDefault(-1)
        RuntimeController.log("[runtime] broker process exited (code=$code)")
        if (RuntimeController.state.value == RuntimeState.RUNNING) {
            RuntimeController.setState(RuntimeState.STOPPED, "broker exited")
        }
    }

    /**
     * Background health poll: flips to RUNNING when the broker answers /healthz.
     * After the initial window it keeps polling at a slower cadence so an
     * externally-started broker (e.g. via `adb reverse`) is still picked up, and
     * reports the wait so the UI isn't stuck silently in STARTING.
     */
    private fun pollHealth() {
        if (pollThread?.isAlive == true) return // never run two pollers (restart used to leak one)
        polling = true
        pollThread = Thread {
            val url = RuntimeConfig.brokerUrl(ctx)
            val deadline = System.currentTimeMillis() + 90_000
            var announced = false
            while (polling) {
                if (BrokerHealth.isUp(url)) {
                    RuntimeController.setState(RuntimeState.RUNNING, "broker is up")
                    RuntimeController.log("[runtime] broker healthy at $url")
                    return@Thread
                }
                if (!announced && System.currentTimeMillis() > deadline) {
                    announced = true
                    RuntimeController.log("[runtime] broker not reachable yet at $url — still polling")
                    if (RuntimeController.state.value == RuntimeState.STARTING) {
                        RuntimeController.setState(RuntimeState.STARTING, "Waiting for broker at $url…")
                    }
                }
                Thread.sleep(if (announced) 5000 else 1000)
            }
        }.apply { isDaemon = true; start() }
    }

    fun stop() {
        polling = false // tell the health poller to exit (was while(true), never stopped)
        // destroyForcibly (SIGKILL) and, where ProcessHandle is available (API 26+),
        // also kill descendants so the proot guest + Node broker don't orphan.
        runCatching {
            val p = process
            if (p != null) {
                runCatching { p.toHandle().descendants().forEach { it.destroyForcibly() } }
                p.destroyForcibly()
            }
        }
        process = null
        if (RuntimeController.state.value != RuntimeState.BOOTSTRAP_MISSING) {
            RuntimeController.setState(RuntimeState.STOPPED, "stopped")
        }
    }
}
