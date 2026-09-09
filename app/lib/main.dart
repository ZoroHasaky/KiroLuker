import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'core/app_state.dart';
import 'features/accounts/accounts_screen.dart';
import 'features/connection/connection_screen.dart';
import 'features/network/network_screen.dart';
import 'features/payment/payment_screen.dart';
import 'features/settings/settings_screen.dart';

final _router = GoRouter(initialLocation: '/accounts', routes: [
  GoRoute(path: '/accounts', builder: (_, _) => const _MainScaffold(index: 0, child: AccountsScreen())),
  GoRoute(path: '/network', builder: (_, _) => const _MainScaffold(index: 1, child: NetworkScreen())),
  GoRoute(path: '/settings', builder: (_, _) => const _MainScaffold(index: 2, child: SettingsScreen())),
  GoRoute(path: '/account/:id', builder: (_, state) => AccountDetailScreen(id: state.pathParameters['id']!)),
  GoRoute(path: '/payment/:id', builder: (_, state) => PaymentScreen(accountId: state.pathParameters['id']!)),
]);

void main() => runApp(const ProviderScope(child: KiroLukerApp()));

class KiroLukerApp extends ConsumerWidget {
  const KiroLukerApp({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final connection = ref.watch(connectionControllerProvider);
    final connected = connection.asData?.value.isConnected == true;
    final theme = ThemeData(useMaterial3: true, colorSchemeSeed: const Color(0xff5b5bd6), brightness: Brightness.light);
    return connected
        ? MaterialApp.router(title: 'KiroLuker', theme: theme, routerConfig: _router)
        : MaterialApp(title: 'KiroLuker', theme: theme, home: const ConnectionScreen());
  }
}

class _MainScaffold extends StatelessWidget {
  const _MainScaffold({required this.index, required this.child});
  final int index; final Widget child;
  @override
  Widget build(BuildContext context) => Scaffold(body: child, bottomNavigationBar: NavigationBar(selectedIndex: index, onDestinationSelected: (next) => context.go(switch (next) { 0 => '/accounts', 1 => '/network', _ => '/settings' }), destinations: const [NavigationDestination(icon: Icon(Icons.people_outline), selectedIcon: Icon(Icons.people), label: '账号'), NavigationDestination(icon: Icon(Icons.public_outlined), selectedIcon: Icon(Icons.public), label: '网络'), NavigationDestination(icon: Icon(Icons.settings_outlined), selectedIcon: Icon(Icons.settings), label: '设置')]));
}
