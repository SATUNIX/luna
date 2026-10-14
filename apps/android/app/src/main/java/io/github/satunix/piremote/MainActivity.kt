package io.github.satunix.piremote

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.TypedValue
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.lifecycleScope
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.IOException
import kotlin.math.roundToInt

/**
 * One full-screen WebView showing the kit's mobile interface from the APK's own assets, at
 * https://appassets.androidplatform.net. The page has no network: every request to a computer
 * goes through [Bridge], which signs in with Keystore keys and pins each computer's certificate.
 */
class MainActivity : FragmentActivity(), Bridge.Shell {
    private lateinit var prefs: SharedPreferences
    private lateinit var store: HostStore
    private lateinit var bridge: Bridge
    private var webView: WebView? = null
    private var root: FrameLayout? = null
    private var page: JavaScriptReplyProxy? = null
    private var pendingLink: String? = null
    private val main = Handler(Looper.getMainLooper())

    private var lockOverlay: View? = null
    private var stoppedAt = 0L
    private var autoPrompted = false
    private var authenticating = false

    private var scanResult: CompletableDeferred<String?>? = null
    private val scanLauncher = registerForActivityResult(ScanContract()) { result ->
        scanResult?.complete(result.contents)
        scanResult = null
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = getSharedPreferences("settings", Context.MODE_PRIVATE)
        applySecureScreen()
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            setContentView(message(getString(R.string.webview_missing)))
            return
        }
        store = HostStore(this)
        bridge = Bridge(this, store, Remote(applicationContext, store))
        pendingLink = linkFrom(intent)

        val frame = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        val web = buildWebView()
        frame.addView(web, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        root = frame
        webView = web
        setContentView(frame)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                // The page decides (close a sheet, go back a screen); at its first screen it
                // answers app.exit. Locked, or with no page, there is nothing to go back to.
                if (page == null || lockOverlay != null) moveTaskToBack(true) else post(JSONObject().put("event", "back"))
            }
        })

        if (prefs.getBoolean(PREF_LOCK, false)) showLock()
        web.loadUrl(START_URL)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun buildWebView(): WebView {
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        val web = WebView(this)
        web.setBackgroundColor(Color.BLACK)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            setGeolocationEnabled(false)
            mediaPlaybackRequiresUserGesture = true
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            cacheMode = WebSettings.LOAD_NO_CACHE
            textZoom = textZoomFor(resources.configuration)
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
            WebSettingsCompat.setAlgorithmicDarkeningAllowed(web.settings, false)
        }

        val assets = WebViewAssetLoader.Builder()
            .setDomain(ASSET_HOST)
            .addPathHandler("/", WebAssets(this))
            .build()
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
                val url = request.url
                if (url.scheme == "https" && url.host == ASSET_HOST) {
                    return assets.shouldInterceptRequest(url) ?: emptyResponse(404, "Not Found")
                }
                // Nothing else is ever fetched: the page's only way out is the bridge.
                return emptyResponse(403, "Forbidden")
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                if (url.scheme == "https" && url.host == ASSET_HOST) return false
                if (request.isForMainFrame && request.hasGesture()) runCatching { openUrl(url.toString()) }
                return true
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                page = null
                bridge.pageGone()
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                // The renderer crashed or was reclaimed: start the interface again.
                if (view === webView) main.post { recreateWebView() }
                return true
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) = request.deny()

            override fun onGeolocationPermissionsShowPrompt(origin: String?, callback: GeolocationPermissions.Callback?) {
                callback?.invoke(origin, false, false)
            }

            override fun onShowFileChooser(view: WebView?, callback: ValueCallback<Array<Uri>>?, params: FileChooserParams?): Boolean {
                callback?.onReceiveValue(null)
                return true
            }
        }
        WebViewCompat.addWebMessageListener(web, "piNative", setOf(ORIGIN)) { _, message, origin, isMainFrame, reply ->
            if (!isMainFrame || origin.scheme != "https" || origin.host != ASSET_HOST) return@addWebMessageListener
            page = reply
            message.data?.let(bridge::onMessage)
        }
        return web
    }

    private fun recreateWebView() {
        val frame = root ?: return
        webView?.let {
            frame.removeView(it)
            it.destroy()
        }
        page = null
        bridge.pageGone()
        val web = buildWebView()
        frame.addView(web, 0, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        webView = web
        web.loadUrl(START_URL)
    }

    private fun emptyResponse(status: Int, reason: String) =
        WebResourceResponse("text/plain", "utf-8", status, reason, mapOf("Cache-Control" to "no-store"), ByteArrayInputStream(ByteArray(0)))

    private fun textZoomFor(config: Configuration) = (config.fontScale * 100).roundToInt().coerceIn(85, 150)

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        webView?.settings?.textZoom = textZoomFor(newConfig)
    }

    // ------------------------------------------------------------- lifecycle ---

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val link = linkFrom(intent) ?: return
        if (page != null) post(JSONObject().put("event", "deeplink").put("link", link)) else pendingLink = link
    }

    private fun linkFrom(intent: Intent?): String? {
        val data = intent?.data ?: return null
        if (intent.action != Intent.ACTION_VIEW || data.scheme != "pirc" || data.host != "pair") return null
        return data.toString().take(2000)
    }

    override fun onStart() {
        super.onStart()
        if (prefs.getBoolean(PREF_LOCK, false) && stoppedAt != 0L && SystemClock.elapsedRealtime() - stoppedAt > LOCK_AFTER_MS) showLock()
    }

    override fun onResume() {
        super.onResume()
        post(JSONObject().put("event", "resume"))
        if (lockOverlay != null && !autoPrompted) {
            autoPrompted = true
            unlock()
        }
    }

    override fun onPause() {
        post(JSONObject().put("event", "pause"))
        super.onPause()
    }

    override fun onStop() {
        stoppedAt = SystemClock.elapsedRealtime()
        autoPrompted = false
        super.onStop()
    }

    override fun onDestroy() {
        if (::bridge.isInitialized) bridge.close()
        webView?.destroy()
        webView = null
        super.onDestroy()
    }

    // ----------------------------------------------------------------- lock ---

    private fun showLock() {
        if (lockOverlay != null) return
        val frame = root ?: return
        val overlay = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(Color.BLACK)
            isClickable = true
            isFocusable = true
            addView(TextView(context).apply {
                text = getString(R.string.locked_title)
                setTextColor(ContextCompat.getColor(context, R.color.text))
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 20f)
                gravity = Gravity.CENTER
            })
            addView(Button(context).apply {
                text = getString(R.string.unlock)
                isAllCaps = false
                setTextColor(Color.BLACK)
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 17f)
                setTypeface(typeface, android.graphics.Typeface.BOLD)
                setBackgroundColor(ContextCompat.getColor(context, R.color.lime))
                stateListAnimator = null
                setPadding(dp(32), dp(14), dp(32), dp(14))
                setOnClickListener { unlock() }
            }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(28) })
        }
        frame.addView(overlay, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        webView?.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        lockOverlay = overlay
    }

    private fun hideLock() {
        lockOverlay?.let { (it.parent as? ViewGroup)?.removeView(it) }
        lockOverlay = null
        webView?.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_AUTO
    }

    private fun unlock() {
        if (authenticating) return
        lifecycleScope.launch { if (authenticate()) hideLock() }
    }

    private suspend fun authenticate(): Boolean {
        if (authenticating) return false
        authenticating = true
        try {
            val result = CompletableDeferred<Boolean>()
            val prompt = BiometricPrompt(this, ContextCompat.getMainExecutor(this), object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(r: BiometricPrompt.AuthenticationResult) {
                    result.complete(true)
                }

                override fun onAuthenticationError(code: Int, message: CharSequence) {
                    result.complete(false)
                }
            })
            prompt.authenticate(
                BiometricPrompt.PromptInfo.Builder()
                    .setTitle(getString(R.string.unlock_title))
                    .setSubtitle(getString(R.string.unlock_subtitle))
                    .setAllowedAuthenticators(AUTHENTICATORS)
                    .build(),
            )
            return result.await()
        } finally {
            authenticating = false
        }
    }

    private fun applySecureScreen() {
        if (prefs.getBoolean(PREF_SECURE, false)) window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
    }

    // ------------------------------------------------------ Bridge.Shell ---

    override fun post(message: JSONObject) {
        val text = message.toString()
        main.post { runCatching { page?.postMessage(text) } }
    }

    override fun info(): JSONObject {
        val link = pendingLink
        pendingLink = null
        val storage = store.list().firstNotNullOfOrNull { DeviceKeys.storage(it.keyAlias) }
        return JSONObject()
            .put("version", BuildConfig.VERSION_NAME)
            .put("keyStorage", storage ?: JSONObject.NULL)
            .put("lockEnabled", prefs.getBoolean(PREF_LOCK, false))
            .put("secureScreen", prefs.getBoolean(PREF_SECURE, false))
            .put("pendingLink", link ?: JSONObject.NULL)
    }

    override suspend fun setLock(enabled: Boolean): Boolean {
        if (enabled) {
            if (BiometricManager.from(this).canAuthenticate(AUTHENTICATORS) != BiometricManager.BIOMETRIC_SUCCESS) {
                throw BridgeError("no_screen_lock", "Set a screen lock (PIN, pattern, password or biometrics) on this phone first.")
            }
            // Prove it works before relying on it.
            if (!authenticate()) return prefs.getBoolean(PREF_LOCK, false)
        }
        prefs.edit().putBoolean(PREF_LOCK, enabled).apply()
        return enabled
    }

    override fun setSecureScreen(enabled: Boolean): Boolean {
        prefs.edit().putBoolean(PREF_SECURE, enabled).apply()
        applySecureScreen()
        return enabled
    }

    override fun haptic() {
        webView?.performHapticFeedback(
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.VIRTUAL_KEY,
        )
    }

    override fun openUrl(url: String) {
        val uri = Uri.parse(url)
        if ((uri.scheme != "http" && uri.scheme != "https") || uri.host.isNullOrEmpty()) {
            throw BridgeError("bad_link", "pi remote only opens web links (http and https)")
        }
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE))
        } catch (e: ActivityNotFoundException) {
            throw BridgeError("no_app", "no app on this phone opens that link")
        }
    }

    override suspend fun scan(): String? {
        scanResult?.complete(null)
        val result = CompletableDeferred<String?>()
        scanResult = result
        scanLauncher.launch(
            ScanOptions()
                .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                .setPrompt(getString(R.string.scan_prompt))
                .setBeepEnabled(false)
                .setOrientationLocked(false),
        )
        return result.await()
    }

    override fun exit() {
        moveTaskToBack(true)
    }

    // ---------------------------------------------------------------- helpers ---

    private fun message(text: String) = TextView(this).apply {
        this.text = text
        setTextColor(ContextCompat.getColor(context, R.color.text))
        setBackgroundColor(Color.BLACK)
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 17f)
        setPadding(dp(24), dp(48), dp(24), dp(24))
    }

    private fun dp(value: Int) = (value * resources.displayMetrics.density).roundToInt()

    /** Serves assets/web/ and nothing else, with the same policy the page declares. */
    private class WebAssets(private val context: Context) : WebViewAssetLoader.PathHandler {
        override fun handle(path: String): WebResourceResponse? {
            if (path.isEmpty() || path.startsWith("/") || path.contains("..") || path.contains('\\')) return null
            val type = TYPES[path.substringAfterLast('.', "")] ?: return null
            val stream = try {
                context.assets.open("web/$path")
            } catch (e: IOException) {
                return null
            }
            return WebResourceResponse(type, "utf-8", 200, "OK", HEADERS, stream)
        }
    }

    companion object {
        private const val ASSET_HOST = "appassets.androidplatform.net"
        private const val ORIGIN = "https://$ASSET_HOST"
        private const val START_URL = "$ORIGIN/mobile/index.html"
        private const val PREF_LOCK = "lock"
        private const val PREF_SECURE = "secure"
        private const val LOCK_AFTER_MS = 30_000L
        private const val AUTHENTICATORS = BIOMETRIC_WEAK or DEVICE_CREDENTIAL

        private val TYPES = mapOf(
            "html" to "text/html",
            "js" to "text/javascript",
            "css" to "text/css",
            "svg" to "image/svg+xml",
            "png" to "image/png",
            "woff2" to "font/woff2",
        )
        private val HEADERS = mapOf(
            "Cache-Control" to "no-store",
            "X-Content-Type-Options" to "nosniff",
            "Referrer-Policy" to "no-referrer",
            "Content-Security-Policy" to "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
                "font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        )
    }
}
