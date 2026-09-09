import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:kiro_lucker/core/connection.dart';
import 'package:kiro_lucker/core/models.dart';

void main() {
  test('局域网地址默认使用 HTTP 和 19840，完整 URL 会同步协议与端口', () {
    final lan = ConnectionConfig.fromFields(endpoint: '192.168.1.8', port: '19840', apiKey: 'klr_test');
    expect(lan.baseUri.toString(), 'http://192.168.1.8:19840');

    final form = ConnectionConfig.parseForm(endpoint: 'https://api.example.com:2443', port: '19840');
    expect(form.scheme, 'https');
    expect(form.host, 'api.example.com');
    expect(form.port, '2443');
  });

  test('连接拒绝路径、查询片段和无效端口，避免错误拼接 URL', () {
    expect(() => ConnectionConfig.fromFields(endpoint: 'https://api.example.com/base', port: '443', apiKey: 'k'), throwsFormatException);
    expect(() => ConnectionConfig.fromFields(endpoint: 'https://api.example.com?x=1', port: '443', apiKey: 'k'), throwsFormatException);
    expect(() => ConnectionConfig.fromFields(endpoint: '10.0.0.1', port: '0', apiKey: 'k'), throwsFormatException);
  });

  test('CheckoutBillingResult 与共享 TypeScript JSON 样本字段一致', () async {
    final sample = jsonDecode(await File('../contracts/checkout-billing-result.json').readAsString()) as Map<String, dynamic>;
    final result = CheckoutBillingResult.fromJson(sample);
    expect(result.countryCode, 'CN');
    expect(result.postalCode, matches(RegExp(r'^\d{6}$')));
    expect(result.addressLine1, 'Lihua Lu 122 Hao');
    expect(result.toPlatformMap()['province'], '云南省');
  });
}
