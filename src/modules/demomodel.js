/* ============================================================
 * modules/demomodel：chat-demo 页模型切换（最小实现：只换 model 字段）
 *
 * 背景：官方 API demo（cdn.deepseek.com/chat-demo）把模型写死为
 * deepseek-flash，界面没有模型选择器。用户需要在官方壳子里换模型
 * （deepseek-chat / deepseek-reasoner / 未来的新模型）。
 *
 * 本模块只做一件事：拦截发往 /anthropic/v1/messages 的请求，把 body
 * 里的 model 换成配置值。**其余一律原样**——端点、x-api-key、
 * deepseek_* 服务端工具（联网搜索/读链接）、系统提示、thinking /
 * safety_check / title 等私有字段全都不碰。配置为空时完全不动。
 *
 * 配置入口：注入到官方设置弹窗（通用设置 tab）末尾的“模型”行，
 * 只追加 DOM、不改动弹窗原有节点；样式按注入时刻的现有设置行计算值
 * 镜像（跟随明暗主题）。
 *
 * 协议实测（2026-11-17，bundle 分析）：demo 用 Anthropic Messages API，
 * POST {api.deepseek.com}/anthropic/v1/messages，头 x-api-key，SSE 流式。
 * 该 URL 模式只存在于 demo 页，主站（/api/v0/chat/completion）不受影响。
 * ============================================================ */
var DemoModel = {
  KEY: 'demoModel',
  // 仅作输入建议（datalist），不限制手输；官方默认值写死在 bundle 里
  HINTS: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-flash'],

  // 当前配置的模型（空 = 不干预，用官方默认）
  model: function () {
    return (DSE.config.get(this.KEY) || '').trim();
  },

  /* ---------- 请求改写：只换 model 字段 ---------- */
  patchFetch: function () {
    var self = this;
    if (!window.fetch) return;
    var orig = window.fetch;
    window.fetch = function (input, init) {
      try {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        var model = self.model();
        if (model && url.indexOf('/anthropic/v1/messages') !== -1 &&
            init && typeof init.body === 'string') {
          var body = JSON.parse(init.body);
          if (body && body.model !== model) {
            body.model = model;
            var next = {};
            for (var k in init) if (Object.prototype.hasOwnProperty.call(init, k)) next[k] = init[k];
            next.body = JSON.stringify(body);
            init = next;
          }
        }
      } catch (e) {}
      return orig.call(this, input, init);
    };
  },

  /* ---------- UI：注入官方设置弹窗的“模型”行 ---------- */
  injectUI: function () {
    var dlg = document.querySelector('[class*="dialogMain-"]');
    if (!dlg) return;
    var refRow = dlg.querySelector('[class*="cell-"][class*="row-"]');
    if (!refRow || !refRow.parentElement) return;
    var content = refRow.parentElement;
    if (content.querySelector('[data-dse-model-row]')) return;
    var pick = function (el, props) {
      var cs = getComputedStyle(el), o = {};
      props.forEach(function (p) { o[p] = cs[p]; });
      return o;
    };
    var refLabel = refRow.querySelector('[class*="label-"]') || refRow;
    var refCtrl = refRow.querySelector('button') || refRow;
    var rowCss = pick(refRow, ['color', 'fontSize']);
    var labelCss = pick(refLabel, ['color', 'fontSize']);
    var ctrlCss = pick(refCtrl, ['backgroundColor', 'color']);

    var row = document.createElement('div');
    row.setAttribute('data-dse-model-row', '1');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;min-height:60px;padding:12px 0;' +
      'font-size:' + (rowCss.fontSize || '14px') + ';color:' + (rowCss.color || 'inherit');

    var label = document.createElement('div');
    label.textContent = DSE.t('模型');
    label.style.cssText = 'flex:1;font-size:' + (labelCss.fontSize || '14px') + ';color:' + (labelCss.color || 'inherit');

    var input = document.createElement('input');
    input.type = 'text';
    input.setAttribute('data-dse-model-input', '1');
    input.setAttribute('list', 'dse-model-hints');
    input.placeholder = DSE.t('deepseek-flash（官方默认）');
    input.value = this.model();
    input.title = DSE.t('留空 = 官方默认 deepseek-flash；只更换请求中的 model 字段，端点 / Key / 工具一律不变');
    input.style.cssText = 'width:200px;height:36px;border:none;outline:none;border-radius:18px;' +
      'padding:0 14px;font-size:14px;background:' + (ctrlCss.backgroundColor || 'rgba(127,127,127,.18)') + ';' +
      'color:' + (ctrlCss.color || 'inherit');
    input.addEventListener('input', function () {
      clearTimeout(input._dseT);
      var v = input.value.trim();
      input._dseT = setTimeout(function () { DSE.config.set(DemoModel.KEY, v); }, 300);
    });
    // 失焦即落库，避免只改不看
    input.addEventListener('blur', function () {
      clearTimeout(input._dseT);
      DSE.config.set(DemoModel.KEY, input.value.trim());
    });

    var dl = document.createElement('datalist');
    dl.id = 'dse-model-hints';
    this.HINTS.forEach(function (m) {
      var o = document.createElement('option');
      o.value = m;
      dl.appendChild(o);
    });

    row.appendChild(label);
    row.appendChild(input);
    content.appendChild(row);
    if (!document.getElementById('dse-model-hints')) document.body.appendChild(dl);
  },

  init: function () {
    var self = this;
    this.patchFetch();
    Utils.onReady(function () {
      self.injectUI();
      // 弹窗是 React 组件，开合/切 tab 会重建 DOM——有弹窗时才补注入
      new MutationObserver(Utils.debounce(function () {
        if (document.querySelector('[class*="dialogMain-"]')) self.injectUI();
      }, 300)).observe(document.body, { childList: true, subtree: true });
    });
  }
};
DSE.modules.demoModel = DemoModel;
