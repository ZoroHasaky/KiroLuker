import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/app_state.dart';
import '../../core/models.dart';
import '../../platform/payment_browser.dart';

class PaymentScreen extends ConsumerStatefulWidget {
  const PaymentScreen({super.key, required this.accountId});
  final String accountId;
  @override
  ConsumerState<PaymentScreen> createState() => _PaymentScreenState();
}

class _PaymentScreenState extends ConsumerState<PaymentScreen> {
  PaymentBrowserSession? _session;
  String? _url;
  CheckoutBillingResult? _billing;
  Timer? _billingDismissTimer;
  String? _error;
  bool _filling = false;
  bool _showSessionNotice = true;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _open());
  }

  @override
  void dispose() {
    _billingDismissTimer?.cancel();
    _session?.close();
    super.dispose();
  }

  Future<void> _open() async {
    try {
      final url = await apiFor(ref).paymentLink(widget.accountId);
      if (url == null) {
        throw const ApiFailure('PAYMENT_LINK_NOT_CONFIGURED', '桌面端未配置支付链接');
      }
      final session = await PaymentBrowserSession.create(
        url,
        persona: ref.read(browserPersonaProvider),
      );
      if (!session.supported) {
        throw ApiFailure('PAYMENT_UNSUPPORTED', session.message ?? '支付浏览器不可用');
      }
      if (!mounted) {
        await session.close();
        return;
      }
      setState(() {
        _url = url;
        _session = session;
        _showSessionNotice = session.message != null;
      });
    } on ApiFailure catch (error) {
      if (mounted) setState(() => _error = error.message);
    } catch (error) {
      if (mounted) setState(() => _error = '无法打开支付页面：$error');
    }
  }

  Future<void> _closePayment() async {
    final session = _session;
    await session?.close();
    if (!mounted) return;
    Navigator.of(context).pop();
  }

  /// WebView 伪装无法保证通过所有风控（Stripe 可能对内嵌页面弹人机验证），
  /// 复用 app-update 通道的 openUrl 让用户随时换系统/夸克等真实浏览器兜底。
  Future<void> _openInBrowser() async {
    final url = _url;
    if (url == null) return;
    try {
      final opened =
          await const MethodChannel('com.kiroluker/app-update')
              .invokeMethod<bool>('openUrl', {'url': url}) ??
          false;
      if (!mounted) return;
      if (!opened) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('系统未能打开外部浏览器')),
        );
      }
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('打开外部浏览器失败：$error')));
      }
    }
  }

  Future<void> _fill() async {
    final session = _session;
    if (session == null || _filling) return;
    setState(() {
      _filling = true;
      _error = null;
    });
    try {
      final billing = await apiFor(ref).generateCheckoutBilling();
      if (!mounted || _session != session) return;
      final result = await session.fill(billing);
      if (!mounted) return;
      setState(() => _billing = billing);
      _billingDismissTimer?.cancel();
      _billingDismissTimer = Timer(const Duration(seconds: 3), () {
        if (mounted) setState(() => _billing = null);
      });
      final message = result.success
          ? '已填充：${result.completedFields.join('、')}'
          : '部分字段需手动填写：${result.failedFields.join('、')}';
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(message)));
    } on ApiFailure catch (error) {
      if (mounted) setState(() => _error = error.message);
    } catch (error) {
      if (mounted) setState(() => _error = '填充失败：$error');
    } finally {
      if (mounted) setState(() => _filling = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final host = _url == null ? '' : Uri.tryParse(_url!)?.host ?? '';
    return Scaffold(
      appBar: AppBar(
        title: Text(host.isEmpty ? '支付页面' : host),
        actions: [
          IconButton(
            onPressed: _session == null ? null : () => _session!.reload(),
            icon: const Icon(Icons.refresh),
            tooltip: '刷新',
          ),
          IconButton(
            onPressed: _session == null ? null : _openInBrowser,
            icon: const Icon(Icons.open_in_new),
            tooltip: '在外部浏览器打开',
          ),
          IconButton(
            onPressed: _session == null ? null : _closePayment,
            icon: const Icon(Icons.close),
            tooltip: '关闭并清理会话',
          ),
        ],
      ),
      body: Stack(
        children: [
          if (_error != null)
            Center(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(_error!),
                    const SizedBox(height: 12),
                    OutlinedButton(onPressed: _open, child: const Text('重试')),
                  ],
                ),
              ),
            )
          else if (_session == null)
            const Center(child: CircularProgressIndicator())
          else
            NativePaymentBrowser(session: _session!),
          if (_showSessionNotice && _session?.message != null && _error == null)
            Positioned(
              left: 12,
              right: 12,
              top: 12,
              child: Card(
                color: Theme.of(context).colorScheme.secondaryContainer,
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(12, 12, 4, 12),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Padding(
                        padding: EdgeInsets.only(top: 8),
                        child: Icon(Icons.privacy_tip_outlined),
                      ),
                      const SizedBox(width: 8),
                      Expanded(child: Text(_session!.message!)),
                      IconButton(
                        onPressed: () =>
                            setState(() => _showSessionNotice = false),
                        icon: const Icon(Icons.close),
                        tooltip: '关闭提示',
                      ),
                    ],
                  ),
                ),
              ),
            ),
          if (_billing != null)
            Positioned(
              left: 12,
              right: 12,
              bottom: 84,
              child: Card(
                child: Padding(
                  padding: const EdgeInsets.all(10),
                  child: Text(
                    '本次结果：${_billing!.pinyinName}\n${_billing!.province} · ${_billing!.city} · ${_billing!.district}\n${_billing!.addressLine1} · ${_billing!.postalCode}',
                  ),
                ),
              ),
            ),
          Positioned(
            right: 18,
            bottom: 20,
            child: FloatingActionButton(
              onPressed: _session == null || _filling ? null : _fill,
              tooltip: '生成并填充',
              child: _filling
                  ? const SizedBox.square(
                      dimension: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.auto_fix_high),
            ),
          ),
        ],
      ),
    );
  }
}
