import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/app_state.dart';
import '../../core/connection.dart';

class ConnectionScreen extends ConsumerStatefulWidget {
  const ConnectionScreen({super.key});
  @override
  ConsumerState<ConnectionScreen> createState() => _ConnectionScreenState();
}

class _ConnectionScreenState extends ConsumerState<ConnectionScreen> {
  final _endpoint = TextEditingController(text: 'http://');
  final _port = TextEditingController(text: '19840');
  final _apiKey = TextEditingController();
  bool _save = false;
  bool _initialized = false;

  @override
  void dispose() { _endpoint.dispose(); _port.dispose(); _apiKey.dispose(); super.dispose(); }

  void _loadInitial() {
    if (_initialized) return;
    _initialized = true;
    final existing = ref.read(connectionControllerProvider).asData?.value;
    final config = existing?.config;
    if (config != null) {
      _endpoint.text = '${config.scheme}://${config.host}';
      _port.text = '${config.port}';
      _apiKey.text = config.apiKey;
      _save = existing?.saved ?? false;
    }
  }

  Future<void> _connect() async {
    ConnectionConfig config;
    try {
      config = ConnectionConfig.fromFields(endpoint: _endpoint.text, port: _port.text, apiKey: _apiKey.text);
    } on FormatException catch (error) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(error.message)));
      return;
    }
    if (config.scheme == 'http' && mounted) {
      final approved = await showDialog<bool>(context: context, builder: (context) => AlertDialog(
        title: const Text('HTTP 明文传输提醒'),
        content: const Text('局域网 HTTP 不会加密 API Key 和账号请求。仅在可信网络继续；公网请使用你配置的 HTTPS 反向代理。'),
        actions: [TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('取消')), FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('继续'))],
      ));
      if (approved != true) return;
    }
    await ref.read(connectionControllerProvider.notifier).connect(config, save: _save);
  }

  @override
  Widget build(BuildContext context) {
    _loadInitial();
    final status = ref.watch(connectionControllerProvider);
    final value = status.asData?.value;
    final loading = status.isLoading;
    return Scaffold(
      appBar: AppBar(title: const Text('连接 KiroLuker 桌面服务')),
      body: SafeArea(
        child: ListView(padding: const EdgeInsets.all(20), children: [
          const Icon(Icons.phone_android_rounded, size: 56),
          const SizedBox(height: 12),
          Text('使用桌面端创建的 API Key 登录，不会创建另一套手机账号。', style: Theme.of(context).textTheme.bodyLarge),
          const SizedBox(height: 24),
          TextField(controller: _endpoint, keyboardType: TextInputType.url, decoration: const InputDecoration(labelText: 'IP 或 URL', hintText: '192.168.1.10 / https://api.example.com')),
          const SizedBox(height: 12),
          TextField(controller: _port, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: '端口', hintText: '局域网默认 19840')),
          const SizedBox(height: 12),
          TextField(controller: _apiKey, obscureText: true, autocorrect: false, enableSuggestions: false, decoration: const InputDecoration(labelText: 'API Key')),
          CheckboxListTile(contentPadding: EdgeInsets.zero, value: _save, onChanged: (value) => setState(() => _save = value ?? false), title: const Text('保存登录信息'), subtitle: const Text('默认不保存；保存时仅使用系统安全存储。')),
          if (value?.error != null) Padding(padding: const EdgeInsets.only(bottom: 12), child: _ErrorNotice(error: value!.error!)),
          FilledButton.icon(onPressed: loading ? null : _connect, icon: const Icon(Icons.login), label: Text(loading ? '正在校验…' : '连接并校验')),
          const SizedBox(height: 18),
          const Text('提示：完整 URL 会自动解析协议和端口；不会忽略 HTTPS 证书错误。'),
        ]),
      ),
    );
  }
}

class _ErrorNotice extends StatelessWidget {
  const _ErrorNotice({required this.error});
  final Object error;
  @override
  Widget build(BuildContext context) => Card(color: Theme.of(context).colorScheme.errorContainer, child: Padding(padding: const EdgeInsets.all(12), child: Text(error.toString())));
}
