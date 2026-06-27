package com.ondevice.agent.ui

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.Intent
import android.net.Uri
import android.webkit.ConsoleMessage
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import com.ondevice.agent.service.RuntimeController

/**
 * Hosts the broker's web UI in a WebView. A WebView is NOT a full browser, so we
 * bridge the things the web UI needs but a WebView doesn't provide:
 *   - JS dialogs (alert/confirm/prompt) → native AlertDialogs (otherwise every
 *     "Delete?"/"Replace all?" confirm silently cancels);
 *   - image attach, file save/export, voice, notifications → the WebAppBridge,
 *     injected as window.AndroidAgent (the web UI feature-detects it).
 * http(s)/ws to loopback load in place; exp:// launches the Expo dev client.
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun AgentWebView(
    url: String,
    host: MainActions,
    modifier: Modifier = Modifier,
    onCreated: (WebView) -> Unit = {},
    onCanGoBackChange: (Boolean) -> Unit = {},
) {
    AndroidView(
        modifier = modifier,
        factory = { ctx ->
            WebView(ctx).apply {
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                settings.mediaPlaybackRequiresUserGesture = false
                // Use the HTTP cache between loads — the broker cache-busts its
                // assets with ?v=__VER__, so stale JS/CSS isn't a risk and we avoid
                // re-fetching everything over loopback on each (re)load.
                settings.cacheMode = android.webkit.WebSettings.LOAD_DEFAULT
                // Honor the page's <meta viewport width=device-width> and fit to the
                // screen width — without this the WebView can lay the page out wider
                // than the device and let it pan sideways.
                settings.useWideViewPort = true
                settings.loadWithOverviewMode = true
                settings.builtInZoomControls = false
                settings.displayZoomControls = false
                // Bridge the WebView to native capabilities.
                addJavascriptInterface(WebAppBridge(host, this), "AndroidAgent")

                webChromeClient = object : WebChromeClient() {
                    override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                        RuntimeController.log("[webui] ${m.message()}")
                        return true
                    }
                    // Native JS dialogs — without these, confirm() returns false and
                    // destructive actions in the UI silently no-op.
                    override fun onJsAlert(v: WebView, u: String?, msg: String?, r: JsResult): Boolean {
                        AlertDialog.Builder(v.context).setMessage(msg)
                            .setPositiveButton("OK") { _, _ -> r.confirm() }
                            .setOnCancelListener { r.cancel() }.show()
                        return true
                    }
                    override fun onJsConfirm(v: WebView, u: String?, msg: String?, r: JsResult): Boolean {
                        AlertDialog.Builder(v.context).setMessage(msg)
                            .setPositiveButton("OK") { _, _ -> r.confirm() }
                            .setNegativeButton("Cancel") { _, _ -> r.cancel() }
                            .setOnCancelListener { r.cancel() }.show()
                        return true
                    }
                    override fun onJsPrompt(v: WebView, u: String?, msg: String?, def: String?, r: JsPromptResult): Boolean {
                        val input = EditText(v.context).apply { setText(def ?: "") }
                        AlertDialog.Builder(v.context).setMessage(msg).setView(input)
                            .setPositiveButton("OK") { _, _ -> r.confirm(input.text.toString()) }
                            .setNegativeButton("Cancel") { _, _ -> r.cancel() }
                            .setOnCancelListener { r.cancel() }.show()
                        return true
                    }
                    // Grant ONLY audio capture (the voice path); never blanket-grant
                    // camera etc. to in-page content — an XSS'd microapp widget could
                    // otherwise request and be handed the camera.
                    override fun onPermissionRequest(request: PermissionRequest) {
                        val audio = request.resources.filter { it == PermissionRequest.RESOURCE_AUDIO_CAPTURE }.toTypedArray()
                        if (audio.isNotEmpty()) request.grant(audio) else request.deny()
                    }
                }

                webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                        handleUrl(view, request.url)
                    override fun doUpdateVisitedHistory(view: WebView, u: String?, isReload: Boolean) {
                        onCanGoBackChange(view.canGoBack())
                    }
                    override fun onPageFinished(view: WebView, u: String?) {
                        onCanGoBackChange(view.canGoBack())
                    }
                }
                tag = url
                loadUrl(url)
                onCreated(this)
            }
        },
        update = { wv ->
            if (wv.tag != url) {
                wv.tag = url
                wv.loadUrl(url)
            }
        },
    )
}

private fun handleUrl(view: WebView, uri: Uri): Boolean {
    return when (uri.scheme?.lowercase()) {
        "http", "https", "ws", "wss", null -> false // load loopback content in the WebView
        else -> {
            runCatching {
                view.context.startActivity(
                    Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
            }.onFailure { RuntimeController.log("[webui] cannot open $uri: ${it.message}") }
            true
        }
    }
}
