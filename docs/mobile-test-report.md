# Flutter project test report

| Area | Command / method | Result | Notes |
|---|---|---|---|
| Desktop typecheck | `npm run typecheck` | Passed | TypeScript and Vue typechecks completed after the API-only removal. |
| Desktop test suite | `npm test` | Passed: 425/425 | Includes the encrypted default mobile API Key lifecycle, API Key regeneration/revocation, API-only route removal, credential/payment-link leak protections, Checkout billing validation, and import-date / pending-payment account filters. |
| Flutter analysis | `E:\projs\KiroLucker\.tooling\flutter\bin\flutter.bat analyze` | Passed | No issues found after account filters, payment compatibility fallback, and SIM-aware network-IP changes. |
| Flutter widget/unit tests | `E:\projs\KiroLucker\.tooling\flutter\bin\flutter.bat test` | Passed: 9/9 | Covers connection parsing, account filters/usage presentation, Checkout contract parsing, payment UI behavior, and SIM IP result mapping/history fallback. |
| Android LAN HTTP configuration | Merged manifest + `aapt dump xmltree` on the built APK | Passed | User-approved global cleartext support is present in the packaged artifact. The app still requires an in-app confirmation before credentials are sent over HTTP; public endpoints should always use HTTPS. |
| Android debug APK | `flutter build apk --debug` | Passed | Kotlin, Pigeon, AndroidX WebKit, payment compatibility fallback, per-SIM network binding, manifest permissions and native payment code compiled successfully with the supplied local SDK. Artifact: `app/build/app/outputs/flutter-apk/app-debug.apk`. |
| Android device test | Physical Android device | Prior build was user-tested; revised build not rerun | The user confirmed connection and an Android App test before this change set. The revised payment fallback and SIM1/SIM2 functions still need a fresh device run; APK compilation is not a substitute for Stripe form or carrier/OEM behavior. |
| iOS LAN HTTP configuration | `Info.plist` ATS/local-network configuration | Configured, not device-tested | iOS declares local-network use and permits local networking for the requested LAN API flow; physical iOS 15+ verification is still required. |
| iOS build | macOS/Xcode required | Not verified | CI uses macOS/Xcode for an unsigned IPA. Physical iOS 15+ verification and user re-signing remain required. |
| Stripe test Checkout | Controlled test Checkout | Not run | Requires a configured desktop map/AI environment and a Stripe test Checkout URL. No live charge is performed. |