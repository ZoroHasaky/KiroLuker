import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api_client.dart';
import '../../core/app_state.dart';
import '../../core/models.dart';

class AccountsScreen extends ConsumerStatefulWidget {
  const AccountsScreen({super.key});

  @override
  ConsumerState<AccountsScreen> createState() => _AccountsScreenState();
}

class _AccountsScreenState extends ConsumerState<AccountsScreen> {
  final _search = TextEditingController();

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  void _apply({
    String? subscription,
    String? tagId,
    String? paymentStatus,
    DateTime? importDate,
    bool clearSubscription = false,
    bool clearTag = false,
    bool clearPaymentStatus = false,
    bool clearImportDate = false,
  }) {
    final current = ref.read(accountFilterProvider);
    ref
        .read(accountFilterProvider.notifier)
        .update(
          current.copyWith(
            page: 1,
            search: _search.text,
            subscription: subscription,
            tagId: tagId,
            paymentStatus: paymentStatus,
            importDate: importDate,
            clearSubscription: clearSubscription,
            clearTag: clearTag,
            clearPaymentStatus: clearPaymentStatus,
            clearImportDate: clearImportDate,
          ),
        );
  }

  Future<void> _pickImportDate(AccountFilter filter) async {
    final today = DateUtils.dateOnly(DateTime.now());
    final selected = await showDatePicker(
      context: context,
      initialDate: filter.importDate ?? today,
      firstDate: DateTime(2020),
      lastDate: today,
      helpText: '选择导入日期',
    );
    if (selected != null) _apply(importDate: selected);
  }

  @override
  Widget build(BuildContext context) {
    final filter = ref.watch(accountFilterProvider);
    final page = ref.watch(accountPageProvider);
    final tags = ref.watch(tagsProvider);
    final today = DateUtils.dateOnly(DateTime.now());

    return Scaffold(
      appBar: AppBar(title: const Text('账号')),
      body: RefreshIndicator(
        onRefresh: () async {
          ref.invalidate(accountPageProvider);
          ref.invalidate(tagsProvider);
        },
        child: ListView(
          padding: const EdgeInsets.all(12),
          children: [
            TextField(
              controller: _search,
              textInputAction: TextInputAction.search,
              onSubmitted: (_) => _apply(),
              decoration: InputDecoration(
                labelText: '搜索邮箱或昵称',
                suffixIcon: IconButton(
                  onPressed: _apply,
                  icon: const Icon(Icons.search),
                ),
              ),
            ),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                _Choice(
                  value: filter.subscription,
                  label: '订阅',
                  choices: subscriptionFilterLabels,
                  onChanged: (value) => _apply(
                    subscription: value,
                    clearSubscription: value == null || value.isEmpty,
                  ),
                ),
                _Choice(
                  value: filter.paymentStatus,
                  label: '支付状态',
                  choices: const {
                    '': '全部支付状态',
                    'pending': '待支付',
                    'not_pending': '非待支付',
                  },
                  onChanged: (value) => _apply(
                    paymentStatus: value,
                    clearPaymentStatus: value == null || value.isEmpty,
                  ),
                ),
                tags.when(
                  data: (items) => _TagChoice(
                    value: filter.tagId,
                    tags: items,
                    onChanged: (value) => _apply(
                      tagId: value,
                      clearTag: value == null || value.isEmpty,
                    ),
                  ),
                  loading: () => const SizedBox(
                    width: 80,
                    height: 36,
                    child: Center(child: CircularProgressIndicator()),
                  ),
                  error: (_, _) => const SizedBox.shrink(),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                OutlinedButton.icon(
                  onPressed: () => _pickImportDate(filter),
                  icon: const Icon(Icons.calendar_month_outlined),
                  label: Text(
                    filter.importDate == null
                        ? '导入日期：全部'
                        : '导入日期：${_formatDate(filter.importDate!)}',
                  ),
                ),
                FilterChip(
                  label: const Text('仅看今天'),
                  selected: filter.isOnlyToday(today),
                  onSelected: (selected) => _apply(
                    importDate: selected ? today : null,
                    clearImportDate: !selected,
                  ),
                ),
                if (filter.importDate != null)
                  IconButton(
                    tooltip: '清除导入日期',
                    onPressed: () => _apply(clearImportDate: true),
                    icon: const Icon(Icons.clear),
                  ),
              ],
            ),
            const SizedBox(height: 12),
            page.when(
              loading: () => const Padding(
                padding: EdgeInsets.all(48),
                child: Center(child: CircularProgressIndicator()),
              ),
              error: (error, _) => _RetryCard(
                error: error,
                onRetry: () => ref.invalidate(accountPageProvider),
              ),
              data: (data) => Column(
                children: [
                  if (data.items.isEmpty)
                    const Padding(
                      padding: EdgeInsets.all(48),
                      child: Text('没有匹配的账号'),
                    ),
                  for (final account in data.items)
                    _AccountTile(
                      account: account,
                      tags: tags.asData?.value ?? const [],
                    ),
                  if (data.total > 0)
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 12),
                      child: Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          Text(
                            '第 ${data.page}/${data.pageCount} 页 · ${data.total} 个',
                          ),
                          Row(
                            children: [
                              IconButton(
                                onPressed: data.page > 1
                                    ? () => ref
                                          .read(accountFilterProvider.notifier)
                                          .update(
                                            filter.copyWith(
                                              page: data.page - 1,
                                            ),
                                          )
                                    : null,
                                icon: const Icon(Icons.chevron_left),
                              ),
                              IconButton(
                                onPressed: data.page < data.pageCount
                                    ? () => ref
                                          .read(accountFilterProvider.notifier)
                                          .update(
                                            filter.copyWith(
                                              page: data.page + 1,
                                            ),
                                          )
                                    : null,
                                icon: const Icon(Icons.chevron_right),
                              ),
                            ],
                          ),
                        ],
                      ),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

String _formatDate(DateTime value) =>
    '${value.year.toString().padLeft(4, '0')}-${value.month.toString().padLeft(2, '0')}-${value.day.toString().padLeft(2, '0')}';

class _Choice extends StatelessWidget {
  const _Choice({
    required this.value,
    required this.label,
    required this.choices,
    required this.onChanged,
  });

  final String? value;
  final String label;
  final Map<String, String> choices;
  final ValueChanged<String?> onChanged;

  @override
  Widget build(BuildContext context) => SizedBox(
    width: 150,
    child: DropdownButtonFormField<String>(
      key: ValueKey('$label:$value'),
      initialValue: value ?? '',
      isExpanded: true,
      decoration: InputDecoration(labelText: label, isDense: true),
      items: choices.entries
          .map(
            (entry) => DropdownMenuItem(
              value: entry.key,
              child: Text(entry.value, overflow: TextOverflow.ellipsis),
            ),
          )
          .toList(),
      onChanged: onChanged,
    ),
  );
}

class _TagChoice extends StatelessWidget {
  const _TagChoice({
    required this.value,
    required this.tags,
    required this.onChanged,
  });

  final String? value;
  final List<AccountTag> tags;
  final ValueChanged<String?> onChanged;

  @override
  Widget build(BuildContext context) => SizedBox(
    width: 140,
    child: DropdownButtonFormField<String>(
      key: ValueKey('标签:$value'),
      initialValue: value ?? '',
      isExpanded: true,
      decoration: const InputDecoration(labelText: '标签', isDense: true),
      items: [
        const DropdownMenuItem(value: '', child: Text('全部标签')),
        ...tags.map(
          (tag) => DropdownMenuItem(
            value: tag.id,
            child: Text(tag.name, overflow: TextOverflow.ellipsis),
          ),
        ),
      ],
      onChanged: onChanged,
    ),
  );
}

class _AccountTile extends StatelessWidget {
  const _AccountTile({required this.account, required this.tags});

  final PublicAccount account;
  final List<AccountTag> tags;

  @override
  Widget build(BuildContext context) {
    final labels = tags
        .where((tag) => account.tagIds.contains(tag.id))
        .toList();
    final usageProgress = account.usage.percentUsed.clamp(0, 1).toDouble();

    return Card(
      child: ListTile(
        onTap: () => context.push('/account/${account.id}'),
        title: Text(
          account.nickname?.isNotEmpty == true
              ? '${account.nickname} · ${account.email}'
              : account.email,
        ),
        subtitle: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              '${account.subscription.displayType} · ${account.status} · ${account.idp}${account.isPaymentPending ? ' · 待支付' : ''}',
            ),
            const SizedBox(height: 4),
            Text('用量：${formatUsage(account.usage)}'),
            const SizedBox(height: 3),
            LinearProgressIndicator(
              value: usageProgress,
              semanticsLabel: '用量 ${formatUsage(account.usage)}',
            ),
            if (labels.isNotEmpty)
              Wrap(
                spacing: 4,
                children: labels
                    .map(
                      (tag) => Chip(
                        label: Text(tag.name),
                        visualDensity: VisualDensity.compact,
                      ),
                    )
                    .toList(),
              ),
          ],
        ),
        trailing: account.hasPaymentLink
            ? Icon(
                Icons.payment,
                semanticLabel: account.isPaymentPending ? '待支付' : '已配置支付链接',
              )
            : null,
      ),
    );
  }
}

class _RetryCard extends StatelessWidget {
  const _RetryCard({required this.error, required this.onRetry});

  final Object error;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) => Card(
    child: Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(error.toString()),
          const SizedBox(height: 8),
          OutlinedButton(onPressed: onRetry, child: const Text('重试')),
        ],
      ),
    ),
  );
}

class AccountDetailScreen extends ConsumerWidget {
  const AccountDetailScreen({super.key, required this.id});

  final String id;

  Future<void> _copy(BuildContext context, String value, String success) async {
    await Clipboard.setData(ClipboardData(text: value));
    if (context.mounted) {
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(success)));
    }
  }

  Future<void> _copyOidc(BuildContext context, WidgetRef ref) async {
    try {
      final content = await apiFor(ref).oidc(id);
      if (!context.mounted) return;
      await _copy(context, content, 'OIDC 精简 JSON 已复制；未写入账号缓存');
    } on ApiFailure catch (error) {
      if (context.mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(error.message)));
      }
    }
  }

  Future<void> _editTags(
    BuildContext context,
    WidgetRef ref,
    PublicAccount account,
  ) async {
    final tags = await ref.read(tagsProvider.future);
    final selected = {...account.tagIds};
    if (!context.mounted) return;
    final next = await showModalBottomSheet<List<String>>(
      context: context,
      isScrollControlled: true,
      builder: (context) => StatefulBuilder(
        builder: (context, setModalState) => SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text('修改标签', style: Theme.of(context).textTheme.titleLarge),
                const SizedBox(height: 8),
                for (final tag in tags)
                  CheckboxListTile(
                    value: selected.contains(tag.id),
                    title: Text(tag.name),
                    onChanged: (checked) => setModalState(() {
                      if (checked == true) {
                        selected.add(tag.id);
                      } else {
                        selected.remove(tag.id);
                      }
                    }),
                  ),
                FilledButton(
                  onPressed: () => Navigator.pop(context, selected.toList()),
                  child: const Text('保存'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
    if (next == null) return;
    try {
      await apiFor(ref).updateTags(id, next);
      ref.invalidate(accountDetailProvider(id));
      ref.invalidate(accountPageProvider);
      if (context.mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('账号标签已同步到桌面端')));
      }
    } on ApiFailure catch (error) {
      if (context.mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(error.message)));
      }
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final detail = ref.watch(accountDetailProvider(id));
    return Scaffold(
      appBar: AppBar(title: const Text('账号详情')),
      body: detail.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, _) => _RetryCard(
          error: error,
          onRetry: () => ref.invalidate(accountDetailProvider(id)),
        ),
        data: (account) => ListView(
          padding: const EdgeInsets.all(16),
          children: [
            Text(account.email, style: Theme.of(context).textTheme.titleLarge),
            if (account.nickname?.isNotEmpty == true) Text(account.nickname!),
            if (account.note?.isNotEmpty == true)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(account.note!),
              ),
            const Divider(height: 28),
            _Info(label: '订阅', value: account.subscription.displayType),
            _Info(label: '用量', value: formatUsage(account.usage)),
            _Info(label: '状态', value: account.status),
            _Info(label: '登录来源', value: account.idp),
            const SizedBox(height: 16),
            FilledButton.tonalIcon(
              onPressed: () => _copy(context, account.email, '邮箱已复制'),
              icon: const Icon(Icons.copy),
              label: const Text('复制邮箱'),
            ),
            const SizedBox(height: 8),
            FilledButton.tonalIcon(
              onPressed: () => _copyOidc(context, ref),
              icon: const Icon(Icons.key_outlined),
              label: const Text('复制精简 JSON'),
            ),
            const SizedBox(height: 8),
            FilledButton.tonalIcon(
              onPressed: () => _editTags(context, ref, account),
              icon: const Icon(Icons.label_outline),
              label: const Text('修改标签'),
            ),
            const SizedBox(height: 8),
            FilledButton.icon(
              onPressed: account.hasPaymentLink
                  ? () => context.push('/payment/$id')
                  : null,
              icon: const Icon(Icons.payment),
              label: Text(account.hasPaymentLink ? '跳转支付' : '桌面端未配置支付链接'),
            ),
          ],
        ),
      ),
    );
  }
}

class _Info extends StatelessWidget {
  const _Info({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 4),
    child: Row(
      children: [
        SizedBox(width: 88, child: Text(label)),
        Expanded(child: Text(value)),
      ],
    ),
  );
}
