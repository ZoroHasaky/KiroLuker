import 'package:dio/dio.dart';

import 'connection.dart';
import 'models.dart';

class ApiFailure implements Exception {
  const ApiFailure(this.code, this.message);
  final String code;
  final String message;

  factory ApiFailure.fromDio(DioException error) {
    return switch (error.type) {
      DioExceptionType.connectionTimeout ||
      DioExceptionType.sendTimeout ||
      DioExceptionType.receiveTimeout => const ApiFailure(
        'TIMEOUT',
        '连接超时，请检查手机和桌面服务网络',
      ),
      DioExceptionType.connectionError => const ApiFailure(
        'OFFLINE',
        '无法连接桌面服务，请确认服务已启动且网络可达',
      ),
      _ => ApiFailure('NETWORK_ERROR', error.message ?? '网络请求失败'),
    };
  }

  @override
  String toString() => message;
}

class KiroApi {
  KiroApi(ConnectionConfig config)
    : _dio = Dio(
        BaseOptions(
          baseUrl: config.baseUri.toString(),
          connectTimeout: const Duration(seconds: 10),
          receiveTimeout: const Duration(seconds: 30),
          headers: {
            'authorization': 'Bearer ${config.apiKey}',
            'accept': 'application/json',
          },
        ),
      );

  final Dio _dio;

  Future<T> _request<T>(
    String method,
    String path, {
    Map<String, dynamic>? query,
    Object? data,
    required T Function(Object?) decode,
  }) async {
    try {
      final response = await _dio.request<Map<String, dynamic>>(
        path,
        options: Options(method: method),
        queryParameters: query,
        data: data,
      );
      final body = response.data;
      if (body == null || body['success'] != true) {
        throw const ApiFailure('INVALID_RESPONSE', '桌面服务返回了无效响应');
      }
      return decode(body['data']);
    } on ApiFailure {
      rethrow;
    } on DioException catch (error) {
      final body = error.response?.data;
      if (body is Map && body['error'] is Map) {
        final detail = (body['error'] as Map).cast<String, dynamic>();
        throw ApiFailure(
          detail['code']?.toString() ?? 'HTTP_${error.response?.statusCode}',
          detail['message']?.toString() ?? '请求失败',
        );
      }
      throw ApiFailure.fromDio(error);
    }
  }

  Future<CapabilitySet> capabilities() => _request(
    'GET',
    '/api/v1/capabilities',
    decode: (data) =>
        CapabilitySet.fromJson((data as Map).cast<String, dynamic>()),
  );

  static Map<String, dynamic> _optionalIntQuery(String key, int? value) =>
      value == null ? const {} : {key: value};

  static Map<String, dynamic> accountsQuery({
    int page = 1,
    int pageSize = 30,
    String search = '',
    String? subscription,
    String? tagId,
    String? paymentStatus,
    int? createdAfter,
    int? createdBefore,
  }) => {
    'page': page,
    'pageSize': pageSize,
    if (search.trim().isNotEmpty) 'search': search.trim(),
    if (subscription != null && subscription.isNotEmpty)
      'subscription': subscription,
    if (tagId != null && tagId.isNotEmpty) 'tagId': tagId,
    if (paymentStatus != null && paymentStatus.isNotEmpty)
      'paymentStatus': paymentStatus,
    ..._optionalIntQuery('createdAfter', createdAfter),
    ..._optionalIntQuery('createdBefore', createdBefore),
  };

  Future<AccountPage> accounts({
    int page = 1,
    int pageSize = 30,
    String search = '',
    String? subscription,
    String? tagId,
    String? paymentStatus,
    int? createdAfter,
    int? createdBefore,
  }) => _request(
    'GET',
    '/api/v1/accounts',
    query: accountsQuery(
      page: page,
      pageSize: pageSize,
      search: search,
      subscription: subscription,
      tagId: tagId,
      paymentStatus: paymentStatus,
      createdAfter: createdAfter,
      createdBefore: createdBefore,
    ),
    decode: (data) =>
        AccountPage.fromJson((data as Map).cast<String, dynamic>()),
  );

  Future<PublicAccount> account(String id) => _request(
    'GET',
    '/api/v1/accounts/$id',
    decode: (data) =>
        PublicAccount.fromJson((data as Map).cast<String, dynamic>()),
  );
  Future<List<AccountTag>> tags() => _request(
    'GET',
    '/api/v1/tags',
    decode: (data) => (data as List)
        .whereType<Map>()
        .map((item) => AccountTag.fromJson(item.cast<String, dynamic>()))
        .toList(),
  );
  Future<PublicAccount> updateTags(String id, List<String> tagIds) => _request(
    'PATCH',
    '/api/v1/accounts/$id',
    data: {'tagIds': tagIds},
    decode: (data) =>
        PublicAccount.fromJson((data as Map).cast<String, dynamic>()),
  );
  Future<String> oidc(String id) => _request(
    'GET',
    '/api/v1/accounts/$id/oidc',
    decode: (data) => ((data as Map)['content'] as String?) ?? '',
  );
  Future<String?> paymentLink(String id) => _request(
    'GET',
    '/api/v1/accounts/$id/payment-link',
    decode: (data) {
      final value = (data as Map).cast<String, dynamic>();
      return value['configured'] == true ? value['url'] as String? : null;
    },
  );
  Future<CheckoutBillingResult> generateCheckoutBilling() => _request(
    'POST',
    '/api/v1/billing/checkout/generate',
    data: const {},
    decode: (data) =>
        CheckoutBillingResult.fromJson((data as Map).cast<String, dynamic>()),
  );
}
