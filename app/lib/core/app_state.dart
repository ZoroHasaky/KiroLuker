import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'api_client.dart';
import 'connection.dart';
import 'connection_store.dart';
import 'models.dart';

final secureStorageProvider = Provider<FlutterSecureStorage>(
  (ref) => const FlutterSecureStorage(),
);
final connectionStoreProvider = Provider<ConnectionStore>(
  (ref) => ConnectionStore(ref.watch(secureStorageProvider)),
);

class ConnectionState {
  const ConnectionState({
    this.config,
    this.capabilities,
    this.error,
    this.saved = false,
  });
  final ConnectionConfig? config;
  final CapabilitySet? capabilities;
  final ApiFailure? error;
  final bool saved;
  bool get isConnected => config != null && capabilities != null;

  ConnectionState copyWith({
    ConnectionConfig? config,
    CapabilitySet? capabilities,
    ApiFailure? error,
    bool? saved,
    bool clearError = false,
  }) => ConnectionState(
    config: config ?? this.config,
    capabilities: capabilities ?? this.capabilities,
    error: clearError ? null : error ?? this.error,
    saved: saved ?? this.saved,
  );
}

final connectionControllerProvider =
    AsyncNotifierProvider<ConnectionController, ConnectionState>(
      ConnectionController.new,
    );

class ConnectionController extends AsyncNotifier<ConnectionState> {
  @override
  Future<ConnectionState> build() async {
    final saved = await ref.read(connectionStoreProvider).read();
    if (saved == null) return const ConnectionState();
    try {
      final capabilities = await KiroApi(saved).capabilities();
      return ConnectionState(
        config: saved,
        capabilities: capabilities,
        saved: true,
      );
    } on ApiFailure catch (error) {
      return ConnectionState(config: saved, error: error, saved: true);
    }
  }

  Future<void> connect(ConnectionConfig config, {required bool save}) async {
    state = const AsyncLoading();
    try {
      final capabilities = await KiroApi(config).capabilities();
      if (capabilities.apiVersion != '1') {
        throw const ApiFailure('INCOMPATIBLE_API', '桌面服务 API 版本不兼容，请更新桌面端');
      }
      if (save) {
        await ref.read(connectionStoreProvider).save(config);
      } else {
        await ref.read(connectionStoreProvider).clear();
      }
      state = AsyncData(
        ConnectionState(
          config: config,
          capabilities: capabilities,
          saved: save,
        ),
      );
    } on ApiFailure catch (error) {
      state = AsyncData(
        ConnectionState(config: config, error: error, saved: save),
      );
    }
  }

  Future<void> retry() async {
    final current = state.asData?.value.config;
    if (current != null) {
      await connect(current, save: state.asData?.value.saved ?? false);
    }
  }

  Future<void> disconnect({required bool clearSaved}) async {
    if (clearSaved) await ref.read(connectionStoreProvider).clear();
    state = const AsyncData(ConnectionState());
  }
}

KiroApi apiFor(dynamic ref) {
  final status =
      ref.read(connectionControllerProvider) as AsyncValue<ConnectionState>;
  final config = status.asData?.value.config;
  if (config == null) throw const ApiFailure('AUTH_REQUIRED', '请先连接桌面服务');
  return KiroApi(config);
}

class AccountFilter {
  const AccountFilter({
    this.page = 1,
    this.search = '',
    this.subscription,
    this.tagId,
    this.paymentStatus,
    this.importDate,
  });

  final int page;
  final String search;
  final String? subscription;
  final String? tagId;

  /// API value: `pending` or `not_pending`.
  final String? paymentStatus;

  /// Local calendar date selected by the user; it is sent to the API as [start, next-day start).
  final DateTime? importDate;

  int? get createdAfter => importDate == null
      ? null
      : _startOfDay(importDate!).millisecondsSinceEpoch;
  int? get createdBefore => importDate == null
      ? null
      : _startOfDay(importDate!)
            .add(const Duration(days: 1))
            .millisecondsSinceEpoch;

  bool isOnlyToday(DateTime now) =>
      importDate != null && _startOfDay(importDate!) == _startOfDay(now);

  AccountFilter copyWith({
    int? page,
    String? search,
    String? subscription,
    String? tagId,
    String? paymentStatus,
    DateTime? importDate,
    bool clearSubscription = false,
    bool clearTag = false,
    bool clearPaymentStatus = false,
    bool clearImportDate = false,
  }) => AccountFilter(
    page: page ?? this.page,
    search: search ?? this.search,
    subscription: clearSubscription ? null : subscription ?? this.subscription,
    tagId: clearTag ? null : tagId ?? this.tagId,
    paymentStatus: clearPaymentStatus
        ? null
        : paymentStatus ?? this.paymentStatus,
    importDate: clearImportDate ? null : importDate ?? this.importDate,
  );
}

DateTime _startOfDay(DateTime value) =>
    DateTime(value.year, value.month, value.day);

final accountFilterProvider =
    NotifierProvider<AccountFilterController, AccountFilter>(
      AccountFilterController.new,
    );

class AccountFilterController extends Notifier<AccountFilter> {
  @override
  AccountFilter build() => const AccountFilter();
  void update(AccountFilter next) => state = next;
}

final accountPageProvider = FutureProvider.autoDispose<AccountPage>((ref) {
  final filter = ref.watch(accountFilterProvider);
  return apiFor(ref).accounts(
    page: filter.page,
    search: filter.search,
    subscription: filter.subscription,
    tagId: filter.tagId,
    paymentStatus: filter.paymentStatus,
    createdAfter: filter.createdAfter,
    createdBefore: filter.createdBefore,
  );
});

final tagsProvider = FutureProvider.autoDispose<List<AccountTag>>(
  (ref) => apiFor(ref).tags(),
);
final accountDetailProvider = FutureProvider.autoDispose
    .family<PublicAccount, String>((ref, id) => apiFor(ref).account(id));

class IpResult {
  const IpResult({required this.value, required this.checkedAt});
  final String value;
  final DateTime checkedAt;
}

enum SwitchStage { idle, waitForAirplaneMode, waitForNetwork, completed }

class NetworkState {
  const NetworkState({
    this.ipv4,
    this.ipv6,
    this.error,
    this.stage = SwitchStage.idle,
    this.startedAt,
    this.beforeIpv4,
    this.beforeIpv6,
    this.switchResult,
  });
  final IpResult? ipv4;
  final IpResult? ipv6;
  final String? error;
  final SwitchStage stage;
  final DateTime? startedAt;
  final String? beforeIpv4;
  final String? beforeIpv6;
  final String? switchResult;

  NetworkState copyWith({
    IpResult? ipv4,
    IpResult? ipv6,
    String? error,
    SwitchStage? stage,
    DateTime? startedAt,
    String? beforeIpv4,
    String? beforeIpv6,
    String? switchResult,
    bool clearError = false,
  }) => NetworkState(
    ipv4: ipv4 ?? this.ipv4,
    ipv6: ipv6 ?? this.ipv6,
    error: clearError ? null : error ?? this.error,
    stage: stage ?? this.stage,
    startedAt: startedAt ?? this.startedAt,
    beforeIpv4: beforeIpv4 ?? this.beforeIpv4,
    beforeIpv6: beforeIpv6 ?? this.beforeIpv6,
    switchResult: switchResult ?? this.switchResult,
  );
}

final networkControllerProvider =
    AsyncNotifierProvider<NetworkController, NetworkState>(
      NetworkController.new,
    );

class NetworkController extends AsyncNotifier<NetworkState> {
  @override
  Future<NetworkState> build() async => const NetworkState();

  Future<String?> _readIp(String endpoint, bool ipv6) async {
    try {
      final response = await Dio().get<Map<String, dynamic>>(
        endpoint,
        options: Options(
          receiveTimeout: const Duration(seconds: 7),
          sendTimeout: const Duration(seconds: 7),
        ),
      );
      final value = response.data?['ip']?.toString();
      if (value == null ||
          value.isEmpty ||
          (ipv6 ? !value.contains(':') : value.contains(':'))) {
        return null;
      }
      return value;
    } catch (_) {
      return null;
    }
  }

  Future<void> check() async {
    final prior = state.asData?.value ?? const NetworkState();
    final values = await Future.wait([
      _readIp('https://api.ipify.org?format=json', false),
      _readIp('https://api64.ipify.org?format=json', true),
    ]);
    final now = DateTime.now();
    state = AsyncData(
      prior.copyWith(
        ipv4: values[0] == null
            ? null
            : IpResult(value: values[0]!, checkedAt: now),
        ipv6: values[1] == null
            ? null
            : IpResult(value: values[1]!, checkedAt: now),
        error: values.every((value) => value == null)
            ? 'IPv4 和 IPv6 均检测失败；已保留上次成功结果'
            : null,
        clearError: values.any((value) => value != null),
      ),
    );
  }

  Future<void> beginSwitch() async {
    await check();
    final current = state.asData?.value ?? const NetworkState();
    state = AsyncData(
      current.copyWith(
        stage: SwitchStage.waitForAirplaneMode,
        startedAt: DateTime.now(),
        beforeIpv4: current.ipv4?.value,
        beforeIpv6: current.ipv6?.value,
        switchResult: null,
      ),
    );
  }

  Future<void> airplaneModeConfirmed() async {
    final current = state.asData?.value ?? const NetworkState();
    state = AsyncData(current.copyWith(stage: SwitchStage.waitForNetwork));
  }

  bool get canAskToDisableAirplaneMode {
    final started = state.asData?.value.startedAt;
    return started != null &&
        DateTime.now().difference(started) >= const Duration(seconds: 20);
  }

  Future<void> recheckAfterSwitch() async {
    final baseline = state.asData?.value ?? const NetworkState();
    final deadline = DateTime.now().add(const Duration(seconds: 30));
    do {
      await check();
      final current = state.asData?.value ?? baseline;
      final changed =
          (baseline.beforeIpv4 != null &&
              current.ipv4?.value != null &&
              baseline.beforeIpv4 != current.ipv4?.value) ||
          (baseline.beforeIpv6 != null &&
              current.ipv6?.value != null &&
              baseline.beforeIpv6 != current.ipv6?.value);
      final bothAvailable = current.ipv4 != null || current.ipv6 != null;
      if (changed || bothAvailable) {
        final result = changed ? '已变化' : '未变化';
        state = AsyncData(
          current.copyWith(stage: SwitchStage.completed, switchResult: result),
        );
        return;
      }
      await Future<void>.delayed(const Duration(seconds: 3));
    } while (DateTime.now().isBefore(deadline));
    final current = state.asData?.value ?? baseline;
    state = AsyncData(
      current.copyWith(stage: SwitchStage.completed, switchResult: '检测失败'),
    );
  }
}
