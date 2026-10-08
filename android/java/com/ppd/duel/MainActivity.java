package com.ppd.duel;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.os.Bundle;
import android.view.View;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.ProgressBar;
import android.widget.Toast;

public class MainActivity extends Activity {
    // 游戏内置在 APK 资产中（assets/www），离线即可玩单机/人机/本地双人；
    // 战绩同步（审计 #8）：内置版页面为 file:// 无同源后端，战绩默认存手机本地；
    // 在游戏内「设置 → 公网联机服务器地址」填写自建服务器地址（如 http://电脑IP:8765）后，
    // 战绩异步同步到该服务器（跨设备共享，见 app/records.js serverBase）。
    private WebView web;
    private ProgressBar progress;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.main);
        web = findViewById(R.id.web);
        progress = findViewById(R.id.progress);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false); // 背景音乐可自动播放
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        // file:// 页面跨源访问 http://局域网IP:8765（战绩同步 / 本地联机）不被混合内容拦截
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

        // 与站点 --bg #0d1220 一致：windowBackground（styles.xml）+ WebView 自身底色双重对齐，
        // 首屏渲染前不白闪。
        web.setBackgroundColor(0xFF0D1220);

        // 先隐藏，页面加载完成再显示（旧代码在 onPageFinished 里 setVisibility(VISIBLE) 属于死代码：
        // WebView 默认就是 VISIBLE，从来没有先隐藏过）。必须配 onReceivedError 兜底——
        // 否则加载失败时永远停在隐藏态 = 整屏纯黑，看起来像闪退。
        web.setVisibility(View.INVISIBLE);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) { return false; }
            @Override
            public void onPageFinished(WebView v, String u) {
                progress.setVisibility(View.GONE);
                v.setVisibility(View.VISIBLE);
            }
            @Override
            public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                progress.setVisibility(View.GONE);
                v.setVisibility(View.VISIBLE);      // 让系统错误页可见，不要停在隐藏态
                Toast.makeText(v.getContext(), "页面加载失败，请重启应用", Toast.LENGTH_LONG).show();
            }
        });
        web.setWebChromeClient(new WebChromeClient());
        web.loadUrl("file:///android_asset/www/index.html");
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }
}
