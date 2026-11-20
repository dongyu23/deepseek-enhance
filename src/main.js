/* ============================================================
 * main：初始化（顺序敏感：网络层 → 防撤回 → 提示词 → 其余）
 *
 * 网络层（net / antiRecall）必须在 document-start 就装好，不能等 DOMContentLoaded：
 * 站点完全可能在 DCL 之前就发出首屏请求（内联预取、早期 XHR），晚一步打 patch
 * 那段响应就整段漏掉——表现为「用量统计有时候不激活、一直显示 0」。
 * 这两个模块只碰原型和事件总线，不依赖 DOM，提前装没有副作用。
 * ============================================================ */
(function () {
  var order = [
    'net',            // 先 patch XHR/fetch
    'antiRecall',     // 请求记录（原始 prompt）+ 响应拦截
    'prompt',         // 请求装饰（在 antiRecall 之后）
    'background',
    'think',
    'bubbles',
    'latex',
    'fold',
    'tweaks',
    'context',
    'nav',
    'zoom',
    'buttons',
    'demoPasteTxt',
    'tabTitle',
    'panel'
  ];
  // 提前装的模块：其余仍等 DCL（要 DOM）
  var EARLY = ['net', 'antiRecall'];

  function initModule(name) {
    var m = DSE.modules[name];
    if (!m || typeof m.init !== 'function') return;
    if (m._inited) return;              // 提前装过就不再装（请求改写器会重复注册）
    m._inited = true;
    try { m.init(); } catch (e) { console.error('[DSE] init fail:', name, e); }
  }

  EARLY.forEach(initModule);

  function boot() {
    try {
      order.forEach(initModule);
      DSE.emit('dse:ready');
      console.log('%c[DeepSeek Enhance] v' + DSE.version + ' loaded', 'color:#3b6cf6');
    } catch (e) { console.error('[DSE] boot error', e); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
