package com.restosplus.app;

import android.app.Activity;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.view.Gravity;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;

public class MainActivity extends Activity {
    private static final String APP_URL = "https://restosplus.com/";
    private WebView webView;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(Color.rgb(16,47,36));
        showSplash();
        new Handler(getMainLooper()).postDelayed(this::showApp, 900);
    }

    private void showSplash() {
        FrameLayout splash = new FrameLayout(this);
        splash.setBackgroundColor(Color.rgb(16,47,36));
        TextView logo = new TextView(this);
        logo.setText("RestOS+");
        logo.setTextColor(Color.WHITE);
        logo.setTextSize(42);
        logo.setGravity(Gravity.CENTER);
        logo.setTypeface(null, android.graphics.Typeface.BOLD);
        splash.addView(logo, new FrameLayout.LayoutParams(-1,-1));
        setContentView(splash);
    }

    private void showApp() {
        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(16,47,36));
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setLoadWithOverviewMode(false);
        s.setUseWideViewPort(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);
        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, android.webkit.WebResourceRequest request) {
                String host = request.getUrl().getHost();
                if (host != null && (host.equals("restosplus.com") || host.endsWith(".restosplus.com"))) return false;
                startActivity(new android.content.Intent(android.content.Intent.ACTION_VIEW, request.getUrl()));
                return true;
            }
        });
        setContentView(webView);
        if (stateUrl() == null) webView.loadUrl(APP_URL); else webView.loadUrl(stateUrl());
    }

    private String stateUrl() { return null; }

    @Override public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack(); else super.onBackPressed();
    }
}
