# pi remote (Android)

The Android app for [remote control](../../docs/remote-control.md): a phone-sized pi-console that
links to a computer running `/remote` and talks to it directly, over the LAN or a VPN such as
Tailscale. How linking works, what protects it and its limits are described in
[`docs/remote-control.md`](../../docs/remote-control.md).

Android 10 (API 29) or newer. Application id `io.github.satunix.piremote`.

## Layout

- `app/src/main/java/.../MainActivity.kt` hosts a WebView that shows the bundled screens, the app
  lock (fingerprint, face or screen lock), the QR scanner and `pirc://pair` links.
- `Bridge.kt` is the only way the page reaches native code: JSON messages over a
  `WebMessageListener` that accepts the app's own origin only. There is no JavaScript interface.
- `Remote.kt` does all networking: per-computer OkHttp clients that pin the certificate
  fingerprint, address racing, the signed-challenge sign-in, tokens (memory only), event streams
  and linking. `PinnedTls.kt` holds the pinning trust manager.
- `DeviceKeys.kt` creates and uses the per-computer EC P-256 key in the Android Keystore
  (StrongBox when available). `HostStore.kt` keeps the linked computers (no secrets) in app-private
  storage, which is excluded from backups.
- The screens are not in this directory: they are `packages/web-ui/mobile` plus pi-console's
  Markdown and chat code from `packages/web-ui/public/js`, copied into the APK at build time (the
  `copyWebAssets` task). Edit them there. To work on them in a desktop browser, serve
  `packages/web-ui` with any static server and open `/mobile/index.html?mock`; a fake computer
  (`mobile/dev/mock-native.js`, never packaged) answers instead of the app.

## Building

You need JDK 17 and the Android SDK command-line tools with `platforms;android-34` and
`build-tools;34.0.0`. Android Studio is not required. Point Gradle at the SDK with `ANDROID_HOME`
(or `sdk.dir` in `local.properties`, which git ignores). The Gradle wrapper is pinned with a
checksum in `gradle/wrapper/gradle-wrapper.properties`.

```sh
cd apps/android
./gradlew assembleDebug      # app/build/outputs/apk/debug/app-debug.apk
```

The debug build is for development: its id ends in `.debug`, so it installs beside a release
build, and its WebView can be inspected from a desktop browser. Do not use it day to day.

### A signed release build

A release APK must be signed, and every update must be signed with the same key, or Android
refuses to install it over the old one. Create a key once and keep it (and its password) safe,
outside the repository:

```sh
mkdir -p ~/.android/pi-remote && chmod 700 ~/.android/pi-remote
keytool -genkeypair -keystore ~/.android/pi-remote/release.jks -storetype PKCS12 \
  -alias pi-remote -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=pi remote"
```

Then describe it in a properties file, also outside the repository and readable only by you
(`storeFile` must be an absolute path: Gradle does not expand `~`):

```properties
storeFile=/absolute/path/to/release.jks
storePassword=...
keyAlias=pi-remote
keyPassword=...
```

and build with it:

```sh
PI_REMOTE_SIGNING=~/.android/pi-remote/signing.properties ./gradlew assembleRelease
# or: ./gradlew assembleRelease -PpiRemoteSigning=/path/to/signing.properties
```

The result is `app/build/outputs/apk/release/app-release.apk`, shrunk with R8 and signed with APK
signature scheme v3. Without a signing file the release build is produced unsigned. The version
name and code come from the repository's `package.json`.

## Installing

Copy the APK to the phone and open it (Android asks you to allow installs from that app once), or
install it over USB with `adb install app-release.apk`. Then follow
[Linking a phone](../../docs/remote-control.md#linking-a-phone).

An APK signed with a different key cannot replace the installed app: uninstall it first, which
also forgets its links, and link the phone again.

## Permissions

| Permission | Why |
|---|---|
| Internet | To reach your computers |
| Camera | Only for scanning the QR code, asked for when you tap **Scan QR code** |
| Biometric | Only for the optional app lock |

Cleartext traffic is disabled, and backups and device-to-device transfers exclude all app data.

## Third-party components

The APK bundles these libraries, all under the Apache License 2.0: OkHttp and Okio (Square), ZXing
and ZXing Android Embedded (QR scanning), AndroidX (Core, Activity, Fragment, Lifecycle, WebKit,
Biometric) and the Kotlin standard library and coroutines. Gradle fetches them at build time; the
repository does not vendor them. Whoever distributes a built APK must pass on their licence and
notices; the app does not show them yet.

## Tests

Nothing in this repository tests the app automatically. The protocol it speaks is pinned by
`tests/remote-host-smoke.ts`, whose client does what the app does, and the app itself has been
exercised by hand on an Android 14 emulator against a real host.
