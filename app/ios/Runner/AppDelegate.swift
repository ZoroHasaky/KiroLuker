import Flutter
import UIKit
import WebKit

private let paymentViewType = "com.kiroluker/payment-browser"

private final class PaymentSession {
  let id: String
  let url: URL
  let dataStore: WKWebsiteDataStore
  var webView: WKWebView?

  init(id: String, url: URL) {
    self.id = id
    self.url = url
    self.dataStore = WKWebsiteDataStore.nonPersistent()
  }
}

/// Every session gets a brand-new non-persistent WebsiteDataStore. No script message handler is installed.
private final class PaymentSessionRegistry {
  private var sessions: [String: PaymentSession] = [:]

  func create(_ request: PaymentSessionRequest) throws -> PaymentSessionStatus {
    guard let url = URL(string: request.initialUrl), url.scheme == "https", url.host == "checkout.stripe.com" else {
      return PaymentSessionStatus(supported: false, message: "支付链接不是受支持的 Stripe Checkout HTTPS 地址")
    }
    sessions[request.sessionId] = PaymentSession(id: request.sessionId, url: url)
    return PaymentSessionStatus(supported: true)
  }

  func createView(sessionId: String, frame: CGRect) -> UIView {
    guard let session = sessions[sessionId] else { return errorView("支付会话已过期") }
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = session.dataStore
    configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
    // No WKScriptMessageHandler, URL scheme handler, or platform-channel bridge is exposed to the page.
    let webView = WKWebView(frame: frame, configuration: configuration)
    webView.allowsBackForwardNavigationGestures = true
    webView.navigationDelegate = PaymentNavigationDelegate()
    session.webView = webView
    webView.load(URLRequest(url: session.url, cachePolicy: .reloadIgnoringLocalCacheData))
    return webView
  }

  func canGoBack(_ sessionId: String) -> Bool { sessions[sessionId]?.webView?.canGoBack ?? false }
  func goBack(_ sessionId: String) throws { try webView(sessionId).goBack() }
  func reload(_ sessionId: String) throws { webView(sessionId).reload() }

  func fill(_ sessionId: String, billing: CheckoutBillingPayload) async throws -> PaymentFillResult {
    let target = try webView(sessionId)
    let raw: Any
    do { raw = try await target.evaluateJavaScript(checkoutFillScript(billing)) }
    catch { throw PigeonError(code: "FILL_EXECUTION_FAILED", message: "支付页面字段填充未能执行", details: nil) }
    guard let text = raw as? String,
          let data = text.data(using: .utf8),
          let result = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      throw PigeonError(code: "FILL_RESULT_INVALID", message: "支付页面未返回可验证的填充结果", details: nil)
    }
    return PaymentFillResult(
      success: result["success"] as? Bool ?? false,
      completedFields: result["completed"] as? [String] ?? [],
      failedFields: result["failed"] as? [String] ?? [],
      message: result["message"] as? String
    )
  }

  func close(_ sessionId: String) async {
    guard let session = sessions.removeValue(forKey: sessionId) else { return }
    session.webView?.stopLoading()
    session.webView?.loadHTMLString("", baseURL: nil)
    session.webView?.navigationDelegate = nil
    session.webView = nil
    // Completion is awaited before releasing the non-persistent store and WebView.
    await withCheckedContinuation { continuation in
      session.dataStore.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast) {
        continuation.resume()
      }
    }
  }

  private func webView(_ sessionId: String) throws -> WKWebView {
    guard let view = sessions[sessionId]?.webView else {
      throw PigeonError(code: "SESSION_NOT_READY", message: "支付页面尚未加载或已关闭", details: nil)
    }
    return view
  }

  private func errorView(_ message: String) -> UIView {
    let label = UILabel()
    label.text = message
    label.numberOfLines = 0
    label.textAlignment = .center
    return label
  }
}

private final class PaymentNavigationDelegate: NSObject, WKNavigationDelegate {
  func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    // Bank authentication can navigate cross-site; it remains user-driven, and auto-fill resumes only after returning to checkout.stripe.com.
    decisionHandler(.allow)
  }
}

private func checkoutFillScript(_ billing: CheckoutBillingPayload) -> String {
  let object: [String: String] = [
    "pinyinName": billing.pinyinName, "countryCode": billing.countryCode, "province": billing.province,
    "city": billing.city, "district": billing.district, "pinyinCity": billing.pinyinCity,
    "pinyinDistrict": billing.pinyinDistrict, "addressLine1": billing.addressLine1, "postalCode": billing.postalCode
  ]
  let json = String(data: try! JSONSerialization.data(withJSONObject: object), encoding: .utf8)!
  return """
  (() => {
    const data = \(json); const done = [], failed = [];
    if (location.hostname !== 'checkout.stripe.com') return JSON.stringify({success:false,completed:done,failed:['supported-checkout-page'],message:'当前不是受支持的 Stripe Checkout 页面'});
    const emit = (el) => { el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); el.dispatchEvent(new Event('blur',{bubbles:true})); };
    const labelInput = (terms) => Array.from(document.querySelectorAll('label')).map(label => ({label,target:document.getElementById(label.htmlFor)})).find(x => x.target && terms.some(t => x.label.textContent.toLowerCase().includes(t)))?.target;
    const find = (key,terms) => document.querySelector(`[autocomplete="${key}"]`) || labelInput(terms);
    const setText = (name,key,value,terms) => { const el=find(key,terms); if(!el || el.matches('[autocomplete^="cc-"]:not([autocomplete="cc-name"])')) { failed.push(name); return; } el.focus(); el.value=value; emit(el); done.push(name); };
    const setSelect = (name,key,value,terms,fallback) => { const el=find(key,terms); if(!el || el.tagName !== 'SELECT') { failed.push(name); return; } const option=Array.from(el.options).find(o => [value,fallback].filter(Boolean).some(v => o.textContent.trim()===v || o.value===v)); if(!option) { failed.push(name); return; } el.value=option.value; emit(el); done.push(name); };
    setSelect('国家/地区','country',data.countryCode,['country','国家/地区'],'China');
    setText('持卡人姓名','cc-name',data.pinyinName,['name on card','持卡人姓名']);
    setSelect('省/州','address-level1',data.province,['province','state','省']);
    setText('城市','address-level2',data.pinyinCity,['city','城市']);
    setText('地区','address-level3',data.pinyinDistrict,['district','地区']);
    setText('地址第 1 行','address-line1',data.addressLine1,['address','地址']);
    setText('邮编','postal-code',data.postalCode,['postal','zip','邮编']);
    return JSON.stringify({success:failed.length===0,completed:done,failed:failed,message:failed.length?'页面字段结构不完整，请手动填写未匹配字段':''});
  })();
  """
}

private final class PaymentBrowserPlatformView: NSObject, FlutterPlatformView {
  private let nativeView: UIView
  init(registry: PaymentSessionRegistry, frame: CGRect, sessionId: String) { nativeView = registry.createView(sessionId: sessionId, frame: frame) }
  func view() -> UIView { nativeView }
}

private final class PaymentBrowserPlatformViewFactory: NSObject, FlutterPlatformViewFactory {
  private let registry: PaymentSessionRegistry
  init(registry: PaymentSessionRegistry) { self.registry = registry }
  func createArgsCodec() -> (FlutterMessageCodec & NSObjectProtocol) { FlutterStandardMessageCodec.sharedInstance() }
  func create(withFrame frame: CGRect, viewIdentifier viewId: Int64, arguments args: Any?) -> FlutterPlatformView {
    let dictionary = args as? [String: Any]
    return PaymentBrowserPlatformView(registry: registry, frame: frame, sessionId: dictionary?["sessionId"] as? String ?? "")
  }
}

private final class PaymentBrowserHost: PaymentBrowserHostApi {
  private let registry: PaymentSessionRegistry
  init(registry: PaymentSessionRegistry) { self.registry = registry }
  func createSession(request: PaymentSessionRequest) async throws -> PaymentSessionStatus { try registry.create(request) }
  func canGoBack(sessionId: String) async throws -> Bool { registry.canGoBack(sessionId) }
  func goBack(sessionId: String) async throws { try registry.goBack(sessionId) }
  func reload(sessionId: String) async throws { try registry.reload(sessionId) }
  func fillCheckout(sessionId: String, billing: CheckoutBillingPayload) async throws -> PaymentFillResult { try await registry.fill(sessionId, billing: billing) }
  func closeSession(sessionId: String) async throws { await registry.close(sessionId) }
}

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  private let paymentRegistry = PaymentSessionRegistry()
  private var paymentHost: PaymentBrowserHost?

  override func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
    super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
    guard let registrar = engineBridge.pluginRegistry.registrar(forPlugin: "PaymentBrowser") else { return }
    let host = PaymentBrowserHost(registry: paymentRegistry)
    paymentHost = host
    registrar.register(PaymentBrowserPlatformViewFactory(registry: paymentRegistry), withId: paymentViewType)
    PaymentBrowserHostApiSetup.setUp(binaryMessenger: registrar.messenger(), api: host)
  }
}
