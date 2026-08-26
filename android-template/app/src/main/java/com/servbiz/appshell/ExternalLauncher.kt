package com.servbiz.appshell

import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.os.Environment
import android.util.Log
import android.webkit.CookieManager
import android.webkit.URLUtil
import android.widget.Toast
import androidx.core.net.toUri

/**
 * Everything that leaves the WebView.
 *
 * The intent-scheme handling here is the part that makes UPI and card checkout
 * work. Razorpay, PhonePe, GPay and most Indian PSPs bounce the user out to a
 * payment app via a non-http scheme and return by deep link. A WebView that does
 * not resolve those schemes shows the user a dead button and no error at all.
 */
object ExternalLauncher {

    private const val TAG = "ExternalLauncher"

    /** What happened to a non-http URL, so the caller can finish the job. */
    sealed interface Outcome {
        /** Another app took it. Nothing more to do. */
        data object Launched : Outcome

        /**
         * No app took it, but the URL carried a `browser_fallback_url`.
         *
         * Deliberately returned rather than opened here. The caller re-runs it
         * through the host allow-list, because a payment fallback is usually a
         * hosted checkout page on the customer's own domain -- and shoving that
         * into an external browser abandons the WebView's cookies mid-payment.
         * In-app is the right destination when the host is ours.
         */
        data class Fallback(val url: String) : Outcome

        /** Nothing could handle it; the user has been told. */
        data object Unhandled : Outcome

        /** Could not even be parsed. Let the WebView try. */
        data object Unparseable : Outcome
    }

    /** Resolves and launches a non-http URL. */
    fun openExternal(context: Context, rawUrl: String): Outcome {
        val intent = buildSafeIntent(rawUrl) ?: return Outcome.Unparseable

        return try {
            context.startActivity(intent)
            Log.i(TAG, "Handed ${intent.scheme}: off to an external app")
            Outcome.Launched
        } catch (_: ActivityNotFoundException) {
            val fallback = intent.getStringExtra("browser_fallback_url")
            if (!fallback.isNullOrBlank()) {
                Log.i(TAG, "No handler for ${intent.scheme}; using browser_fallback_url")
                Outcome.Fallback(fallback)
            } else {
                // Worth logging: "the payment button does nothing" reports are
                // almost always a missing handler app, and this is the line that
                // says so.
                Log.w(TAG, "No activity found to handle scheme: ${intent.scheme}")
                toast(context, context.getString(R.string.no_app_for_link))
                Outcome.Unhandled
            }
        } catch (e: SecurityException) {
            Log.w(TAG, "Blocked by permissions: ${intent.scheme}", e)
            toast(context, context.getString(R.string.no_app_for_link))
            Outcome.Unhandled
        }
    }

    /**
     * Parses a URL into an intent that is safe to launch from untrusted page
     * content.
     *
     * `Intent.parseUri` will happily produce an intent naming an explicit
     * component or carrying a selector. Launching that unmodified lets any page
     * in the WebView invoke this app's own private components, or third-party
     * ones, with our identity -- the classic intent-scheme redirect hole. The
     * mitigation is to strip the component and selector and require
     * CATEGORY_BROWSABLE, which limits resolution to activities that have opted
     * in to being launched from web content.
     */
    private fun buildSafeIntent(rawUrl: String): Intent? = try {
        Intent.parseUri(rawUrl, Intent.URI_INTENT_SCHEME).apply {
            addCategory(Intent.CATEGORY_BROWSABLE)
            component = null
            selector = null
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            flags = flags and
                Intent.FLAG_GRANT_READ_URI_PERMISSION.inv() and
                Intent.FLAG_GRANT_WRITE_URI_PERMISSION.inv() and
                Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION.inv() and
                Intent.FLAG_GRANT_PREFIX_URI_PERMISSION.inv()
        }
    } catch (e: Exception) {
        Log.w(TAG, "Unparseable external URL", e)
        null
    }

    fun openInBrowser(context: Context, url: String): Boolean {
        val uri = runCatching { url.toUri() }.getOrNull() ?: return false
        val scheme = uri.scheme?.lowercase()
        if (scheme != "http" && scheme != "https") return false

        val intent = Intent(Intent.ACTION_VIEW, uri).apply {
            // CATEGORY_BROWSABLE is not optional here. Without it the intent can
            // resolve to a non-browser activity, or to nothing at all -- verified
            // on an emulator, where a bare VIEW intent for https did not reach
            // Chrome but VIEW+BROWSABLE did.
            addCategory(Intent.CATEGORY_BROWSABLE)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        return try {
            context.startActivity(intent)
            Log.i(TAG, "Opened an off-host link in the browser")
            true
        } catch (_: ActivityNotFoundException) {
            Log.w(TAG, "No browser installed to open an off-host link")
            toast(context, context.getString(R.string.no_app_for_link))
            true
        }
    }

    /**
     * Hands a download to the system DownloadManager, carrying the WebView's
     * cookies so authenticated downloads (invoices, receipts, gated PDFs) do not
     * come back as a login page.
     */
    fun enqueueDownload(
        context: Context,
        url: String,
        userAgent: String?,
        contentDisposition: String?,
        mimeType: String?
    ) {
        val uri = runCatching { url.toUri() }.getOrNull()
        val scheme = uri?.scheme?.lowercase()
        if (uri == null || (scheme != "http" && scheme != "https")) {
            // blob: and data: downloads cannot be handed to DownloadManager.
            toast(context, context.getString(R.string.download_failed))
            return
        }

        val fileName = URLUtil.guessFileName(url, contentDisposition, mimeType)

        try {
            val request = DownloadManager.Request(uri).apply {
                setMimeType(mimeType)
                addRequestHeader("User-Agent", userAgent ?: "")
                CookieManager.getInstance().getCookie(url)?.let {
                    addRequestHeader("Cookie", it)
                }
                setTitle(fileName)
                setDescription(uri.host)
                setNotificationVisibility(
                    DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED
                )
                setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName)
            }
            val dm = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
            dm.enqueue(request)
            toast(context, context.getString(R.string.download_started))
        } catch (e: Exception) {
            Log.w(TAG, "Download failed for $fileName", e)
            toast(context, context.getString(R.string.download_failed))
        }
    }

    private fun toast(context: Context, message: String) {
        Toast.makeText(context, message, Toast.LENGTH_SHORT).show()
    }
}
