class ConnectionConfig {
  const ConnectionConfig({required this.baseUri, required this.apiKey});
  final Uri baseUri;
  final String apiKey;

  String get scheme => baseUri.scheme;
  String get host => baseUri.host;
  int get port => baseUri.hasPort ? baseUri.port : (scheme == 'https' ? 443 : 80);

  Map<String, String> toSecureMap() => {
        'endpoint': baseUri.toString(),
        'apiKey': apiKey,
      };

  static ConnectionConfig? fromSecureMap(Map<String, String> value) {
    final endpoint = value['endpoint'];
    final apiKey = value['apiKey'];
    if (endpoint == null || apiKey == null || apiKey.isEmpty) return null;
    try {
      return ConnectionConfig(baseUri: _validateUri(Uri.parse(endpoint)), apiKey: apiKey);
    } on FormatException {
      return null;
    }
  }

  static ConnectionForm parseForm({required String endpoint, required String port}) {
    final input = endpoint.trim();
    if (input.isEmpty) return ConnectionForm(scheme: 'http', host: '', port: port.trim().isEmpty ? '19840' : port.trim());
    final hasScheme = RegExp(r'^[a-zA-Z][a-zA-Z0-9+.-]*://').hasMatch(input);
    final uri = hasScheme ? Uri.tryParse(input) : Uri.tryParse('http://$input');
    if (uri == null || uri.host.isEmpty) {
      return ConnectionForm(scheme: 'http', host: input, port: port.trim().isEmpty ? '19840' : port.trim());
    }
    return ConnectionForm(
      scheme: uri.scheme.toLowerCase() == 'https' ? 'https' : 'http',
      host: uri.host,
      port: uri.hasPort ? '${uri.port}' : (port.trim().isEmpty ? (uri.scheme == 'https' ? '443' : '19840') : port.trim()),
    );
  }

  static ConnectionConfig fromFields({required String endpoint, required String port, required String apiKey}) {
    final raw = endpoint.trim();
    if (raw.isNotEmpty) {
      final hasScheme = RegExp(r'^[a-zA-Z][a-zA-Z0-9+.-]*://').hasMatch(raw);
      final supplied = Uri.tryParse(hasScheme ? raw : 'http://$raw');
      if (supplied != null && supplied.host.isNotEmpty) _validateUri(supplied);
    }
    final form = parseForm(endpoint: endpoint, port: port);
    final parsedPort = int.tryParse(form.port);
    if (form.host.isEmpty) throw const FormatException('请输入 IP 或 URL');
    if (parsedPort == null || parsedPort < 1 || parsedPort > 65535) throw const FormatException('端口必须在 1 到 65535 之间');
    if (apiKey.trim().isEmpty) throw const FormatException('请输入 API Key');
    final uri = Uri(scheme: form.scheme, host: form.host, port: parsedPort);
    return ConnectionConfig(baseUri: _validateUri(uri), apiKey: apiKey.trim());
  }

  static Uri _validateUri(Uri uri) {
    if (uri.scheme != 'http' && uri.scheme != 'https') throw const FormatException('仅支持 HTTP 或 HTTPS');
    if (uri.host.isEmpty || uri.userInfo.isNotEmpty || uri.query.isNotEmpty || uri.fragment.isNotEmpty) {
      throw const FormatException('服务地址必须是不含凭证、查询参数或片段的根地址');
    }
    if (uri.path.isNotEmpty && uri.path != '/') throw const FormatException('服务地址不能包含路径');
    return Uri(scheme: uri.scheme, host: uri.host, port: uri.port == 0 ? null : uri.port);
  }
}

class ConnectionForm {
  const ConnectionForm({required this.scheme, required this.host, required this.port});
  final String scheme;
  final String host;
  final String port;
  String get endpoint => '$scheme://$host';
}
