import groovy.json.JsonSlurper
import java.util.Properties
import javax.inject.Inject
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
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
    compileSdk {
        version = release(37) { minorApiLevel = 2 }
    }
    buildToolsVersion = "37.0.0"

    defaultConfig {
        applicationId = "io.github.satunix.piremote"
        minSdk = 29
        targetSdk = 37
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
    buildFeatures {
        buildConfig = true
    }
    packaging {
        resources.excludes += setOf("META-INF/*.version", "META-INF/*.kotlin_module", "kotlin/**", "DebugProbesKt.bin")
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_17
    }
}

// assets/web/mobile/...     the mobile interface (its dev/ stand-in is not packaged)
// assets/web/public/js/...  pi-console's renderer, imported as ../../public/js/*.js
abstract class CopyWebAssets : DefaultTask() {
    @get:InputDirectory
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val mobile: DirectoryProperty

    @get:InputDirectory
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val publicJs: DirectoryProperty

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @get:Inject
    abstract val fs: FileSystemOperations

    @TaskAction
    fun copy() {
        fs.sync {
            from(mobile) {
                into("web/mobile")
                exclude("dev/**")
            }
            from(publicJs) {
                into("web/public/js")
                include("*.js")
            }
            into(outputDir)
        }
    }
}

// AGP 9 accepts generated assets only through the variant API, which also wires the task
// dependency, so each variant gets its own copy task and output directory.
androidComponents {
    onVariants { variant ->
        val copy = tasks.register<CopyWebAssets>("copy${variant.name.replaceFirstChar { it.uppercase() }}WebAssets") {
            mobile.set(webUi.resolve("mobile"))
            publicJs.set(webUi.resolve("public/js"))
        }
        variant.sources.assets?.addGeneratedSourceDirectory(copy, CopyWebAssets::outputDir)
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.19.1")
    implementation("androidx.activity:activity-ktx:1.13.0")
    implementation("androidx.fragment:fragment-ktx:1.9.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.11.0")
    implementation("androidx.webkit:webkit:1.18.0")
    implementation("androidx.biometric:biometric:1.1.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")
    implementation("com.squareup.okhttp3:okhttp:5.5.1")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    // zxing-android-embedded 4.3.0 is the latest release but depends on ZXing core 3.4.1; core
    // 3.5 needs API 24, which this app's minSdk (29) meets, so the newer core is declared here.
    implementation("com.google.zxing:core:3.5.4")

    // Android Lint runs with the same outdated Bouncy Castle and commons-lang3 as AGP (see the
    // root build file), plus httpclient 4.5.6 (GHSA-7r82-7xv7-xcpj); raise them to their latest.
    constraints {
        add("androidLintTool", "org.bouncycastle:bcprov-jdk18on:1.86")
        add("androidLintTool", "org.bouncycastle:bcpkix-jdk18on:1.86")
        add("androidLintTool", "org.bouncycastle:bcutil-jdk18on:1.86")
        add("androidLintTool", "org.apache.commons:commons-lang3:3.21.0")
        add("androidLintTool", "org.apache.httpcomponents:httpclient:4.5.14")
    }
}
