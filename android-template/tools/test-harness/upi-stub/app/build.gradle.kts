plugins {
    id("com.android.application")
}

// Deliberately dependency-free: no Kotlin, no androidx. This exists only to
// register itself as a upi:// handler and report what it was handed, so it should
// build in seconds and have nothing that can break.
android {
    namespace = "com.servbiz.upistub"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.servbiz.upistub"
        minSdk = 24
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    lint {
        abortOnError = false
    }
}
