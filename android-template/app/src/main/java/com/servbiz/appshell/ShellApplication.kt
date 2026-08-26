package com.servbiz.appshell

import android.app.Application
import android.webkit.WebView

class ShellApplication : Application() {

    override fun onCreate() {
        super.onCreate()

        // chrome://inspect access, debug builds only. Never ship this enabled:
        // it would let anyone with adb access inspect and script the WebView,
        // including any logged-in session inside it.
        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true)
        }
    }
}
