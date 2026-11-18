/* ============================================================
 * modules/tabtitle：浏览器标签页标题跟随当前会话名
 *
 * 官方公式（主站 bundle 逐字，React 19 metadata hoisting）：
 *   jsx("title",{children: 标题 ? `标题 - 品牌名` : `品牌名 - chatHtmlTitle`})
 *   → 实测 "ln(ax+b)高阶导数 - DeepSeek"；无标题时 "DeepSeek - 探索未至之境"
 * demo  bundle 里**没有**这段代码（jsx("title") 零处），标签页标题永远是
 * 静态的 "API 使用 demo"——所以这是按官方公式补的新增功能，不是复刻。
 *
 * 数据源：demo 页聊天区自己渲染出来的当前会话标题 .title-_5fa77。不用
 * 侧边栏——收起边栏时侧边栏条目会整个从 DOM 消失（实测 47→0），标题就断了；
 * 聊天区标题在收起时依然在，且换会话/改名都会重渲染。无标题会话该元素显示
 * 占位"新对话"，按官方语义等同无标题（只有真标题才进标签页）；新对话时该
 * 元素干脆不存在。两者都回落到页面原标题（demo 没有官方那句 slogan 可替）。
 * ============================================================ */
var TabTitle = {
  BRAND: 'DeepSeek',      // 官方 useBrandName() 的值（DSeek 品牌时为 "DSeek"）
  // demo 页对无标题会话的占位显示（侧边栏/聊天区一致）。两种写法都比一遍：
  // 页面按浏览器语言渲染，脚本 i18n 可能与页面不同步，漏一种就会把占位当真标题
  PLACEHOLDERS: ['新对话', 'New chat'],

  init: function () {
    // 只做 demo 页：主站自己会用 React hoisting 改标题，脚本不能插手
    if (location.hostname !== 'cdn.deepseek.com') return;
    var self = this;
    this.orig = document.title;
    Utils.onReady(function () {
      self.sync();
      self.bind();
      // 兜底自愈：聊天区容器整体被换掉（切会话）时重新绑。节流（带前缘）而非
      // 防抖——防抖会被连续 DOM 变动不断重置，重建后迟迟不生效
      new MutationObserver(Utils.throttle(function () {
        if (!self._host || !self._host.isConnected) self.bind();
        self.sync();
      }, 100)).observe(document.body, { childList: true, subtree: true });
    });
  },

  // 当前会话名 → "会话名 - DeepSeek"；无标题/新对话 → 页面原标题
  sync: function () {
    var el = document.querySelector(DSE.SEL.chatTitle);
    var t = el ? String(el.textContent || '').trim() : '';
    if (this.PLACEHOLDERS.indexOf(t) !== -1) t = '';
    var want = t ? t + ' - ' + this.BRAND : this.orig;
    if (document.title !== want) document.title = want;
  },

  // 精确观察器绑在聊天区标题的父容器上：childList 管元素出现/消失（新对话）、
  // subtree+characterData 管标题文本变化（改名）
  bind: function () {
    var el = document.querySelector(DSE.SEL.chatTitle);
    var host = (el && el.parentElement) || document.querySelector(DSE.SEL.chatHeader) ||
               document.querySelector(DSE.SEL.chatView);
    if (!host) return;
    if (this._mo) { try { this._mo.disconnect(); } catch (e) {} }
    this._host = host;
    var self = this;
    this._mo = new MutationObserver(Utils.throttle(function () { self.sync(); }, 50));
    this._mo.observe(host, { childList: true, subtree: true, characterData: true });
  }
};
DSE.modules.tabTitle = TabTitle;
