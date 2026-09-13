import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/app_state.dart';
import '../../core/kiro_subscription_client.dart';
import '../../core/models.dart';

class SubscriptionScreen extends StatelessWidget {
  const SubscriptionScreen({super.key});

  @override
  Widget build(BuildContext context) => DefaultTabController(
    length: 2,
    child: Scaffold(
      appBar: AppBar(
        title: const Text('订阅'),
        bottom: const TabBar(
          tabs: [
            Tab(text: '提链'),
            Tab(text: '切Free'),
          ],
        ),
      ),
      body: const TabBarView(
        children: [
          _SubscriptionOperationPane(operation: _SubscriptionOperation.link),
          _SubscriptionOperationPane(operation: _SubscriptionOperation.free),
        ],
      ),
    ),
  );
}

enum _SubscriptionOperation { link, free }

class _SubscriptionOperationPane extends ConsumerStatefulWidget {
  const _SubscriptionOperationPane({required this.operation});
  final _SubscriptionOperation operation;

  @override
  ConsumerState<_SubscriptionOperationPane> createState() =>
      _SubscriptionOperationPaneState();
}

class _SubscriptionOperationPaneState
    extends ConsumerState<_SubscriptionOperationPane> {
  final Set<String> _selected = <String>{};
  SubscriptionPlansResult? _plans;
  String? _selectedPlan;
  bool _working = false;
  String? _message;

  AccountGroup get _group => widget.operation == _SubscriptionOperation.link
      ? AccountGroup.unused
      : AccountGroup.subscribed;

  Future<void> _loadPlans(List<PublicAccount> accounts) async {
    if (accounts.isEmpty || _working) return;
    setState(() {
      _working = true;
      _message = null;
    });
    try {
      final result = await apiFor(ref).subscriptionPlans(accounts.first.id);
      if (!mounted) return;
      setState(() {
        _plans = result;
        _selectedPlan ??= result.plans.isEmpty ? null : result.plans.first.type;
      });
    } on ApiFailure catch (error) {
      if (mounted) setState(() => _message = error.message);
    } finally {
      if (mounted) setState(() => _working = false);
    }
  }

  Future<void> _run(List<PublicAccount> accounts) async {
    final ids = accounts
        .where((account) => _selected.contains(account.id))
        .map((account) => account.id)
        .toList();
    if (ids.isEmpty || _working) return;
    if (widget.operation == _SubscriptionOperation.link &&
        (_selectedPlan == null || _selectedPlan!.isEmpty)) {
      setState(() => _message = '请先加载并选择订阅计划');
      return;
    }
    setState(() {
      _working = true;
      _message = null;
    });
    try {
      if (widget.operation == _SubscriptionOperation.link) {
        await _runDirectLinks(ids);
      } else {
        final jobId = await apiFor(ref).switchSubscriptionsToFree(ids);
        final job = await _waitJob(jobId);
        if (!mounted) return;
        setState(() {
          _message = '完成：成功 ${job.succeeded}，失败 ${job.failed}，跳过 ${job.skipped}';
          _selected.clear();
        });
      }
      ref.invalidate(subscriptionAccountsProvider);
    } on ApiFailure catch (error) {
      if (mounted) setState(() => _message = error.message);
    } finally {
      if (mounted) setState(() => _working = false);
    }
  }

  /// 提链在手机本机直连 Kiro：逐账号取材料 → 请求 CreateSubscriptionToken → 回传桌面存储。
  /// 顺序执行不并发，避免手机侧集中请求；单个账号失败不中断其余账号。
  Future<void> _runDirectLinks(List<String> ids) async {
    final client = KiroSubscriptionClient();
    var succeeded = 0;
    final failures = <String>[];
    for (var index = 0; index < ids.length; index++) {
      final id = ids[index];
      if (mounted) setState(() => _message = '正在提链 ${index + 1}/${ids.length}…');
      try {
        var material = await apiFor(ref).subscriptionMaterial(id);
        // access token 临期时先借桌面现有刷新任务，再重新取材料。
        if (material.tokenExpiresAt - DateTime.now().millisecondsSinceEpoch <
            5 * 60 * 1000) {
          final job = await _waitJob(await apiFor(ref).refreshToken(id));
          if (job.failed > 0) {
            throw const ApiFailure('REFRESH_FAILED', '刷新密钥失败，请稍后重试');
          }
          material = await apiFor(ref).subscriptionMaterial(id);
        }
        final url = await client.createSubscriptionToken(
          material: material,
          subscriptionType: _selectedPlan!,
        );
        await apiFor(ref).setPaymentLink(id, url);
        succeeded++;
      } on ApiFailure catch (error) {
        failures.add('${index + 1}. ${error.message}');
      }
    }
    if (!mounted) return;
    setState(() {
      _selected.clear();
      _message = failures.isEmpty
          ? '完成：成功 $succeeded'
          : '完成：成功 $succeeded，失败 ${failures.length}\n${failures.take(5).join('\n')}';
    });
  }

  Future<WebJob> _waitJob(String id) async {
    while (true) {
      final job = await apiFor(ref).job(id);
      if (job.finished) return job;
      await Future<void>.delayed(const Duration(milliseconds: 500));
    }
  }

  @override
  Widget build(BuildContext context) {
    final page = ref.watch(subscriptionAccountsProvider(_group));
    return page.when(
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (error, _) => _SubscriptionError(
        error: error,
        onRetry: () => ref.invalidate(subscriptionAccountsProvider(_group)),
      ),
      data: (data) {
        final accounts = data.items;
        final visibleIds = accounts.map((account) => account.id).toSet();
        _selected.removeWhere((id) => !visibleIds.contains(id));
        return RefreshIndicator(
          onRefresh: () async =>
              ref.invalidate(subscriptionAccountsProvider(_group)),
          child: ListView(
            padding: const EdgeInsets.all(12),
            children: [
              Text(
                widget.operation == _SubscriptionOperation.link
                    ? '仅显示未使用账号'
                    : '仅显示当前可管理的已订阅账号',
                style: Theme.of(context).textTheme.bodyMedium,
              ),
              const SizedBox(height: 8),
              if (widget.operation == _SubscriptionOperation.link) ...[
                Row(
                  children: [
                    FilledButton.tonalIcon(
                      onPressed: _working ? null : () => _loadPlans(accounts),
                      icon: const Icon(Icons.refresh),
                      label: const Text('加载订阅计划'),
                    ),
                    const SizedBox(width: 8),
                    if (_plans != null) Text('${_plans!.plans.length} 个计划'),
                  ],
                ),
                if (_plans != null) ...[
                  const SizedBox(height: 8),
                  DropdownButtonFormField<String>(
                    initialValue: _selectedPlan,
                    decoration: const InputDecoration(labelText: '订阅计划'),
                    items: _plans!.plans
                        .map(
                          (plan) => DropdownMenuItem(
                            value: plan.type,
                            child: Text('${plan.title} · ${plan.priceLabel}'),
                          ),
                        )
                        .toList(),
                    onChanged: _working
                        ? null
                        : (value) => setState(() => _selectedPlan = value),
                  ),
                ],
              ],
              const SizedBox(height: 8),
              Row(
                children: [
                  Text('可操作 ${data.total} 个账号'),
                  const Spacer(),
                  TextButton(
                    onPressed: accounts.isEmpty
                        ? null
                        : () => setState(() => _selected.addAll(visibleIds)),
                    child: const Text('全选'),
                  ),
                  TextButton(
                    onPressed: _selected.isEmpty
                        ? null
                        : () => setState(_selected.clear),
                    child: const Text('清空'),
                  ),
                ],
              ),
              for (final account in accounts)
                CheckboxListTile(
                  value: _selected.contains(account.id),
                  onChanged: _working
                      ? null
                      : (checked) => setState(
                          () => checked == true
                              ? _selected.add(account.id)
                              : _selected.remove(account.id),
                        ),
                  title: Text(
                    account.nickname?.isNotEmpty == true
                        ? account.nickname!
                        : account.email,
                  ),
                  subtitle: Text(
                    '${account.email}\n${account.subscription.displayType} · ${formatUsage(account.usage)}',
                  ),
                  isThreeLine: true,
                ),
              if (accounts.isEmpty)
                const Padding(
                  padding: EdgeInsets.all(40),
                  child: Center(child: Text('没有可操作的账号')),
                ),
              const SizedBox(height: 8),
              FilledButton.icon(
                onPressed: _working || _selected.isEmpty
                    ? null
                    : () => _run(accounts),
                icon: _working
                    ? const SizedBox.square(
                        dimension: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : Icon(
                        widget.operation == _SubscriptionOperation.link
                            ? Icons.link
                            : Icons.undo,
                      ),
                label: Text(
                  widget.operation == _SubscriptionOperation.link
                      ? '提链（${_selected.length}）'
                      : '切Free（${_selected.length}）',
                ),
              ),
              if (_message != null)
                Padding(
                  padding: const EdgeInsets.only(top: 12),
                  child: Text(_message!),
                ),
            ],
          ),
        );
      },
    );
  }
}

class _SubscriptionError extends StatelessWidget {
  const _SubscriptionError({required this.error, required this.onRetry});
  final Object error;
  final VoidCallback onRetry;
  @override
  Widget build(BuildContext context) => Center(
    child: Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(error.toString()),
        const SizedBox(height: 12),
        OutlinedButton(onPressed: onRetry, child: const Text('重试')),
      ],
    ),
  );
}
