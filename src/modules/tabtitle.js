/* ============================================================
 * modules/tabtitle：浏览器标签页标题跟随当前会话名
 *
 * 先说清这不是复刻：官方两个站都不改 document.title——主站 bundle
 * （1.66MB，2026-11-18 实时拉取）逐字 grep 零处 document.title，HTML
 * <title> 静态 "DeepSeek"；demo bundle 同样零处，<title> 静态
 * "API 使用 demo"；vendor 里虽打包了 react-helmet（唯一一处
 * document.title 在它里面），但应用代码 0 处引用 Helmet。本模块是
 * 用户明确要求的新增功能。
 *
 * 数据源用 demo 页侧边栏自己渲染出来的当前会话项：打开某会话后该项
 * 加上 active-ff6fc9（实测），其 .title-ff6fc9 的文本就是当前会话名
 * ——不另读 IndexedDB、不猜会话 id，界面显示什么标签页就显示什么。
 * 换会话 = active 类转移到另一项；改名 = 标题文本变；两者都由同一个
 * 观察器覆盖。新对话（没有任何 active 项）时还原成页面原标题。
 * ============================================================ */
var TabTitle = {
  init: function () {
    // 只做 demo 页：主站侧边栏类名没实测过（账号禁言中主站 UI 被公告挡
    // 住，点不开会话），不猜哈希
    if (location.hostname !== 'cdn.deepseek.com') return;
    var self = this;
    this.orig = document.title;
    Utils.onReady(function () {
      self.sync();
      self.bind();
      // 兜底自愈：侧边栏容器整体被换掉（会话切换/重渲染）时重新绑。节流
      // （带前缘）而非防抖——防抖会被连续 DOM 变动不断重置，重建后迟迟不生效
      new MutationObserver(Utils.throttle(function () {
        if (!self._host || !self._host.isConnected) self.bind();
        self.sync();
      }, 100)).observe(document.body, { childList: true, subtree: true });
    });
  },

  // 当前会话名 → document.title；无当前会话（新对话）→ 还原原标题
  sync: function () {
    var el = document.querySelector(DSE.SEL.sidebarItemActive);
    var t = '';
    if (el) {
      var te = el.querySelector(DSE.SEL.sidebarItemTitle);
      t = te ? String(te.textContent || '').trim() : '';
    }
    var want = t || this.orig;
    if (document.title !== want) document.title = want;
  },

  // 精确观察器绑在侧边栏列表容器上：childList 管 active 类转移（换会话），
  // subtree+characterData 管标题文本变化（改名）
  bind: function () {
    var host = document.querySelector(DSE.SEL.sidebarList) ||
               (document.querySelector(DSE.SEL.sidebarItem) || {}).parentElement;
    if (!host) return;
    if (this._mo) { try { this._mo.disconnect(); } catch (e) {} }
    this._host = host;
    var self = this;
    this._mo = new MutationObserver(Utils.throttle(function () { self.sync(); }, 50));
    this._mo.observe(host, { childList: true, subtree: true, characterData: true });
  }
};
DSE.modules.tabTitle = TabTitle;
