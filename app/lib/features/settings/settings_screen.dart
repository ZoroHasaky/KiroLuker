import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter/services.dart';

import '../../core/app_state.dart';
import '../../core/app_version.dart';
import '../../core/browser_persona.dart';

class SettingsScreen extends ConsumerStatefulWidget {
  const SettingsScreen({super.key});
  @override
  ConsumerState<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends ConsumerState<SettingsScreen> {
  bool _checking = false;
  String? _error;
  String? _latestVersion;
  String? _releaseUrl;
  String? _apkUrl;

  @override
  void initState() {
    super.initState();
  }

  Future<void> _checkUpdate() async {
    setState(() {
      _checking = true;
      _error = null;
    });
    try {
      final response = await Dio().get<Map<String, dynamic>>(
        'https://api.github.com/repos/ZoroHasaky/KiroLuker/releases/latest',
        options: Options(
          headers: {'accept': 'application/vnd.github+json'},
          receiveTimeout: const Duration(seconds: 10),
        ),
      );
      final data = response.data ?? const <String, dynamic>{};
      final tag = data['tag_name']?.toString() ?? '';
      final assets =
          (data['assets'] as List?)
              ?.whereType<Map>()
              .map((item) => item.cast<String, dynamic>())
              .toList() ??
          const <Map<String, dynamic>>[];
      final apk = assets.firstWhere(
        (item) => item['name']?.toString().contains('arm64-v8a.apk') == true,
        orElse: () => <String, dynamic>{},
      );
      if (!mounted) return;
      setState(() {
        _latestVersion = tag.replaceFirst(RegExp(r'^v'), '');
        _releaseUrl = data['html_url']?.toString();
        _apkUrl = apk['browser_download_url']?.toString();
      });
      final current = appVersion;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            _compareVersion(_latestVersion ?? '', current) > 0
                ? '发现新版本：$_latestVersion'
                : '当前已是最新版本',
          ),
        ),
      );
    } catch (error) {
      if (mounted) setState(() => _error = '检查更新失败：$error');
    } finally {
      if (mounted) setState(() => _checking = false);
    }
  }

  Future<void> _openUpdate() async {
    final url = Theme.of(context).platform == TargetPlatform.android
        ? (_apkUrl ?? _releaseUrl)
        : _releaseUrl;
    if (url == null) {
      if (mounted) setState(() => _error = '暂无可用更新地址');
      return;
    }
    try {
      final channel = const MethodChannel('com.kiroluker/app-update');
      final isAndroid = Theme.of(context).platform == TargetPlatform.android;
      final result =
          await channel.invokeMethod<bool>(
            isAndroid ? 'downloadUrl' : 'openUrl',
            isAndroid
                ? {'url': url, 'filename': 'kiroluker-update.apk'}
                : {'url': url},
          ) ??
          false;
      if (mounted) {
        if (result) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text(isAndroid ? '已开始下载更新，请在系统通知中查看进度' : '已打开更新页面'),
            ),
          );
        } else {
          setState(() => _error = '无法打开更新地址');
        }
      }
    } on PlatformException catch (error) {
      if (mounted) setState(() => _error = error.message ?? '无法打开更新地址');
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(connectionControllerProvider).asData?.value;
    final capabilities = state?.capabilities;
    final current = appVersion;
    final selectedPersona = ref.watch(browserPersonaProvider);
    final hasUpdate =
        _latestVersion != null &&
        _compareVersion(_latestVersion!, appVersion) > 0;
    return Scaffold(
      appBar: AppBar(title: const Text('设置')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text('应用更新', style: Theme.of(context).textTheme.titleLarge),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('当前版本：$current'),
                  if (_latestVersion != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 6),
                      child: Text(
                        hasUpdate ? '最新版本：$_latestVersion' : '已是最新版本',
                      ),
                    ),
                  const SizedBox(height: 10),
                  Wrap(
                    spacing: 8,
                    children: [
                      FilledButton.tonalIcon(
                        onPressed: _checking ? null : _checkUpdate,
                        icon: _checking
                            ? const SizedBox.square(
                                dimension: 16,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                ),
                              )
                            : const Icon(Icons.system_update),
                        label: const Text('检查更新'),
                      ),
                      if (hasUpdate)
                        OutlinedButton.icon(
                          onPressed: _openUpdate,
                          icon: const Icon(Icons.download),
                          label: Text(
                            Theme.of(context).platform == TargetPlatform.android
                                ? '下载更新'
                                : '打开更新页面',
                          ),
                        ),
                    ],
                  ),
                  if (_error != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 8),
                      child: Text(
                        _error!,
                        style: TextStyle(
                          color: Theme.of(context).colorScheme.error,
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 20),
          Text('连接', style: Theme.of(context).textTheme.titleLarge),
          Card(
            child: ListTile(
              leading: const Icon(Icons.dns_outlined),
              title: Text(state?.config?.baseUri.toString() ?? '未连接'),
              subtitle: Text(
                state?.saved == true
                    ? '登录信息已保存至系统安全存储'
                    : '本次运行临时连接；未保存 API Key',
              ),
            ),
          ),
          if (capabilities != null)
            Card(
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text('桌面 API 能力'),
                    const SizedBox(height: 8),
                    Text('版本：${capabilities.apiVersion}'),
                    const SizedBox(height: 4),
                    Wrap(
                      spacing: 6,
                      runSpacing: 6,
                      children: capabilities.scopes
                          .map(
                            (scope) => Chip(
                              label: Text(scope),
                              visualDensity: VisualDensity.compact,
                            ),
                          )
                          .toList(),
                    ),
                  ],
                ),
              ),
            ),
          const SizedBox(height: 8),
          FilledButton.tonalIcon(
            onPressed: () => ref
                .read(connectionControllerProvider.notifier)
                .disconnect(clearSaved: true),
            icon: const Icon(Icons.logout),
            label: const Text('退出登录并清除保存信息'),
          ),
          const SizedBox(height: 8),
          OutlinedButton.icon(
            onPressed: () => ref
                .read(connectionControllerProvider.notifier)
                .disconnect(clearSaved: true),
            icon: const Icon(Icons.delete_outline),
            label: const Text('清除已保存连接'),
          ),
          const SizedBox(height: 24),
          Text('支付浏览器标识', style: Theme.of(context).textTheme.titleLarge),
          Card(
            child: RadioGroup<BrowserPersona>(
              groupValue: selectedPersona,
              onChanged: (value) {
                if (value != null) {
                  ref.read(browserPersonaProvider.notifier).set(value);
                }
              },
              child: Column(
                children: [
                  for (final (persona, title, subtitle) in [
                    (
                      BrowserPersona.auto,
                      '自动推荐',
                      'Android 伪装为 Chrome，iOS 伪装为 Safari',
                    ),
                    (
                      BrowserPersona.chrome,
                      'Chrome',
                      'Android 为手机版 Chrome，iOS 为 Chrome（CriOS）',
                    ),
                    (
                      BrowserPersona.edge,
                      'Edge',
                      'Android 为 EdgA，iOS 为 EdgiOS',
                    ),
                    (
                      BrowserPersona.quark,
                      '夸克浏览器',
                      'Android 为夸克完整标识；iOS 回落为 Safari',
                    ),
                  ])
                    RadioListTile<BrowserPersona>(
                      value: persona,
                      title: Text(title),
                      subtitle: Text(subtitle),
                      dense: true,
                    ),
                ],
              ),
            ),
          ),
          const Card(
            child: Padding(
              padding: EdgeInsets.all(12),
              child: Text(
                '支付页 WebView 会伪装成所选浏览器：User-Agent 与 navigator.userAgentData 品牌与真实浏览器一致，'
                '引擎版本号动态取自设备真实 WebView，与声称版本严格吻合。夸克、Chrome iOS 与 Edge iOS 的品牌版本号随应用发版维护。',
              ),
            ),
          ),
          const SizedBox(height: 24),
          Text('安全说明', style: Theme.of(context).textTheme.titleLarge),
          const Card(
            child: Padding(
              padding: EdgeInsets.all(12),
              child: Text(
                '账号列表不会保存凭证或完整支付链接。OIDC 精简 JSON 只在点击复制时从桌面按需获取；支付 WebView 无法读取 API Key，也没有任意 JavaScript 调用通道。',
              ),
            ),
          ),
        ],
      ),
    );
  }
}

int _compareVersion(String left, String right) {
  List<int> parse(String value) => value
      .replaceFirst(RegExp(r'^v'), '')
      .split(RegExp(r'[-+]'))
      .first
      .split('.')
      .map((part) => int.tryParse(part) ?? 0)
      .toList();
  final a = parse(left), b = parse(right);
  for (var i = 0; i < 3; i++) {
    final diff = (a.length > i ? a[i] : 0) - (b.length > i ? b[i] : 0);
    if (diff != 0) return diff;
  }
  return 0;
}
