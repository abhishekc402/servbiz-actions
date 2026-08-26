# The shell has no reflection-heavy code, so the defaults are almost enough.

# Keep any @JavascriptInterface members. None are exposed today; this guard is
# here so that adding a bridge later cannot be silently stripped by R8.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# org.json is part of the platform, not bundled.
-dontwarn org.json.**
