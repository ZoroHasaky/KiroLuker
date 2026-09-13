import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kiro_lucker/core/api_client.dart';
import 'package:kiro_lucker/core/kiro_subscription_client.dart';
import 'package:kiro_lucker/core/models.dart';

void main() {
  test('端点 URL 由桌面下发的服务区域拼接，不带额外路径', () {
    expect(
      KiroSubscriptionClient.createSubscriptionTokenUrl('us-east-1'),
      'https://q.us-east-1.amazonaws.com/CreateSubscriptionToken',
    );
    expect(
      KiroSubscriptionClient.createSubscriptionTokenUrl('eu-central-1'),
      'https://q.eu-central-1.amazonaws.com/CreateSubscriptionToken',
    );
  });

  test('请求头与桌面 subscriptionService 逐字对齐，含准入敏感的 IDE UA', () {
    final headers = KiroSubscriptionClient.createSubscriptionTokenHeaders(
      'access-token',
      'invocation-id',
    );
    expect(headers['authorization'], 'Bearer access-token');
    expect(headers['content-type'], 'application/json');
    expect(headers['user-agent'], KiroSubscriptionClient.userAgent);
    expect(headers['x-amz-user-agent'], KiroSubscriptionClient.amzUserAgent);
    expect(headers['amz-sdk-invocation-id'], 'invocation-id');
    expect(headers['amz-sdk-request'], 'attempt=1; max=1');
    // 版本号是服务端准入门槛，必须与桌面 kiroEndpoints.ts 同步。
    expect(KiroSubscriptionClient.userAgent, contains('KiroIDE-0.12.155'));
    expect(KiroSubscriptionClient.userAgent, contains('api/codewhispererruntime#1.0.0'));
    expect(KiroSubscriptionClient.userAgent, contains('m/N,E'));
    expect(KiroSubscriptionClient.amzUserAgent, 'aws-sdk-js/1.0.0 KiroIDE-0.12.155');
  });

  test('请求体字段与桌面一致；clientToken 可由调用方固定', () {
    final body = KiroSubscriptionClient.createSubscriptionTokenBody(
      profileArn: 'arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX',
      subscriptionType: 'KIRO_POWER',
      clientToken: 'fixed-token',
    );
    expect(body, {
      'clientToken': 'fixed-token',
      'provider': 'STRIPE',
      'profileArn': 'arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX',
      'subscriptionType': 'KIRO_POWER',
    });
    final generated = KiroSubscriptionClient.createSubscriptionTokenBody(
      profileArn: 'arn',
      subscriptionType: 'KIRO_PRO',
    );
    expect(generated['clientToken'], isNotEmpty);
  });

  test('响应解析兼容 encodedVerificationUrl 与 url，且拒绝非 http(s) 链接', () {
    expect(
      KiroSubscriptionClient.parseSubscriptionLink({
        'encodedVerificationUrl': 'https://checkout.stripe.com/c/pay/token',
        'status': 'ACTIVE',
      }),
      'https://checkout.stripe.com/c/pay/token',
    );
    expect(
      KiroSubscriptionClient.parseSubscriptionLink({'url': 'https://pay.example/xyz'}),
      'https://pay.example/xyz',
    );
    expect(
      KiroSubscriptionClient.parseSubscriptionLink({'url': 'javascript:alert(1)'}),
      isNull,
    );
    expect(
      KiroSubscriptionClient.parseSubscriptionLink({'url': 'not a url'}),
      isNull,
    );
    expect(KiroSubscriptionClient.parseSubscriptionLink({}), isNull);
  });

  test('上游错误提取顺序与桌面一致并截断到 240 字符', () {
    expect(
      KiroSubscriptionClient.upstreamErrorMessage({'message': 'User is not authorized'}),
      'User is not authorized',
    );
    expect(
      KiroSubscriptionClient.upstreamErrorMessage({'__type': 'AccessDeniedException'}),
      'AccessDeniedException',
    );
    expect(KiroSubscriptionClient.upstreamErrorMessage(null), '');
    expect(KiroSubscriptionClient.upstreamErrorMessage('plain'), '');
    expect(
      KiroSubscriptionClient.upstreamErrorMessage({'message': 'x' * 300}).length,
      240,
    );
  });

  test('SubscriptionMaterial 解析桌面下发的字段并兜底默认区域', () {
    final material = SubscriptionMaterial.fromJson({
      'accessToken': 'access',
      'serviceRegion': 'eu-central-1',
      'profileArn': 'arn',
      'tokenExpiresAt': 123456,
    });
    expect(material.accessToken, 'access');
    expect(material.serviceRegion, 'eu-central-1');
    expect(material.profileArn, 'arn');
    expect(material.tokenExpiresAt, 123456);
    expect(
      SubscriptionMaterial.fromJson({'accessToken': 'access', 'profileArn': 'arn'})
          .serviceRegion,
      'us-east-1',
    );
  });

  test('直连客户端成功路径返回链接，非法响应抛 KIRO_INVALID_RESPONSE', () async {
    final passed = <Uri>[];
    final client = KiroSubscriptionClient(
      dio: _stubDio(
        (request) {
          passed.add(request.uri);
          return {'encodedVerificationUrl': 'https://pay.example/ok'};
        },
      ),
    );
    const material = SubscriptionMaterial(
      accessToken: 'access',
      serviceRegion: 'us-east-1',
      profileArn: 'arn',
      tokenExpiresAt: 999999999999999,
    );
    expect(
      await client.createSubscriptionToken(material: material, subscriptionType: 'KIRO_PRO'),
      'https://pay.example/ok',
    );
    expect(passed.single.toString(),
        'https://q.us-east-1.amazonaws.com/CreateSubscriptionToken');

    final invalid = KiroSubscriptionClient(dio: _stubDio((_) => {'status': 'PENDING'}));
    await expectLater(
      invalid.createSubscriptionToken(material: material, subscriptionType: 'KIRO_PRO'),
      throwsA(isA<ApiFailure>().having((e) => e.code, 'code', 'KIRO_INVALID_RESPONSE')),
    );
  });

  test('上游 4xx/5xx 响应映射为 KIRO_UPSTREAM 并带上游错误信息', () async {
    final client = KiroSubscriptionClient(
      dio: _stubDio((_) => {'message': 'User is not authorized to make this call.'}, status: 403),
    );
    const material = SubscriptionMaterial(
      accessToken: 'bad',
      serviceRegion: 'us-east-1',
      profileArn: 'arn',
      tokenExpiresAt: 999999999999999,
    );
    await expectLater(
      client.createSubscriptionToken(material: material, subscriptionType: 'KIRO_PRO'),
      throwsA(
        isA<ApiFailure>()
            .having((e) => e.code, 'code', 'KIRO_UPSTREAM')
            .having((e) => e.message, 'message', 'User is not authorized to make this call.'),
      ),
    );
  });
}

/// 返回一个把请求交给回调的伪 Dio：不走网络，直接返回回调给定的 JSON 与状态码。
Dio _stubDio(Map<String, dynamic> Function(RequestOptions options) handler, {int status = 200}) {
  final dio = Dio(BaseOptions(baseUrl: 'https://stub.invalid'));
  dio.httpClientAdapter = _StubAdapter(handler, status);
  return dio;
}

class _StubAdapter implements HttpClientAdapter {
  _StubAdapter(this.handler, this.status);
  final Map<String, dynamic> Function(RequestOptions options) handler;
  final int status;

  @override
  void close({bool force = false}) {}

  @override
  Future<ResponseBody> fetch(RequestOptions options, Stream<Uint8List>? requestStream, Future<void>? cancelFuture) async {
    final payload = handler(options);
    return ResponseBody.fromString(
      jsonEncode(payload),
      status,
      headers: {
        Headers.contentTypeHeader: [Headers.jsonContentType],
      },
    );
  }
}
