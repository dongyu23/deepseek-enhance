/* ============================================================
 * bootstrap：IIFE 外壳 + 运行时桥（油猴 / Android WebView 注入通用）
 * ============================================================ */
(function () {
'use strict';

/* ---------- 运行时探测：GM 可用用油猴，否则回退 localStorage（WebView 注入） ---------- */
var HAS_GM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
var LS_PREFIX = 'dse_store_';
var lsStore = {};
try { lsStore = JSON.parse(localStorage.getItem('dse_bridge_store') || '{}') || {}; } catch (e) { lsStore = {}; }
var lsTimer = null;
function lsWriteNow() { try { localStorage.setItem('dse_bridge_store', JSON.stringify(lsStore)); } catch (e) {} }
/* 合并写入：粘贴长文本时 input 会连续触发，逐次全量 stringify+写盘会卡死主线程 */
function lsFlush() {
  if (lsTimer) return;
  lsTimer = setTimeout(function () { lsTimer = null; lsWriteNow(); }, 150);
}
function lsFlushNow() { if (lsTimer) { clearTimeout(lsTimer); lsTimer = null; } lsWriteNow(); }
try {
  window.addEventListener('pagehide', lsFlushNow);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') lsFlushNow(); });
} catch (e) {}

var Bridge = {
  get: function (k, d) {
    if (HAS_GM) { var v = GM_getValue(k, undefined); return (v === undefined || v === null) ? d : v; }
    return (k in lsStore) ? lsStore[k] : d;
  },
  set: function (k, v) {
    if (HAS_GM) return GM_setValue(k, v);
    lsStore[k] = v; lsFlush();
  },
  remove: function (k) {
    if (HAS_GM) { try { GM_deleteValue(k); } catch (e) {} return; }
    delete lsStore[k]; lsFlush();
  },
  list: function () {
    if (HAS_GM) { try { return GM_listValues() || []; } catch (e) { return []; } }
    return Object.keys(lsStore);
  },
  _pendingCss: [],
  _flushScheduled: false,
  _mount: function (css) {
    if (typeof GM_addStyle === 'function') { try { return GM_addStyle(css); } catch (e) {} }
    var host = document.head || document.documentElement;
    if (!host) { this._pendingCss.push(css); this._scheduleFlush(); return null; }
    var s = document.createElement('style');
    s.setAttribute('data-dse', '1');
    s.textContent = css;
    host.appendChild(s);
    return s;
  },
  _scheduleFlush: function () {
    if (this._flushScheduled) return; this._flushScheduled = true;
    var self = this;
    var flush = function () {
      self._flushScheduled = false;
      var host = document.head || document.documentElement;
      if (!host) { self._scheduleFlush(); return; }
      var all = self._pendingCss.slice(); self._pendingCss = [];
      all.forEach(function (css) {
        var s = document.createElement('style');
        s.setAttribute('data-dse', '1'); s.textContent = css; host.appendChild(s);
      });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', flush);
    else setTimeout(flush, 0);
  },
  addStyle: function (css) { return this._mount(css); },
  hasGM: HAS_GM
};

/* ---------- 页面真正的 window ----------
 * 油猴带 @grant 时把脚本跑在沙箱里，沙箱的 window 不是页面的 window：读会沿
 * 原型链穿透过去，写只落在沙箱全局。于是 `window.fetch = 补丁` 这种写法页面
 * 一个字节都没换到——demo 页走 fetch，桥接整个不工作、圆圈永远 0（主站走
 * XHR、改的是共享原型所以照常，故只有 demo 页炸）。document.defaultView 在
 * 任何上下文里都指向页面真正的 window，unsafeWindow 是油猴的显式通道 */
function pageWindow() {
  try { if (typeof unsafeWindow !== 'undefined' && unsafeWindow) return unsafeWindow; } catch (e) {}
  try { if (document.defaultView) return document.defaultView; } catch (e) {}
  return window;
}

/* ---------- 全局命名空间 + 极简事件总线 ---------- */
var DSE = window.DSE = {
  version: '8.5.0',
  runtime: HAS_GM ? 'tampermonkey' : 'inject',
  pageWindow: pageWindow,
  bridge: Bridge,
  modules: {},
  _ev: {},
  on: function (name, fn) { (this._ev[name] = this._ev[name] || []).push(fn); },
  emit: function (name, payload) {
    var list = this._ev[name] || [];
    for (var i = 0; i < list.length; i++) { try { list[i](payload); } catch (e) { console.error('[DSE]', name, e); } }
  }
};
// 沙箱里 window 不是页面的 window——再往页面真正的 window 上挂一份，控制台/
// 其它脚本才拿得到 DSE（实测沙箱下不挂的话控制台里 DSE is not defined）
try { var pw = pageWindow(); if (pw && pw !== window) pw.DSE = DSE; } catch (e) {}

DSE.register = function (name, api) { this.modules[name] = api || {}; };
DSE.log = function () {
  var a = ['[DSE]'].concat([].slice.call(arguments));
  try { console.log.apply(console, a); } catch (e) {}
};
