import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kiro_lucker/core/api_client.dart';
import 'package:kiro_lucker/core/app_state.dart';
import 'package:kiro_lucker/core/models.dart';
import 'package:kiro_lucker/features/accounts/accounts_screen.dart';

void main() {
  PublicAccount account({
    String subscription = 'Free',
    bool hasPaymentLink = false,
    num percentUsed = 0.125,
  }) => PublicAccount(
    id: 'account-1',
    email: 'person@example.com',
    idp: 'Google',
    subscription: SubscriptionInfo(type: subscription),
    usage: UsageInfo(
      current: 125,
      limit: 1000,
      percentUsed: percentUsed,
      lastUpdated: 1,
    ),
    status: 'active',
    tagIds: const [],
    hasPaymentLink: hasPaymentLink,
  );

  test('订阅原始类型映射、待支付判定和用量比例展示与桌面契约一致', () {
    expect(subscriptionFilterLabels, {
      '': '全部订阅',
      'Free': 'Free',
      'Pro': 'Pro',
      'Pro_Plus': 'Pro+',
      'Pro_Max': 'Max',
      'Power': 'Power',
    });
    expect(account(subscription: 'Pro_Plus').subscription.displayType, 'Pro+');
    expect(account(subscription: 'Pro_Max').subscription.displayType, 'Max');
    expect(
      account(subscription: 'Free', hasPaymentLink: true).isPaymentPending,
      isTrue,
    );
    expect(
      account(subscription: 'Pro', hasPaymentLink: true).isPaymentPending,
      isFalse,
    );
    expect(formatUsage(account().usage), '125 / 1000（12.5%）');
  });

  test('导入日期转换为本地整日的 API 半开区间，且复制筛选可清除日期和支付状态', () {
    final date = DateTime(2026, 9, 9, 18, 45);
    final filter = AccountFilter(importDate: date, paymentStatus: 'pending');
    expect(filter.createdAfter, DateTime(2026, 9, 9).millisecondsSinceEpoch);
    expect(filter.createdBefore, DateTime(2026, 9, 10).millisecondsSinceEpoch);
    expect(filter.isOnlyToday(DateTime(2026, 9, 9, 1)), isTrue);

    final cleared = filter.copyWith(
      clearImportDate: true,
      clearPaymentStatus: true,
    );
    expect(cleared.importDate, isNull);
    expect(cleared.paymentStatus, isNull);
  });

  test('账户 API 查询仅发送支持的订阅、标签、支付状态和导入日期参数', () {
    expect(
      KiroApi.accountsQuery(
        page: 2,
        pageSize: 50,
        search: ' person@example.com ',
        subscription: 'Pro_Plus',
        tagId: 'tag-1',
        paymentStatus: 'pending',
        createdAfter: 100,
        createdBefore: 200,
      ),
      {
        'page': 2,
        'pageSize': 50,
        'search': 'person@example.com',
        'subscription': 'Pro_Plus',
        'tagId': 'tag-1',
        'paymentStatus': 'pending',
        'createdAfter': 100,
        'createdBefore': 200,
      },
    );
  });

  testWidgets('账户页移除来源和状态筛选，提供今天快捷筛选并展示列表用量', (tester) async {
    final page = AccountPage(
      items: [account(hasPaymentLink: true)],
      page: 1,
      pageSize: 30,
      total: 1,
    );
    final container = ProviderContainer(
      overrides: [
        accountPageProvider.overrideWith((ref) async => page),
        tagsProvider.overrideWith((ref) async => const <AccountTag>[]),
      ],
    );
    addTearDown(container.dispose);

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: const MaterialApp(home: AccountsScreen()),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('状态'), findsNothing);
    expect(find.text('来源'), findsNothing);
    expect(find.text('支付状态'), findsOneWidget);
    expect(find.text('用量：125 / 1000（12.5%）'), findsOneWidget);
    expect(find.textContaining('待支付'), findsOneWidget);

    await tester.tap(find.text('仅看今天'));
    await tester.pump();
    final filter = container.read(accountFilterProvider);
    final today = DateUtils.dateOnly(DateTime.now());
    expect(filter.createdAfter, today.millisecondsSinceEpoch);
    expect(
      filter.createdBefore,
      today.add(const Duration(days: 1)).millisecondsSinceEpoch,
    );

    await tester.tap(find.byKey(const ValueKey('订阅:null')));
    await tester.pumpAndSettle();
    expect(find.text('Pro+'), findsOneWidget);
    expect(find.text('Max'), findsOneWidget);
    expect(find.text('Power'), findsOneWidget);
  });
}
