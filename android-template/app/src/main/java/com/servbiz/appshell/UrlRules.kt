package com.servbiz.appshell

import android.net.Uri

/**
 * Navigation policy. Pure functions, no Android context, so this is the piece
 * worth unit testing if you add tests later.
 */
object UrlRules {

    const val SENTINEL_SCHEME = "servbiz-shell"
    const val RETRY_URL = "$SENTINEL_SCHEME://retry"

    /**
     * Bundled pages are served over https through WebViewAssetLoader rather than
     * file:// so that WebSettings.allowFileAccess can stay disabled. A WebView
     * with file access enabled can be walked into reading app-private storage;
     * this reserved domain avoids needing it at all. It never touches the network.
     */
    const val ASSET_DOMAIN = "appassets.androidplatform.net"
    const val ASSET_BASE = "https://$ASSET_DOMAIN/assets/"
    const val OFFLINE_ASSET = "${ASSET_BASE}offline.html"

    enum class Action {
        /** Load inside the WebView. */
        IN_APP,

        /** Hand to the user's browser. */
        EXTERNAL_BROWSER,

        /** Hand to another installed app: upi:, tel:, mailto:, intent:, ... */
        EXTERNAL_INTENT,

        /** Our own bundled asset pages. */
        INTERNAL_ASSET,

        /** servbiz-shell:// control URLs from offline.html. */
        SENTINEL,

        /** Malformed or unsupported. Swallow it. */
        BLOCK
    }

    fun classify(rawUrl: String, config: AppConfig): Action {
        val uri = runCatching { Uri.parse(rawUrl) }.getOrNull() ?: return Action.BLOCK
        val scheme = uri.scheme?.lowercase() ?: return Action.BLOCK

        if (scheme == SENTINEL_SCHEME) return Action.SENTINEL

        // No legitimate reason for page content to reach the local filesystem.
        if (scheme == "file" || scheme == "content") return Action.BLOCK

        if (scheme == "http" || scheme == "https") {
            val host = uri.host?.lowercase() ?: return Action.BLOCK

            // Checked ahead of the allow-list so the bundled error page always
            // loads, even when the configured host list is wrong.
            if (host == ASSET_DOMAIN) return Action.INTERNAL_ASSET

            return if (isAllowedHost(host, config)) {
                Action.IN_APP
            } else if (config.behavior.externalLinksInBrowser) {
                Action.EXTERNAL_BROWSER
            } else {
                Action.IN_APP
            }
        }

        // upi:, tel:, sms:, mailto:, geo:, market:, whatsapp:, intent:, and every
        // payment-app deep link. Getting this branch wrong is the single most
        // common reason WebView wrappers break checkout flows.
        return Action.EXTERNAL_INTENT
    }

    /**
     * Exact match, or a true subdomain match when enabled.
     *
     * The `endsWith(".$allowed")` form matters: a naive `contains` or bare
     * `endsWith` would accept `example.com.attacker.net` and
     * `notexample.com` respectively.
     */
    fun isAllowedHost(host: String, config: AppConfig): Boolean {
        val allowed = effectiveAllowedHosts(config)
        if (allowed.isEmpty()) return false
        val h = host.lowercase().trimEnd('.')
        return allowed.any { a ->
            h == a || (config.buildTime.allowSubdomains && h.endsWith(".$a"))
        }
    }

    /**
     * Falls back to the start URL's own host when allowedHosts was left empty,
     * so a misconfigured app is locked to its own origin rather than open to
     * everything.
     */
    fun effectiveAllowedHosts(config: AppConfig): List<String> {
        if (config.buildTime.allowedHosts.isNotEmpty()) return config.buildTime.allowedHosts
        val host = runCatching { Uri.parse(config.buildTime.startUrl).host }.getOrNull()
        return listOfNotNull(host?.lowercase())
    }

    /** URL for the bundled error page, styled and worded to match the failure. */
    fun offlineUrl(config: AppConfig, isOffline: Boolean, detail: String?): String {
        val accent = String.format("#%06X", 0xFFFFFF and config.display.themeColor)
        val builder = Uri.parse(OFFLINE_ASSET).buildUpon()
            .appendQueryParameter("accent", accent)
            .appendQueryParameter("offline", if (isOffline) "1" else "0")
        if (!detail.isNullOrBlank()) {
            builder.appendQueryParameter("detail", detail.take(160))
        }
        return builder.build().toString()
    }
}
