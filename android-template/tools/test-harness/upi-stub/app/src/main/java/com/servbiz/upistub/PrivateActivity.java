package com.servbiz.upistub;

import android.app.Activity;
import android.os.Bundle;
import android.util.Log;

/**
 * A component that page content must never be able to reach.
 *
 * Declared with exported="false" and no intent filter, so the only way in is an
 * intent that names it explicitly. Intent.parseUri will happily produce exactly
 * that from an `intent://...;component=...;end` URL, which is the classic
 * intent-scheme redirect hole: a page in the WebView gets to invoke arbitrary
 * components with the host app's identity.
 *
 * ExternalLauncher.buildSafeIntent is supposed to strip the component and force
 * CATEGORY_BROWSABLE, which limits resolution to activities that opted in to
 * being launched from web content. If this class ever logs, that mitigation has
 * regressed.
 */
public class PrivateActivity extends Activity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Log.e("UpiStub", "SECURITY FAILURE: PRIVATE ACTIVITY REACHED from page content");
        finish();
    }
}
