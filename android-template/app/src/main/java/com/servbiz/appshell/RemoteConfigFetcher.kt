package com.servbiz.appshell

import android.content.Context
import android.util.Log
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import javax.net.ssl.HttpsURLConnection

/**
 * Fetches cosmetic config overrides in the background.
 *
 * Intentionally boring: HttpURLConnection on a single-thread executor, no
 * dependency, hard size cap, HTTPS only. This never blocks the UI and a failure
 * is logged and forgotten -- the bundled config is always a working fallback.
 */
object RemoteConfigFetcher {

    private const val TAG = "RemoteConfig"
    private const val MAX_BYTES = 64 * 1024
    private const val MIN_INTERVAL_MS = 15 * 60 * 1000L

    private val executor = Executors.newSingleThreadExecutor { r ->
        Thread(r, "remote-config").apply { isDaemon = true }
    }

    fun refreshIfDue(context: Context, config: AppConfig) {
        val url = config.remoteConfig.url
        if (!config.remoteConfig.enabled || url.isNullOrBlank()) return

        val age = System.currentTimeMillis() - ConfigStore.lastFetchedAt(context)
        if (age < MIN_INTERVAL_MS) return

        val appContext = context.applicationContext
        executor.execute {
            try {
                val payload = fetch(url, config.appId, config.remoteConfig.timeoutMs)
                if (payload != null) {
                    ConfigStore.storeRemote(appContext, payload)
                    Log.i(TAG, "Stored new remote config; applies on next launch")
                }
            } catch (e: Exception) {
                Log.w(TAG, "Remote config refresh failed, keeping current config", e)
            }
        }
    }

    private fun fetch(endpoint: String, appId: String, timeoutMs: Int): JSONObject? {
        val url = URL(endpoint)
        if (!url.protocol.equals("https", ignoreCase = true)) {
            Log.w(TAG, "Refusing non-HTTPS config endpoint")
            return null
        }

        val conn = (url.openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = timeoutMs
            readTimeout = timeoutMs
            instanceFollowRedirects = false
            setRequestProperty("Accept", "application/json")
            setRequestProperty("X-Shell-App-Id", appId)
            setRequestProperty("X-Shell-Version", BuildConfig.VERSION_NAME)
        }
        if (conn !is HttpsURLConnection) {
            conn.disconnect()
            return null
        }

        return try {
            if (conn.responseCode != HttpURLConnection.HTTP_OK) {
                Log.w(TAG, "Config endpoint returned ${conn.responseCode}")
                return null
            }
            val bytes = conn.inputStream.use { input ->
                val buffer = ByteArray(MAX_BYTES)
                var total = 0
                while (total < MAX_BYTES) {
                    val read = input.read(buffer, total, MAX_BYTES - total)
                    if (read == -1) break
                    total += read
                }
                buffer.copyOf(total)
            }
            JSONObject(bytes.decodeToString())
        } finally {
            conn.disconnect()
        }
    }
}
