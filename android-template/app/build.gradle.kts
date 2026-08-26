import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// ---------------------------------------------------------------------------
// Per-app build inputs.
//
// Everything here is injected by the build worker as -P properties. The Kotlin
// `namespace` below deliberately stays FIXED while `applicationId` varies, so
// no source file is ever rewritten per app -- the package name lives only in
// the merged manifest.
//
// These are the only values that require a full Gradle build. Anything the
// user can change later (icon, splash, colours, URL, behaviour flags) lives in
// assets/config.json and is swapped by the fast-patch path instead.
// ---------------------------------------------------------------------------
fun prop(name: String, default: String): String =
    (project.findProperty("servbiz.$name") as String?)?.takeIf { it.isNotBlank() } ?: default

val appApplicationId = prop("applicationId", "com.servbiz.app.template")
val appLabel = prop("appName", "Servbiz App")
val appVersionCode = prop("versionCode", "1").toInt()
val appVersionName = prop("versionName", "1.0.0")
val appAllowCleartext = prop("allowCleartextTraffic", "false")
val appSplashColor = prop("splashBackgroundColor", "#FFFFFF")
val appIconBackgroundColor = prop("iconBackgroundColor", "#FFFFFF")

// Signing material is passed by file path, never inlined into the build script.
// signing.properties is written by the worker into the build sandbox and
// deleted immediately afterwards. It is gitignored.
val signingProps = Properties().apply {
    val f = rootProject.file("signing.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
val hasSigning = signingProps.getProperty("storeFile")?.isNotBlank() == true

android {
    namespace = "com.servbiz.appshell"
    compileSdk = 35

    defaultConfig {
        applicationId = appApplicationId
        minSdk = 24
        targetSdk = 35
        versionCode = appVersionCode
        versionName = appVersionName

        // Consumed by AndroidManifest.xml
        manifestPlaceholders["usesCleartextTraffic"] = appAllowCleartext

        // Consumed by themes.xml / the splash overlay fallback.
        resValue("string", "app_name", appLabel)
        resValue("color", "splash_background", appSplashColor)
        resValue("color", "ic_launcher_background", appIconBackgroundColor)

        vectorDrawables.useSupportLibrary = true
    }

    signingConfigs {
        if (hasSigning) {
            create("release") {
                storeFile = file(signingProps.getProperty("storeFile"))
                storePassword = signingProps.getProperty("storePassword")
                keyAlias = signingProps.getProperty("keyAlias")
                keyPassword = signingProps.getProperty("keyPassword")

                // Direct-download distribution makes v2 mandatory: an APK
                // targeting API 30+ with only a v1 signature is refused at
                // install time on Android 11+. v3 adds key-rotation headroom.
                //
                // v1 is off because minSdk is 24 -- v1 only matters below API 24,
                // and AGP skips it regardless at this minSdk. Leaving it "on" was
                // misleading: verified output is v1=false, v2=true, v3=true.
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
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            if (hasSigning) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
        debug {
            applicationIdSuffix = ".debug"
            isMinifyEnabled = false
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
        viewBinding = true
        // ShellApplication reads BuildConfig.DEBUG and RemoteConfigFetcher reads
        // BuildConfig.VERSION_NAME, and AGP defaults this to false.
        buildConfig = true
    }

    packaging {
        resources.excludes += setOf(
            "/META-INF/{AL2.0,LGPL2.1}",
            "DebugProbesKt.bin"
        )
    }

    lint {
        // A per-app build must never fail on a lint nit. Correctness is enforced
        // by the template being reviewed once, not per generated app.
        abortOnError = false
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.swiperefreshlayout:swiperefreshlayout:1.1.0")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("com.google.android.material:material:1.12.0")

    testImplementation("junit:junit:4.13.2")
}
