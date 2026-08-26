package com.servbiz.appshell

import android.graphics.Color
import org.json.JSONObject

/**
 * Immutable snapshot of everything the shell can be told about itself.
 *
 * The split between [buildTime] and the rest is a security boundary, not just
 * organisation. Remote config can restyle an app but it can never repoint it:
 * a compromise of the config endpoint must not be able to redirect installed
 * apps at an attacker's page. See [merge].
 */
data class AppConfig(
    val configVersion: Int,
    val appId: String,
    val buildTime: BuildTime,
    val display: Display,
    val splash: Splash,
    val behavior: Behavior,
    val remoteConfig: Remote
) {
    /** Fixed at build time. Never overridable from the network. */
    data class BuildTime(
        val startUrl: String,
        val allowedHosts: List<String>,
        val allowSubdomains: Boolean
    )

    data class Display(
        val fullscreen: Boolean,
        val orientation: String,
        val themeColor: Int,
        val backgroundColor: Int,
        val lightStatusBarIcons: Boolean
    )

    data class Splash(
        val backgroundColor: Int,
        val showLogo: Boolean,
        val maxWaitMs: Long
    )

    data class Behavior(
        val pullToRefresh: Boolean,
        val externalLinksInBrowser: Boolean,
        val userAgentSuffix: String,
        val allowFileUploads: Boolean,
        val allowGeolocation: Boolean,
        val allowCamera: Boolean,
        val allowMicrophone: Boolean,
        val allowMixedContent: Boolean,
        val confirmExitOnBack: Boolean,
        val openPopupsInApp: Boolean,
        val handleDownloads: Boolean
    )

    data class Remote(
        val enabled: Boolean,
        val url: String?,
        val timeoutMs: Int
    )

    /**
     * Applies a remote payload on top of this config.
     *
     * [buildTime] and [remoteConfig] are carried over from the local config
     * verbatim. Even if the remote payload contains those keys they are ignored,
     * so the worst outcome of a hostile or corrupted payload is an app with the
     * wrong colours -- not one pointing at a different origin, and not one that
     * has been redirected to a different config server.
     */
    fun merge(remote: JSONObject): AppConfig = copy(
        configVersion = remote.optInt("configVersion", configVersion),
        display = parseDisplay(remote.optJSONObject("display"), display),
        splash = parseSplash(remote.optJSONObject("splash"), splash),
        behavior = parseBehavior(remote.optJSONObject("behavior"), behavior)
    )

    companion object {
        /** Used only if the bundled asset is missing or unparseable. */
        val FALLBACK = AppConfig(
            configVersion = 0,
            appId = "unknown",
            buildTime = BuildTime("about:blank", emptyList(), false),
            display = Display(false, "unspecified", 0xFF0F172A.toInt(), Color.WHITE, true),
            splash = Splash(Color.WHITE, true, 10_000L),
            behavior = Behavior(
                pullToRefresh = true,
                externalLinksInBrowser = true,
                userAgentSuffix = "",
                allowFileUploads = true,
                allowGeolocation = false,
                allowCamera = false,
                allowMicrophone = false,
                allowMixedContent = false,
                confirmExitOnBack = false,
                openPopupsInApp = true,
                handleDownloads = true
            ),
            remoteConfig = Remote(enabled = false, url = null, timeoutMs = 2500)
        )

        fun parse(json: JSONObject): AppConfig {
            val bt = json.optJSONObject("buildTime") ?: JSONObject()
            val hosts = bt.optJSONArray("allowedHosts")
            return AppConfig(
                configVersion = json.optInt("configVersion", 1),
                appId = json.optString("appId", "unknown"),
                buildTime = BuildTime(
                    startUrl = bt.optString("startUrl", FALLBACK.buildTime.startUrl),
                    allowedHosts = buildList {
                        for (i in 0 until (hosts?.length() ?: 0)) {
                            hosts?.optString(i)
                                ?.trim()
                                ?.lowercase()
                                ?.takeIf { it.isNotEmpty() }
                                ?.let { add(it) }
                        }
                    },
                    allowSubdomains = bt.optBoolean("allowSubdomains", true)
                ),
                display = parseDisplay(json.optJSONObject("display"), FALLBACK.display),
                splash = parseSplash(json.optJSONObject("splash"), FALLBACK.splash),
                behavior = parseBehavior(json.optJSONObject("behavior"), FALLBACK.behavior),
                remoteConfig = json.optJSONObject("remoteConfig").let { rc ->
                    Remote(
                        enabled = rc?.optBoolean("enabled", false) ?: false,
                        url = rc?.optString("url")?.takeIf {
                            it.isNotBlank() && it != "null" && it.startsWith("https://")
                        },
                        timeoutMs = (rc?.optInt("timeoutMs", 2500) ?: 2500).coerceIn(500, 10_000)
                    )
                }
            )
        }

        private fun parseDisplay(o: JSONObject?, d: Display): Display {
            if (o == null) return d
            return Display(
                fullscreen = o.optBoolean("fullscreen", d.fullscreen),
                orientation = o.optString("orientation", d.orientation),
                themeColor = color(o.optString("themeColor"), d.themeColor),
                backgroundColor = color(o.optString("backgroundColor"), d.backgroundColor),
                lightStatusBarIcons = o.optBoolean("lightStatusBarIcons", d.lightStatusBarIcons)
            )
        }

        private fun parseSplash(o: JSONObject?, d: Splash): Splash {
            if (o == null) return d
            return Splash(
                backgroundColor = color(o.optString("backgroundColor"), d.backgroundColor),
                showLogo = o.optBoolean("showLogo", d.showLogo),
                maxWaitMs = o.optLong("maxWaitMs", d.maxWaitMs).coerceIn(1_000L, 30_000L)
            )
        }

        private fun parseBehavior(o: JSONObject?, d: Behavior): Behavior {
            if (o == null) return d
            return Behavior(
                pullToRefresh = o.optBoolean("pullToRefresh", d.pullToRefresh),
                externalLinksInBrowser = o.optBoolean("externalLinksInBrowser", d.externalLinksInBrowser),
                userAgentSuffix = o.optString("userAgentSuffix", d.userAgentSuffix),
                allowFileUploads = o.optBoolean("allowFileUploads", d.allowFileUploads),
                allowGeolocation = o.optBoolean("allowGeolocation", d.allowGeolocation),
                allowCamera = o.optBoolean("allowCamera", d.allowCamera),
                allowMicrophone = o.optBoolean("allowMicrophone", d.allowMicrophone),
                allowMixedContent = o.optBoolean("allowMixedContent", d.allowMixedContent),
                confirmExitOnBack = o.optBoolean("confirmExitOnBack", d.confirmExitOnBack),
                openPopupsInApp = o.optBoolean("openPopupsInApp", d.openPopupsInApp),
                handleDownloads = o.optBoolean("handleDownloads", d.handleDownloads)
            )
        }

        private fun color(raw: String?, fallback: Int): Int {
            val v = raw?.trim().orEmpty()
            if (!Regex("^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$").matches(v)) return fallback
            return try {
                Color.parseColor(v)
            } catch (_: IllegalArgumentException) {
                fallback
            }
        }
    }
}
