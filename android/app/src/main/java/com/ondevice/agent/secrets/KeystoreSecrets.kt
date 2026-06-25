package com.ondevice.agent.secrets

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Provider auth tokens (e.g. ZAI_AUTH_TOKEN, OpenRouter keys) encrypted with an
 * AES key held in the hardware-backed Android Keystore. The plaintext is only
 * ever materialised transiently to inject into the engine process env at spawn
 * (RuntimeLauncher) — never written to a project .env or committed.
 */
class KeystoreSecrets(ctx: Context) {

    private val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun names(): Set<String> = prefs.all.keys

    fun put(name: String, value: String) {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
        val iv = cipher.iv
        val ct = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        val packed = ByteArray(iv.size + ct.size)
        System.arraycopy(iv, 0, packed, 0, iv.size)
        System.arraycopy(ct, 0, packed, iv.size, ct.size)
        prefs.edit().putString(name, Base64.encodeToString(packed, Base64.NO_WRAP)).apply()
    }

    fun get(name: String): String? {
        val packed = prefs.getString(name, null) ?: return null
        return runCatching {
            val bytes = Base64.decode(packed, Base64.NO_WRAP)
            val iv = bytes.copyOfRange(0, IV_LEN)
            val ct = bytes.copyOfRange(IV_LEN, bytes.size)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), GCMParameterSpec(128, iv))
            String(cipher.doFinal(ct), Charsets.UTF_8)
        }.getOrNull()
    }

    fun remove(name: String) = prefs.edit().remove(name).apply()

    /**
     * All secrets decrypted, for env injection. If a stored entry fails to
     * decrypt (e.g. the Keystore key was invalidated by a reinstall), log it
     * (without the value) so the missing env var is visible instead of silent.
     */
    fun all(): Map<String, String> {
        val out = HashMap<String, String>()
        for (n in names()) {
            val v = get(n)
            if (v != null) out[n] = v
            else com.ondevice.agent.service.RuntimeController.log(
                "[secrets] could not decrypt '$n' — it will be missing from the engine env"
            )
        }
        return out
    }

    private fun getOrCreateKey(): SecretKey {
        val ks = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (ks.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        gen.init(
            KeyGenParameterSpec.Builder(
                ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build()
        )
        return gen.generateKey()
    }

    companion object {
        private const val PREFS = "agent_secrets"
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val ALIAS = "ondevice_agent_secret_key"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val IV_LEN = 12
    }
}
