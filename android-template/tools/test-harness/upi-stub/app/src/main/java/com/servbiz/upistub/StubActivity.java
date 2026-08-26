package com.servbiz.upistub;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.view.ViewGroup;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.Set;

/**
 * Reports what it was handed and stops.
 *
 * Everything is logged under a single tag so the test driver can assert on it.
 * The payment parameters are logged individually because getting one of them
 * mangled -- a dropped amount, a truncated payee address -- is a failure that
 * looks identical to success from the outside.
 */
public class StubActivity extends Activity {

    private static final String TAG = "UpiStub";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Intent intent = getIntent();
        Uri data = intent == null ? null : intent.getData();

        Log.i(TAG, "LAUNCHED action=" + (intent == null ? "null" : intent.getAction()));
        Log.i(TAG, "URI " + (data == null ? "(none)" : data.toString()));
        Log.i(TAG, "SCHEME " + (data == null ? "(none)" : data.getScheme()));
        Log.i(TAG, "CALLER " + describeCaller());

        StringBuilder shown = new StringBuilder();
        shown.append("Handed to UPI Stub\n\n");
        shown.append("uri: ").append(data == null ? "(none)" : data.toString()).append("\n\n");

        if (data != null) {
            Set<String> names = data.getQueryParameterNames();
            for (String name : names) {
                String value = data.getQueryParameter(name);
                Log.i(TAG, "PARAM " + name + "=" + value);
                shown.append(name).append(" = ").append(value).append('\n');
            }
            // The four a real UPI app requires. Their absence is the difference
            // between a payment app opening ready to pay and opening confused.
            Log.i(TAG, "REQUIRED pa=" + data.getQueryParameter("pa")
                    + " pn=" + data.getQueryParameter("pn")
                    + " am=" + data.getQueryParameter("am")
                    + " cu=" + data.getQueryParameter("cu"));
        }

        // Anything the intent carried beyond the URI. A sanitised intent should
        // have no component and no selector; logged so that can be asserted.
        Log.i(TAG, "COMPONENT " + (intent == null || intent.getComponent() == null
                ? "(null, as expected)" : intent.getComponent().toString()));
        Log.i(TAG, "CATEGORIES " + (intent == null || intent.getCategories() == null
                ? "(none)" : intent.getCategories().toString()));
        Log.i(TAG, "FLAGS 0x" + Integer.toHexString(intent == null ? 0 : intent.getFlags()));

        setContentView(buildView(shown.toString()));
    }

    private String describeCaller() {
        try {
            String pkg = getCallingPackage();
            if (pkg != null) return pkg;
            Uri referrer = getReferrer();
            return referrer == null ? "(unknown)" : referrer.toString();
        } catch (Exception e) {
            return "(unavailable: " + e.getClass().getSimpleName() + ")";
        }
    }

    private ScrollView buildView(String text) {
        TextView view = new TextView(this);
        view.setText(text);
        view.setTextIsSelectable(true);
        view.setTextColor(Color.parseColor("#111827"));
        view.setPadding(40, 40, 40, 40);

        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        column.addView(view, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT));

        ScrollView scroll = new ScrollView(this);
        scroll.addView(column);
        return scroll;
    }
}
