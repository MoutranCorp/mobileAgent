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
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
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
            runCatching {
                val pkg = WebView.getCurrentWebViewPackage()
                RuntimeController.log("[webui] WebView engine ${pkg?.packageName} ${pkg?.versionName}")
            }
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
                    // Up to 5 auto-retries of the MAIN frame: if the WebView is created
                    // the instant the broker flips to RUNNING, the very first GET can
                    // still race the listener and fail with CONNECTION_REFUSED, leaving
                    // a permanent blank page (the browser "works" only because the user
                    // opens it a moment later). Retry on a short backoff instead.
                    var retries = 0
                    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                        handleUrl(view, request.url)
                    override fun doUpdateVisitedHistory(view: WebView, u: String?, isReload: Boolean) {
                        onCanGoBackChange(view.canGoBack())
                    }
                    override fun onPageStarted(view: WebView, u: String?, favicon: android.graphics.Bitmap?) {
                        RuntimeController.log("[webui] page started: $u")
                        // Install an error catcher ASAP so an exception during init lands
                        // in the runtime log even on the in-guest clone (no overlay yet).
                        view.evaluateJavascript(
                            "window.onerror=function(m,s,l,c,e){console.error('[jserr] '+m+' @'+s+':'+l+':'+c+(e&&e.stack?' '+e.stack:''));};" +
                                "window.addEventListener('unhandledrejection',function(e){console.error('[jsrej] '+(e.reason&&e.reason.stack||e.reason));});",
                            null,
                        )
                    }
                    override fun onPageFinished(view: WebView, u: String?) {
                        onCanGoBackChange(view.canGoBack())
                        // Dynamic viewport units (dvh) misresolve to 0 in this Compose-
                        // hosted WebView, collapsing #app to zero height (blank page, full
                        // DOM). Force concrete pixel heights from the Android side so the
                        // fix ships in the APK and doesn't depend on the served CSS being
                        // updated. Retries until innerHeight is known, then re-applies on
                        // resize. Also reports the measured heights for diagnosis.
                        view.evaluateJavascript(FIX_AND_PROBE) { r ->
                            RuntimeController.log("[webui] page finished: $u :: ${r?.trim('"')}")
                        }
                    }
                    override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                        if (!request.isForMainFrame) return // ignore sub-resource hiccups
                        val u = request.url.toString()
                        RuntimeController.log("[webui] load error ${error.errorCode} ${error.description} @ $u")
                        // The on-device broker is HTTP-only; an https loopback URL (saved
                        // scheme or an upgrade) fails the TLS handshake and renders blank.
                        // Fall back to http instead of looping on the SSL error.
                        val httpFallback = Regex("^https://(127\\.0\\.0\\.1|localhost|\\[::1\\])", RegexOption.IGNORE_CASE)
                        if (httpFallback.containsMatchIn(u)) {
                            val httpUrl = u.replaceFirst(Regex("^https://", RegexOption.IGNORE_CASE), "http://")
                            RuntimeController.log("[webui] retrying over http: $httpUrl")
                            view.postDelayed({ view.loadUrl(httpUrl) }, 200)
                            return
                        }
                        if (u == view.url || view.url == null) {
                            if (retries < 5) {
                                retries++
                                view.postDelayed({ view.reload() }, 800L * retries)
                            }
                        }
                    }
                    override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
                        if (request.isForMainFrame)
                            RuntimeController.log("[webui] http ${response.statusCode} @ ${request.url}")
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

// Injected after each load. Forces html/body/#app to a concrete pixel height equal
// to innerHeight (dvh/% can collapse to 0 in this embedded WebView), retrying until
// innerHeight is known and re-applying on resize. Returns a one-line diagnostic.
private const val FIX_AND_PROBE = """
(function(){
  function fit(){
    var h = window.innerHeight || document.documentElement.clientHeight || 0;
    if (h > 0) {
      var de = document.documentElement, b = document.body, a = document.getElementById('app');
      de.style.height = h + 'px'; if (b) b.style.height = h + 'px';
      if (a) { a.style.height = h + 'px'; a.style.minHeight = h + 'px'; }
      // Drive --vh too so overlays/modals (calc(N*var(--vh))) don't collapse when
      // vh/dvh misresolve in this WebView — works even before the broker is updated.
      de.style.setProperty('--vh', h / 100 + 'px');
    }
    return h;
  }
  if (!window.__fitInstalled) {
    window.__fitInstalled = true;
    window.addEventListener('resize', fit);
    var n = 0, t = setInterval(function(){ if (fit() > 0 || ++n > 20) clearInterval(t); }, 150);
  }
  var h = fit(), ap = document.getElementById('app');
  return 'innerH=' + h + ' appH=' + (ap ? ap.offsetHeight : -1);
})()
"""

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
