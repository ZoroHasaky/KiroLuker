import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

final networkControllerProvider =
    AsyncNotifierProvider<NetworkController, NetworkState>(
      NetworkController.new,
    );

class IpResult {
  const IpResult({required this.value, required this.checkedAt});

  final String value;
  final DateTime checkedAt;
}

class SimIpResult {
  const SimIpResult({
    required this.slotIndex,
    required this.label,
    this.ipv4,
    this.ipv6,
    this.lastIpv4,
    this.lastIpv6,
    this.lastCheckedAt,
    this.status,
  });

  final int slotIndex;
  final String label;
  final IpResult? ipv4;
  final IpResult? ipv6;
  final String? lastIpv4;
  final String? lastIpv6;
  final DateTime? lastCheckedAt;
  final String? status;

  bool get hasCurrentValue => ipv4 != null || ipv6 != null;
  bool get hasStoredValue => lastIpv4 != null || lastIpv6 != null;

  factory SimIpResult.fromPlatform(Map<Object?, Object?> raw) {
    DateTime? dateFor(Object? value) {
      final millis = value is num ? value.toInt() : int.tryParse('$value');
      return millis == null || millis <= 0
          ? null
          : DateTime.fromMillisecondsSinceEpoch(millis);
    }

    IpResult? current(String? value, DateTime? checkedAt) {
      if (value == null || value.isEmpty || checkedAt == null) return null;
      return IpResult(value: value, checkedAt: checkedAt);
    }

    final checkedAt = dateFor(raw['checkedAt']);
    final slotIndex = raw['slotIndex'] is num
        ? (raw['slotIndex'] as num).toInt()
        : int.tryParse('${raw['slotIndex']}') ?? -1;
    return SimIpResult(
      slotIndex: slotIndex,
      label: raw['label']?.toString().trim().isNotEmpty == true
          ? raw['label']!.toString()
          : 'SIM',
      ipv4: current(raw['ipv4']?.toString(), checkedAt),
      ipv6: current(raw['ipv6']?.toString(), checkedAt),
      lastIpv4: raw['lastIpv4']?.toString(),
      lastIpv6: raw['lastIpv6']?.toString(),
      lastCheckedAt: dateFor(raw['lastCheckedAt']),
      status: raw['status']?.toString(),
    );
  }
}

class SimDetectionReport {
  const SimDetectionReport({
    required this.permissionRequired,
    required this.sims,
    this.status,
  });

  final bool permissionRequired;
  final List<SimIpResult> sims;
  final String? status;

  factory SimDetectionReport.fromPlatform(Map<Object?, Object?> raw) {
    final rawSims = raw['sims'] as List? ?? const [];
    final sims =
        rawSims
            .whereType<Map>()
            .map(
              (item) => SimIpResult.fromPlatform(item.cast<Object?, Object?>()),
            )
            .toList()
          ..sort((left, right) => left.slotIndex.compareTo(right.slotIndex));
    return SimDetectionReport(
      permissionRequired: raw['permissionRequired'] == true,
      sims: List.unmodifiable(sims),
      status: raw['status']?.toString(),
    );
  }
}

class _SimNetworkPlatform {
  static const _channel = MethodChannel('com.kiroluker/network-ip');

  Future<SimDetectionReport> detect() async {
    if (defaultTargetPlatform != TargetPlatform.android) {
      return const SimDetectionReport(
        permissionRequired: false,
        sims: [],
        status: '仅 Android 支持按 SIM 卡分别检测公网 IP。',
      );
    }
    try {
      final raw = await _channel.invokeMethod<Object?>('detectSimIps');
      if (raw is! Map) {
        return const SimDetectionReport(
          permissionRequired: false,
          sims: [],
          status: 'Android 未返回有效的 SIM 网络检测结果。',
        );
      }
      return SimDetectionReport.fromPlatform(raw.cast<Object?, Object?>());
    } on PlatformException catch (error) {
      return SimDetectionReport(
        permissionRequired: false,
        sims: const [],
        status: 'SIM 网络检测不可用：${error.message ?? error.code}',
      );
    } on MissingPluginException {
      return const SimDetectionReport(
        permissionRequired: false,
        sims: [],
        status: '当前安装包不包含 Android SIM 网络检测组件，请更新 App。',
      );
    }
  }

  Future<bool> requestPermission() async {
    if (defaultTargetPlatform != TargetPlatform.android) return false;
    try {
      return await _channel.invokeMethod<bool>('requestPhoneStatePermission') ??
          false;
    } on PlatformException {
      return false;
    } on MissingPluginException {
      return false;
    }
  }
}

enum SwitchStage { idle, waitForAirplaneMode, waitForNetwork, completed }

class NetworkState {
  const NetworkState({
    this.ipv4,
    this.ipv6,
    this.sims = const [],
    this.simPermissionRequired = false,
    this.simStatus,
    this.error,
    this.stage = SwitchStage.idle,
    this.startedAt,
    this.beforeIpv4,
    this.beforeIpv6,
    this.switchResult,
  });

  final IpResult? ipv4;
  final IpResult? ipv6;
  final List<SimIpResult> sims;
  final bool simPermissionRequired;
  final String? simStatus;
  final String? error;
  final SwitchStage stage;
  final DateTime? startedAt;
  final String? beforeIpv4;
  final String? beforeIpv6;
  final String? switchResult;

  NetworkState copyWith({
    IpResult? ipv4,
    IpResult? ipv6,
    List<SimIpResult>? sims,
    bool? simPermissionRequired,
    String? simStatus,
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
    sims: sims ?? this.sims,
    simPermissionRequired: simPermissionRequired ?? this.simPermissionRequired,
    simStatus: simStatus,
    error: clearError ? null : error ?? this.error,
    stage: stage ?? this.stage,
    startedAt: startedAt ?? this.startedAt,
    beforeIpv4: beforeIpv4 ?? this.beforeIpv4,
    beforeIpv6: beforeIpv6 ?? this.beforeIpv6,
    switchResult: switchResult ?? this.switchResult,
  );
}

class NetworkController extends AsyncNotifier<NetworkState> {
  final _simPlatform = _SimNetworkPlatform();

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
      _simPlatform.detect(),
    ]);
    final now = DateTime.now();
    final simReport = values[2] as SimDetectionReport;
    state = AsyncData(
      prior.copyWith(
        ipv4: values[0] == null
            ? null
            : IpResult(value: values[0]! as String, checkedAt: now),
        ipv6: values[1] == null
            ? null
            : IpResult(value: values[1]! as String, checkedAt: now),
        sims: simReport.sims,
        simPermissionRequired: simReport.permissionRequired,
        simStatus: simReport.status,
        error: values[0] == null && values[1] == null
            ? 'IPv4 和 IPv6 均检测失败；已保留上次成功结果'
            : null,
        clearError: values[0] != null || values[1] != null,
      ),
    );
  }

  Future<void> requestSimPermission() async {
    final granted = await _simPlatform.requestPermission();
    if (!granted) {
      final current = state.asData?.value ?? const NetworkState();
      state = AsyncData(
        current.copyWith(
          simPermissionRequired: false,
          simStatus: '未授予“读取手机状态”权限，无法识别并分别检测 SIM 卡。',
        ),
      );
      return;
    }
    await check();
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
      final eitherAvailable = current.ipv4 != null || current.ipv6 != null;
      if (changed || eitherAvailable) {
        state = AsyncData(
          current.copyWith(
            stage: SwitchStage.completed,
            switchResult: changed ? '已变化' : '未变化',
          ),
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
