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
import android.os.Environment
import android.os.PowerManager
import android.provider.OpenableColumns
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
import org.json.JSONArray
import org.json.JSONObject

class MainActivity : ComponentActivity(), MainActions {

    // --- WebView bridge plumbing (registered before STARTED) -----------------
    private var imageCb: ((String?, String?) -> Unit)? = null
    private var filesCb: ((String?) -> Unit)? = null
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

    // Multi-select picker for any file type. Returns a JSON array string of
    // { name, mime, dataBase64 } (or null when cancelled / nothing readable).
    private val pickFilesLauncher =
        registerForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris: List<Uri> ->
            val cb = filesCb; filesCb = null
            if (uris.isEmpty()) { cb?.invoke(null); return@registerForActivityResult }
            val arr = JSONArray()
            for (uri in uris) readAttachment(uri)?.let { arr.put(it) }
            cb?.invoke(if (arr.length() > 0) arr.toString() else null)
        }

    private val voicePermLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) beginRecognition() else { voiceCb?.invoke(null); voiceCb = null }
        }

    // Pre-API-30 path for "all files access": the legacy WRITE_EXTERNAL_STORAGE
    // runtime permission (with targetSdk 28 this grants broad shared-storage access).
    private val storagePermLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* state re-read on resume */ }

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

    override fun hasAllFilesAccess(): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) Environment.isExternalStorageManager()
        else checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED

    override fun requestAllFilesAccess() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            // Open this app's "All files access" screen; fall back to the global list.
            val scoped = runCatching {
                Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:$packageName"))
            }.getOrNull()
            val ok = scoped != null && runCatching { startActivity(scoped) }.isSuccess
            if (!ok) runCatching { startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)) }
                .onFailure { Toast.makeText(this, "Open Settings → Apps → special access → All files access", Toast.LENGTH_LONG).show() }
        } else {
            storagePermLauncher.launch(Manifest.permission.WRITE_EXTERNAL_STORAGE)
        }
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

    override fun pickFiles(onResult: (String?) -> Unit) {
        filesCb = onResult
        runCatching { pickFilesLauncher.launch("*/*") }
            .onFailure { onResult(null); filesCb = null }
    }

    // Read one picked file into { name, mime, dataBase64 }. Skips unreadable files
    // and anything over MAX_ATTACH_BYTES (keeps the base64 + the JS bridge string
    // from blowing up memory on a phone).
    private fun readAttachment(uri: Uri): JSONObject? = runCatching {
        val mime = contentResolver.getType(uri) ?: "application/octet-stream"
        var name = "file"
        var size = -1L
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
            if (c.moveToFirst()) {
                val ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (ni >= 0 && !c.isNull(ni)) name = c.getString(ni)
                val si = c.getColumnIndex(OpenableColumns.SIZE)
                if (si >= 0 && !c.isNull(si)) size = c.getLong(si)
            }
        }
        if (size > MAX_ATTACH_BYTES) return@runCatching null
        val bytes = contentResolver.openInputStream(uri)!!.use { it.readBytes() }
        if (bytes.size > MAX_ATTACH_BYTES) return@runCatching null
        JSONObject()
            .put("name", name)
            .put("mime", mime)
            .put("dataBase64", Base64.encodeToString(bytes, Base64.NO_WRAP))
    }.getOrNull()

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

    override fun installDownloadedApk() {
        val apk = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "mobile-agent-debug.apk")
        if (!apk.isFile) {
            Toast.makeText(this, "No exported APK found in Downloads", Toast.LENGTH_SHORT).show()
            return
        }
        runCatching {
            val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", apk)
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            startActivity(intent)
        }.onFailure {
            Toast.makeText(this, "Couldn't open APK installer: ${it.message}", Toast.LENGTH_LONG).show()
        }
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
        private const val MAX_ATTACH_BYTES = 20L * 1024 * 1024 // 20 MB per file
    }
}
