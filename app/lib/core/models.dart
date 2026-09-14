import 'dart:convert';

class CapabilitySet {
  const CapabilitySet({
    required this.apiVersion,
    required this.scopes,
    required this.features,
  });

  final String apiVersion;
  final Set<String> scopes;
  final Map<String, bool> features;

  factory CapabilitySet.fromJson(Map<String, dynamic> json) => CapabilitySet(
    apiVersion: json['apiVersion'] as String? ?? '',
    scopes: ((json['scopes'] as List<dynamic>?) ?? const [])
        .whereType<String>()
        .toSet(),
    features: ((json['features'] as Map<String, dynamic>?) ?? const {}).map(
      (key, value) => MapEntry(key, value == true),
    ),
  );

  bool has(String scope) => scopes.contains(scope);
}

class AccountTag {
  const AccountTag({required this.id, required this.name, required this.color});
  final String id;
  final String name;
  final String color;

  factory AccountTag.fromJson(Map<String, dynamic> json) => AccountTag(
    id: json['id'] as String,
    name: json['name'] as String,
    color: json['color'] as String? ?? '#7c3aed',
  );
}

/// Raw values must stay aligned with the desktop `SubscriptionType` contract.
const Map<String, String> subscriptionFilterLabels = {
  '': '全部订阅',
  'Free': 'Free',
  'Pro': 'Pro',
  'Pro_Plus': 'Pro+',
  'Pro_Max': 'Max',
  'Power': 'Power',
};

String subscriptionDisplayType(String rawType) =>
    subscriptionFilterLabels[rawType] ?? rawType;

class SubscriptionInfo {
  const SubscriptionInfo({required this.type});

  final String type;
  String get displayType => subscriptionDisplayType(type);

  factory SubscriptionInfo.fromJson(Map<String, dynamic> json) =>
      SubscriptionInfo(type: json['type']?.toString() ?? '-');
}

class UsageInfo {
  const UsageInfo({
    required this.current,
    required this.limit,
    required this.percentUsed,
    required this.lastUpdated,
  });

  final num current;
  final num limit;

  /// Desktop API ratio in the range 0–1, rather than a 0–100 percentage.
  final num percentUsed;
  final int lastUpdated;

  factory UsageInfo.fromJson(Map<String, dynamic> json) => UsageInfo(
    current: json['current'] as num? ?? 0,
    limit: json['limit'] as num? ?? 0,
    percentUsed: json['percentUsed'] as num? ?? 0,
    lastUpdated: json['lastUpdated'] as int? ?? 0,
  );
}

String formatUsage(UsageInfo usage) =>
    '${_formatNumber(usage.current)} / ${_formatNumber(usage.limit)}（${_formatNumber(usage.percentUsed * 100)}%）';

String _formatNumber(num value) => value == value.roundToDouble()
    ? value.toInt().toString()
    : value.toStringAsFixed(1);

enum AccountGroup { unused, pending, subscribed, deprecated }

String accountGroupLabel(AccountGroup group) => switch (group) {
  AccountGroup.unused => '未使用',
  AccountGroup.pending => '待支付',
  AccountGroup.subscribed => '已订阅',
  AccountGroup.deprecated => '已废弃',
};

AccountGroup? accountGroupFromJson(Object? value) =>
    switch (value?.toString()) {
      'unused' => AccountGroup.unused,
      'pending' => AccountGroup.pending,
      'subscribed' => AccountGroup.subscribed,
      'deprecated' => AccountGroup.deprecated,
      _ => null,
    };

class SubscriptionPlan {
  const SubscriptionPlan({
    required this.name,
    required this.type,
    required this.title,
    required this.billingInterval,
    required this.features,
    required this.amount,
    required this.currency,
  });
  final String name;
  final String type;
  final String title;
  final String billingInterval;
  final List<String> features;
  final num amount;
  final String currency;

  factory SubscriptionPlan.fromJson(Map<String, dynamic> json) =>
      SubscriptionPlan(
        name: json['name']?.toString() ?? '',
        type: json['qSubscriptionType']?.toString() ?? '',
        title:
            (json['description'] as Map?)?['title']?.toString() ??
            json['name']?.toString() ??
            '',
        billingInterval:
            (json['description'] as Map?)?['billingInterval']?.toString() ?? '',
        features:
            (((json['description'] as Map?)?['features'] as List?) ?? const [])
                .whereType<String>()
                .toList(growable: false),
        amount: ((json['pricing'] as Map?)?['amount'] as num?) ?? 0,
        currency: (json['pricing'] as Map?)?['currency']?.toString() ?? 'USD',
      );

  String get priceLabel =>
      '$currency ${(amount / 100).toStringAsFixed(2)}${billingInterval.isEmpty ? '' : '/$billingInterval'}';
}

class SubscriptionPlansResult {
  const SubscriptionPlansResult({
    required this.plans,
    this.disclaimer = const [],
  });
  final List<SubscriptionPlan> plans;
  final List<String> disclaimer;

  factory SubscriptionPlansResult.fromJson(Map<String, dynamic> json) =>
      SubscriptionPlansResult(
        plans: ((json['plans'] as List?) ?? const [])
            .whereType<Map>()
            .map(
              (item) => SubscriptionPlan.fromJson(item.cast<String, dynamic>()),
            )
            .toList(growable: false),
        disclaimer: ((json['disclaimer'] as List?) ?? const [])
            .whereType<String>()
            .toList(growable: false),
      );
}

class WebJob {
  const WebJob({
    required this.id,
    required this.status,
    required this.total,
    required this.completed,
    required this.succeeded,
    required this.failed,
    required this.skipped,
    required this.messages,
  });
  final String id;
  final String status;
  final int total;
  final int completed;
  final int succeeded;
  final int failed;
  final int skipped;
  final List<String> messages;
  bool get finished => status == 'completed' || status == 'failed';

  factory WebJob.fromJson(Map<String, dynamic> json) => WebJob(
    id: json['id']?.toString() ?? '',
    status: json['status']?.toString() ?? '',
    total: json['total'] as int? ?? 0,
    completed: json['completed'] as int? ?? 0,
    succeeded: json['succeeded'] as int? ?? 0,
    failed: json['failed'] as int? ?? 0,
    skipped: json['skipped'] as int? ?? 0,
    messages: ((json['messages'] as List?) ?? const [])
        .whereType<String>()
        .toList(growable: false),
  );
}

class PublicAccount {
  const PublicAccount({
    required this.id,
    required this.email,
    required this.idp,
    required this.subscription,
    required this.usage,
    required this.status,
    required this.tagIds,
    required this.hasPaymentLink,
    this.nickname,
    this.note,
    this.createdAt,
    this.lastUsedAt,
    this.group,
  });

  final String id;
  final String email;
  final String? nickname;
  final String? note;
  final String idp;
  final SubscriptionInfo subscription;
  final UsageInfo usage;
  final String status;
  final List<String> tagIds;
  final bool hasPaymentLink;
  final int? createdAt;
  final int? lastUsedAt;
  final AccountGroup? group;

  /// `pending` is deliberately the same predicate used by the desktop API.
  bool get isPaymentPending =>
      group == AccountGroup.pending ||
      (group == null &&
          hasPaymentLink &&
          subscription.type == 'Free' &&
          usage.current == 0);

  factory PublicAccount.fromJson(Map<String, dynamic> json) => PublicAccount(
    id: json['id'] as String,
    email: json['email'] as String? ?? '',
    nickname: json['nickname'] as String?,
    note: json['note'] as String?,
    idp: json['idp']?.toString() ?? '-',
    subscription: SubscriptionInfo.fromJson(
      (json['subscription'] as Map?)?.cast<String, dynamic>() ?? const {},
    ),
    usage: UsageInfo.fromJson(
      (json['usage'] as Map?)?.cast<String, dynamic>() ?? const {},
    ),
    status: json['status']?.toString() ?? '-',
    tagIds: ((json['tagIds'] as List?) ?? const []).whereType<String>().toList(
      growable: false,
    ),
    hasPaymentLink: json['hasPaymentLink'] == true,
    createdAt: json['createdAt'] as int?,
    lastUsedAt: json['lastUsedAt'] as int?,
    group: accountGroupFromJson(json['group']),
  );
}

class AccountPage {
  const AccountPage({
    required this.items,
    required this.page,
    required this.pageSize,
    required this.total,
  });
  final List<PublicAccount> items;
  final int page;
  final int pageSize;
  final int total;
  int get pageCount => total == 0 ? 1 : (total / pageSize).ceil();

  factory AccountPage.fromJson(Map<String, dynamic> json) => AccountPage(
    items: ((json['items'] as List?) ?? const [])
        .whereType<Map>()
        .map((item) => PublicAccount.fromJson(item.cast<String, dynamic>()))
        .toList(growable: false),
    page: json['page'] as int? ?? 1,
    pageSize: json['pageSize'] as int? ?? 30,
    total: json['total'] as int? ?? 0,
  );
}

class CheckoutBillingResult {
  const CheckoutBillingResult({
    required this.chineseName,
    required this.pinyinName,
    required this.countryCode,
    required this.province,
    required this.city,
    required this.district,
    required this.pinyinCity,
    required this.pinyinDistrict,
    required this.addressLine1,
    required this.postalCode,
    required this.mapSource,
    required this.generatedAt,
  });

  final String chineseName;
  final String pinyinName;
  final String countryCode;
  final String province;
  final String city;
  final String district;
  final String pinyinCity;
  final String pinyinDistrict;
  final String addressLine1;
  final String postalCode;
  final String mapSource;
  final int generatedAt;

  factory CheckoutBillingResult.fromJson(Map<String, dynamic> json) =>
      CheckoutBillingResult(
        chineseName: json['chineseName'] as String,
        pinyinName: json['pinyinName'] as String,
        countryCode: json['countryCode'] as String,
        province: json['province'] as String,
        city: json['city'] as String,
        district: json['district'] as String,
        pinyinCity: json['pinyinCity'] as String,
        pinyinDistrict: json['pinyinDistrict'] as String,
        addressLine1: json['addressLine1'] as String,
        postalCode: json['postalCode'] as String,
        mapSource: json['mapSource'] as String,
        generatedAt: json['generatedAt'] as int,
      );

  Map<String, Object> toPlatformMap() => {
    'chineseName': chineseName,
    'pinyinName': pinyinName,
    'countryCode': countryCode,
    'province': province,
    'city': city,
    'district': district,
    'pinyinCity': pinyinCity,
    'pinyinDistrict': pinyinDistrict,
    'addressLine1': addressLine1,
    'postalCode': postalCode,
  };

  @override
  String toString() => const JsonEncoder.withIndent('  ').convert({
    'chineseName': chineseName,
    'pinyinName': pinyinName,
    'countryCode': countryCode,
    'province': province,
    'city': city,
    'district': district,
    'pinyinCity': pinyinCity,
    'pinyinDistrict': pinyinDistrict,
    'addressLine1': addressLine1,
    'postalCode': postalCode,
    'mapSource': mapSource,
    'generatedAt': generatedAt,
  });
}
