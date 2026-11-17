/* ============================================================
 * modules/demoapi：chat-demo 页 API 覆盖（端点 / Key / 模型，三项各自独立）
 *
 * 背景：官方 API demo（cdn.deepseek.com/chat-demo）把端点与模型写死
 * （api.deepseek.com/anthropic/v1 + deepseek-flash），Key 存在页面
 * localStorage。用户需要换模型、以及换模型提供方的端点。
 *
 * 做法：拦截发往 /anthropic/v1/messages 的请求，按配置改写三项，
 * **彼此独立、留空即不干预**：
 *   - demoEndpoint：替换请求 URL 的 base（官方默认
 *     https://api.deepseek.com/anthropic/v1；填到不含 /messages 为止）
 *   - demoKey：替换 x-api-key 请求头（空 = 用页面里填的官方 Key）
 *   - demoModel：替换 body.model（空 = 官方默认 deepseek-flash）
 * **请求体其余部分一律原样**——deepseek_* 服务端工具（联网搜索/读链接）、
 * 系统提示、thinking / safety_check / title 等私有字段全都不碰。
 *
 * 协议实测（2026-11-17，bundle 分析）：demo 用 Anthropic Messages API，
 * POST {base}/messages，头 x-api-key，SSE 流式。该 URL 模式只存在于
 * demo 页，主站（/api/v0/chat/completion）不受影响。
 *
 * 端点兼容性（如实说明）：
 *   - 换成 DeepSeek 的中转/镜像（同协议）→ 全部照旧，工具也照样工作；
 *   - 换成别家提供方 → 请求原样直达，deepseek_* 工具类型对方不认
 *     （报错或被忽略），且对方必须说 Anthropic 协议；OpenAI 协议的
 *     端点需要额外的协议翻译层（未做）。
 *   - 模型与工具在当前实现里是同一个请求发出的（服务端工具），详见
 *     代码注释与交付说明——解耦需要客户端 agent 桥接，未做。
 * ============================================================ */
var DemoApi = {
  KEYS: { endpoint: 'demoEndpoint', key: 'demoKey', model: 'demoModel' },
  DEFAULT_BASE: 'https://api.deepseek.com/anthropic/v1',
  // 模型输入建议（datalist），不限制手输
  HINTS: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-flash'],

  cfg: function (k) { return (DSE.config.get(this.KEYS[k]) || '').trim(); },
  base: function () { return this.cfg('endpoint').replace(/\/+$/, ''); },

  /* ---------- 请求改写：端点 / Key / 模型 ---------- */
  patchFetch: function () {
    var self = this;
    if (!window.fetch) return;
    var orig = window.fetch;
    window.fetch = function (input, init) {
      try {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        if (url.indexOf('/anthropic/v1/messages') !== -1) {
          var base = self.base(), key = self.cfg('key'), model = self.cfg('model');
          // 1) 端点：替换 base（已带 /messages 则原样用）
          if (base) url = /\/messages$/.test(base) ? base : base + '/messages';
          // 2) 请求头：x-api-key
          if (key && init && init.headers) {
            var h = {};
            for (var k in init.headers) if (Object.prototype.hasOwnProperty.call(init.headers, k)) h[k] = init.headers[k];
            h['x-api-key'] = key;
            init = Object.assign({}, init, { headers: h });
          }
          // 3) body.model（其余字段原样，含 tools 数组）
          if (model && init && typeof init.body === 'string') {
            var body = JSON.parse(init.body);
            if (body && body.model !== model) {
              body.model = model;
              init = Object.assign({}, init, { body: JSON.stringify(body) });
            }
          }
        }
      } catch (e) {}
      return orig.call(this, url, init);
    };
  },

  /* ---------- UI：注入官方设置弹窗（通用设置 tab 末尾） ---------- */
  injectUI: function () {
    var dlg = document.querySelector('[class*="dialogMain-"]');
    if (!dlg) return;
    var refRow = dlg.querySelector('[class*="cell-"][class*="row-"]');
    if (!refRow || !refRow.parentElement) return;
    var content = refRow.parentElement;
    if (content.querySelector('[data-dse-api-row]')) return;
    var pick = function (el, props) {
      var cs = getComputedStyle(el), o = {};
      props.forEach(function (p) { o[p] = cs[p]; });
      return o;
    };
    var refLabel = refRow.querySelector('[class*="label-"]') || refRow;
    var refCtrl = refRow.querySelector('button') || refRow;
    var labelCss = pick(refLabel, ['color', 'fontSize']);
    var ctrlCss = pick(refCtrl, ['backgroundColor', 'color']);
    var ctrlStyle = 'width:260px;height:36px;border:none;outline:none;border-radius:18px;padding:0 14px;' +
      'font-size:14px;background:' + (ctrlCss.backgroundColor || 'rgba(127,127,127,.18)') + ';' +
      'color:' + (ctrlCss.color || 'inherit');

    var self = this;
    var mkRow = function (labelText, cfgKey, placeholder, title, isPassword) {
      var row = document.createElement('div');
      row.setAttribute('data-dse-api-row', cfgKey);
      row.style.cssText = 'display:flex;align-items:center;gap:8px;min-height:60px;padding:12px 0;font-size:14px';
      var label = document.createElement('div');
      label.textContent = DSE.t(labelText);
      label.style.cssText = 'flex:1;font-size:' + (labelCss.fontSize || '14px') + ';color:' + (labelCss.color || 'inherit');
      var input = document.createElement('input');
      input.type = isPassword ? 'password' : 'text';
      if (cfgKey === 'model') input.setAttribute('list', 'dse-model-hints');
      input.placeholder = placeholder;
      input.value = self.cfg(cfgKey);
      input.title = title;
      input.style.cssText = ctrlStyle;
      input.addEventListener('input', function () {
        clearTimeout(input._dseT);
        var v = input.value.trim();
        input._dseT = setTimeout(function () { DSE.config.set(self.KEYS[cfgKey], v); }, 300);
      });
      input.addEventListener('blur', function () {
        clearTimeout(input._dseT);
        DSE.config.set(self.KEYS[cfgKey], input.value.trim());
      });
      row.appendChild(label);
      row.appendChild(input);
      return row;
    };

    content.appendChild(mkRow('API 端点', 'endpoint', DemoApi.DEFAULT_BASE,
      DSE.t('留空 = 官方 ' + DemoApi.DEFAULT_BASE + '。填模型提供方的 Anthropic 协议 base（不含 /messages）。注意：换走后 deepseek_* 工具对方不认')));
    content.appendChild(mkRow('API Key', 'key', DSE.t('（用页面里填的官方 Key）'),
      DSE.t('留空 = 用官方设置里填的 Key；填写则替换请求头 x-api-key'), true));
    content.appendChild(mkRow('模型', 'model', DSE.t('deepseek-flash（官方默认）'),
      DSE.t('留空 = 官方默认 deepseek-flash；只更换请求中的 model 字段')));

    if (!document.getElementById('dse-model-hints')) {
      var dl = document.createElement('datalist');
      dl.id = 'dse-model-hints';
      this.HINTS.forEach(function (m) {
        var o = document.createElement('option');
        o.value = m;
        dl.appendChild(o);
      });
      document.body.appendChild(dl);
    }
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
DSE.modules.demoApi = DemoApi;
