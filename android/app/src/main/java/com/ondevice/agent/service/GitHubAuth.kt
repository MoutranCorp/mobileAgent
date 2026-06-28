package com.ondevice.agent.service

import android.content.Context
import com.ondevice.agent.secrets.KeystoreSecrets
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/**
 * Native, on-device GitHub authentication so the agent's `git` (and `gh`/MCP) can
 * push, pull, and merge against your repos — including private ones. Two methods:
 *
 *  - **Device Flow** (account login): POST a device code, the user authorizes at
 *    github.com/login/device, we poll for the access token. Needs an OAuth App
 *    Client ID (no client secret in device flow).
 *  - **Personal Access Token**: the user pastes a token (classic `repo` scope or a
 *    fine-grained token with contents read/write); we validate it via the API.
 *
 * Either way the token is stored in the hardware-backed Keystore as `GITHUB_TOKEN`
 * + `GH_TOKEN`, which `ProotRuntime.prootGuest` injects into the guest env for
 * EVERY guest process (broker → claude → git). We then point git's credential
 * helper for github.com at those env vars, so the token is never written to a file
 * yet authenticates all HTTPS git traffic. `user.name`/`user.email` are set from
 * the account so the agent's commits/merges are attributed correctly.
 */
object GitHubAuth {

    enum class Phase { IDLE, DEVICE_STARTING, AWAITING_AUTH, VERIFYING, DONE, ERROR }
    data class State(
        val phase: Phase = Phase.IDLE,
        val userCode: String? = null,
        val verificationUri: String? = null,
        val message: String = "",
        val login: String? = null,
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state

    @Volatile private var polling = false

    private const val UA = "ondevice-agent"
    private const val PREFS = "github_prefs"
    private const val KEY_CLIENT_ID = "client_id"

    // ---- public surface the UI calls ----------------------------------------

    /** The @login of the signed-in account, or null. Survives app restarts. */
    fun signedInUser(ctx: Context): String? = KeystoreSecrets(ctx).get("GITHUB_USER")

    fun clientId(ctx: Context): String =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_CLIENT_ID, "") ?: ""

    fun setClientId(ctx: Context, id: String) =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_CLIENT_ID, id.trim()).apply()

    /** Validate + store a pasted Personal Access Token, then wire git to use it. */
    fun signInWithToken(ctx: Context, pat: String) {
        _state.value = State(Phase.VERIFYING, message = "Validating token…")
        Thread {
            try {
                val user = fetchUser(pat)
                if (user == null) {
                    _state.value = State(Phase.ERROR, message = "Token rejected by GitHub — check it has repo access and isn't expired.")
                    return@Thread
                }
                storeAndApply(ctx, pat, user.first, user.second)
            } catch (t: Throwable) {
                _state.value = State(Phase.ERROR, message = t.message ?: "sign-in failed")
            }
        }.apply { isDaemon = true; start() }
    }

    /** Begin the OAuth device flow against the given OAuth App Client ID. */
    fun startDeviceFlow(ctx: Context, clientId: String) {
        if (_state.value.phase == Phase.DEVICE_STARTING || _state.value.phase == Phase.AWAITING_AUTH) return
        _state.value = State(Phase.DEVICE_STARTING, message = "Requesting device code…")
        polling = true
        Thread {
            try {
                // 1) ask GitHub for a device + user code.
                val codeResp = httpForm(
                    "https://github.com/login/device/code",
                    "client_id=${enc(clientId)}&scope=repo",
                )
                if (codeResp.code !in 200..299) {
                    _state.value = State(Phase.ERROR, message = "Couldn't start device login (HTTP ${codeResp.code}) — check the Client ID.")
                    return@Thread
                }
                val j = JSONObject(codeResp.body)
                val deviceCode = j.optString("device_code")
                val userCode = j.optString("user_code")
                val verUri = j.optString("verification_uri", "https://github.com/login/device")
                var interval = j.optInt("interval", 5).coerceAtLeast(1)
                val expiresIn = j.optInt("expires_in", 900)
                if (deviceCode.isEmpty() || userCode.isEmpty()) {
                    _state.value = State(Phase.ERROR, message = "GitHub didn't return a device code — check the Client ID and that Device Flow is enabled on the OAuth App.")
                    return@Thread
                }
                _state.value = State(Phase.AWAITING_AUTH, userCode = userCode, verificationUri = verUri,
                    message = "Open the link, enter the code, and authorize. Waiting…")

                // 2) poll for the access token until authorized / expired / cancelled.
                val deadline = System.currentTimeMillis() + expiresIn * 1000L
                while (polling && System.currentTimeMillis() < deadline) {
                    Thread.sleep(interval * 1000L)
                    if (!polling) return@Thread
                    val tokResp = httpForm(
                        "https://github.com/login/oauth/access_token",
                        "client_id=${enc(clientId)}&device_code=${enc(deviceCode)}" +
                            "&grant_type=urn:ietf:params:oauth:grant-type:device_code",
                    )
                    val tj = runCatching { JSONObject(tokResp.body) }.getOrNull() ?: continue
                    val token = tj.optString("access_token", "")
                    if (token.isNotEmpty()) {
                        _state.value = State(Phase.VERIFYING, message = "Authorized — finishing…")
                        val user = fetchUser(token)
                        if (user == null) { _state.value = State(Phase.ERROR, message = "Got a token but couldn't read the account."); return@Thread }
                        storeAndApply(ctx, token, user.first, user.second)
                        return@Thread
                    }
                    when (tj.optString("error")) {
                        "authorization_pending" -> { /* keep waiting */ }
                        "slow_down" -> interval += 5
                        "expired_token" -> { _state.value = State(Phase.ERROR, message = "The code expired — try again."); return@Thread }
                        "access_denied" -> { _state.value = State(Phase.ERROR, message = "Authorization was denied."); return@Thread }
                        else -> { /* transient; keep polling */ }
                    }
                }
                if (polling) _state.value = State(Phase.ERROR, message = "Timed out waiting for authorization — try again.")
            } catch (t: Throwable) {
                _state.value = State(Phase.ERROR, message = t.message ?: "device login failed")
            } finally {
                polling = false
            }
        }.apply { isDaemon = true; start() }
    }

    fun cancel() {
        polling = false
        _state.value = State(Phase.IDLE)
    }

    fun reset() {
        if (!polling) _state.value = State(Phase.IDLE)
    }

    fun signOut(ctx: Context) {
        polling = false
        val ks = KeystoreSecrets(ctx)
        for (k in listOf("GITHUB_TOKEN", "GH_TOKEN", "GITHUB_USER", "GITHUB_EMAIL")) runCatching { ks.remove(k) }
        // Best-effort: drop the github.com credential helper from the guest gitconfig.
        runCatching {
            val rt = ProotRuntime(ctx)
            if (rt.isProvisioned()) {
                val p = rt.startGuestCommand("git config --global --remove-section 'credential.https://github.com' 2>/dev/null; echo done")
                p.inputStream.bufferedReader().readText(); p.waitFor()
            }
        }
        _state.value = State(Phase.IDLE)
    }

    /** Re-apply the guest gitconfig at runtime launch if we're signed in but the
     *  rootfs lost it (e.g. an environment reset kept app data but wiped the guest).
     *  Cheap: a host-side file check gates the one guest command. */
    fun ensureGitConfig(ctx: Context) {
        val ks = KeystoreSecrets(ctx)
        val login = ks.get("GITHUB_USER") ?: return
        ks.get("GITHUB_TOKEN") ?: return
        val email = ks.get("GITHUB_EMAIL") ?: "$login@users.noreply.github.com"
        val rt = ProotRuntime(ctx)
        if (!rt.isProvisioned()) return
        val cfg = File(rt.rootfs, "root/.gitconfig")
        if (cfg.exists() && cfg.readText().contains("credential \"https://github.com\"")) return
        runCatching { applyGitConfig(ctx, login, email) }
    }

    // ---- internals ----------------------------------------------------------

    private fun storeAndApply(ctx: Context, token: String, login: String, id: Long) {
        val email = "$id+$login@users.noreply.github.com"
        val ks = KeystoreSecrets(ctx)
        // GITHUB_TOKEN: standard for git/MCP/tooling. GH_TOKEN: the gh CLI reads it.
        ks.put("GITHUB_TOKEN", token)
        ks.put("GH_TOKEN", token)
        ks.put("GITHUB_USER", login)
        ks.put("GITHUB_EMAIL", email)
        val applied = runCatching { applyGitConfig(ctx, login, email) }.getOrDefault(false)
        val tail = if (applied) "Stop & Start the runtime to apply." else "Start the runtime to finish wiring git."
        RuntimeController.log("[github] signed in as @$login")
        _state.value = State(Phase.DONE, login = login, message = "Signed in as @$login ✓  $tail")
    }

    /** Configure git in the guest to authenticate github.com from the injected env
     *  vars (the token itself is never written to a file). Idempotent. */
    private fun applyGitConfig(ctx: Context, loginRaw: String, emailRaw: String): Boolean {
        val rt = ProotRuntime(ctx)
        if (!rt.isProvisioned()) return false
        val login = loginRaw.replace("'", "")
        val email = emailRaw.replace("'", "")
        val d = "$" // keep $GITHUB_* literal in the helper (expanded by git at run-time, not now)
        val helper = "!f() { echo username=${d}GITHUB_USER; echo password=${d}GITHUB_TOKEN; }; f"
        val script = listOf(
            "git config --global user.name '$login'",
            "git config --global user.email '$email'",
            "git config --global 'credential.https://github.com.helper' '$helper'",
            "git config --global 'credential.https://github.com.useHttpPath' false",
            "echo OK_GHCFG",
        ).joinToString(" && ")
        val p = rt.startGuestCommand(script)
        val out = p.inputStream.bufferedReader().readText()
        val code = runCatching { p.waitFor() }.getOrDefault(-1)
        return code == 0 || out.contains("OK_GHCFG")
    }

    /** GET /user with the token → (login, id), or null if the token is invalid. */
    private fun fetchUser(token: String): Pair<String, Long>? {
        val r = httpGet("https://api.github.com/user", mapOf(
            "Authorization" to "Bearer $token",
            "Accept" to "application/vnd.github+json",
        ))
        if (r.code !in 200..299) return null
        val j = JSONObject(r.body)
        val login = j.optString("login")
        val id = j.optLong("id")
        return if (login.isNotEmpty()) login to id else null
    }

    private data class Http(val code: Int, val body: String)

    private fun httpForm(url: String, body: String): Http =
        http("POST", url, body, mapOf(
            "Accept" to "application/json",
            "Content-Type" to "application/x-www-form-urlencoded",
        ))

    private fun httpGet(url: String, headers: Map<String, String>): Http = http("GET", url, null, headers)

    private fun http(method: String, urlStr: String, body: String?, headers: Map<String, String>): Http {
        val c = URL(urlStr).openConnection() as HttpURLConnection
        return try {
            c.requestMethod = method
            c.connectTimeout = 15000
            c.readTimeout = 20000
            c.setRequestProperty("User-Agent", UA) // GitHub 403s requests with no UA
            for ((k, v) in headers) c.setRequestProperty(k, v)
            if (body != null) {
                c.doOutput = true
                c.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            }
            val code = c.responseCode
            val stream = if (code in 200..299) c.inputStream else (c.errorStream ?: c.inputStream)
            val text = stream?.bufferedReader()?.use { it.readText() } ?: ""
            Http(code, text)
        } finally {
            runCatching { c.disconnect() }
        }
    }

    private fun enc(s: String): String = URLEncoder.encode(s, "UTF-8")
}
