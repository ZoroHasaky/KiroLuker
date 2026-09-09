import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/app_state.dart';

class SettingsScreen extends ConsumerWidget {
  const SettingsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(connectionControllerProvider).asData?.value;
    final capabilities = state?.capabilities;
    return Scaffold(
      appBar: AppBar(title: const Text('设置')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text('连接', style: Theme.of(context).textTheme.titleLarge),
          Card(
            child: ListTile(
              leading: const Icon(Icons.dns_outlined),
              title: Text(state?.config?.baseUri.toString() ?? '未连接'),
              subtitle: Text(state?.saved == true ? '登录信息已保存至系统安全存储' : '本次运行临时连接；未保存 API Key'),
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
                      children: capabilities.scopes.map((scope) => Chip(label: Text(scope), visualDensity: VisualDensity.compact)).toList(),
                    ),
                  ],
                ),
              ),
            ),
          const SizedBox(height: 8),
          FilledButton.tonalIcon(
            onPressed: () => ref.read(connectionControllerProvider.notifier).disconnect(clearSaved: true),
            icon: const Icon(Icons.logout),
            label: const Text('退出登录并清除保存信息'),
          ),
          const SizedBox(height: 8),
          OutlinedButton.icon(
            onPressed: () => ref.read(connectionControllerProvider.notifier).disconnect(clearSaved: true),
            icon: const Icon(Icons.delete_outline),
            label: const Text('清除已保存连接'),
          ),
          const SizedBox(height: 24),
          Text('安全说明', style: Theme.of(context).textTheme.titleLarge),
          const Card(
            child: Padding(
              padding: EdgeInsets.all(12),
              child: Text('账号列表不会保存凭证或完整支付链接。OIDC 精简 JSON 只在点击复制时从桌面按需获取；支付 WebView 无法读取 API Key，也没有任意 JavaScript 调用通道。'),
            ),
          ),
        ],
      ),
    );
  }
}
