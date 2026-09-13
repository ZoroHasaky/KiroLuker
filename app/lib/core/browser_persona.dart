import '../platform/payment_browser_api.g.dart';

/// 支付 WebView 的浏览器伪装标识。
enum BrowserPersona {
  /// 自动推荐：Android 伪装 Chrome，iOS 伪装 Safari。
  auto,
  chrome,
  edge,
  quark,
  /// 仅作为 iOS 端解析结果使用（auto 的 iOS 默认与夸克的 iOS 回落），设置页不直接提供。
  safari,
}

/// 夸克品牌版本。夸克内核版本无法从系统 WebView 推导，只能随发版手工维护。
const quarkVersion = '7.9.5.298';

/// Chrome iOS 品牌版本，随发版手工维护。
const criosVersion = '153.0.7214.101';

/// Edge iOS 品牌版本，随发版手工维护。
const edgiosVersion = '153.0.7237.117';

// 引擎版本解析失败时的回落值，与桌面端 browserConfig 的回落保持一致。
const _fallbackEngineVersion = '134.0.0.0';
// Chromium 的 GREASE 品牌：名称与版本随版本轮换，取与桌面端相同的值即可，不构成稳定指纹。
const _greaseBrand = 'Not(A:Brand';
const _greaseVersion = '24';
// 现代 iOS Safari 的 WebKit 版本 token 已冻结为常量。
const _webkitToken = 'AppleWebKit/605.1.15 (KHTML, like Gecko)';
const _mobileToken = 'Mobile/15E148 Safari/604.1';

/// 把用户可选项解析成具体平台上的标识。
BrowserPersona resolveBrowserPersona(BrowserPersona persona, {required bool isAndroid}) {
  if (persona == BrowserPersona.auto) return isAndroid ? BrowserPersona.chrome : BrowserPersona.safari;
  if (persona == BrowserPersona.quark && !isAndroid) return BrowserPersona.safari;
  return persona;
}

/// 由原生引擎信息构造伪装标识。全部输出走白名单模板，不透传任何自由文本脚本。
BrowserIdentity buildBrowserIdentity({
  required BrowserPersona persona,
  required BrowserEngineInfo engineInfo,
  required bool isAndroid,
}) {
  final resolved = resolveBrowserPersona(persona, isAndroid: isAndroid);
  return isAndroid ? _androidIdentity(resolved, engineInfo) : _iosIdentity(resolved, engineInfo);
}

/// Android：UA 声称的引擎版本必须取设备真实 WebView 版本，
/// 与真实 Chrome 的缩减 UA 只差 WebView 专属 token（"; wv"、"Version/4.0"），摘除即字节级一致。
BrowserIdentity _androidIdentity(BrowserPersona persona, BrowserEngineInfo engineInfo) {
  final engineMatch = RegExp(r'Chrome/(\d+(?:\.\d+)*)').firstMatch(engineInfo.engineUserAgent);
  final engineVersion = engineMatch?.group(1) ?? _fallbackEngineVersion;
  final major = engineVersion.split('.').first;
  final cleaned = engineInfo.engineUserAgent.replaceAll('; wv', '').replaceAll(' Version/4.0', '');
  final chromeUa = cleaned.startsWith('Mozilla/5.0') && cleaned.contains('Chrome/')
      ? cleaned
      : 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) '
          'Chrome/$engineVersion Mobile Safari/537.36';
  final String userAgent;
  final List<BrandVersion> brands;
  switch (persona) {
    case BrowserPersona.edge:
      // Chromium 的 UA 缩减会把 EdgA 的小版本同样归零，主版本与 Chrome 严格同步。
      userAgent = '$chromeUa EdgA/$major.0.0.0';
      brands = [
        BrandVersion(brand: 'Chromium', version: major),
        BrandVersion(brand: 'Microsoft Edge', version: major),
        BrandVersion(brand: _greaseBrand, version: _greaseVersion),
      ];
    case BrowserPersona.quark:
      // 夸克用完整机型 token + 汉语地区标识；iOS 无稳定夸克样式，已在解析层回落 Safari。
      final build = engineInfo.buildId;
      userAgent = 'Mozilla/5.0 (Linux; U; Android ${engineInfo.osVersion}; zh-Hans-CN; '
          '${engineInfo.deviceModel}${build == null || build.isEmpty ? '' : ' Build/$build'}) '
          'AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/$engineVersion '
          'Quark/$quarkVersion Mobile Safari/537.36';
      brands = [
        BrandVersion(brand: 'Chromium', version: major),
        BrandVersion(brand: _greaseBrand, version: _greaseVersion),
      ];
    default:
      userAgent = chromeUa;
      brands = [
        BrandVersion(brand: 'Chromium', version: major),
        BrandVersion(brand: 'Google Chrome', version: major),
        BrandVersion(brand: _greaseBrand, version: _greaseVersion),
      ];
  }
  return BrowserIdentity(
    userAgent: userAgent,
    brands: brands,
    mobile: true,
    platform: 'Android',
    // 真实 Chrome 的高熵 platformVersion 形如 "13.0.0"。
    platformVersion: engineInfo.osVersion.contains('.') ? engineInfo.osVersion : '${engineInfo.osVersion}.0.0',
    architecture: engineInfo.architecture,
    fullVersion: engineVersion,
    // 缩减 UA 下真实 Chrome 的高熵查询同样不返回机型。
    model: '',
  );
}

/// iOS：所有主流浏览器都是 WebKit 引擎且都不实现 navigator.userAgentData，
/// customUserAgent 一个属性即可达成引擎级一致，brands 留空。
BrowserIdentity _iosIdentity(BrowserPersona persona, BrowserEngineInfo engineInfo) {
  final osVersion = engineInfo.osVersion.isEmpty ? '18.0' : engineInfo.osVersion;
  final underscored = osVersion.replaceAll('.', '_');
  final isPad = engineInfo.deviceModel.toLowerCase().contains('ipad');
  final osToken = isPad ? 'iPad; CPU OS $underscored like Mac OS X' : 'iPhone; CPU iPhone OS $underscored like Mac OS X';
  final base = 'Mozilla/5.0 ($osToken) $_webkitToken';
  final String userAgent;
  switch (persona) {
    case BrowserPersona.chrome:
      userAgent = '$base CriOS/$criosVersion $_mobileToken';
    case BrowserPersona.edge:
      userAgent = '$base EdgiOS/$edgiosVersion $_mobileToken';
    default:
      userAgent = '$base Version/$osVersion $_mobileToken';
  }
  return BrowserIdentity(
    userAgent: userAgent,
    brands: const [],
    mobile: true,
    platform: 'iOS',
    fullVersion: osVersion,
  );
}
