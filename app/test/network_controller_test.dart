import 'package:flutter_test/flutter_test.dart';
import 'package:kiro_lucker/features/network/network_controller.dart';

void main() {
  group('SimDetectionReport', () {
    test('parses and orders current SIM results by slot', () {
      final report = SimDetectionReport.fromPlatform({
        'permissionRequired': false,
        'sims': [
          {
            'slotIndex': 1,
            'label': 'SIM 2',
            'ipv4': '203.0.113.22',
            'ipv6': null,
            'checkedAt': 1760000000000,
            'lastIpv4': '203.0.113.20',
            'lastCheckedAt': 1759990000000,
            'status': null,
          },
          {
            'slotIndex': 0,
            'label': 'SIM 1',
            'ipv4': '198.51.100.10',
            'ipv6': '2001:db8::10',
            'checkedAt': 1760000000000,
            'status': null,
          },
        ],
      });

      expect(report.permissionRequired, isFalse);
      expect(report.sims.map((sim) => sim.label), ['SIM 1', 'SIM 2']);
      expect(report.sims.first.ipv4?.value, '198.51.100.10');
      expect(report.sims.first.ipv6?.value, '2001:db8::10');
      expect(report.sims.last.lastIpv4, '203.0.113.20');
    });

    test('keeps a previous local value when one SIM cannot be bound', () {
      final report = SimDetectionReport.fromPlatform({
        'permissionRequired': false,
        'sims': [
          {
            'slotIndex': 1,
            'label': 'SIM 2',
            'ipv4': null,
            'ipv6': null,
            'lastIpv4': '203.0.113.22',
            'lastIpv6': null,
            'lastCheckedAt': 1760000000000,
            'status': '该 SIM 未提供可供应用绑定的蜂窝数据网络',
          },
        ],
      });

      final sim = report.sims.single;
      expect(sim.hasCurrentValue, isFalse);
      expect(sim.hasStoredValue, isTrue);
      expect(sim.status, contains('绑定'));
      expect(sim.lastCheckedAt, isNotNull);
    });
  });
}
