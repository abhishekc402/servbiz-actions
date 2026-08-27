package com.servbiz.appshell

import android.Manifest
import android.animation.ObjectAnimator
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.util.Log
import android.view.View
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.WebViewAssetLoader
import com.servbiz.appshell.databinding.ActivityMainBinding
import java.io.File
import kotlin.math.max

class MainActivity : AppCompatActivity(), AppWebViewClient.Host {

    private lateinit var binding: ActivityMainBinding
    private lateinit var config: AppConfig
    private lateinit var assetLoader: WebViewAssetLoader

    private val mainHandler = Handler(Looper.getMainLooper())
    private lateinit var backCallback: OnBackPressedCallback
    private var splashDismissed = false
    private var lastFailedUrl: String? = null
    private var backPressedAt = 0L

    // --- file upload state -------------------------------------------------
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null
    private var pendingCaptureUri: Uri? = null
    private var pendingCaptureFile: File? = null
    private lateinit var fileChooserLauncher: ActivityResultLauncher<Intent>

    // --- webview permission state ------------------------------------------
    private var pendingWebPermission: PermissionRequest? = null
    private var pendingGeolocationOrigin: String? = null
    private var pendingGeolocationCallback: GeolocationPermissions.Callback? = null
    private lateinit var permissionLauncher: ActivityResultLauncher<Array<String>>

    // -----------------------------------------------------------------------

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        config = ConfigStore.get(this)

        // Config is applied before inflate so the very first frame is already
        // the right colour and orientation. Swap off the launch theme first,
        // then opt into edge-to-edge, then inflate.
        setTheme(R.style.Theme_AppShell)
        applyOrientation()
        enableEdgeToEdge()

        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        assetLoader = WebViewAssetLoader.Builder()
            .setDomain(UrlRules.ASSET_DOMAIN)
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        registerLaunchers()
        applyWindowChrome()
        applySplashStyling()
        configureWebView()
        configurePullToRefresh()
        registerBackHandler()

        if (savedInstanceState != null) {
            binding.webView.restoreState(savedInstanceState)
            // Restored state paints from cache, so the splash can go immediately.
            dismissSplash(animate = false)
        } else {
            loadStartUrl()
        }

        // Splash safety net. A site that never fires onPageCommitVisible must
        // not leave the user staring at a logo forever.
        mainHandler.postDelayed({ dismissSplash() }, config.splash.maxWaitMs)

        RemoteConfigFetcher.refreshIfDue(this, config)
    }

    // === configuration =====================================================

    private fun applyOrientation() {
        requestedOrientation = when (config.display.orientation.lowercase()) {
            "portrait" -> ActivityInfo.SCREEN_ORIENTATION_USER_PORTRAIT
            "landscape" -> ActivityInfo.SCREEN_ORIENTATION_USER_LANDSCAPE
            else -> ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        }
    }

    private fun applyWindowChrome() {
        val controller = WindowCompat.getInsetsController(window, binding.root)

        // config.lightStatusBarIcons describes the ICONS; the platform flag
        // describes the BACKGROUND. They are inverses of each other.
        controller.isAppearanceLightStatusBars = !config.display.lightStatusBarIcons
        controller.isAppearanceLightNavigationBars = !config.display.lightStatusBarIcons

        // fullscreen stays the blunt instrument: both bars away, swipe to reveal.
        // The per-bar flags exist for hiding one and keeping the other, which
        // fullscreen cannot express.
        val hideStatus = config.display.fullscreen || config.display.hideStatusBar
        val hideNav = config.display.fullscreen || config.display.hideNavigationBar

        if (hideStatus) controller.hide(WindowInsetsCompat.Type.statusBars())
        if (hideNav) controller.hide(WindowInsetsCompat.Type.navigationBars())
        if (hideStatus || hideNav) {
            controller.systemBarsBehavior =
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }

        applyCutoutMode()

        // A window flag, not the WAKE_LOCK permission: it stays patchable, and the
        // system releases it with the window rather than leaving it held.
        if (config.behavior.keepScreenOn) {
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }

        // The root now carries the page background; the two scrims paint the strips
        // behind the system bars. Previously the root was tinted with themeColor and
        // padded, which meant both bars necessarily shared one colour.
        binding.root.setBackgroundColor(config.display.backgroundColor)
        binding.statusScrim.setBackgroundColor(config.display.themeColor)
        binding.navScrim.setBackgroundColor(config.display.navigationBarColor)

        ViewCompat.setOnApplyWindowInsetsListener(binding.root) { _, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())

            val top = if (hideStatus) 0 else bars.top
            // Keyboard wins over the nav bar so form fields stay reachable;
            // adjustResize alone does not do this under edge-to-edge.
            val bottom = max(if (hideNav) 0 else bars.bottom, ime.bottom)

            // Padding moved off the root and onto the content layers, so the scrims
            // can still occupy the inset areas.
            binding.refresh.setPadding(bars.left, top, bars.right, bottom)
            binding.splashOverlay.setPadding(bars.left, top, bars.right, bottom)

            resize(binding.statusScrim, top)
            // While the keyboard is up it covers the navigation bar, so a scrim
            // sized to the nav inset would float above the keyboard instead.
            resize(binding.navScrim, if (ime.bottom > 0 || hideNav) 0 else bars.bottom)

            WindowInsetsCompat.CONSUMED
        }
    }

    /** Sets a view's height without disturbing the rest of its layout params. */
    private fun resize(view: View, height: Int) {
        val lp = view.layoutParams
        if (lp.height != height) {
            lp.height = height
            view.layoutParams = lp
        }
    }

    /**
     * Whether the app may draw into a notch or punch-hole.
     *
     * Set in code rather than as a theme attribute so it stays on the fast-patch
     * path -- a theme attribute is a compiled resource and would force a full
     * rebuild. shortEdges is the only mode that reaches into the cutout, and it is
     * worth pairing with a dark theme colour, since content then sits beside the
     * camera.
     */
    private fun applyCutoutMode() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return
        window.attributes = window.attributes.apply {
            layoutInDisplayCutoutMode = when (config.display.cutoutMode) {
                "shortEdges" ->
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
                "never" ->
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_NEVER
                else ->
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_DEFAULT
            }
        }
    }

    private fun applySplashStyling() {
        binding.splashOverlay.setBackgroundColor(config.splash.backgroundColor)
        binding.splashLogo.visibility =
            if (config.splash.showLogo) View.VISIBLE else View.GONE

        // Keep the spinner legible whatever the splash colour is.
        val onLight = isLight(config.splash.backgroundColor)
        binding.splashProgress.indeterminateTintList =
            android.content.res.ColorStateList.valueOf(
                if (onLight) config.display.themeColor else Color.WHITE
            )
    }

    // JavaScript is the entire point of the shell, and the two file-URL settings
    // are deprecated but still the only way to be explicit about turning them off
    // on older API levels.
    @Suppress("SetJavaScriptEnabled", "DEPRECATION")
    private fun configureWebView() = with(binding.webView) {
        setBackgroundColor(config.display.backgroundColor)

        settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true

            loadWithOverviewMode = true
            useWideViewPort = true
            builtInZoomControls = false
            displayZoomControls = false

            // Autoplay of muted video, carousels and similar all depend on this.
            mediaPlaybackRequiresUserGesture = false

            // target="_blank" links do nothing at all without this plus
            // onCreateWindow below.
            setSupportMultipleWindows(true)
            javaScriptCanOpenWindowsAutomatically = true

            // Hardening. The bundled error page is served through
            // WebViewAssetLoader, so no file:// access is required anywhere.
            allowFileAccess = false
            allowContentAccess = false
            allowFileAccessFromFileURLs = false
            allowUniversalAccessFromFileURLs = false

            // Off by default. Sites still loading http subresources should be
            // fixed rather than accommodated, but the flag exists for the rare
            // legacy customer site that cannot be.
            mixedContentMode = if (config.behavior.allowMixedContent) {
                WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            } else {
                WebSettings.MIXED_CONTENT_NEVER_ALLOW
            }

            setGeolocationEnabled(config.behavior.allowGeolocation)

            cacheMode = WebSettings.LOAD_DEFAULT
            if (config.behavior.userAgentSuffix.isNotBlank()) {
                // Lets the site detect the shell and hide "download our app"
                // banners, install prompts and similar.
                userAgentString = "$userAgentString ${config.behavior.userAgentSuffix}"
            }
        }

        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            // Most third-party auth and payment flows set cookies from another
            // origin inside an iframe. Without this, they silently fail to
            // establish a session.
            setAcceptThirdPartyCookies(this@with, true)
        }

        webViewClient = AppWebViewClient(config, assetLoader, this@MainActivity)
        webChromeClient = ShellChromeClient()

        if (config.behavior.handleDownloads) {
            setDownloadListener { url, userAgent, disposition, mimeType, _ ->
                ExternalLauncher.enqueueDownload(
                    this@MainActivity, url, userAgent, disposition, mimeType
                )
            }
        }
    }

    private fun configurePullToRefresh() {
        binding.refresh.isEnabled = config.behavior.pullToRefresh
        binding.refresh.setColorSchemeColors(config.display.themeColor)
        binding.refresh.setOnRefreshListener {
            lastFailedUrl = null
            binding.webView.reload()
        }
        // Without this, the gesture fires whenever the user swipes down anywhere
        // in the page, hijacking scroll partway through an article.
        binding.refresh.setOnChildScrollUpCallback { _, _ ->
            binding.webView.scrollY > 0
        }
    }

    /**
     * Back handling, with predictive back in mind.
     *
     * The manifest opts into `enableOnBackInvokedCallback`, which is required for
     * Android 13+ predictive back and which becomes mandatory as the legacy
     * `onBackPressed` path is retired. The catch: a callback that is *always*
     * enabled suppresses the predictive animation entirely, because the system
     * cannot preview an exit it knows the app will intercept.
     *
     * So the callback is enabled only while there is WebView history to pop.
     * When there is nothing to go back to, the system handles back itself and the
     * user gets the native predictive gesture. `confirmExitOnBack` opts out of
     * that in exchange for a double-tap confirmation, which is why it now
     * defaults to false.
     */
    private fun registerBackHandler() {
        backCallback = object : OnBackPressedCallback(config.behavior.confirmExitOnBack) {
            override fun handleOnBackPressed() {
                when {
                    binding.webView.canGoBack() -> {
                        binding.webView.goBack()
                        syncBackCallback()
                    }

                    // Only reachable when confirmExitOnBack is set; otherwise the
                    // callback is disabled and the system never routes here.
                    System.currentTimeMillis() - backPressedAt < EXIT_CONFIRM_WINDOW_MS -> finish()

                    config.behavior.confirmExitOnBack -> {
                        backPressedAt = System.currentTimeMillis()
                        toast(getString(R.string.exit_confirm))
                    }

                    else -> finish()
                }
            }
        }
        onBackPressedDispatcher.addCallback(this, backCallback)
    }

    /** Keeps the back callback's enabled state in step with WebView history. */
    private fun syncBackCallback() {
        if (!::backCallback.isInitialized) return
        backCallback.isEnabled = config.behavior.confirmExitOnBack || binding.webView.canGoBack()
    }

    private fun registerLaunchers() {
        fileChooserLauncher = registerForActivityResult(
            ActivityResultContracts.StartActivityForResult()
        ) { result -> deliverFileChooserResult(result.resultCode, result.data) }

        permissionLauncher = registerForActivityResult(
            ActivityResultContracts.RequestMultiplePermissions()
        ) { grants -> deliverPermissionResult(grants) }
    }

    // === navigation ========================================================

    private fun loadStartUrl() {
        val url = config.buildTime.startUrl
        if (UrlRules.effectiveAllowedHosts(config).isEmpty()) {
            Log.e(TAG, "No resolvable host for startUrl; showing error page")
            showErrorPage(isOffline = false, detail = "App is misconfigured")
            return
        }
        binding.webView.loadUrl(url)
    }

    private fun showErrorPage(isOffline: Boolean, detail: String?) {
        dismissSplash()
        binding.refresh.isRefreshing = false
        binding.webView.loadUrl(UrlRules.offlineUrl(config, isOffline, detail))
    }

    private fun isOnline(): Boolean {
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            ?: return true
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    // === AppWebViewClient.Host =============================================

    override fun onFirstContentPainted() = dismissSplash()

    override fun onNavigationStarted(url: String) {
        // Only a genuinely different destination clears the remembered failure.
        //
        // onPageStarted is NOT guaranteed to precede onReceivedHttpError. For a
        // main-frame response with an error status the observed order is
        // shouldOverrideUrlLoading -> onReceivedHttpError -> onPageStarted, since
        // the error document is still committed for rendering. Clearing
        // unconditionally therefore wiped lastFailedUrl immediately after it was
        // set, and Retry silently fell back to the start URL instead of the page
        // the user was actually trying to reach.
        if (url != lastFailedUrl) {
            lastFailedUrl = null
        }
    }

    override fun onNavigationFinished(url: String, canGoBack: Boolean) {
        binding.refresh.isRefreshing = false
        syncBackCallback()
    }

    override fun onMainFrameFailure(failingUrl: String, isOffline: Boolean, detail: String?) {
        // Remembered so Retry returns to the page the user actually wanted,
        // not just the app's start URL.
        lastFailedUrl = failingUrl.takeIf {
            it.isNotBlank() && !it.startsWith(UrlRules.ASSET_BASE)
        }
        Log.d(TAG, "failure on ${pathOf(failingUrl)}; lastFailedUrl=${pathOf(lastFailedUrl)}")
        showErrorPage(isOffline || !isOnline(), detail)
    }

    override fun onRetryRequested() {
        val target = lastFailedUrl ?: config.buildTime.startUrl
        Log.i(TAG, "retry -> ${pathOf(target)} (remembered=${lastFailedUrl != null})")

        // Posted, not called directly. onRetryRequested runs inside
        // shouldOverrideUrlLoading, and a loadUrl issued synchronously from there
        // is silently dropped -- the WebView is still resolving the current
        // navigation decision. Symptom: the Try again button on the error page
        // does nothing at all, on the one screen a user only sees when something
        // has already gone wrong.
        binding.webView.post { binding.webView.loadUrl(target) }
    }

    override fun openExternalUrl(url: String): Boolean =
        when (val outcome = ExternalLauncher.openExternal(this, url)) {
            is ExternalLauncher.Outcome.Launched,
            is ExternalLauncher.Outcome.Unhandled -> true

            // Re-classify the fallback instead of forcing it into a browser. A
            // payment fallback almost always points at a hosted checkout page on
            // the customer's own domain, and sending that to an external browser
            // loses the WebView's session cookies mid-transaction.
            is ExternalLauncher.Outcome.Fallback -> {
                routePopup(outcome.url)
                true
            }

            // Unparseable: let the WebView have a go rather than swallowing it.
            is ExternalLauncher.Outcome.Unparseable -> false
        }

    override fun openBrowserUrl(url: String): Boolean =
        ExternalLauncher.openInBrowser(this, url)

    // === splash ============================================================

    private fun dismissSplash(animate: Boolean = true) {
        if (splashDismissed) return
        splashDismissed = true
        mainHandler.removeCallbacksAndMessages(null)

        if (!animate) {
            binding.splashOverlay.visibility = View.GONE
            return
        }

        ObjectAnimator.ofFloat(binding.splashOverlay, View.ALPHA, 1f, 0f).apply {
            duration = SPLASH_FADE_MS
            addListener(object : android.animation.AnimatorListenerAdapter() {
                override fun onAnimationEnd(animation: android.animation.Animator) {
                    binding.splashOverlay.visibility = View.GONE
                }
            })
            start()
        }
    }

    // === WebChromeClient ===================================================

    private inner class ShellChromeClient : WebChromeClient() {

        override fun onProgressChanged(view: WebView, newProgress: Int) {
            if (newProgress >= FIRST_PAINT_PROGRESS) dismissSplash()
        }

        /**
         * target="_blank" and window.open().
         *
         * A throwaway WebView is used purely to capture the URL the popup wants,
         * then routed through the normal policy and destroyed. Returning false
         * here (the default) is what makes those links appear broken.
         */
        override fun onCreateWindow(
            view: WebView,
            isDialog: Boolean,
            isUserGesture: Boolean,
            resultMsg: android.os.Message
        ): Boolean {
            val transport = resultMsg.obj as? WebView.WebViewTransport ?: return false

            val proxy = WebView(this@MainActivity)
            proxy.webViewClient = object : android.webkit.WebViewClient() {
                override fun shouldOverrideUrlLoading(
                    v: WebView,
                    request: android.webkit.WebResourceRequest
                ): Boolean {
                    routePopup(request.url.toString())
                    // Destroying a WebView from inside its own callback is not
                    // safe; hand it to the next loop iteration.
                    mainHandler.post { proxy.destroy() }
                    return true
                }
            }
            transport.webView = proxy
            resultMsg.sendToTarget()
            return true
        }

        override fun onShowFileChooser(
            view: WebView,
            filePathCallback: ValueCallback<Array<Uri>>,
            params: FileChooserParams
        ): Boolean {
            if (!config.behavior.allowFileUploads) return false
            return startFileChooser(filePathCallback, params)
        }

        override fun onPermissionRequest(request: PermissionRequest) {
            val needed = mutableListOf<String>()
            for (resource in request.resources) {
                when (resource) {
                    PermissionRequest.RESOURCE_VIDEO_CAPTURE -> {
                        if (!config.behavior.allowCamera) {
                            request.deny(); return
                        }
                        needed += Manifest.permission.CAMERA
                    }
                    PermissionRequest.RESOURCE_AUDIO_CAPTURE -> {
                        if (!config.behavior.allowMicrophone) {
                            request.deny(); return
                        }
                        needed += Manifest.permission.RECORD_AUDIO
                    }
                    // Protected media and midi are not granted by the shell.
                    else -> {
                        request.deny(); return
                    }
                }
            }

            val missing = needed.filterNot { hasPermission(it) }
            if (missing.isEmpty()) {
                request.grant(request.resources)
                return
            }

            pendingWebPermission = request
            permissionLauncher.launch(missing.toTypedArray())
        }

        override fun onPermissionRequestCanceled(request: PermissionRequest) {
            if (pendingWebPermission == request) pendingWebPermission = null
        }

        override fun onGeolocationPermissionsShowPrompt(
            origin: String,
            callback: GeolocationPermissions.Callback
        ) {
            if (!config.behavior.allowGeolocation) {
                callback.invoke(origin, false, false)
                return
            }
            // Only the app's own origin gets location, never a third-party frame.
            val host = runCatching { Uri.parse(origin).host }.getOrNull()
            if (host == null || !UrlRules.isAllowedHost(host, config)) {
                callback.invoke(origin, false, false)
                return
            }

            if (hasPermission(Manifest.permission.ACCESS_FINE_LOCATION) ||
                hasPermission(Manifest.permission.ACCESS_COARSE_LOCATION)
            ) {
                callback.invoke(origin, true, false)
                return
            }

            pendingGeolocationOrigin = origin
            pendingGeolocationCallback = callback
            permissionLauncher.launch(
                arrayOf(
                    Manifest.permission.ACCESS_FINE_LOCATION,
                    Manifest.permission.ACCESS_COARSE_LOCATION
                )
            )
        }
    }

    private fun routePopup(url: String) {
        when (UrlRules.classify(url, config)) {
            UrlRules.Action.IN_APP,
            UrlRules.Action.INTERNAL_ASSET -> binding.webView.loadUrl(url)

            UrlRules.Action.EXTERNAL_BROWSER -> openBrowserUrl(url)
            UrlRules.Action.EXTERNAL_INTENT -> openExternalUrl(url)
            UrlRules.Action.SENTINEL -> onRetryRequested()
            UrlRules.Action.BLOCK -> Unit
        }
    }

    // === file chooser ======================================================

    private fun startFileChooser(
        callback: ValueCallback<Array<Uri>>,
        params: WebChromeClient.FileChooserParams
    ): Boolean {
        // A previous request that never resolved would wedge the WebView's file
        // input permanently. Cancel it explicitly before taking a new one.
        fileChooserCallback?.onReceiveValue(null)
        fileChooserCallback = callback
        pendingCaptureUri = null

        // accept="" can legitimately hold bare extensions (".pdf") as well as
        // MIME types. Only the latter mean anything to an Intent, so extensions
        // are dropped rather than passed through as a bogus type.
        val mimeTypes = params.acceptTypes
            .map { it.trim() }
            .filter { it.isNotBlank() && it.contains('/') }
            .distinct()
            .toTypedArray()

        val contentIntent = Intent(Intent.ACTION_GET_CONTENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = mimeTypes.singleOrNull() ?: "*/*"
            if (mimeTypes.size > 1) putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes)
            putExtra(
                Intent.EXTRA_ALLOW_MULTIPLE,
                params.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE
            )
        }

        val chooser = Intent.createChooser(contentIntent, getString(R.string.choose_file))

        // Offer the camera directly when the input accepts images and the app is
        // configured for it -- otherwise users have to leave, take a photo and
        // come back.
        captureIntentOrNull(mimeTypes)?.let { capture ->
            chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, arrayOf(capture))
        }

        return try {
            fileChooserLauncher.launch(chooser)
            true
        } catch (_: ActivityNotFoundException) {
            fileChooserCallback = null
            false
        }
    }

    private fun captureIntentOrNull(mimeTypes: Array<String>): Intent? {
        if (!config.behavior.allowCamera) return null
        val wantsImage = mimeTypes.isEmpty() ||
            mimeTypes.any { it.startsWith("image/") || it == "*/*" }
        if (!wantsImage) return null
        if (!hasPermission(Manifest.permission.CAMERA)) return null

        return try {
            val dir = File(cacheDir, "captures").apply { mkdirs() }
            val file = File.createTempFile("capture_", ".jpg", dir)
            val uri = FileProvider.getUriForFile(
                this, "$packageName.fileprovider", file
            )
            pendingCaptureUri = uri
            pendingCaptureFile = file
            Intent(MediaStore.ACTION_IMAGE_CAPTURE).apply {
                putExtra(MediaStore.EXTRA_OUTPUT, uri)
                addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            }
        } catch (e: Exception) {
            Log.w(TAG, "Could not prepare a camera capture target", e)
            pendingCaptureUri = null
            pendingCaptureFile = null
            null
        }
    }

    private fun deliverFileChooserResult(resultCode: Int, data: Intent?) {
        val callback = fileChooserCallback ?: return
        fileChooserCallback = null

        if (resultCode != Activity.RESULT_OK) {
            callback.onReceiveValue(null)
            discardPendingCapture()
            return
        }

        val clip = data?.clipData
        val single = data?.data
        val uris: Array<Uri>? = when {
            clip != null && clip.itemCount > 0 ->
                Array(clip.itemCount) { i -> clip.getItemAt(i).uri }

            single != null -> arrayOf(single)

            // A camera capture returns no data at all; the file is at the URI we
            // handed out. Only treat it as a result if it actually has bytes.
            else -> pendingCaptureUri?.takeIf { captureHasContent(it) }?.let { arrayOf(it) }
        }

        if (uris == null) discardPendingCapture()
        callback.onReceiveValue(uris)
    }

    private fun captureHasContent(uri: Uri): Boolean = try {
        contentResolver.openAssetFileDescriptor(uri, "r")?.use { it.length > 0 } ?: false
    } catch (_: Exception) {
        false
    }

    private fun discardPendingCapture() {
        // The real File is kept alongside the content:// URI because a
        // FileProvider URI's path is not a filesystem path and cannot be deleted
        // through it.
        val file = pendingCaptureFile
        pendingCaptureUri = null
        pendingCaptureFile = null
        runCatching { file?.takeIf(File::exists)?.delete() }
    }

    // === permissions =======================================================

    private fun hasPermission(permission: String) =
        ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

    private fun deliverPermissionResult(grants: Map<String, Boolean>) {
        val anyGranted = grants.values.any { it }

        pendingWebPermission?.let { request ->
            pendingWebPermission = null
            if (grants.values.all { it }) {
                request.grant(request.resources)
            } else {
                request.deny()
                toast(getString(R.string.permission_denied))
            }
        }

        val origin = pendingGeolocationOrigin
        val geoCallback = pendingGeolocationCallback
        if (origin != null && geoCallback != null) {
            pendingGeolocationOrigin = null
            pendingGeolocationCallback = null
            geoCallback.invoke(origin, anyGranted, false)
            if (!anyGranted) toast(getString(R.string.permission_denied))
        }
    }

    // === lifecycle =========================================================

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        binding.webView.saveState(outState)
    }

    override fun onResume() {
        super.onResume()
        binding.webView.onResume()
        binding.webView.resumeTimers()
    }

    override fun onPause() {
        // Stops JS timers, animations and media while backgrounded. Without it,
        // a site with a carousel or video keeps draining battery.
        binding.webView.onPause()
        binding.webView.pauseTimers()
        super.onPause()
    }

    override fun onDestroy() {
        mainHandler.removeCallbacksAndMessages(null)
        fileChooserCallback?.onReceiveValue(null)
        fileChooserCallback = null
        pendingWebPermission?.deny()
        pendingWebPermission = null
        CookieManager.getInstance().flush()
        binding.webView.apply {
            stopLoading()
            webChromeClient = null
            destroy()
        }
        super.onDestroy()
    }

    // === helpers ===========================================================

    private fun toast(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
    }

    /**
     * Path component only, for logging. Query strings are deliberately dropped:
     * they routinely carry session tokens and one-time links, and logcat is not a
     * place to put those.
     */
    private fun pathOf(url: String?): String {
        if (url.isNullOrBlank()) return "(none)"
        return runCatching { Uri.parse(url).path?.ifEmpty { "/" } ?: "/" }.getOrDefault("?")
    }

    private fun isLight(color: Int): Boolean {
        val luminance = (0.299 * Color.red(color) +
            0.587 * Color.green(color) +
            0.114 * Color.blue(color)) / 255.0
        return luminance > 0.6
    }

    private companion object {
        const val TAG = "MainActivity"
        const val SPLASH_FADE_MS = 220L
        const val EXIT_CONFIRM_WINDOW_MS = 2000L

        /** Enough of the page has arrived that the splash is just in the way. */
        const val FIRST_PAINT_PROGRESS = 70
    }
}
