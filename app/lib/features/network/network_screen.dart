import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'network_controller.dart';

class NetworkScreen extends ConsumerStatefulWidget {
  const NetworkScreen({super.key});

  @override
  ConsumerState<NetworkScreen> createState() => _NetworkScreenState();
}

class _NetworkScreenState extends ConsumerState<NetworkScreen>
    with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    WidgetsBinding.instance.addPostFrameCallback(
      (_) => ref.read(networkControllerProvider.notifier).check(),
    );
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final state =
        ref.watch(networkControllerProvider).asData?.value ??
        const NetworkState();
    final controller = ref.read(networkControllerProvider.notifier);
    final canDisable = controller.canAskToDisableAirplaneMode;
    return Scaffold(
      appBar: AppBar(title: const Text('网络')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text(
            '默认网络公网 IP 直接由手机访问 ipify 检测，不经桌面服务转发。',
            style: Theme.of(context).textTheme.bodyMedium,
          ),
          const SizedBox(height: 12),
          _IpCard(label: 'IPv4', result: state.ipv4),
          _IpCard(label: 'IPv6', result: state.ipv6),
          if (state.error != null)
            Card(
              color: Theme.of(context).colorScheme.errorContainer,
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Text(state.error!),
              ),
            ),
          const Divider(height: 32),
          Text(
            'SIM 卡分别检测（Android）',
            style: Theme.of(context).textTheme.titleLarge,
          ),
          const SizedBox(height: 8),
          Text(
            '检测会通过每张 SIM 请求的蜂窝网络分别访问 ipify。结果仅保存在本机；不会同步到桌面服务。受 Android、机型、运营商和数据卡设置限制，SIM 2 不一定可被应用单独绑定检测。',
            style: Theme.of(context).textTheme.bodyMedium,
          ),
          const SizedBox(height: 8),
          if (state.simPermissionRequired)
            Card(
              color: Theme.of(context).colorScheme.secondaryContainer,
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text('需要“读取手机状态”权限来列出并区分 SIM 卡。'),
                    const SizedBox(height: 8),
                    FilledButton.tonalIcon(
                      onPressed: controller.requestSimPermission,
                      icon: const Icon(Icons.sim_card_outlined),
                      label: const Text('允许检测 SIM 1 / SIM 2'),
                    ),
                  ],
                ),
              ),
            ),
          if (state.simStatus != null)
            Card(
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Text(state.simStatus!),
              ),
            ),
          for (final sim in state.sims) _SimIpCard(result: sim),
          FilledButton.tonalIcon(
            onPressed: controller.check,
            icon: const Icon(Icons.refresh),
            label: const Text('重新检测'),
          ),
          const Divider(height: 32),
          Text('手动换 IP 辅助', style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 8),
          Text(switch (state.stage) {
            SwitchStage.idle => '先记录当前 IP，再由你手动开启飞行模式。',
            SwitchStage.waitForAirplaneMode => '请手动开启飞行模式，然后点击“已开启”。',
            SwitchStage.waitForNetwork =>
              canDisable
                  ? '已满 20 秒，请手动关闭飞行模式并返回 App。'
                  : '飞行模式计时中；达到 20 秒后手动关闭。',
            SwitchStage.completed => '结果：${state.switchResult ?? '检测失败'}',
          }),
          const SizedBox(height: 12),
          if (state.stage == SwitchStage.idle ||
              state.stage == SwitchStage.completed)
            FilledButton(
              onPressed: controller.beginSwitch,
              child: const Text('记录切换前 IP'),
            ),
          if (state.stage == SwitchStage.waitForAirplaneMode)
            FilledButton(
              onPressed: controller.airplaneModeConfirmed,
              child: const Text('我已开启飞行模式'),
            ),
          if (state.stage == SwitchStage.waitForNetwork && canDisable)
            FilledButton(
              onPressed: controller.recheckAfterSwitch,
              child: const Text('已关闭飞行模式，重新检测'),
            ),
          if (state.stage == SwitchStage.waitForNetwork && !canDisable)
            const Text('提示：切换前后台时会根据实际起止时间恢复计时。'),
          const SizedBox(height: 8),
          const Text('最长等待 30 秒。检测失败不会覆盖上次成功的默认网络 IP 记录。'),
        ],
      ),
    );
  }
}

class _IpCard extends StatelessWidget {
  const _IpCard({required this.label, required this.result});

  final String label;
  final IpResult? result;

  @override
  Widget build(BuildContext context) => Card(
    child: ListTile(
      leading: Icon(label == 'IPv4' ? Icons.public : Icons.language),
      title: Text(label),
      subtitle: Text(
        result == null
            ? '尚未检测到'
            : '${result!.value}\n${result!.checkedAt.toLocal()}',
      ),
    ),
  );
}

class _SimIpCard extends StatelessWidget {
  const _SimIpCard({required this.result});

  final SimIpResult result;

  @override
  Widget build(BuildContext context) {
    final current = <String>[
      if (result.ipv4 != null) 'IPv4：${result.ipv4!.value}',
      if (result.ipv6 != null) 'IPv6：${result.ipv6!.value}',
    ];
    final stored = <String>[
      if (result.lastIpv4 != null) 'IPv4：${result.lastIpv4}',
      if (result.lastIpv6 != null) 'IPv6：${result.lastIpv6}',
    ];
    return Card(
      child: ListTile(
        leading: const Icon(Icons.sim_card_outlined),
        title: Text(result.label),
        subtitle: Text(
          [
            if (current.isNotEmpty) ...current,
            if (current.isNotEmpty)
              '本次检测：${result.ipv4?.checkedAt.toLocal() ?? result.ipv6?.checkedAt.toLocal()}',
            if (result.status != null) result.status!,
            if (current.isEmpty && stored.isNotEmpty) ...[
              '本次未获得新结果；本机上次成功记录：',
              ...stored,
              if (result.lastCheckedAt != null)
                '记录时间：${result.lastCheckedAt!.toLocal()}',
            ],
            if (current.isEmpty && stored.isEmpty && result.status == null)
              '尚未检测到',
          ].join('\n'),
        ),
      ),
    );
  }
}
