import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:uuid/uuid.dart';

import '../core/models.dart';
import 'payment_browser_api.g.dart';

class PaymentBrowserSession {
  PaymentBrowserSession._({required this.id, required this.url, required this.supported, this.message});
  final String id;
  final String url;
  final bool supported;
  final String? message;
  static final _api = PaymentBrowserHostApi();

  static Future<PaymentBrowserSession> create(String url) async {
    final id = const Uuid().v4();
    final status = await _api.createSession(PaymentSessionRequest(sessionId: id, initialUrl: url));
    return PaymentBrowserSession._(id: id, url: url, supported: status.supported, message: status.message);
  }

  Future<bool> canGoBack() => _api.canGoBack(id);
  Future<void> goBack() => _api.goBack(id);
  Future<void> reload() => _api.reload(id);
  Future<PaymentFillResult> fill(CheckoutBillingResult value) => _api.fillCheckout(id, CheckoutBillingPayload(
        pinyinName: value.pinyinName,
        countryCode: value.countryCode,
        province: value.province,
        city: value.city,
        district: value.district,
        pinyinCity: value.pinyinCity,
        pinyinDistrict: value.pinyinDistrict,
        addressLine1: value.addressLine1,
        postalCode: value.postalCode,
      ));
  Future<void> close() => _api.closeSession(id);
}

class NativePaymentBrowser extends StatelessWidget {
  const NativePaymentBrowser({super.key, required this.session});
  final PaymentBrowserSession session;
  static const _viewType = 'com.kiroluker/payment-browser';

  @override
  Widget build(BuildContext context) {
    final params = <String, Object>{'sessionId': session.id};
    if (kIsWeb || !(Platform.isAndroid || Platform.isIOS)) {
      return const Center(child: Text('支付浏览器仅支持 Android 和 iOS 设备'));
    }
    if (Platform.isAndroid) {
      return AndroidView(viewType: _viewType, creationParams: params, creationParamsCodec: const StandardMessageCodec());
    }
    return UiKitView(viewType: _viewType, creationParams: params, creationParamsCodec: const StandardMessageCodec());
  }
}
