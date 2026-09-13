import 'package:dio/dio.dart';
import 'package:uuid/uuid.dart';

import 'api_client.dart';
import 'models.dart';

const _uuid = Uuid();

/// 手机端直连 Kiro 的 CreateSubscriptionToken 客户端（提链）。
///
/// 请求形态复刻桌面端 subscriptionService.postSubscription：
/// - UA 版本号是服务端准入门槛（BuilderId/IdC 用旧版本号会被 403 拒绝），
///   必须与桌面端 src/main/kiroEndpoints.ts 的 kiroSubscriptionUserAgent 同步维护
/// - profileArn 与 serviceRegion 由桌面 resolve 后随 SubscriptionMaterial 下发
class KiroSubscriptionClient {
  KiroSubscriptionClient({Dio? dio}) : _dio = dio ?? Dio();

  final Dio _dio;

  static const kiroIdeVersion = '0.12.155';
  // os / node 段伪装成一台普通 Windows 桌面上的 Kiro IDE；服务端只按 KiroIDE 版本号做准入。
  static const userAgent =
      'aws-sdk-js/1.0.0 ua/2.1 os/win32#10.0.19045 lang/js md/nodejs#22.14.0 '
      'api/codewhispererruntime#1.0.0 m/N,E KiroIDE-$kiroIdeVersion';
  static const amzUserAgent = 'aws-sdk-js/1.0.0 KiroIDE-$kiroIdeVersion';

  static String createSubscriptionTokenUrl(String serviceRegion) =>
      'https://q.$serviceRegion.amazonaws.com/CreateSubscriptionToken';

  static Map<String, String> createSubscriptionTokenHeaders(
    String accessToken,
    String invocationId,
  ) => {
    'authorization': 'Bearer $accessToken',
    'content-type': 'application/json',
    'user-agent': userAgent,
    'x-amz-user-agent': amzUserAgent,
    'amz-sdk-invocation-id': invocationId,
    'amz-sdk-request': 'attempt=1; max=1',
  };

  static Map<String, String> createSubscriptionTokenBody({
    required String profileArn,
    required String subscriptionType,
    String? clientToken,
  }) => {
    'clientToken': clientToken ?? _uuid.v4(),
    'provider': 'STRIPE',
    'profileArn': profileArn,
    'subscriptionType': subscriptionType,
  };

  /// 链接字段在不同版本中可能叫 encodedVerificationUrl 或 url；必须是 http/https 地址。
  static String? parseSubscriptionLink(Map<String, dynamic> json) {
    final url =
        json['encodedVerificationUrl']?.toString() ??
        json['url']?.toString() ??
        '';
    final uri = Uri.tryParse(url);
    if (uri == null || (uri.scheme != 'http' && uri.scheme != 'https') || uri.host.isEmpty) {
      return null;
    }
    return url;
  }

  /// 与桌面 upstreamMessage 一致：提取 message/error/errorMessage/__type，最长 240 字符。
  static String upstreamErrorMessage(Object? data) {
    if (data is! Map) return '';
    for (final key in ['message', 'error', 'errorMessage', '__type']) {
      final value = data[key];
      if (value is String && value.isNotEmpty) {
        return value.length > 240 ? value.substring(0, 240) : value;
      }
    }
    return '';
  }

  /// 手机直连 Kiro 生成订阅链接；成功返回链接 URL（由调用方回传桌面存储）。
  Future<String> createSubscriptionToken({
    required SubscriptionMaterial material,
    required String subscriptionType,
  }) async {
    try {
      final response = await _dio.post<dynamic>(
        createSubscriptionTokenUrl(material.serviceRegion),
        data: createSubscriptionTokenBody(
          profileArn: material.profileArn,
          subscriptionType: subscriptionType,
        ),
        options: Options(
          headers: createSubscriptionTokenHeaders(material.accessToken, _uuid.v4()),
          sendTimeout: const Duration(seconds: 15),
          receiveTimeout: const Duration(seconds: 20),
        ),
      );
      final data = response.data;
      if (data is! Map) {
        throw const ApiFailure('KIRO_INVALID_RESPONSE', 'Kiro 未返回有效的订阅链接');
      }
      final link = parseSubscriptionLink(data.cast<String, dynamic>());
      if (link == null) {
        throw const ApiFailure('KIRO_INVALID_RESPONSE', 'Kiro 未返回有效的订阅链接');
      }
      return link;
    } on ApiFailure {
      rethrow;
    } on DioException catch (error) {
      final detail = error.response?.data;
      if (detail is Map) {
        final message = upstreamErrorMessage(detail);
        throw ApiFailure(
          'KIRO_UPSTREAM',
          message.isNotEmpty ? message : 'Kiro 请求失败（HTTP ${error.response?.statusCode}）',
        );
      }
      throw switch (error.type) {
        DioExceptionType.connectionTimeout ||
        DioExceptionType.sendTimeout ||
        DioExceptionType.receiveTimeout => const ApiFailure(
          'TIMEOUT',
          '连接 Kiro 超时，请检查手机网络',
        ),
        DioExceptionType.connectionError => const ApiFailure(
          'OFFLINE',
          '无法连接 Kiro 服务，请检查手机网络',
        ),
        _ => ApiFailure('NETWORK_ERROR', error.message ?? 'Kiro 请求失败'),
      };
    }
  }
}
