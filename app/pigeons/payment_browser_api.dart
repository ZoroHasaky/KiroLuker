import 'package:pigeon/pigeon.dart';

@ConfigurePigeon(
  PigeonOptions(
    dartOut: 'lib/platform/payment_browser_api.g.dart',
    dartOptions: DartOptions(),
    kotlinOut: 'android/app/src/main/kotlin/com/kiroluker/kiro_lucker/PaymentBrowserApi.g.kt',
    kotlinOptions: KotlinOptions(package: 'com.kiroluker.kiro_lucker'),
    swiftOut: 'ios/Runner/PaymentBrowserApi.g.swift',
    swiftOptions: SwiftOptions(),
  ),
)

/// 原生 WebView 运行环境的只读事实，Dart 侧据此构造伪装标识。
class BrowserEngineInfo {
  BrowserEngineInfo({
    required this.engineUserAgent,
    required this.osVersion,
    required this.deviceModel,
    this.buildId,
    this.architecture,
  });

  /// Android：WebView 默认 UA（解析引擎版本用）；iOS 为空串。
  String engineUserAgent;
  /// Android：Build.VERSION.RELEASE；iOS：UIDevice.systemVersion。
  String osVersion;
  /// Android：Build.MODEL；iOS："iPhone" 或 "iPad"。
  String deviceModel;
  /// Android：Build.ID；iOS 为 null。
  String? buildId;
  /// Android：如 "arm"（已按 UA-CH 惯例映射）；iOS 为 null。
  String? architecture;
}

/// UA-CH 品牌条目；只传结构化数据，注入脚本模板留在原生侧。
class BrandVersion {
  BrandVersion({required this.brand, required this.version});
  String brand;
  String version;
}

/// 支付 WebView 的浏览器伪装标识。全字段由 Dart 侧白名单模板生成，原生不执行透传脚本。
class BrowserIdentity {
  BrowserIdentity({
    required this.userAgent,
    required this.brands,
    required this.mobile,
    required this.platform,
    this.platformVersion,
    this.architecture,
    required this.fullVersion,
    this.model,
  });

  String userAgent;
  List<BrandVersion> brands;
  bool mobile;
  String platform;
  String? platformVersion;
  String? architecture;
  String fullVersion;
  String? model;
}

class PaymentSessionRequest {
  PaymentSessionRequest({required this.sessionId, required this.initialUrl, this.identity});
  String sessionId;
  String initialUrl;
  /// null 表示不做伪装，沿用系统默认 UA。
  BrowserIdentity? identity;
}

class PaymentSessionStatus {
  PaymentSessionStatus({required this.supported, this.message});
  bool supported;
  String? message;
}

class PaymentFillResult {
  PaymentFillResult({required this.success, required this.completedFields, required this.failedFields, this.message});
  bool success;
  List<String> completedFields;
  List<String> failedFields;
  String? message;
}

class CheckoutBillingPayload {
  CheckoutBillingPayload({
    required this.pinyinName,
    required this.countryCode,
    required this.province,
    required this.city,
    required this.district,
    required this.pinyinCity,
    required this.pinyinDistrict,
    required this.addressLine1,
    required this.postalCode,
  });

  String pinyinName;
  String countryCode;
  String province;
  String city;
  String district;
  String pinyinCity;
  String pinyinDistrict;
  String addressLine1;
  String postalCode;
}

/// Flutter 仅能调用这些固定命令；没有任意 JavaScript 执行接口。
@HostApi()
abstract class PaymentBrowserHostApi {
  @async
  PaymentSessionStatus createSession(PaymentSessionRequest request);

  /// 读取 WebView 引擎与系统的只读信息，供 Dart 构造伪装 UA。
  @async
  BrowserEngineInfo getBrowserEngineInfo();

  @async
  bool canGoBack(String sessionId);

  @async
  void goBack(String sessionId);

  @async
  void reload(String sessionId);

  @async
  PaymentFillResult fillCheckout(String sessionId, CheckoutBillingPayload billing);

  /// 停止页面、清理本次 profile/data store 后再释放 WebView。
  @async
  void closeSession(String sessionId);
}
