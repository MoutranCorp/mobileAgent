package com.ondevice.agent.service

import android.content.Context
import android.system.Os
import android.system.OsConstants
import com.ondevice.agent.RuntimeConfig
import com.ondevice.agent.net.BrokerHealth
import java.io.File

/**
 * Launches and supervises the Node broker inside a Debian guest via a bundled
 * proot (option 1 — no Termux). Flow on first launch:
 *   1. stage proot (+ loader + libs) out of assets,
 *   2. download + extract the Debian rootfs (one-time, needs network),
 *   3. provision the toolchain + the bundled broker into the guest (one-time),
 *   4. run the broker under proot and flip to RUNNING once it answers /healthz.
 * Later launches skip 1–3 and go straight to 4.
 */
class RuntimeLauncher(private val ctx: Context) {

    @Volatile private var process: Process? = null
    @Volatile private var pumpThread: Thread? = null
    @Volatile private var pollThread: Thread? = null
    @Volatile private var polling = false

    fun launch() {
        RuntimeController.setState(RuntimeState.STARTING, "Preparing runtime…")
        val rt = ProotRuntime(ctx)

        if (!rt.isProotStaged()) {
            if (!rt.hasBundledProot()) {
                RuntimeController.setState(
                    RuntimeState.BOOTSTRAP_MISSING,
                    "This APK is missing its bundled proot runtime. Install a self-contained APK built with android/app/src/main/assets/proot-aarch64/proot."
                )
                RuntimeController.log("[runtime] missing bundled proot asset; this APK is not self-contained")
                pollHealth()
                return
            }
            val ok = runCatching { rt.stageProot { RuntimeController.log(it) }; true }.getOrDefault(false)
            if (!ok) { RuntimeController.setState(RuntimeState.ERROR, "proot staging failed — see logs"); return }
        }

        if (!rt.isRootfsReady()) {
            RuntimeController.setState(RuntimeState.STARTING, "Setting up Debian (one-time, needs network)…")
            if (!runCatching { rt.downloadAndExtractRootfs { RuntimeController.log(it) } }.getOrDefault(false)) {
                RuntimeController.setState(RuntimeState.ERROR, "Debian rootfs setup failed — see logs"); return
            }
        }

        if (!rt.isProvisioned()) {
            RuntimeController.setState(RuntimeState.STARTING, "Installing toolchain (one-time, minutes)…")
            if (!runCatching { rt.provision { RuntimeController.log(it) } }.getOrDefault(false)) {
                RuntimeController.setState(RuntimeState.ERROR, "Provisioning failed — see logs"); return
            }
        }

        // Deliver / refresh the broker source as a git clone (falls back to the bundled
        // tarball). Re-runs on a version bump so an existing bundled install migrates to
        // a clone — which is what makes the in-app Update (git pull) work.
        if (!rt.isBrokerSourceReady()) {
            RuntimeController.setState(RuntimeState.STARTING, "Setting up broker source (git clone, one-time)…")
            if (!runCatching { rt.ensureBrokerSource { RuntimeController.log(it) } }.getOrDefault(false)) {
                RuntimeController.setState(RuntimeState.ERROR, "Broker source setup failed — see logs"); return
            }
        }

        // If signed in to GitHub, make sure the guest gitconfig points git at the
        // injected token env (re-applied here in case an env reset wiped the rootfs).
        runCatching { GitHubAuth.ensureGitConfig(ctx) }

        val cmd = rt.brokerArgv()
        RuntimeController.setState(RuntimeState.STARTING, "Starting broker…")
        RuntimeController.log("[runtime] launching broker under proot")
        try {
            val pb = ProcessBuilder(cmd).directory(rt.rootDir).redirectErrorStream(true)
            rt.applyEnv(pb.environment())
            val p = pb.start()
            process = p
            pumpThread = Thread { pump(p) }.also { it.isDaemon = true; it.start() }
            pollHealth()
        } catch (t: Throwable) {
            RuntimeController.setState(RuntimeState.ERROR, t.message ?: "launch failed")
            RuntimeController.log("[runtime] launch error: ${t.message}")
        }
    }

    private fun pump(p: Process) {
        runCatching {
            p.inputStream.bufferedReader().forEachLine { line ->
                // A `@@NATIVE_NOTIFY@@ {json}` marker becomes a real Android
                // notification (fires even when the UI is dead) instead of log noise.
                if (Notifier.handleMarkerLine(ctx, line)) return@forEachLine
                RuntimeController.log(line)
            }
        }
        val code = runCatching { p.waitFor() }.getOrDefault(-1)
        RuntimeController.log("[runtime] broker process exited (code=$code)")
        if (RuntimeController.state.value == RuntimeState.RUNNING) {
            RuntimeController.setState(RuntimeState.STOPPED, "broker exited")
        }
    }

    /** Background health poll: flips to RUNNING when the broker answers /healthz.
     *  Keeps polling slower afterwards so an externally-started broker (adb reverse)
     *  is still picked up, and reports the wait so the UI isn't stuck silently. */
    private fun pollHealth() {
        if (pollThread?.isAlive == true) return
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
        polling = false
        val p = process
        process = null
        // Killing proot does NOT reliably stop the broker: node runs as proot's
        // TRACEE under our own UID, and a SIGKILLed tracer just detaches, orphaning
        // node so it keeps serving (the "Stop does nothing" bug). proot also doesn't
        // forward SIGTERM here. So signal the node broker DIRECTLY — same-UID, so
        // we're allowed. SIGTERM first (the broker has its own clean-shutdown handler
        // with a 3s self-backstop), then SIGKILL anything still alive + force proot.
        killBrokerProcesses(OsConstants.SIGTERM)
        runCatching { p?.destroy() }
        Thread {
            runCatching {
                Thread.sleep(3500)
                killBrokerProcesses(OsConstants.SIGKILL)
                p?.destroyForcibly()
            }
        }.apply { isDaemon = true; start() }
        if (RuntimeController.state.value != RuntimeState.BOOTSTRAP_MISSING) {
            RuntimeController.setState(RuntimeState.STOPPED, "stopped")
        }
    }

    /** Signal the on-device broker node process(es) directly via /proc. They run
     *  under our app UID (proot is ptrace, not a uid change), so Os.kill is permitted.
     *  Matches the broker entrypoint (`node …/src/index.js … --port …`) so unrelated
     *  node processes (claude CLI, MCP servers) aren't touched. */
    private fun killBrokerProcesses(signal: Int) {
        val procs = File("/proc").listFiles() ?: return
        for (d in procs) {
            val pid = d.name.toIntOrNull() ?: continue
            val raw = runCatching { File(d, "cmdline").readBytes() }.getOrNull() ?: continue
            if (raw.isEmpty()) continue
            val cmd = String(raw).replace('\u0000', ' ')
            if (cmd.contains("src/index.js") && cmd.contains("--port")) {
                runCatching {
                    Os.kill(pid, signal)
                    RuntimeController.log("[runtime] sent ${signalName(signal)} to broker pid=$pid")
                }
            }
        }
    }

    private fun signalName(sig: Int) = when (sig) {
        OsConstants.SIGTERM -> "SIGTERM"; OsConstants.SIGKILL -> "SIGKILL"; else -> "sig$sig"
    }
}
