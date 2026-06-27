package com.ondevice.agent.service

import android.content.Context
import com.ondevice.agent.RuntimeConfig
import com.ondevice.agent.net.BrokerHealth
import java.util.concurrent.TimeUnit

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
                    "No bundled proot — run an external broker (adb reverse) or rebuild with provisioning/make-runtime.sh."
                )
                RuntimeController.log("[runtime] no bundled proot — external-broker mode")
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
            RuntimeController.setState(RuntimeState.STARTING, "Installing toolchain + broker (one-time, minutes)…")
            if (!runCatching { rt.provision { RuntimeController.log(it) } }.getOrDefault(false)) {
                RuntimeController.setState(RuntimeState.ERROR, "Provisioning failed — see logs"); return
            }
        }

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
        runCatching { p.inputStream.bufferedReader().forEachLine { RuntimeController.log(it) } }
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
        // The broker (node) runs as a TRACEE of proot, not as our direct child. A
        // SIGKILL (destroyForcibly) can't be trapped, so proot dies without running
        // its --kill-on-exit cleanup and node is orphaned — it keeps serving and the
        // "Stop" button looks like a no-op. Send SIGTERM (destroy) first so proot
        // exits cleanly and reaps its tracees; only force-kill if it doesn't.
        if (p != null) {
            runCatching { p.destroy() } // SIGTERM → proot → --kill-on-exit reaps node
            Thread {
                runCatching {
                    if (!p.waitFor(4, TimeUnit.SECONDS)) {
                        RuntimeController.log("[runtime] broker didn't exit on SIGTERM — force-killing")
                        p.destroyForcibly()
                    }
                }
            }.apply { isDaemon = true; start() }
        }
        if (RuntimeController.state.value != RuntimeState.BOOTSTRAP_MISSING) {
            RuntimeController.setState(RuntimeState.STOPPED, "stopped")
        }
    }
}
