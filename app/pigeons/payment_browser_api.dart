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

class PaymentSessionRequest {
  PaymentSessionRequest({required this.sessionId, required this.initialUrl});
  String sessionId;
  String initialUrl;
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
