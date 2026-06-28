package com.ondevice.agent.ui

import android.webkit.WebView
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import android.content.Intent
import android.net.Uri
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import com.ondevice.agent.service.ClaudeLogin
import com.ondevice.agent.service.ClaudeUpdate
import com.ondevice.agent.service.RuntimeController
import com.ondevice.agent.service.RuntimeState

/** Callbacks the host Activity wires into the screen. */
interface MainActions {
    fun startService()
    fun stopService()
    fun isBatteryExempt(): Boolean
    fun requestBatteryExempt()
    // "All files access" (MANAGE_EXTERNAL_STORAGE) so the File Manager + agent can
    // read the whole shared-storage tree, not just the app-scoped view.
    fun hasAllFilesAccess(): Boolean
    fun requestAllFilesAccess()
    fun brokerUrl(): String
    fun setBrokerUrl(url: String)
    fun defaultProfile(): String
    fun setDefaultProfile(p: String)
    fun secretNames(): Set<String>
    fun setSecret(name: String, value: String)
    fun removeSecret(name: String)
    // WebView bridge (window.AndroidAgent) — capabilities a WebView lacks.
    fun pickImage(onResult: (String?, String?) -> Unit)
    fun saveFile(name: String, content: String)
    fun notifyUser(title: String, body: String)
    fun startVoice(onResult: (String?) -> Unit)
    fun openExternal(url: String)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MainScreen(actions: MainActions) {
    val state by RuntimeController.state.collectAsState()
    val detail by RuntimeController.detail.collectAsState()
    var tab by remember { mutableIntStateOf(0) }

    Column(Modifier.fillMaxSize().background(Bg)) {
        // Top bar
        Row(
            Modifier.fillMaxWidth().background(BgElev).statusBarsPadding()
                .padding(horizontal = 16.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("On-Device Agent", color = TextMain, fontSize = 17.sp)
            Spacer(Modifier.weight(1f))
            StatusPill(state)
        }

        TabRow(
            selectedTabIndex = tab,
            containerColor = BgElev,
            contentColor = Accent,
        ) {
            Tab(selected = tab == 0, onClick = { tab = 0 },
                text = { Text("Agent", color = if (tab == 0) Accent else TextDim) })
            Tab(selected = tab == 1, onClick = { tab = 1 },
                text = { Text("Runtime", color = if (tab == 1) Accent else TextDim) })
        }

        Box(Modifier.weight(1f).fillMaxWidth()) {
            when (tab) {
                0 -> AgentTab(state, detail, actions)
                else -> RuntimeTab(state, detail, actions)
            }
        }
    }
}

@Composable
private fun AgentTab(state: RuntimeState, detail: String, actions: MainActions) {
    var forceWeb by remember { mutableStateOf(false) }
    var webView by remember { mutableStateOf<WebView?>(null) }
    var canGoBack by remember { mutableStateOf(false) }

    if (state == RuntimeState.RUNNING || forceWeb) {
        BackHandler(enabled = canGoBack) { webView?.goBack() }
        AgentWebView(
            url = actions.brokerUrl(),
            host = actions,
            modifier = Modifier.fillMaxSize(),
            onCreated = { webView = it },
            onCanGoBackChange = { canGoBack = it },
        )
    } else {
        Column(
            Modifier.fillMaxSize().padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Text("Runtime: ${state.name}", color = TextMain, fontSize = 20.sp)
            Spacer(Modifier.height(8.dp))
            Text(detail.ifEmpty { "The agent runtime isn't running yet." },
                color = TextDim, fontSize = 14.sp)
            Spacer(Modifier.height(20.dp))
            FilledButton("Start runtime") { actions.startService() }
            Spacer(Modifier.height(10.dp))
            OutlineButton("Load agent UI anyway") { forceWeb = true }
            if (state == RuntimeState.BOOTSTRAP_MISSING) {
                Spacer(Modifier.height(18.dp))
                Text(
                    "No on-device bootstrap yet. Provision it (provisioning/README) " +
                        "or run the broker on your computer and use `adb reverse tcp:8765 tcp:8765`, " +
                        "then tap “Load agent UI anyway”.",
                    color = TextDim, fontSize = 12.sp,
                )
            }
        }
    }
}

@Composable
private fun RuntimeTab(state: RuntimeState, detail: String, actions: MainActions) {
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
    ) {
        Section("Status") {
            Text("State: ${state.name}", color = TextMain)
            if (detail.isNotEmpty()) Text(detail, color = TextDim, fontSize = 13.sp)
            Spacer(Modifier.height(10.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilledButton("Start") { actions.startService() }
                OutlineButton("Stop") { actions.stopService() }
            }
        }

        ClaudeSignInSection()

        ClaudeUpdateSection(state)

        FileAccessSection(actions)

        var exempt by remember { mutableStateOf(actions.isBatteryExempt()) }
        Section("Battery (keep alive while testing)") {
            Text(if (exempt) "Exempt from battery optimization ✓" else "NOT exempt — Doze may kill Metro",
                color = if (exempt) Green else Amber, fontSize = 13.sp)
            Spacer(Modifier.height(8.dp))
            OutlineButton("Request exemption") {
                actions.requestBatteryExempt(); exempt = actions.isBatteryExempt()
            }
        }

        var urlText by remember { mutableStateOf(actions.brokerUrl()) }
        Section("Broker URL") {
            DarkField(urlText, { urlText = it }, "http://127.0.0.1:8765/")
            Spacer(Modifier.height(8.dp))
            FilledButton("Save") { actions.setBrokerUrl(urlText.trim()) }
        }

        Section("Default engine profile") {
            val profiles = listOf("claude-max", "glm-zai", "opencode", "mock")
            var sel by remember { mutableStateOf(actions.defaultProfile()) }
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                profiles.forEach { p ->
                    Chip(p, p == sel) { sel = p; actions.setDefaultProfile(p) }
                }
            }
        }

        Section("Provider secrets (Keystore-encrypted)") {
            Text(
                "Sign in to Claude: add CLAUDE_CODE_OAUTH_TOKEN (generate it with " +
                    "`claude setup-token` on any computer, or in-app via Terminal), then " +
                    "Stop+Start the runtime. ANTHROPIC_API_KEY also works.",
                color = TextDim, fontSize = 12.sp,
            )
            Spacer(Modifier.height(8.dp))
            var names by remember { mutableStateOf(actions.secretNames().toList()) }
            names.forEach { n ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(n, color = TextMain, modifier = Modifier.weight(1f))
                    TextButton(onClick = {
                        actions.removeSecret(n); names = actions.secretNames().toList()
                    }) { Text("Remove", color = Red) }
                }
            }
            var k by remember { mutableStateOf("") }
            var v by remember { mutableStateOf("") }
            DarkField(k, { k = it }, "SECRET_NAME (e.g. ZAI_AUTH_TOKEN)")
            Spacer(Modifier.height(6.dp))
            DarkField(v, { v = it }, "value", secret = true)
            Spacer(Modifier.height(6.dp))
            FilledButton("Add secret") {
                if (k.isNotBlank() && v.isNotBlank()) {
                    actions.setSecret(k.trim(), v.trim()); k = ""; v = ""
                    names = actions.secretNames().toList()
                }
            }
        }

        Section("Runtime logs") {
            val logs by RuntimeController.logs.collectAsState()
            val listState = rememberLazyListState()
            val clipboard = LocalClipboardManager.current
            val context = LocalContext.current
            LaunchedEffect(logs.size) {
                if (logs.isNotEmpty()) listState.animateScrollToItem(logs.size - 1)
            }
            Surface(color = Color(0xFF0A0C10), shape = RoundedCornerShape(8.dp)) {
                LazyColumn(
                    state = listState,
                    modifier = Modifier.fillMaxWidth().height(220.dp).padding(8.dp),
                ) {
                    // Wrap (don't ellipsize) so long error lines are fully readable.
                    items(logs) { line ->
                        Text(line, color = TextDim, fontFamily = FontFamily.Monospace, fontSize = 11.sp)
                    }
                }
            }
            Spacer(Modifier.height(6.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilledButton("Copy logs") {
                    clipboard.setText(AnnotatedString(logs.joinToString("\n")))
                    android.widget.Toast.makeText(context, "Logs copied (${logs.size} lines)", android.widget.Toast.LENGTH_SHORT).show()
                }
                OutlineButton("Clear logs") { RuntimeController.clearLogs() }
            }
        }

            Spacer(Modifier.height(40.dp))
    }
}

/** Native on-device Claude sign-in: drives `claude setup-token`, opens the OAuth
 *  link in a real browser, and submits the pasted code straight to the process. */
@Composable
private fun ClaudeSignInSection() {
    val ctx = LocalContext.current
    val st by ClaudeLogin.state.collectAsState()
    Section("Sign in to Claude") {
        when (st.phase) {
            ClaudeLogin.Phase.IDLE, ClaudeLogin.Phase.ERROR -> {
                Text(
                    if (st.phase == ClaudeLogin.Phase.ERROR) st.message
                    else "Authorize Claude on this device — opens your browser, then paste the code back.",
                    color = if (st.phase == ClaudeLogin.Phase.ERROR) Red else TextDim, fontSize = 13.sp,
                )
                Spacer(Modifier.height(8.dp))
                FilledButton(if (st.phase == ClaudeLogin.Phase.ERROR) "Try again" else "Sign in") { ClaudeLogin.start(ctx) }
            }
            ClaudeLogin.Phase.STARTING -> Text(st.message.ifEmpty { "Starting…" }, color = TextDim, fontSize = 13.sp)
            ClaudeLogin.Phase.AWAITING_CODE, ClaudeLogin.Phase.VERIFYING -> {
                Text(st.message, color = TextMain, fontSize = 13.sp)
                Spacer(Modifier.height(8.dp))
                st.url?.let { url ->
                    FilledButton("Open sign-in page") {
                        runCatching {
                            ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                        }
                    }
                    Spacer(Modifier.height(6.dp))
                }
                var codeText by remember { mutableStateOf("") }
                DarkField(codeText, { codeText = it }, "paste the code here")
                Spacer(Modifier.height(6.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilledButton("Submit code") { ClaudeLogin.submitCode(codeText); codeText = "" }
                    OutlineButton("Cancel") { ClaudeLogin.cancel() }
                }
                if (st.phase == ClaudeLogin.Phase.VERIFYING) {
                    Spacer(Modifier.height(6.dp)); Text("Submitting…", color = TextDim, fontSize = 12.sp)
                }
            }
            ClaudeLogin.Phase.DONE -> {
                Text(st.message, color = Green, fontSize = 13.sp)
                Spacer(Modifier.height(8.dp))
                OutlineButton("Sign in again") { ClaudeLogin.reset() }
            }
        }
    }
}

/** Update the Claude Code CLI in the guest via its built-in `claude update`. */
@Composable
private fun ClaudeUpdateSection(runtime: RuntimeState) {
    val ctx = LocalContext.current
    val st by ClaudeUpdate.state.collectAsState()
    // Read the installed version once the runtime is up (and after an update).
    LaunchedEffect(runtime, st.phase) {
        if (runtime == RuntimeState.RUNNING && st.phase != ClaudeUpdate.Phase.UPDATING) {
            ClaudeUpdate.refresh(ctx)
        }
    }
    val busy = st.phase == ClaudeUpdate.Phase.UPDATING
    Section("Claude Code") {
        Text(
            if (st.version.isNotEmpty()) "Installed: ${st.version}"
            else if (runtime == RuntimeState.RUNNING) "Checking version…"
            else "Start the runtime to check / update.",
            color = TextMain, fontSize = 13.sp,
        )
        if (st.message.isNotEmpty()) {
            Spacer(Modifier.height(4.dp))
            Text(
                st.message,
                color = when (st.phase) {
                    ClaudeUpdate.Phase.ERROR -> Red
                    ClaudeUpdate.Phase.DONE -> Green
                    else -> TextDim
                },
                fontSize = 12.sp,
            )
        }
        Spacer(Modifier.height(8.dp))
        FilledButton(if (busy) "Updating…" else "Update Claude Code") {
            if (!busy) ClaudeUpdate.update(ctx)
        }
    }
}

/** Toggle Android "All files access" so the File Manager (and the agent) can reach
 *  the whole shared-storage tree, not just the app-scoped view. */
@Composable
private fun FileAccessSection(actions: MainActions) {
    val owner = LocalLifecycleOwner.current
    var granted by remember { mutableStateOf(actions.hasAllFilesAccess()) }
    // Re-read the grant when returning from the system settings screen.
    DisposableEffect(owner) {
        val obs = LifecycleEventObserver { _, e ->
            if (e == Lifecycle.Event.ON_RESUME) granted = actions.hasAllFilesAccess()
        }
        owner.lifecycle.addObserver(obs)
        onDispose { owner.lifecycle.removeObserver(obs) }
    }
    Section("File access") {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Access all device files", color = TextMain, fontSize = 14.sp)
                Text(
                    if (granted) "On — the File Manager can browse all of shared storage."
                    else "Off — only app-scoped files are visible.",
                    color = if (granted) Green else TextDim, fontSize = 12.sp,
                )
            }
            Switch(checked = granted, onCheckedChange = { actions.requestAllFilesAccess() })
        }
        Spacer(Modifier.height(6.dp))
        Text(
            "Grants Android “All files access”. System files and other apps’ private " +
                "storage stay inaccessible without root.",
            color = TextDim, fontSize = 11.sp,
        )
    }
}

// ---- small reusable bits ----

@Composable
private fun Section(title: String, content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxWidth().padding(vertical = 10.dp)) {
        Text(title.uppercase(), color = TextDim, fontSize = 11.sp)
        Spacer(Modifier.height(6.dp))
        Surface(color = BgElev, shape = RoundedCornerShape(12.dp)) {
            Column(Modifier.fillMaxWidth().padding(14.dp), content = content)
        }
    }
}

@Composable
private fun StatusPill(state: RuntimeState) {
    val (c, label) = when (state) {
        RuntimeState.RUNNING -> Green to "running"
        RuntimeState.STARTING -> Accent to "starting"
        RuntimeState.BOOTSTRAP_MISSING -> Amber to "setup"
        RuntimeState.ERROR -> Red to "error"
        RuntimeState.STOPPED -> TextDim to "stopped"
    }
    Surface(color = Color.Transparent, shape = RoundedCornerShape(999.dp),
        border = androidx.compose.foundation.BorderStroke(1.dp, c)) {
        Text(label, color = c, fontSize = 12.sp,
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 3.dp))
    }
}

@Composable
private fun FilledButton(text: String, onClick: () -> Unit) {
    Button(onClick = onClick,
        colors = ButtonDefaults.buttonColors(containerColor = Accent, contentColor = Color.White)) {
        Text(text)
    }
}

@Composable
private fun OutlineButton(text: String, onClick: () -> Unit) {
    OutlinedButton(onClick = onClick,
        colors = ButtonDefaults.outlinedButtonColors(contentColor = TextMain)) {
        Text(text)
    }
}

@Composable
private fun Chip(text: String, selected: Boolean, onClick: () -> Unit) {
    Surface(
        color = if (selected) Accent else BgElev2,
        shape = RoundedCornerShape(999.dp),
        modifier = Modifier.clickable { onClick() },
    ) {
        Text(text, color = if (selected) Color.White else TextDim, fontSize = 12.sp,
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp))
    }
}

@Composable
private fun DarkField(value: String, onChange: (String) -> Unit, hint: String, secret: Boolean = false) {
    OutlinedTextField(
        value = value,
        onValueChange = onChange,
        placeholder = { Text(hint, color = TextDim, fontSize = 13.sp) },
        singleLine = true,
        visualTransformation = if (secret)
            androidx.compose.ui.text.input.PasswordVisualTransformation()
        else androidx.compose.ui.text.input.VisualTransformation.None,
        colors = OutlinedTextFieldDefaults.colors(
            focusedTextColor = TextMain, unfocusedTextColor = TextMain,
            focusedBorderColor = Accent, unfocusedBorderColor = Border,
            focusedContainerColor = BgElev2, unfocusedContainerColor = BgElev2,
        ),
        modifier = Modifier.fillMaxWidth(),
    )
}
