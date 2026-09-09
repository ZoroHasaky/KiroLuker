import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'connection.dart';

class ConnectionStore {
  const ConnectionStore(this._storage);
  final FlutterSecureStorage _storage;

  static const _endpointKey = 'connection.endpoint';
  static const _apiKeyKey = 'connection.api_key';

  Future<ConnectionConfig?> read() async => ConnectionConfig.fromSecureMap({
        'endpoint': (await _storage.read(key: _endpointKey)) ?? '',
        'apiKey': (await _storage.read(key: _apiKeyKey)) ?? '',
      });

  Future<void> save(ConnectionConfig config) async {
    await _storage.write(key: _endpointKey, value: config.baseUri.toString());
    await _storage.write(key: _apiKeyKey, value: config.apiKey);
  }

  Future<void> clear() => _storage.deleteAll();
}
