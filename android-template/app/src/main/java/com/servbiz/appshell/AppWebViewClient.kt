package com.servbiz.appshell

import android.graphics.Bitmap
import android.net.http.SslError
import android.util.Log
import android.webkit.SslErrorHandler
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader

class AppWebViewClient(
    private val config: AppConfig,
    private val assetLoader: WebViewAssetLoader,
    private val host: Host
) : WebViewClient() {

    /** Serves the bundled error page from the reserved asset domain. */
    override fun shouldInterceptRequest(
        view: WebView,
        request: WebResourceRequest
    ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)

    interface Host {
        fun onFirstContentPainted()
        fun onNavigationStarted(url: String)
        fun onNavigationFinished(url: String, canGoBack: Boolean)
        fun onMainFrameFailure(failingUrl: String, isOffline: Boolean, detail: String?)
        fun onRetryRequested()
        fun openExternalUrl(url: String): Boolean
        fun openBrowserUrl(url: String): Boolean
    }

    override fun shouldOverrideUrlLoading(
        view: WebView,
        request: WebResourceRequest
    ): Boolean {
        val url = request.url.toString()
        val action = UrlRules.classify(url, config)

        // "The link does nothing" is the most common support report for a WebView
        // shell, and this single line is what tells you which branch was taken.
        // Scheme and host only -- never the full URL, which can carry session
        // tokens in query parameters.
        Log.d(TAG, "nav ${request.url.scheme}://${request.url.host ?: "-"} -> $action")

        return when (action) {
            UrlRules.Action.IN_APP,
            UrlRules.Action.INTERNAL_ASSET -> false

            // Returning false when the handoff fails lets the WebView load the
            // URL itself, so a device with no browser or no payment app still
            // shows the user something instead of an unresponsive link.
            UrlRules.Action.EXTERNAL_BROWSER -> host.openBrowserUrl(url)

            UrlRules.Action.EXTERNAL_INTENT -> host.openExternalUrl(url)

            UrlRules.Action.SENTINEL -> {
                if (url.startsWith(UrlRules.RETRY_URL)) host.onRetryRequested()
                true
            }

            UrlRules.Action.BLOCK -> {
                Log.w(TAG, "Blocked navigation to an unsupported URL")
                true
            }
        }
    }

    override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
        if (!isAssetPage(url)) host.onNavigationStarted(url)
    }

    /**
     * Fires when the first pixel of real content is painted. This is the correct
     * moment to drop the splash overlay -- onPageFinished waits for every
     * subresource and leaves the user looking at a splash long after the page is
     * usable.
     */
    override fun onPageCommitVisible(view: WebView, url: String) {
        host.onFirstContentPainted()
    }

    override fun onPageFinished(view: WebView, url: String) {
        host.onNavigationFinished(url, view.canGoBack())
        // Belt and braces: if onPageCommitVisible never fired (cached pages,
        // some vendor WebViews), make sure the splash still comes down.
        host.onFirstContentPainted()
    }

    override fun onReceivedError(
        view: WebView,
        request: WebResourceRequest,
        error: WebResourceError
    ) {
        // Subresource failures are the site's problem, not a reason to replace
        // the whole page with an error screen.
        if (!request.isForMainFrame) return

        // Never react to a failure of the error page itself, or we loop.
        if (isAssetPage(request.url.toString())) return

        val code = error.errorCode
        val offline = code == ERROR_HOST_LOOKUP ||
            code == ERROR_CONNECT ||
            code == ERROR_IO ||
            code == ERROR_TIMEOUT

        Log.w(TAG, "Main frame failed: code=$code")
        host.onMainFrameFailure(
            request.url.toString(),
            offline,
            error.description?.toString()
        )
    }

    override fun onReceivedHttpError(
        view: WebView,
        request: WebResourceRequest,
        errorResponse: WebResourceResponse
    ) {
        if (!request.isForMainFrame) return
        if (isAssetPage(request.url.toString())) return
        val status = errorResponse.statusCode
        if (status < 500) return  // let the site render its own 404

        Log.w(TAG, "Main frame HTTP error: $status")
        host.onMainFrameFailure(request.url.toString(), false, "HTTP $status")
    }

    /**
     * Certificate errors are never proceeded past.
     *
     * The default implementation already cancels, but this override is here so
     * that nobody "fixes" a self-signed staging certificate by calling
     * handler.proceed(). Doing that would strip TLS protection from every app
     * built off this template at once.
     */
    override fun onReceivedSslError(
        view: WebView,
        handler: SslErrorHandler,
        error: SslError
    ) {
        Log.e(TAG, "TLS error ${error.primaryError} for ${error.url}; cancelling")
        handler.cancel()
        host.onMainFrameFailure(error.url ?: "", false, "Secure connection failed")
    }

    private fun isAssetPage(url: String) = url.startsWith(UrlRules.ASSET_BASE)

    private companion object {
        const val TAG = "AppWebViewClient"
    }
}
