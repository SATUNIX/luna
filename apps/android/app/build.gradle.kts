import groovy.json.JsonSlurper
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The app ships the kit's mobile interface (packages/web-ui/mobile) and the pi-console modules
// it reuses (packages/web-ui/public/js), copied in at build time so the two never drift.
val repoRoot: File = rootDir.resolve("../..").canonicalFile
val webUi: File = repoRoot.resolve("packages/web-ui")
val kitVersion: String = (JsonSlurper().parse(repoRoot.resolve("package.json")) as Map<*, *>)["version"] as String

/** 0.2.4-beta.1 -> 204: monotonic across the kit's releases (pre-release suffixes share a code). */
fun versionCodeOf(version: String): Int {
    val (major, minor, patch) = version.substringBefore('-').split('.').map { it.toInt() }
    return major * 10000 + minor * 100 + patch
}

// Release signing comes from a properties file outside the repository:
//   storeFile=/path/to/release.jks  storePassword=...  keyAlias=...  keyPassword=...
// named by -PpiRemoteSigning=<file> or PI_REMOTE_SIGNING=<file>. Without it the release
// APK is left unsigned.
val signingFile: File? = ((findProperty("piRemoteSigning") as String?) ?: System.getenv("PI_REMOTE_SIGNING"))
    ?.let { file(it) }
    ?.takeIf { it.isFile }
val signing: Properties? = signingFile?.let { f -> Properties().apply { f.inputStream().use { load(it) } } }

android {
    namespace = "io.github.satunix.piremote"
    compileSdk = 34

    defaultConfig {
        applicationId = "io.github.satunix.piremote"
        minSdk = 29
        targetSdk = 34
        versionCode = versionCodeOf(kitVersion)
        versionName = kitVersion
    }

    signingConfigs {
        if (signing != null) {
            create("release") {
                storeFile = file(signing.getProperty("storeFile"))
                storePassword = signing.getProperty("storePassword")
                keyAlias = signing.getProperty("keyAlias")
                keyPassword = signing.getProperty("keyPassword")
                enableV1Signing = false
                enableV2Signing = true
                enableV3Signing = true
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release")
        }
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        buildConfig = true
    }
    packaging {
        resources.excludes += setOf("META-INF/*.version", "META-INF/*.kotlin_module", "kotlin/**", "DebugProbesKt.bin")
    }
    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated/web"))
}

// assets/web/mobile/...     the mobile interface (its dev/ stand-in is not packaged)
// assets/web/public/js/...  pi-console's renderer, imported as ../../public/js/*.js
val copyWebAssets by tasks.registering(Sync::class) {
    from(webUi.resolve("mobile")) {
        into("web/mobile")
        exclude("dev/**")
    }
    from(webUi.resolve("public/js")) {
        into("web/public/js")
        include("*.js")
    }
    into(layout.buildDirectory.dir("generated/web"))
}
tasks.named("preBuild") { dependsOn(copyWebAssets) }

dependencies {
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.activity:activity-ktx:1.8.0")
    implementation("androidx.fragment:fragment-ktx:1.6.2")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.6.2")
    implementation("androidx.webkit:webkit:1.9.0")
    implementation("androidx.biometric:biometric:1.1.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
}
