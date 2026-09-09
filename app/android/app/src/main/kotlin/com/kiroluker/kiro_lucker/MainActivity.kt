package com.kiroluker.kiro_lucker

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.TelephonyNetworkSpecifier
import android.telephony.SubscriptionManager
import android.view.View
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.TextView
import androidx.webkit.ProfileStore
import androidx.webkit.WebStorageCompat
import androidx.webkit.WebViewBuilder
import androidx.webkit.WebViewFeature
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugin.platform.PlatformView
import io.flutter.plugin.platform.PlatformViewFactory
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine

private const val PAYMENT_VIEW_TYPE = "com.kiroluker/payment-browser"
private const val PROFILE_PREFIX = "kiroluker_payment_"
private const val NETWORK_IP_CHANNEL = "com.kiroluker/network-ip"
private const val PHONE_STATE_PERMISSION_REQUEST = 7401

/** A fresh profile is used when Android System WebView exposes the profile API. */
private data class PaymentSession(
  val id: String,
  val url: String,
  val profileName: String?,
  val isolated: Boolean,
  var webView: WebView? = null,
)

private class PaymentSessionRegistry(private val context: Context) {
  private val sessions = ConcurrentHashMap<String, PaymentSession>()
  private val preferences = context.getSharedPreferences("payment-profiles", Context.MODE_PRIVATE)

  init { cleanupInterruptedProfiles() }

  private fun supportsProfiles(): Boolean =
    WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE) &&
      WebViewFeature.isFeatureSupported(WebViewFeature.DELETE_BROWSING_DATA) &&
      WebViewFeature.isFeatureSupported(WebViewFeature.WEBVIEW_BUILDER_EXPERIMENTAL_V1)

  /**
   * Legacy System WebView has an application-wide data store, so it cannot match profile isolation.
   * Checkout still opens: all app WebView data is cleared before and after this short-lived session.
   */
  suspend fun create(request: PaymentSessionRequest): PaymentSessionStatus {
    if (!request.initialUrl.isStripeCheckout()) {
      return PaymentSessionStatus(false, "支付链接不是受支持的 Stripe Checkout HTTPS 地址")
    }
    if (supportsProfiles()) {
      val profileName = "$PROFILE_PREFIX${request.sessionId.replace("-", "")}"
      ProfileStore.getInstance().getOrCreateProfile(profileName)
      sessions[request.sessionId] = PaymentSession(request.sessionId, request.initialUrl, profileName, true)
      preferences.edit().putString(profileName, profileName).apply()
      return PaymentSessionStatus(true)
    }
    clearLegacyWebData()
    sessions[request.sessionId] = PaymentSession(request.sessionId, request.initialUrl, null, false)
    return PaymentSessionStatus(
      true,
      "兼容模式：当前 Android System WebView 不支持独立支付 profile。本次会话开始和关闭时会清除本应用 WebView 的 Cookie、缓存和网页存储；请勿在共享设备上保存支付信息。",
    )
  }
  @SuppressLint("SetJavaScriptEnabled")
  fun createView(sessionId: String): View {
    val session = sessions[sessionId] ?: return errorView("支付会话已过期")
    val webView = if (session.isolated) createIsolatedWebView(session) else WebView(context)
    webView.setBackgroundColor(Color.WHITE)
    webView.settings.apply {
      javaScriptEnabled = true // Stripe Checkout needs JavaScript; no JS bridge is exposed to pages.
      domStorageEnabled = true
      databaseEnabled = false
      allowFileAccess = false
      allowContentAccess = false
      setSupportMultipleWindows(false)
      javaScriptCanOpenWindowsAutomatically = false
      mediaPlaybackRequiresUserGesture = true
      mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
      safeBrowsingEnabled = true
    }
    webView.removeJavascriptInterface("searchBoxJavaBridge_")
    webView.removeJavascriptInterface("accessibility")
    webView.removeJavascriptInterface("accessibilityTraversal")
    webView.webChromeClient = WebChromeClient()
    webView.webViewClient = object : WebViewClient() {
      override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
        request.url.scheme?.lowercase() !in setOf("http", "https")
    }
    if (!session.isolated) {
      webView.clearCache(true)
      webView.clearHistory()
      webView.clearFormData()
    }
    session.webView = webView
    webView.loadUrl(session.url)
    return FrameLayout(context).apply { addView(webView, FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT) }
  }

  @OptIn(WebViewBuilder.Experimental::class)
  private fun createIsolatedWebView(session: PaymentSession): WebView = WebViewBuilder(WebViewBuilder.PRESET_LEGACY)
    .setProfile(requireNotNull(session.profileName))
    .restrictJavaScriptInterfaces()
    .build(context)
  fun canGoBack(sessionId: String): Boolean = sessions[sessionId]?.webView?.canGoBack() ?: false
  fun goBack(sessionId: String) { requireWebView(sessionId).goBack() }
  fun reload(sessionId: String) { requireWebView(sessionId).reload() }

  suspend fun fill(sessionId: String, billing: CheckoutBillingPayload): PaymentFillResult {
    val webView = requireWebView(sessionId)
    return suspendCancellableCoroutine { continuation ->
      webView.evaluateJavascript(checkoutFillScript(billing)) { raw ->
        try {
          val decoded = JSONTokener(raw).nextValue() as? String ?: "{}"
          val result = JSONObject(decoded)
          val completed = result.optJSONArray("completed").toStrings()
          val failed = result.optJSONArray("failed").toStrings()
          continuation.resume(PaymentFillResult(result.optBoolean("success", false), completed, failed, result.optString("message").ifBlank { null }))
        } catch (error: Exception) {
          continuation.resumeWithException(FlutterError("FILL_RESULT_INVALID", "支付页面未返回可验证的填充结果", null))
        }
      }
    }
  }

  suspend fun close(sessionId: String) {
    val session = sessions.remove(sessionId) ?: return
    val view = session.webView
    view?.stopLoading()
    view?.loadUrl("about:blank")
    view?.clearHistory()
    view?.clearCache(true)
    view?.clearFormData()
    session.webView = null
    if (session.isolated) clearProfileData(requireNotNull(session.profileName)) else clearLegacyWebData()
    view?.destroy()
  }

  private suspend fun clearProfileData(profileName: String) {
    val store = ProfileStore.getInstance()
    val profile = store.getProfile(profileName)
    if (profile == null) {
      preferences.edit().remove(profileName).apply()
      return
    }
    suspendCancellableCoroutine<Unit> { continuation ->
      WebStorageCompat.deleteBrowsingData(profile.webStorage) {
        profile.cookieManager.removeAllCookies {
          profile.cookieManager.flush()
          // deleteProfile only starts/accepts deletion; it is not disk-cleanup proof.
          store.deleteProfile(profileName)
          preferences.edit().remove(profileName).apply()
          if (continuation.isActive) continuation.resume(Unit)
        }
      }
    }
  }

  private suspend fun clearLegacyWebData() {
    WebStorage.getInstance().deleteAllData()
    val cookies = CookieManager.getInstance()
    suspendCancellableCoroutine<Unit> { continuation ->
      cookies.removeAllCookies {
        cookies.flush()
        if (continuation.isActive) continuation.resume(Unit)
      }
    }
  }
  private fun cleanupInterruptedProfiles() {
    if (!supportsProfiles()) return
    val store = ProfileStore.getInstance()
    for (name in preferences.all.keys.filter { it.startsWith(PROFILE_PREFIX) }) {
      // Cold-start cleanup touches only our prefixed profiles. Loaded profiles are left alone and retried next cold start.
      if (store.deleteProfile(name)) preferences.edit().remove(name).apply()
    }
  }

  private fun requireWebView(sessionId: String): WebView = sessions[sessionId]?.webView
    ?: throw FlutterError("SESSION_NOT_READY", "支付页面尚未加载或已关闭", null)

  private fun errorView(message: String): View = TextView(context).apply { text = message; setPadding(32, 32, 32, 32) }
}

/**
 * Best-effort IP checks bind each HTTP request to an Android Network explicitly requested for the
 * subscription. Many devices permit only the current data SIM, and carrier/OEM policy may refuse
 * the request for another subscription; that restriction is returned per SIM rather than hidden.
 */
private class SimNetworkIpDetector(private val context: Context) {
  private val connectivityManager = context.getSystemService(ConnectivityManager::class.java)
  private val subscriptionManager = context.getSystemService(SubscriptionManager::class.java)
  private val history = context.getSharedPreferences("sim-ip-history", Context.MODE_PRIVATE)

  fun detect(): Map<String, Any?> {
    if (!context.packageManager.hasSystemFeature(PackageManager.FEATURE_TELEPHONY_SUBSCRIPTION)) {
      return report(false, "此设备不支持 SIM 卡订阅信息", emptyList())
    }
    if (context.checkSelfPermission(Manifest.permission.READ_PHONE_STATE) != PackageManager.PERMISSION_GRANTED) {
      return report(true, "需要“读取手机状态”权限，才能按 SIM 卡分别检测网络", emptyList())
    }
    val subscriptions = try {
      subscriptionManager.activeSubscriptionInfoList.orEmpty()
    } catch (_: SecurityException) {
      emptyList()
    }
    if (subscriptions.isEmpty()) {
      return report(false, "未发现可用的 SIM 卡，或系统未允许读取订阅信息", emptyList())
    }
    val values = subscriptions.sortedBy { it.simSlotIndex }.map { subscription ->
      val slotIndex = subscription.simSlotIndex
      detectSubscription(
        subscription.subscriptionId,
        slotIndex,
        if (slotIndex >= 0) "SIM ${slotIndex + 1}" else "SIM",
      )
    }
    return report(false, null, values)
  }

  private fun report(permissionRequired: Boolean, status: String?, sims: List<Map<String, Any?>>): Map<String, Any?> = mapOf(
    "permissionRequired" to permissionRequired,
    "status" to status,
    "sims" to sims,
  )

  private fun detectSubscription(subscriptionId: Int, slotIndex: Int, label: String): Map<String, Any?> {
    var callback: ConnectivityManager.NetworkCallback? = null
    return try {
      val networkRef = AtomicReference<Network?>(null)
      val unavailable = AtomicReference<String?>(null)
      val ready = CountDownLatch(1)
      val request = NetworkRequest.Builder()
        .addTransportType(NetworkCapabilities.TRANSPORT_CELLULAR)
        .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
        .setNetworkSpecifier(TelephonyNetworkSpecifier.Builder().setSubscriptionId(subscriptionId).build())
        .build()
      callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
          networkRef.set(network)
          ready.countDown()
        }

        override fun onUnavailable() {
          unavailable.set("该 SIM 未提供可供应用绑定的蜂窝数据网络")
          ready.countDown()
        }
      }
      connectivityManager.requestNetwork(request, callback, 6000)
      ready.await(7, TimeUnit.SECONDS)
      val network = networkRef.get()
      if (network == null) {
        simResult(slotIndex, label, null, null, unavailable.get() ?: "等待该 SIM 的蜂窝网络超时；系统、运营商或数据设置可能不允许单独检测")
      } else {
        val ipv4 = readPublicIp(network, "https://api.ipify.org?format=json", false)
        val ipv6 = readPublicIp(network, "https://api64.ipify.org?format=json", true)
        val checkedAt = System.currentTimeMillis()
        if (ipv4 != null || ipv6 != null) saveHistory(slotIndex, ipv4, ipv6, checkedAt)
        val status = if (ipv4 == null && ipv6 == null) "已请求到该 SIM 的蜂窝网络，但 ipify 未返回可用公网地址" else null
        simResult(slotIndex, label, ipv4, ipv6, status, checkedAt)
      }
    } catch (error: SecurityException) {
      simResult(slotIndex, label, null, null, "系统拒绝按该 SIM 请求网络：${error.message ?: "权限或厂商限制"}")
    } catch (error: Exception) {
      simResult(slotIndex, label, null, null, "检测失败：${error.message ?: error.javaClass.simpleName}")
    } finally {
      callback?.let {
        try {
          connectivityManager.unregisterNetworkCallback(it)
        } catch (_: Exception) {
          // The callback may already have been released by the system.
        }
      }
    }
  }

  private fun simResult(
    slotIndex: Int,
    label: String,
    ipv4: String?,
    ipv6: String?,
    status: String?,
    checkedAt: Long? = null,
  ): Map<String, Any?> {
    val key = "slot_$slotIndex"
    return mapOf(
      "slotIndex" to slotIndex,
      "label" to label,
      "ipv4" to ipv4,
      "ipv6" to ipv6,
      "checkedAt" to checkedAt,
      "lastIpv4" to history.getString("${key}_ipv4", null),
      "lastIpv6" to history.getString("${key}_ipv6", null),
      "lastCheckedAt" to history.getLong("${key}_checked_at", 0),
      "status" to status,
    )
  }

  private fun saveHistory(slotIndex: Int, ipv4: String?, ipv6: String?, checkedAt: Long) {
    val key = "slot_$slotIndex"
    history.edit().apply {
      if (ipv4 != null) putString("${key}_ipv4", ipv4)
      if (ipv6 != null) putString("${key}_ipv6", ipv6)
      putLong("${key}_checked_at", checkedAt)
    }.apply()
  }

  private fun readPublicIp(network: Network, endpoint: String, ipv6: Boolean): String? = try {
    val connection = network.openConnection(URL(endpoint)) as HttpURLConnection
    try {
      connection.requestMethod = "GET"
      connection.connectTimeout = 7000
      connection.readTimeout = 7000
      connection.useCaches = false
      connection.setRequestProperty("Accept", "application/json")
      if (connection.responseCode !in 200..299) {
        null
      } else {
        connection.inputStream.bufferedReader().use { reader ->
          val value = JSONObject(reader.readText()).optString("ip").trim()
          value.takeIf { it.isNotEmpty() && if (ipv6) it.contains(':') else !it.contains(':') }
        }
      }
    } finally {
      connection.disconnect()
    }
  } catch (_: Exception) {
    null
  }
}

private fun String.isStripeCheckout(): Boolean = try {
  val uri = android.net.Uri.parse(this)
  uri.scheme == "https" && uri.host == "checkout.stripe.com"
} catch (_: Exception) { false }

private fun JSONArray?.toStrings(): List<String> = buildList {
  if (this@toStrings == null) return@buildList
  for (index in 0 until length()) optString(index).takeIf { it.isNotBlank() }?.let(::add)
}

private fun checkoutFillScript(billing: CheckoutBillingPayload): String {
  val payload = JSONObject().apply {
    put("pinyinName", billing.pinyinName); put("countryCode", billing.countryCode); put("province", billing.province)
    put("city", billing.city); put("district", billing.district); put("pinyinCity", billing.pinyinCity)
    put("pinyinDistrict", billing.pinyinDistrict); put("addressLine1", billing.addressLine1); put("postalCode", billing.postalCode)
  }.toString()
  return """
    (() => {
      const data = $payload;
      const done = [], failed = [];
      if (location.hostname !== 'checkout.stripe.com') return JSON.stringify({success:false, completed:done, failed:['supported-checkout-page'], message:'当前不是受支持的 Stripe Checkout 页面'});
      const emit = (el) => { el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); el.dispatchEvent(new Event('blur', {bubbles:true})); };
      const labelInput = (terms) => Array.from(document.querySelectorAll('label')).map(label => ({label, target: document.getElementById(label.htmlFor)})).find(x => x.target && terms.some(t => x.label.textContent.toLowerCase().includes(t)))?.target;
      const find = (key, terms) => document.querySelector(`[autocomplete="${'$'}{key}"]`) || labelInput(terms);
      const setText = (name, key, value, terms) => { const el = find(key, terms); if (!el || el.matches('[autocomplete^="cc-"]:not([autocomplete="cc-name"])')) { failed.push(name); return; } el.focus(); el.value = value; emit(el); done.push(name); };
      const setSelect = (name, key, value, terms, fallback) => { const el = find(key, terms); if (!el || el.tagName !== 'SELECT') { failed.push(name); return; } const match = Array.from(el.options).find(o => [value, fallback].filter(Boolean).some(v => o.textContent.trim() === v || o.value === v)); if (!match) { failed.push(name); return; } el.value = match.value; emit(el); done.push(name); };
      setSelect('国家/地区', 'country', data.countryCode, ['country','国家/地区'], 'China');
      setText('持卡人姓名', 'cc-name', data.pinyinName, ['name on card','持卡人姓名']);
      setSelect('省/州', 'address-level1', data.province, ['province','state','省']);
      setText('城市', 'address-level2', data.pinyinCity, ['city','城市']);
      setText('地区', 'address-level3', data.pinyinDistrict, ['district','地区']);
      setText('地址第 1 行', 'address-line1', data.addressLine1, ['address','地址']);
      setText('邮编', 'postal-code', data.postalCode, ['postal','zip','邮编']);
      return JSON.stringify({success: failed.length === 0, completed: done, failed: failed, message: failed.length ? '页面字段结构不完整，请手动填写未匹配字段' : ''});
    })();
  """.trimIndent()
}

private class PaymentBrowserPlatformViewFactory(private val registry: PaymentSessionRegistry) : PlatformViewFactory(io.flutter.plugin.common.StandardMessageCodec.INSTANCE) {
  override fun create(context: Context, viewId: Int, args: Any?): PlatformView {
    val sessionId = (args as? Map<*, *>)?.get("sessionId") as? String ?: ""
    val view = registry.createView(sessionId)
    return object : PlatformView { override fun getView(): View = view; override fun dispose() = Unit }
  }
}

private class PaymentBrowserHost(private val registry: PaymentSessionRegistry) : PaymentBrowserHostApi {
  override suspend fun createSession(request: PaymentSessionRequest): PaymentSessionStatus = registry.create(request)
  override suspend fun canGoBack(sessionId: String): Boolean = registry.canGoBack(sessionId)
  override suspend fun goBack(sessionId: String) = registry.goBack(sessionId)
  override suspend fun reload(sessionId: String) = registry.reload(sessionId)
  override suspend fun fillCheckout(sessionId: String, billing: CheckoutBillingPayload): PaymentFillResult = registry.fill(sessionId, billing)
  override suspend fun closeSession(sessionId: String) = registry.close(sessionId)
}

class MainActivity : FlutterActivity() {
  private lateinit var registry: PaymentSessionRegistry
  private lateinit var simNetworkIpDetector: SimNetworkIpDetector
  private var pendingPhoneStatePermissionResult: MethodChannel.Result? = null
  override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
    super.configureFlutterEngine(flutterEngine)
    registry = PaymentSessionRegistry(applicationContext)
    simNetworkIpDetector = SimNetworkIpDetector(applicationContext)
    flutterEngine.platformViewsController.registry.registerViewFactory(PAYMENT_VIEW_TYPE, PaymentBrowserPlatformViewFactory(registry))
    PaymentBrowserHostApi.setUp(flutterEngine.dartExecutor.binaryMessenger, PaymentBrowserHost(registry))
    MethodChannel(flutterEngine.dartExecutor.binaryMessenger, NETWORK_IP_CHANNEL).setMethodCallHandler { call, result ->
      when (call.method) {
        "detectSimIps" -> Thread {
          try {
            val report = simNetworkIpDetector.detect()
            runOnUiThread { result.success(report) }
          } catch (error: Exception) {
            runOnUiThread { result.error("SIM_IP_DETECTION_FAILED", error.message, null) }
          }
        }.start()
        "requestPhoneStatePermission" -> requestPhoneStatePermission(result)
        else -> result.notImplemented()
      }
    }
  }
  private fun requestPhoneStatePermission(result: MethodChannel.Result) {
    if (checkSelfPermission(Manifest.permission.READ_PHONE_STATE) == PackageManager.PERMISSION_GRANTED) {
      result.success(true)
      return
    }
    if (pendingPhoneStatePermissionResult != null) {
      result.error("PERMISSION_REQUEST_IN_PROGRESS", "已有手机状态权限请求正在等待结果", null)
      return
    }
    pendingPhoneStatePermissionResult = result
    requestPermissions(arrayOf(Manifest.permission.READ_PHONE_STATE), PHONE_STATE_PERMISSION_REQUEST)
  }

  override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    if (requestCode == PHONE_STATE_PERMISSION_REQUEST) {
      pendingPhoneStatePermissionResult?.success(grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED)
      pendingPhoneStatePermissionResult = null
    }
  }
  override fun cleanUpFlutterEngine(flutterEngine: FlutterEngine) {
    PaymentBrowserHostApi.setUp(flutterEngine.dartExecutor.binaryMessenger, null)
    MethodChannel(flutterEngine.dartExecutor.binaryMessenger, NETWORK_IP_CHANNEL).setMethodCallHandler(null)
    super.cleanUpFlutterEngine(flutterEngine)
  }
}





