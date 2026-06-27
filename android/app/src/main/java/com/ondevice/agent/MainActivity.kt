package com.ondevice.agent

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Base64
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.FileProvider
import com.ondevice.agent.secrets.KeystoreSecrets
import com.ondevice.agent.service.AgentForegroundService
import com.ondevice.agent.ui.AgentTheme
import com.ondevice.agent.ui.MainActions
import com.ondevice.agent.ui.MainScreen
import java.io.File

class MainActivity : ComponentActivity(), MainActions {

    // --- WebView bridge plumbing (registered before STARTED) -----------------
    private var imageCb: ((String?, String?) -> Unit)? = null
    private var voiceCb: ((String?) -> Unit)? = null

    private val pickImageLauncher =
        registerForActivityResult(ActivityResultContracts.GetContent()) { uri: Uri? ->
            val cb = imageCb; imageCb = null
            if (uri == null) { cb?.invoke(null, null); return@registerForActivityResult }
            runCatching {
                val mime = contentResolver.getType(uri) ?: "image/jpeg"
                val bytes = contentResolver.openInputStream(uri)!!.use { it.readBytes() }
                cb?.invoke(Base64.encodeToString(bytes, Base64.NO_WRAP), mime)
            }.onFailure { cb?.invoke(null, null) }
        }

    private val voicePermLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) beginRecognition() else { voiceCb?.invoke(null); voiceCb = null }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        AgentForegroundService.start(this)
        setContent { AgentTheme { MainScreen(this@MainActivity) } }
    }

    // --- MainActions: runtime/settings ---------------------------------------

    override fun startService() = AgentForegroundService.start(this)
    override fun stopService() = AgentForegroundService.stop(this)

    override fun isBatteryExempt(): Boolean {
        val pm = getSystemService(PowerManager::class.java) ?: return false
        return pm.isIgnoringBatteryOptimizations(packageName)
    }
    override fun requestBatteryExempt() {
        val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName"))
        } else {
            Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
        }
        runCatching { startActivity(intent) }
    }

    override fun brokerUrl(): String = RuntimeConfig.brokerUrl(this)
    override fun setBrokerUrl(url: String) = RuntimeConfig.setBrokerUrl(this, url)
    override fun defaultProfile(): String = RuntimeConfig.defaultProfile(this)
    override fun setDefaultProfile(p: String) = RuntimeConfig.setDefaultProfile(this, p)

    override fun secretNames(): Set<String> = KeystoreSecrets(this).names()
    override fun setSecret(name: String, value: String) = KeystoreSecrets(this).put(name, value)
    override fun removeSecret(name: String) = KeystoreSecrets(this).remove(name)

    // --- MainActions: WebView bridge -----------------------------------------

    override fun pickImage(onResult: (String?, String?) -> Unit) {
        imageCb = onResult
        runCatching { pickImageLauncher.launch("image/*") }
            .onFailure { onResult(null, null); imageCb = null }
    }

    override fun saveFile(name: String, content: String) {
        runCatching {
            val dir = File(cacheDir, "exports").apply { mkdirs() }
            dir.listFiles()?.forEach { it.delete() } // don't let exports (conversation text) accumulate in cache
            val f = File(dir, name)
            f.writeText(content)
            val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", f)
            val share = Intent(Intent.ACTION_SEND).apply {
                type = "text/markdown"
                putExtra(Intent.EXTRA_STREAM, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            startActivity(Intent.createChooser(share, "Save / share"))
        }.onFailure { Toast.makeText(this, "Couldn't save: ${it.message}", Toast.LENGTH_SHORT).show() }
    }

    override fun notifyUser(title: String, body: String) {
        val nm = getSystemService(NotificationManager::class.java) ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(
                NotificationChannel(EVENTS_CHANNEL, "Agent events", NotificationManager.IMPORTANCE_DEFAULT)
            )
        }
        val pi = PendingIntent.getActivity(
            this, 2, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            Notification.Builder(this, EVENTS_CHANNEL) else @Suppress("DEPRECATION") Notification.Builder(this)
        nm.notify(7, builder
            .setContentTitle(title).setContentText(body)
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setAutoCancel(true).setContentIntent(pi).build())
    }

    override fun startVoice(onResult: (String?) -> Unit) {
        voiceCb = onResult
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) beginRecognition()
        else voicePermLauncher.launch(Manifest.permission.RECORD_AUDIO)
    }

    override fun openExternal(url: String) {
        // Only let web/Expo links out. A compromised page (e.g. XSS in agent output)
        // could otherwise launch arbitrary intent:// / file:// / deep-link URIs.
        val u = Uri.parse(url)
        val scheme = (u.scheme ?: "").lowercase()
        if (scheme != "http" && scheme != "https" && scheme != "exp") {
            Toast.makeText(this, "Blocked link ($scheme)", Toast.LENGTH_SHORT).show()
            return
        }
        runCatching {
            startActivity(Intent(Intent.ACTION_VIEW, u).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }.onFailure { Toast.makeText(this, "Can't open: $url", Toast.LENGTH_SHORT).show() }
    }

    private fun beginRecognition() {
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            Toast.makeText(this, "Voice recognition unavailable", Toast.LENGTH_SHORT).show()
            voiceCb?.invoke(null); voiceCb = null; return
        }
        val sr = SpeechRecognizer.createSpeechRecognizer(this)
        sr.setRecognitionListener(object : RecognitionListener {
            override fun onResults(results: Bundle) {
                val text = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()
                voiceCb?.invoke(text); voiceCb = null; sr.destroy()
            }
            override fun onError(error: Int) { voiceCb?.invoke(null); voiceCb = null; sr.destroy() }
            override fun onReadyForSpeech(params: Bundle?) {}
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onPartialResults(partialResults: Bundle?) {}
            override fun onEvent(eventType: Int, params: Bundle?) {}
        })
        sr.startListening(
            Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false)
        )
    }

    companion object {
        private const val EVENTS_CHANNEL = "agent_events"
    }
}
