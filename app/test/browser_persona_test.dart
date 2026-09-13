import 'package:flutter_test/flutter_test.dart';
import 'package:kiro_lucker/core/browser_persona.dart';
import 'package:kiro_lucker/platform/payment_browser_api.g.dart';

/// 现代 WebView 的缩减 UA：平台 token 匿名化为 "Android 10; K"，仅剩 "Version/4.0" 是 WebView 专属标记。
const reducedEngineUa =
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) '
    'Version/4.0 Chrome/138.0.7204.157 Mobile Safari/537.36';

/// 未启用 UA 缩减的旧 WebView：完整机型 token + "; wv" 标记。
const fullEngineUa =
    'Mozilla/5.0 (Linux; Android 13; SM-G991B Build/TP1A.220624.014; wv) '
    'AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/121.0.6167.178 Mobile Safari/537.36';

BrowserEngineInfo androidInfo({String engineUserAgent = reducedEngineUa}) => BrowserEngineInfo(
      engineUserAgent: engineUserAgent,
      osVersion: '13',
      deviceModel: 'Pixel 7',
      buildId: 'TQ3A.230903.001',
      architecture: 'arm',
    );

BrowserEngineInfo iosInfo({String deviceModel = 'iPhone', String osVersion = '18.2'}) => BrowserEngineInfo(
      engineUserAgent: '',
      osVersion: osVersion,
      deviceModel: deviceModel,
    );

void main() {
  group('Android', () {
    test('chrome：摘除 WebView 专属 token 后与真实 Chrome 缩减 UA 一致', () {
      final identity = buildBrowserIdentity(
        persona: BrowserPersona.chrome,
        engineInfo: androidInfo(),
        isAndroid: true,
      );
      expect(
        identity.userAgent,
        'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) '
        'Chrome/138.0.7204.157 Mobile Safari/537.36',
      );
      expect(identity.userAgent.contains('Version/4.0'), isFalse);
      expect(identity.userAgent.contains('wv'), isFalse);
      expect(identity.mobile, isTrue);
      expect(identity.platform, 'Android');
      expect(identity.platformVersion, '13.0.0');
      expect(identity.architecture, 'arm');
      expect(identity.fullVersion, '138.0.7204.157');
      expect(identity.model, '');
    });

    test('auto 在 Android 解析为 chrome', () {
      final auto = buildBrowserIdentity(persona: BrowserPersona.auto, engineInfo: androidInfo(), isAndroid: true);
      final chrome = buildBrowserIdentity(persona: BrowserPersona.chrome, engineInfo: androidInfo(), isAndroid: true);
      expect(auto.userAgent, chrome.userAgent);
    });

    test('brands 与 UA 声称的品牌一致：Chromium、Google Chrome 与 GREASE', () {
      final identity = buildBrowserIdentity(
        persona: BrowserPersona.chrome,
        engineInfo: androidInfo(),
        isAndroid: true,
      );
      expect(
        identity.brands.map((brand) => '${brand.brand}/${brand.version}').toList(),
        ['Chromium/138', 'Google Chrome/138', 'Not(A:Brand/24'],
      );
    });

    test('edge：追加 EdgA token，品牌含 Microsoft Edge 且主版本同步', () {
      final identity = buildBrowserIdentity(
        persona: BrowserPersona.edge,
        engineInfo: androidInfo(),
        isAndroid: true,
      );
      expect(
        identity.userAgent,
        'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) '
        'Chrome/138.0.7204.157 Mobile Safari/537.36 EdgA/138.0.0.0',
      );
      expect(
        identity.brands.map((brand) => '${brand.brand}/${brand.version}').toList(),
        ['Chromium/138', 'Microsoft Edge/138', 'Not(A:Brand/24'],
      );
    });

    test('quark：完整机型 token、zh-Hans-CN 与 Quark 品牌版本', () {
      final identity = buildBrowserIdentity(
        persona: BrowserPersona.quark,
        engineInfo: androidInfo(),
        isAndroid: true,
      );
      expect(
        identity.userAgent,
        'Mozilla/5.0 (Linux; U; Android 13; zh-Hans-CN; Pixel 7 Build/TQ3A.230903.001) '
        'AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/138.0.7204.157 '
        'Quark/$quarkVersion Mobile Safari/537.36',
      );
      expect(
        identity.brands.map((brand) => '${brand.brand}/${brand.version}').toList(),
        ['Chromium/138', 'Not(A:Brand/24'],
      );
    });

    test('旧版完整 UA 同样摘除 "; wv" 与 "Version/4.0"，保留完整机型 token', () {
      final identity = buildBrowserIdentity(
        persona: BrowserPersona.chrome,
        engineInfo: androidInfo(engineUserAgent: fullEngineUa),
        isAndroid: true,
      );
      expect(
        identity.userAgent,
        'Mozilla/5.0 (Linux; Android 13; SM-G991B Build/TP1A.220624.014) '
        'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.6167.178 Mobile Safari/537.36',
      );
      expect(identity.fullVersion, '121.0.6167.178');
    });

    test('引擎版本解析失败时回落到常量并构造可用的 Chrome UA', () {
      final identity = buildBrowserIdentity(
        persona: BrowserPersona.chrome,
        engineInfo: androidInfo(engineUserAgent: 'Mozilla/5.0 (Linux; Android 10; K) Mobile Safari/537.36'),
        isAndroid: true,
      );
      expect(identity.fullVersion, '134.0.0.0');
      expect(
        identity.userAgent,
        'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) '
        'Chrome/134.0.0.0 Mobile Safari/537.36',
      );
    });
  });

  group('iOS', () {
    test('auto 解析为 Safari：默认 UA 缺失的 Safari 品牌标识被补齐', () {
      final identity = buildBrowserIdentity(
        persona: BrowserPersona.auto,
        engineInfo: iosInfo(),
        isAndroid: false,
      );
      expect(
        identity.userAgent,
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) '
        'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1',
      );
    });

    test('chrome：CriOS 品牌 token', () {
      final identity = buildBrowserIdentity(
        persona: BrowserPersona.chrome,
        engineInfo: iosInfo(),
        isAndroid: false,
      );
      expect(
        identity.userAgent,
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) '
        'AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/$criosVersion Mobile/15E148 Safari/604.1',
      );
    });

    test('edge：EdgiOS 品牌 token', () {
      final identity = buildBrowserIdentity(
        persona: BrowserPersona.edge,
        engineInfo: iosInfo(),
        isAndroid: false,
      );
      expect(
        identity.userAgent,
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) '
        'AppleWebKit/605.1.15 (KHTML, like Gecko) EdgiOS/$edgiosVersion Mobile/15E148 Safari/604.1',
      );
    });

    test('quark 在 iOS 回落 Safari；brands 全平台为空（WebKit 无 userAgentData）', () {
      final quark = buildBrowserIdentity(persona: BrowserPersona.quark, engineInfo: iosInfo(), isAndroid: false);
      final safari = buildBrowserIdentity(persona: BrowserPersona.safari, engineInfo: iosInfo(), isAndroid: false);
      expect(quark.userAgent, safari.userAgent);
      expect(quark.brands, isEmpty);
      expect(safari.brands, isEmpty);
    });

    test('iPad 使用 iPad 平台 token，版本点号转下划线', () {
      final identity = buildBrowserIdentity(
        persona: BrowserPersona.safari,
        engineInfo: iosInfo(deviceModel: 'iPad', osVersion: '17.5'),
        isAndroid: false,
      );
      expect(
        identity.userAgent,
        'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) '
        'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      );
    });
  });
}
