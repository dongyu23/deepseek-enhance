/* ============================================================
 * modules/demoPasteTxt：复刻官方「粘贴大段文本自动转成 txt 附件」
 *
 * 官方行为（2026-11-18 从主站 chat-main.js 逐字提取）：
 *   - 触发条件是**粘贴**，不是打字；剪贴板里带文件项时整段逻辑不介入
 *   - 阈值 = 服务端 file_feature.paste_text_to_file_character_limit，
 *     取不到时默认 2000；判的是「粘贴文本自身长度 > 阈值」
 *   - 还要 canAddFile（上传可用且文件数没满），否则照常按文本粘贴
 *   - 转成 File 后走页面上传管线：附件卡、上传、document 内容块全原生
 *   - 文件名：首行 → 超 50 字符截断（ASCII 词边界回退）→ 去非法字符 →
 *     折叠空白 → 空则用「粘贴的文本」→ 拼 .txt
 *   - 上传没成功时把文本还回输入框并提示；Ctrl+Z 可撤销这次转换
 *
 * demo 页（cdn.deepseek.com/chat-demo）bundle 里没有这段逻辑，但上传管线
 * 是齐的——隐藏 <input type="file"> 的 onChange 就是上传入口。所以本模块
 * **不重画任何 UI**：把 File 塞进那个 input 再派发 change，让页面自己上传、
 * 自己渲染附件卡。主站（chat.deepseek.com）原生就有这功能，不介入。
 * ============================================================ */
var DemoPasteTxt = {
  // 官方默认阈值（服务端没配 paste_text_to_file_character_limit 时）
  LIMIT: 2000,
  // 上传结果轮询：卡片出现算成功，超时算失败（走官方「还回输入框」分支）
  POLL_MS: 100, POLL_TIMEOUT: 4000,

  /* ---------- 定位（不依赖哈希 class，用结构关系） ---------- */
  // 上传 input：accept 里带 .txt 且可多选——demo 页有两个 file input，
  // 另一个是 image/* 单选，不会误取
  findInput: function () {
    var list = document.querySelectorAll('input[type="file"]');
    for (var i = 0; i < list.length; i++) if (/\.txt/.test(list[i].accept || '')) return list[i];
    return null;
  },

  // 上传按钮：从隐藏 input 往前找最近的一个按钮（它包在 tooltip 的 trigger
  // span 里也没关系，取 span 内的 button）——与 aria-label 的本地化文案无关，
  // 也不依赖 class 哈希
  findUploadBtn: function (input) {
    var n = input ? input.previousElementSibling : null;
    while (n) {
      if (n.tagName === 'BUTTON') return n;
      var b = n.querySelector ? n.querySelector('button') : null;
      if (b) return b;
      n = n.previousElementSibling;
    }
    return null;
  },

  // 输入区：从 input 往上走到第一个含 textarea 的容器（附件卡/输入框/功能行
  // 都在这个容器里）
  findComposer: function (input) {
    var n = input;
    while (n && n !== document.body) {
      if (n.querySelector && n.querySelector('textarea')) return n;
      n = n.parentElement;
    }
    return null;
  },

  // 附件卡列表。注意：**0 个卡片时页面连 attachments 容器都不渲染**，所以不能
  // 先找容器再数子元素（会永远是 0，导致误判"上传失败"而把文本还回输入框）。
  // 改成直接按 card- 前缀找，再用「卡内必有删除按钮」过滤掉误匹配
  cardList: function (composer) {
    if (!composer) return [];
    var all = composer.querySelectorAll('[class*="card-"]');
    var out = [];
    for (var i = 0; i < all.length; i++) if (all[i].querySelector('button')) out.push(all[i]);
    return out;
  },

  countCards: function (composer) {
    return this.cardList(composer).length;
  },

  /* ---------- 粘贴判定 ---------- */
  onPaste: function (e) {
    var cd = e.clipboardData;
    if (!cd) return;
    // 剪贴板带文件项 → 官方整体不介入，交给浏览器默认行为
    var items = cd.items;
    if (items) for (var i = 0; i < items.length; i++) if (items[i].kind === 'file') return;
    var text = cd.getData('text/plain');
    if (!text) return;
    var input = this.findInput();
    if (!input) return;
    var composer = this.findComposer(input);
    if (!composer) return;
    var ta = e.currentTarget;
    var s0 = ta.selectionStart, s1 = ta.selectionEnd;
    // canAddFile：读页面上传按钮自己的禁用态（文件数满/当前不可上传时页面
    // 会禁用它）——不自己猜上限，上限只有页面知道
    var btn = this.findUploadBtn(input);
    if (!btn || btn.disabled) return;
    // 官方还有一条 inputMaxLength 分支（超长直接按文本粘 + 弹计数提示），
    // 但那个上限来自服务端 input_character_limit；demo 页没有该配置，
    // 官方代码里是 `void 0 !== a` 判定，取不到时整条分支跳过——同样跳过
    if (text.length <= this.LIMIT) return;

    e.preventDefault();
    var delInUndo = this.deleteSelection(ta, s0, s1);
    var file = new File([text], this.txtName(text), { type: 'text/plain;charset=utf-8' });
    var self = this;
    this._rec = null;
    this.feed(input, file, composer, function (ok, card) {
      if (!ok) {
        // 官方失败分支：文本还回输入框 + 提示，绝不让用户丢字
        self.insertText(ta, text, s0);
        Utils.toast(DSE.t('内容已恢复到输入框'));
        return;
      }
      // 记下这次转换供 Ctrl+Z 撤销（官方同款：撤销=删卡片+文本回输入框）
      self._rec = { kind: 'converted', text: text, at: s0, card: card, delInUndo: delInUndo, composer: composer };
    });
  },

  /* ---------- 选区删除（官方同款：先 execCommand，失败再走 setValue） ---------- */
  deleteSelection: function (ta, s0, s1) {
    if (s0 === s1) return false;
    ta.focus();
    if (document.activeElement === ta && document.execCommand('delete', false)) return true;
    var setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    var v = ta.value;
    setter.call(ta, v.slice(0, s0) + v.slice(s1));
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.setSelectionRange(s0, s0);
    return false;
  },

  /* ---------- 把 File 交给页面上传管线 ---------- */
  feed: function (input, file, composer, cb) {
    var before = this.countCards(composer);
    var dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    var self = this, t0 = Date.now();
    (function poll() {
      var list = self.cardList(composer);
      if (list.length > before) return cb(true, list[list.length - 1]);
      if (Date.now() - t0 > self.POLL_TIMEOUT) return cb(false, null);
      setTimeout(poll, self.POLL_MS);
    })();
  },

  /* ---------- 文本写回输入框 ---------- */
  insertText: function (ta, text, pos) {
    ta.focus();
    var p = (pos == null ? ta.value.length : Math.max(0, Math.min(pos, ta.value.length)));
    if (document.activeElement === ta) {
      ta.setSelectionRange(p, p);
      if (document.execCommand('insertText', false, text)) return;
    }
    var setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    var v = ta.value;
    setter.call(ta, v.slice(0, p) + text + v.slice(p));
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    requestAnimationFrame(function () { ta.setSelectionRange(p + text.length, p + text.length); });
  },

  /* ---------- Ctrl+Z 撤销这次转换（官方同款） ---------- */
  onKey: function (e) {
    var rec = this._rec;
    // 只拦截「紧接着这次转换」的撤销：用户一打字或按别的键，记录即失效，
    // 之后 Ctrl+Z 交回 textarea 原生撤销，不劫持
    if (!rec) return;
    var isUndo = (e.metaKey || e.ctrlKey) && !e.altKey && String(e.key).toLowerCase() === 'z' && !e.shiftKey;
    if (!isUndo) { this._rec = null; return; }
    e.preventDefault();
    this._rec = null;
    // 删卡片（卡片里唯一的 button 就是删除按钮，aria-label 是本地化的）
    var rm = rec.card && rec.card.querySelector('button');
    if (rm) Utils.realClick(rm);
    // 删除选区时若走了 execCommand（进了原生撤销栈），要连带 undo 一次，
    // 否则撤销栈里会留下那次删除
    if (rec.delInUndo) document.execCommand('undo', false);
    var ta = (rec.composer || document).querySelector('textarea');
    if (ta) this.insertText(ta, rec.text, rec.at);
  },

  /* ---------- 绑定 ---------- */
  bind: function () {
    var self = this;
    var input = this.findInput();
    if (!input) return;
    var composer = this.findComposer(input);
    if (!composer) return;
    var tas = composer.querySelectorAll('textarea');
    for (var i = 0; i < tas.length; i++) {
      var ta = tas[i];
      if (ta.__dsePasteTxt) continue;
      ta.__dsePasteTxt = true;
      ta.addEventListener('paste', function (e) { self.onPaste(e); }, true);
      ta.addEventListener('keydown', function (e) { self.onKey(e); }, true);
      // 用户一打字，这次转换就不再是「最近一次操作」，撤销记录作废
      ta.addEventListener('input', function () { self._rec = null; });
    }
  },

  /* ---------- 文件名（官方算法逐字对应） ---------- */
  txtName: function (text) {
    // v5 = 字母或数字、且不是 CJK/泰文等——官方用它判断「是否处在词中间」
    var RE_WORD = /[\p{L}\p{N}]/u;
    var RE_NON_LATIN = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Thai}\p{sc=Lao}\p{sc=Khmer}\p{sc=Myanmar}]/u;
    var isWord = function (ch) { return !!ch && RE_WORD.test(ch) && !RE_NON_LATIN.test(ch); };
    var RE_BAD = /[\\/:*?"<>|\x00-\x1f]/g;   // v8：文件名非法字符
    var n = text.search(/\r|\n/);
    var first = n === -1 ? text : text.slice(0, n);
    if (first.length > 50) {
      var cut = 50;
      // 第 50 个字符和被挤掉的第 51 个都是 ASCII 词字符 → 说明切在了词中间，
      // 往前退到词边界
      if (isWord(first[49]) && isWord(first[50])) {
        var t = 50;
        while (t > 0 && isWord(first[t - 1])) t -= 1;
        if (t > 0) cut = t;
      }
      first = first.slice(0, cut);
    }
    var s = first.replace(RE_BAD, '').replace(/\s+/g, ' ').trim();
    return (s || this.fallbackName()) + '.txt';
  },

  fallbackName: function () {
    // 官方回退名按页面语言取值：粘贴的文本 / Pasted text
    var lang = '';
    try { lang = localStorage.getItem('latestReminderLanguage') || navigator.language || ''; } catch (e) {}
    return /^zh/i.test(lang) ? '粘贴的文本' : 'Pasted text';
  },

  init: function () {
    // 主站原生就有这功能，只补 demo 页
    if (location.hostname !== 'cdn.deepseek.com') return;
    var self = this;
    Utils.onReady(function () { self.bind(); });
    // 输入框随会话切换重建——节流（带前缘）兜底自愈，不用防抖（连续 DOM
    // 变动会把防抖一直重置，重建后迟迟绑不上）
    new MutationObserver(Utils.throttle(function () { self.bind(); }, 300))
      .observe(document.body, { childList: true, subtree: true });
  }
};
DSE.modules.demoPasteTxt = DemoPasteTxt;
