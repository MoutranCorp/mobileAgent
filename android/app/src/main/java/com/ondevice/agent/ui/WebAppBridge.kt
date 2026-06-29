package com.ondevice.agent.ui

import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject

/**
 * window.AndroidAgent — the bridge the web UI calls into for capabilities a
 * WebView lacks. @JavascriptInterface methods are invoked on a binder thread, so
 * everything is posted to the WebView's (UI) thread. Results are delivered back
 * to JS via evaluateJavascript (window.onPickedImage / window.onVoiceResult).
 */
class WebAppBridge(private val host: MainActions, private val web: WebView) {

    @JavascriptInterface
    fun pickImage() {
        web.post { host.pickImage { b64, mime -> js("onPickedImage", b64, mime) } }
    }

    @JavascriptInterface
    fun pickFiles() {
        web.post { host.pickFiles { json -> js("onPickedFiles", json) } }
    }

    @JavascriptInterface
    fun saveFile(name: String, content: String) {
        web.post { host.saveFile(name, content) }
    }

    @JavascriptInterface
    fun notify(title: String, body: String) {
        web.post { host.notifyUser(title, body) }
    }

    @JavascriptInterface
    fun startVoice() {
        web.post { host.startVoice { text -> js("onVoiceResult", text) } }
    }

    @JavascriptInterface
    fun openExternal(url: String) {
        web.post { host.openExternal(url) }
    }

    private fun js(fn: String, vararg args: String?) {
        // JSONObject.quote produces a fully-escaped, double-quoted JS string literal
        // (handles ", \, control chars, etc.) — the old hand-rolled single-quote
        // escape missed backticks / </script> / unicode separators and could break
        // out of the generated call.
        val a = args.joinToString(",") { if (it == null) "null" else JSONObject.quote(it) }
        web.evaluateJavascript("window.$fn && window.$fn($a)", null)
    }
}
