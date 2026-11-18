/* ============================================================
 * modules/ctxring：自定义模型时的上下文占用圆圈（ZCode 式精简环）
 *
 * 数据来源：demobridge 在每次交换结束后从响应 usage 算出精确占用
 * （input + cache_read + cache_creation = 本次请求模型实际收到的全部
 * 内容：系统提示/工具定义/完整历史——非文本估算），经 'ctx:api' 事件
 * 广播。本模块只负责把占用/窗口画成一个环，注入在输入工具条里、
 * 发送按钮一侧。常驻显示：开着自定义模型就在（首次对话前显示 0%），
 * 交换后变精确值；关闭总开关才隐藏。
 * ============================================================ */
var CtxRing = {
  SIZE: 22, R: 8.5,

  limit: function () {
    var v = parseInt(DSE.config.get('demoCtxLimit'), 10);
    return (v > 0) ? v : 128000;
  },

  fmt: function (n) {
    if (n >= 1000000) return (n / 1000000).toFixed(n >= 10000000 ? 0 : 1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'K';
    return String(n);
  },

  inject: function () {
    var mods = DSE.modules.buttons;
    var bar = mods && mods.findToolbar ? mods.findToolbar() : null;
    if (!bar || document.getElementById('dse-ctx-ring')) return;
    var C = 2 * Math.PI * this.R;
    var btn = document.createElement('button');
    btn.id = 'dse-ctx-ring';
    btn.type = 'button';
    // 不用 .dse-icon-btn（display!important 会压住内联隐藏）；也不给按钮加
    // 圆形边框/底色——那会和里面的 SVG 进度环叠成“两个圈”（UI 瑕疵），
    // 保持只有一个环
    btn.style.cssText = 'display:none;align-items:center;justify-content:center;width:24px;height:24px;' +
      'border:none;background:transparent;cursor:pointer;flex:0 0 auto;padding:0;margin:0 6px;' +
      'transition:opacity .15s;opacity:.8';
    btn.title = '';
    btn.innerHTML =
      '<svg width="' + this.SIZE + '" height="' + this.SIZE + '" viewBox="0 0 ' + this.SIZE + ' ' + this.SIZE + '">' +
      '<circle cx="11" cy="11" r="' + this.R + '" fill="none" stroke="var(--dse-border)" stroke-width="2.5"></circle>' +
      '<circle class="dse-ctx-arc" cx="11" cy="11" r="' + this.R + '" fill="none" stroke="var(--dse-accent)" ' +
      'stroke-width="2.5" stroke-linecap="round" stroke-dasharray="' + C.toFixed(2) + '" stroke-dashoffset="' + C.toFixed(2) + '" ' +
      'transform="rotate(-90 11 11)"></circle></svg>';
    btn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); });
    // 位置：发送按钮左侧（ZCode 式：环挨着发送区）。发送按钮可能嵌在中间层
    // （如 right-xxx 容器），先向上找到属于 bar 的直接子级再插
    var sendBtn = bar.querySelector('[class*="sendButton"]');
    var ref = sendBtn;
    while (ref && ref.parentElement && ref.parentElement !== bar) ref = ref.parentElement;
    if (ref && ref.parentElement === bar) bar.insertBefore(btn, ref);
    else bar.appendChild(btn);
    return btn;
  },

  update: function (data) {
    var self = this;   // 必须在方法内捕获——裸 self 会解析到浏览器全局 window.self
    // 注意 used===0 的判定：早先用 `data.used ? data.used : data`，0 是 falsy
    // 会把整个对象当数字用、pct 算成 NaN（环报废）。现在按类型分流，0 正常走
    var isObj = !!data && typeof data === 'object';
    var used = isObj ? (Number(data.used) || 0) : (Number(data) || 0);
    this._last = used;
    this._data = isObj ? data : { used: used, input: used, cacheRead: 0, cacheCreate: 0, estSys: 0, estTool: 0, estMsg: used };
    var btn = document.getElementById('dse-ctx-ring') || this.inject();
    if (!btn) return;
    var limit = this.limit();
    var pct = Math.max(0, Math.min(100, used / limit * 100));
    var arc = btn.querySelector('.dse-ctx-arc');
    var C = 2 * Math.PI * this.R;
    if (arc) arc.setAttribute('stroke-dashoffset', (C * (1 - pct / 100)).toFixed(2));
    // 颜色分级：>90% 危险 / >70% 警告（与设置面板的 ctx 分级一致）
    arc.setAttribute('stroke', pct >= 90 ? '#f87171' : (pct >= 70 ? '#fbbf24' : 'var(--dse-accent)'));
    btn.style.display = DSE.config.get('demoCustom') ? 'inline-flex' : 'none';
    // 富信息悬浮面板替代原生 title
    btn.onmouseenter = function () { self.showPanel(); };
    btn.onmouseleave = function () { self.hidePanel(); };
    btn.onfocus = function () { self.showPanel(); };
    btn.onblur = function () { self.hidePanel(); };
  },

  /* ---------- 悬浮详情面板（ZCode 式：总量+进度条+构成+缓存命中率） ---------- */
  ensurePanel: function () {
    if (document.getElementById('dse-ctx-panel')) return document.getElementById('dse-ctx-panel');
    var p = document.createElement('div');
    p.id = 'dse-ctx-panel';
    p.style.cssText = 'position:fixed;z-index:99999;display:none;width:264px;box-sizing:border-box;' +
      'border-radius:14px;padding:14px 16px;font-size:12px;line-height:1.6;' +
      'box-shadow:0 12px 40px rgba(0,0,0,.35);backdrop-filter:blur(20px) saturate(160%);' +
      '-webkit-backdrop-filter:blur(20px) saturate(160%);pointer-events:none;';
    document.body.appendChild(p);
    return p;
  },

  paintPanel: function () {
    var d = this._data;
    var p = this.ensurePanel();
    if (!d) { p.style.display = 'none'; return; }
    var dark = document.body.classList.contains('dark');
    var bg = dark ? 'rgba(38,40,48,.92)' : 'rgba(255,255,255,.94)';
    var fg = dark ? '#e8eaef' : '#1d2129';
    var dim = dark ? 'rgba(232,234,239,.55)' : 'rgba(29,33,41,.55)';
    var line = dark ? 'rgba(255,255,255,.1)' : 'rgba(0,0,0,.08)';
    p.style.background = bg; p.style.color = fg;
    p.style.border = '1px solid ' + line;
    var limit = this.limit();
    var pct = Math.max(0, Math.min(100, d.used / limit * 100));
    // 构成占比（估算，归一到 100%）
    var estSum = Math.max(1, d.estSys + d.estTool + d.estMsg);
    var rows = [
      [DSE.t('消息'), d.estMsg],
      [DSE.t('系统提示词'), d.estSys],
      [DSE.t('系统工具'), d.estTool]
    ];
    var hit = (d.input + d.cacheRead + d.cacheCreate) > 0
      ? Math.round(d.cacheRead / (d.input + d.cacheRead + d.cacheCreate) * 1000) / 10 : 0;
    var html = '';
    // 标题行：左“上下文容量”，右当前模型名（响应里回的 model，权威）
    var modelName = d.model || (DSE.config.get('demoModel') || '').trim();
    html += '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:2px">' +
      '<span style="font-size:13px;font-weight:600">' + DSE.t('上下文容量') + '</span>' +
      (modelName ? '<span style="font-size:11px;opacity:.55;font-weight:400;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + Utils.escHtml(modelName) + '">' + Utils.escHtml(modelName) + '</span>' : '') +
      '</div>';
    html += '<div style="font-size:15px;font-weight:600;margin-bottom:8px">' + this.fmt(d.used) + '/' + this.fmt(limit) +
      '<span style="font-weight:400;font-size:12px;opacity:.75">（' + pct.toFixed(pct >= 10 ? 1 : 1) + '%）</span></div>';
    html += '<div style="height:6px;border-radius:3px;background:' + line + ';overflow:hidden;margin-bottom:10px">' +
      '<div style="height:100%;width:' + pct + '%;border-radius:3px;background:' +
      (pct >= 90 ? '#f87171' : (pct >= 70 ? '#fbbf24' : 'var(--dse-accent)')) + '"></div></div>';
    rows.forEach(function (r) {
      var pctRow = Math.round(r[1] / estSum * 1000) / 10;
      html += '<div style="display:flex;justify-content:space-between;padding:1px 0">' +
        '<span style="color:' + dim + '">' + r[0] + '</span><span>' + pctRow.toFixed(1) + '%</span></div>';
    });
    html += '<div style="border-top:1px solid ' + line + ';margin:8px 0 6px"></div>';
    html += '<div style="display:flex;justify-content:space-between"><span style="color:' + dim + '">' +
      DSE.t('平均缓存命中率') + '</span><span>' + hit.toFixed(1) + '%</span></div>';
    html += '<div style="color:' + dim + ';font-size:11px;margin-top:6px">' +
      DSE.t('总量与缓存命中率为接口 usage 精确值；构成占比按请求结构估算') + '</div>';
    p.innerHTML = html;
  },

  showPanel: function () {
    var p = this.ensurePanel();
    var btn = document.getElementById('dse-ctx-ring');
    if (!btn || !this._data) return;
    this.paintPanel();
    p.style.display = 'block';
    var r = btn.getBoundingClientRect();
    var ph = p.offsetHeight, pw = p.offsetWidth;
    var left = Math.max(8, Math.min(window.innerWidth - pw - 8, r.left + r.width / 2 - pw / 2));
    var top = r.top - ph - 8;
    if (top < 8) top = r.bottom + 8;
    p.style.left = left + 'px';
    p.style.top = top + 'px';
  },

  hidePanel: function () {
    var p = document.getElementById('dse-ctx-panel');
    if (p) p.style.display = 'none';
  },

  // 无数据时的占位载荷：圆圈常驻显示（用户要求），首次对话前显示 0%
  emptyData: function () {
    return { used: 0, input: 0, cacheRead: 0, cacheCreate: 0, estSys: 0, estTool: 0, estMsg: 0, model: '' };
  },

  init: function () {
    var self = this;
    Utils.onReady(function () {
      self.inject();
      DSE.on('ctx:api', function (p) { if (p && p.used > 0) self.update(p); });
      // 常驻显隐由总开关决定：关→隐藏；开→立刻显示（没数据时 0%），不必等
      // 首次对话——用户要求圆圈一直显示
      DSE.on('cfg:change', function (e) {
        if (e.path === 'demoCustom') {
          if (e.value) self.update(self._data || self.emptyData());
          else {
            var b = document.getElementById('dse-ctx-ring');
            if (b) b.style.display = 'none';
            self.hidePanel();
          }
        }
        if (e.path === 'demoCtxLimit' && self._data) { self.update(self._data); self.hidePanel(); }
      });
      // 工具条会随会话切换重建——保持圆圈在场。节流（带前缘）而非防抖：
      // 防抖会被连续 DOM 变动不断重置，重建后圆圈迟迟不出现
      new MutationObserver(Utils.throttle(function () {
        if (document.getElementById('dse-ctx-ring')) return;
        self.inject();
        // 用 _data（完整对象）重画——传 _last（数字）会走 update 的兜底分支，
        // 把构成估算数据清零；没有数据也要画（常驻 0%）
        self.update(self._data || self.emptyData());
      }, 100)).observe(document.body, { childList: true, subtree: true });
      // 首帧即显示（开着自定义模型时）
      self.update(self._data || self.emptyData());
    });
  }
};
DSE.modules.ctxRing = CtxRing;
