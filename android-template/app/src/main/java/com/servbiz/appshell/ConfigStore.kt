package com.servbiz.appshell

import android.content.Context
import android.util.Log
import org.json.JSONObject
import java.io.IOException

/**
 * Three-layer config resolution:
 *
 *  1. `assets/config.json`  -- always present, always the source of truth for
 *                              [AppConfig.BuildTime]. Swapped by the fast-patch
 *                              build path.
 *  2. cached remote payload -- last successfully fetched overrides, applied
 *                              immediately at startup so there is no flash of
 *                              stale styling and no dependency on the network.
 *  3. fresh remote payload  -- fetched in the background, never blocking first
 *                              paint. Applied on the next launch.
 *
 * The app is fully functional with layer 1 alone. That is deliberate: the config
 * endpoint going down must be a cosmetic non-event, not an outage.
 */
object ConfigStore {

    private const val TAG = "ConfigStore"
    private const val ASSET = "config.json"
    private const val PREFS = "shell_config"
    private const val KEY_CACHED = "cached_remote"
    private const val KEY_FETCHED_AT = "cached_remote_at"

    @Volatile
    private var cached: AppConfig? = null

    fun get(context: Context): AppConfig {
        cached?.let { return it }
        synchronized(this) {
            cached?.let { return it }
            val resolved = resolve(context)
            cached = resolved
            return resolved
        }
    }

    private fun resolve(context: Context): AppConfig {
        val base = readBundled(context)
        if (!base.remoteConfig.enabled) return base

        val raw = prefs(context).getString(KEY_CACHED, null) ?: return base
        return try {
            base.merge(JSONObject(raw))
        } catch (e: Exception) {
            Log.w(TAG, "Discarding unparseable cached remote config", e)
            prefs(context).edit().remove(KEY_CACHED).apply()
            base
        }
    }

    private fun readBundled(context: Context): AppConfig = try {
        val text = context.assets.open(ASSET).use { it.readBytes().decodeToString() }
        AppConfig.parse(JSONObject(text))
    } catch (e: IOException) {
        Log.e(TAG, "assets/$ASSET missing -- shipping a broken build?", e)
        AppConfig.FALLBACK
    } catch (e: Exception) {
        Log.e(TAG, "assets/$ASSET is not valid JSON", e)
        AppConfig.FALLBACK
    }

    /** Persists a validated remote payload. Takes effect on the next launch. */
    fun storeRemote(context: Context, payload: JSONObject) {
        prefs(context).edit()
            .putString(KEY_CACHED, payload.toString())
            .putLong(KEY_FETCHED_AT, System.currentTimeMillis())
            .apply()
    }

    fun lastFetchedAt(context: Context): Long =
        prefs(context).getLong(KEY_FETCHED_AT, 0L)

    private fun prefs(context: Context) =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
