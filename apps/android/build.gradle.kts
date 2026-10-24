buildscript {
    // AGP 9.4.1, the latest, still resolves these build-time libraries at versions with published
    // advisories (OSV): Bouncy Castle 1.80.2 (GHSA-9pwp-9qqc-pr26, GHSA-qp49-qgx5-5m26,
    // GHSA-c3fc-8qff-9hwx, GHSA-wg6q-6289-32hp), commons-lang3 3.16.0 (GHSA-j288-q9x7-2f5v),
    // jose4j 0.9.5 (GHSA-3677-xxcr-wjqv) and JDOM 2.0.6 (GHSA-2363-cqg2-863c). The constraints
    // raise them to their latest releases. None of them is packaged into the APK.
    dependencies {
        constraints {
            classpath("org.bouncycastle:bcprov-jdk18on:1.86")
            classpath("org.bouncycastle:bcpkix-jdk18on:1.86")
            classpath("org.bouncycastle:bcutil-jdk18on:1.86")
            classpath("org.apache.commons:commons-lang3:3.21.0")
            classpath("org.bitbucket.b_c:jose4j:0.9.7")
            classpath("org.jdom:jdom2:2.0.6.1")
        }
    }
}

plugins {
    id("com.android.application") version "9.4.1" apply false
    // AGP 9 compiles Kotlin itself (built-in Kotlin), so the app module does not apply this plugin.
    // Declaring it here raises the Kotlin Gradle plugin AGP runs from its bundled default to this
    // version.
    id("org.jetbrains.kotlin.android") version "2.4.21" apply false
}
