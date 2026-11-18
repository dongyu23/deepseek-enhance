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
  KEYS: { endpoint: 'demoEndpoint', key: 'demoKey', model: 'demoModel', keyHeader: 'demoKeyHeader', bridge: 'demoBridge', ctxLimit: 'demoCtxLimit', toolMode: 'demoToolMode', titleSource: 'demoTitleSource' },
  DEFAULT_BASE: 'https://api.deepseek.com/anthropic/v1',
  // 模型输入建议（datalist），不限制手输
  HINTS: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-flash'],

  /* ---------- 附件正文捕获（file_id → 文本） ----------
   * 页面把文件 POST 到 /anthropic/v1/files，响应只回 {id,size_bytes,filename,
   * mime_type}——没有正文。而 DeepSeek 明确不支持下载：GET .../files/{id} 只回
   * 元数据，GET .../files/{id}/content 404（官方文档原话「上传的原始文件和解析
   * 结果都不支持下载」）。所以对话请求里的 document/file_id 块**只有 DeepSeek
   * 自己的模型认**，第三方模型收到就是死引用（StepFun 直接 400 input_invalid，
   * 且该 400 不带 CORS 头，浏览器只报 Failed to fetch）。
   * 但上传请求本身就经过这里，FormData 里躺着真正的 File——趁上传时把正文按
   * file_id 记下来，桥接再内联成文本块，附件就能在自定义模型下用了。
   * 只记能当文本读的（txt/md/csv/代码/日志…），且有长度上限；图片/PDF/Office
   * 记不下，桥接会换成一行说明，免得整条请求硬失败。 */
  FILE_TEXT_CAP: 100000,
  _fileTexts: {},
  _textExtRe: /\.(txt|md|csv|tsv|json|log|ya?ml|yml|ini|conf|cfg|html?|css|js|mjs|cjs|ts|tsx|jsx|py|go|java|c|cc|cpp|cxx|h|hpp|rs|rb|sh|bash|zsh|sql|xml|toml|dot|gv|proto|tex|bib|sty|cls|lisp|el|vim|r|lua|pl|pm|php|ps1|bat|cmd|awk|sed|make|mk|cmake|gradle|sbt|scala|kt|kts|swift|m|mm|dart|erl|hrl|ex|exs|clj|hs|lhs|ml|mli|fs|fsi|fsx|nim|cr|d|zig|v|sv|vhd|asm|s)$/i,

  captureFile: function (orig, selfArg, url, init) {
    var file = null, name = '', type = '';
    try {
      var b = init && init.body;
      if (b && typeof FormData !== 'undefined' && b instanceof FormData) {
        file = b.get('file');
        if (file) { name = file.name || ''; type = file.type || ''; }
      }
    } catch (e) {}
    if (!file) return orig.call(selfArg, url, init);
    return orig.call(selfArg, url, init).then(function (resp) {
      var bind = function (id) {
        if (!id) return;
        var rec = { name: name, type: type };
        DemoApi._fileTexts[id] = rec;
        // 只在开着自定义模型时值得存（官方端点下 document 块原生可用）
        if (!DSE.config.get('demoCustom')) return;
        var looksText = /^text\//.test(type) || DemoApi._textExtRe.test(name);
        if (!looksText) return;
        file.text().then(function (tx) {
          rec.truncated = tx.length > DemoApi.FILE_TEXT_CAP;
          rec.text = rec.truncated ? tx.slice(0, DemoApi.FILE_TEXT_CAP) : tx;
        }).catch(function () {});
      };
      try {
        resp.clone().json().then(function (j) { bind(j && j.id); }, function () {});
      } catch (e) {}
      return resp;
    });
  },

  // 注意：配置值不一定是字符串（如 demoCtxLimit 默认是数字 128000），
  // 直接 .trim() 会抛 TypeError 导致整个设置块注入失败
  cfg: function (k) {
    var v = DSE.config.get(this.KEYS[k]);
    return (v == null) ? '' : String(v);
  },
  base: function () { return this.cfg('endpoint').replace(/\/+$/, ''); },

  /* ---------- 请求改写：端点 / Key / 模型 ---------- */
  patchFetch: function () {
    var self = this;
    if (!window.fetch) return;
    var orig = window.fetch;
    DemoApi._origFetch = orig;   // 桥接的出站请求走原生 fetch，避开本补丁的 URL 改写（否则搜索腿会被改写到第三方端点）
    window.fetch = function (input, init) {
      try {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        // 附件上传：顺手记下 file_id → 正文（详见 captureFile 注释）。必须在
        // 下面的 /messages 分支之前——两者 URL 不重叠，顺序只为少一次判断
        if (url.indexOf('/anthropic/v1/files') !== -1 && init && init.method === 'POST') {
          return self.captureFile(orig, this, url, init);
        }
        // 总开关关闭 = 完全官方逻辑（端点/Key/模型/桥接全部不干预）
        if (url.indexOf('/anthropic/v1/messages') !== -1 && DSE.config.get('demoCustom')) {
          var base = self.base(), key = self.cfg('key'), model = self.cfg('model');
          // 页面原始 DeepSeek Key（供桥接的搜索腿使用，先于任何覆盖捕获）
          var origDsKey = (init && init.headers && (init.headers['x-api-key'] || init.headers['X-API-Key'] || init.headers['X-Api-Key'])) || '';
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
          // 4) 桥接：端点非 DeepSeek 时，工具执行拆成「客户端工具循环 +
          //    DeepSeek 极小搜索腿」，demo 侧呈现仍为原生块（见 demobridge.js）
          if (DSE.modules.demoBridge && DSE.modules.demoBridge.active()) {
            var bridged = DSE.modules.demoBridge.intercept(url, init, origDsKey);
            if (bridged) return bridged;
          }
        }
      } catch (e) {}
      return orig.call(this, url, init);
    };
  },

  /* ---------- UI：注入官方设置弹窗（独立「自定义模型」tab） ---------- */
  // 官方弹窗是左侧导航（通用设置/数据管理）+ 右侧内容容器的结构。我们把配置块
  // 收进自建的第三个 tab：导航按钮插进左侧 rail，配置块作为内容容器的直接子
  // 级（与原生行同为 flex 列子级，天然对齐）；tab 显隐自己管，不猜官方机制。
  // 导航按钮直接复制原生按钮的 className（含构建哈希——运行时复制，官方重建
  // 后自动跟随），激活态令牌从"激活/未激活"两个原生按钮的类名差里取。
  injectUI: function () {
    var dlg = document.querySelector('[class*="dialogMain-"]');
    if (!dlg) return;
    var self = this;
    // 导航 = 含「通用设置/数据管理」文字的按钮的父容器；内容容器 = rail 兄弟
    // 里那个 flex 列的容器（都不依赖哈希类名）
    var navBtns = Array.prototype.filter.call(dlg.querySelectorAll('button'), function (b) {
      var t = (b.textContent || '').replace(/\s/g, '');
      return t === '通用设置' || t === '数据管理';
    });
    if (!navBtns.length) return;
    var rail = navBtns[0].parentElement;
    var content = null;
    Array.prototype.forEach.call(rail.parentElement.children, function (c) {
      if (!content && c !== rail && getComputedStyle(c).flexDirection === 'column') content = c;
    });
    if (!content) return;
    // 锚点仍用于取官方行的计算样式（标签/控件配色）——弹窗默认开在通用设置，
    // 该行可见；取不到就不注入（样式对齐优先）
    var anchor = null;
    Array.prototype.forEach.call(dlg.querySelectorAll('[class*="cell-"]'), function (c) {
      var t = (c.textContent || '').replace(/\s/g, '');
      if (/^(主题|语言|朗读音色|位置信息)/.test(t) && c.offsetParent !== null) anchor = c;
    });
    if (!anchor) return;
    var existing = dlg.querySelector('[data-dse-api-wrap]');
    var navExisting = document.getElementById('dse-demo-tab');
    if (existing && navExisting && existing.parentElement === content) {
      if (this._tabCtl) this._tabCtl.sync();   // 已在位：只同步显隐状态
      return;
    }
    if (existing) existing.remove();
    if (navExisting) navExisting.remove();
    // 上次注入绑定的监听/观察器先摘掉，避免重复累积
    if (this._tabCtl) {
      try { this._tabCtl.mo.disconnect(); } catch (e) {}
      try { this._tabCtl.rail.removeEventListener('click', this._tabCtl.onNativeClick, true); } catch (e) {}
      this._tabCtl = null;
    }
    var pick = function (el, props) {
      var cs = getComputedStyle(el), o = {};
      props.forEach(function (p) { o[p] = cs[p]; });
      return o;
    };
    var refLabel = anchor.querySelector('[class*="label-"]') || anchor;
    var refCtrl = anchor.querySelector('button') || anchor;
    var labelCss = pick(refLabel, ['color', 'fontSize']);
    var ctrlCss = pick(refCtrl, ['backgroundColor', 'color']);
    // 注意 box-sizing：demo 的全局 reset 不覆盖注入节点，默认 content-box 会
    // 让 60px 的行变成 84px（padding 外加）——与官方行观感不一致
    var rowBase = 'display:flex;align-items:center;gap:8px;box-sizing:border-box;min-height:60px;padding:12px 0;font-size:14px';
    var ctrlStyle = 'box-sizing:border-box;width:240px;height:36px;border:none;outline:none;border-radius:18px;padding:0 14px;' +
      'font-size:14px;background:' + (ctrlCss.backgroundColor || 'rgba(127,127,127,.18)') + ';' +
      'color:' + (ctrlCss.color || 'inherit');
    var descStyle = 'box-sizing:border-box;font-size:12px;line-height:1.5;opacity:.55;padding:0 0 6px';

    var self = this;
    var mkRow = function (labelText, cfgKey, placeholder, title, isPassword, hints, listId) {
      var row = document.createElement('div');
      row.setAttribute('data-dse-api-row', cfgKey);
      row.style.cssText = rowBase;
      var label = document.createElement('div');
      label.textContent = DSE.t(labelText);
      label.style.cssText = 'flex:1;font-size:' + (labelCss.fontSize || '14px') + ';color:' + (labelCss.color || 'inherit');
      var input = document.createElement('input');
      input.type = isPassword ? 'password' : 'text';
      if (hints && listId) input.setAttribute('list', listId);
      else if (cfgKey === 'model') input.setAttribute('list', 'dse-model-hints');
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

    // 固定选项（鉴权头/桥接）用原生下拉，不用带 datalist 的文本框
    var CHEVRON = "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path d='M1 1l4 4 4-4' stroke='%23888' fill='none' stroke-width='1.5' stroke-linecap='round'/></svg>\")";
    var mkSelect = function (labelText, cfgKey, options, defVal, title) {
      var row = document.createElement('div');
      row.setAttribute('data-dse-api-row', cfgKey);
      row.style.cssText = rowBase;
      var label = document.createElement('div');
      label.textContent = DSE.t(labelText);
      label.style.cssText = 'flex:1;font-size:' + (labelCss.fontSize || '14px') + ';color:' + (labelCss.color || 'inherit');
      var sel = document.createElement('select');
      sel.title = title;
      sel.style.cssText = ctrlStyle + 'appearance:none;-webkit-appearance:none;cursor:pointer;' +
        'padding-right:32px;background-image:' + CHEVRON + ';background-repeat:no-repeat;background-position:right 12px center;';
      options.forEach(function (o) {
        var opt = document.createElement('option');
        opt.value = o[0]; opt.textContent = DSE.t(o[1]);
        sel.appendChild(opt);
      });
      sel.value = self.cfg(cfgKey) || defVal;
      sel.addEventListener('change', function () { DSE.config.set(self.KEYS[cfgKey], sel.value); });
      row.appendChild(label);
      row.appendChild(sel);
      return row;
    };

    var wrap = document.createElement('div');
    wrap.setAttribute('data-dse-api-wrap', '1');

    // 主开关：关=完全官方逻辑（DeepSeek 全套）；开=才允许自定义
    var swRow = document.createElement('div');
    swRow.setAttribute('data-dse-api-row', 'custom');
    swRow.style.cssText = rowBase + 'cursor:pointer;user-select:none';
    var swLabel = document.createElement('div');
    swLabel.textContent = DSE.t('自定义模型');
    swLabel.style.cssText = 'flex:1;font-size:' + (labelCss.fontSize || '14px') + ';color:' + (labelCss.color || 'inherit');
    var swTrack = document.createElement('div');
    var swKnob = document.createElement('div');
    swTrack.style.cssText = 'width:44px;height:26px;border-radius:13px;position:relative;transition:background .15s;flex:0 0 auto';
    swKnob.style.cssText = 'position:absolute;top:2px;left:2px;width:22px;height:22px;border-radius:50%;background:#fff;transition:left .15s;box-shadow:0 1px 3px rgba(0,0,0,.3)';
    swTrack.appendChild(swKnob);
    var cfgBox = document.createElement('div');
    cfgBox.setAttribute('data-dse-cfg-box', '1');
    var paintSw = function (on) {
      var accent = getComputedStyle(document.documentElement).getPropertyValue('--dse-accent').trim() || '#3b6cf6';
      swTrack.style.background = on ? accent : 'rgba(127,127,127,.35)';
      swKnob.style.left = on ? '20px' : '2px';
      cfgBox.style.display = on ? 'block' : 'none';
    };
    swRow.addEventListener('click', function () {
      var v = !DSE.config.get('demoCustom');
      DSE.config.set('demoCustom', v);
      paintSw(v);
    });
    paintSw(!!DSE.config.get('demoCustom'));
    swRow.appendChild(swLabel); swRow.appendChild(swTrack);
    wrap.appendChild(swRow);
    wrap.appendChild(cfgBox);

    // 行+可见描述行的包装。注意：这是 var 函数表达式，定义必须在所有调用
    // 之前——早前端点/Key 行在定义之前调用，执行时 withDesc 还是 undefined，
    // TypeError 让整个 injectUI 中断、设置块整体不注入（实机抓到）
    var withDesc = function (row, desc) {
      var d = document.createElement('div');
      d.style.cssText = descStyle;
      d.textContent = DSE.t(desc);
      var box = document.createElement('div');
      box.appendChild(row); box.appendChild(d);
      return box;
    };

    // 布尔开关行（与主开关同款样式）——供高级选项里的布尔配置用
    var mkSwitch = function (labelText, cfgKey, desc) {
      var row = document.createElement('div');
      row.setAttribute('data-dse-api-row', cfgKey);
      row.style.cssText = rowBase + 'cursor:pointer;user-select:none';
      var label = document.createElement('div');
      label.textContent = DSE.t(labelText);
      label.style.cssText = 'flex:1;font-size:' + (labelCss.fontSize || '14px') + ';color:' + (labelCss.color || 'inherit');
      var track = document.createElement('div');
      var knob = document.createElement('div');
      track.style.cssText = swTrack.style.cssText;
      knob.style.cssText = swKnob.style.cssText;
      track.appendChild(knob);
      var paint = function (on) {
        var accent = getComputedStyle(document.documentElement).getPropertyValue('--dse-accent').trim() || '#3b6cf6';
        track.style.background = on ? accent : 'rgba(127,127,127,.35)';
        knob.style.left = on ? '20px' : '2px';
      };
      row.addEventListener('click', function () {
        var v = !DSE.config.get(self.KEYS[cfgKey]);
        DSE.config.set(self.KEYS[cfgKey], v);
        paint(!!v);
      });
      paint(!!DSE.config.get(self.KEYS[cfgKey]));
      row.appendChild(label); row.appendChild(track);
      return desc ? withDesc(row, desc) : row;
    };

    // 端点/Key 两行的说明较长，既放可见描述行（withDesc），也放输入框
    // hover 提示（title），两处共用同一字符串
    var ENDPOINT_DESC = DSE.t('只填消息接口地址：到 /messages 为止，不要包含 /messages 本身（例：https://api.stepfun.com/step_plan/v1）。留空 = 官方 ' + DemoApi.DEFAULT_BASE);
    var KEY_DESC = DSE.t('留空 = 用官方设置里填的 Key；填写则替换请求头 x-api-key');
    cfgBox.appendChild(withDesc(mkRow('API 端点', 'endpoint', DemoApi.DEFAULT_BASE, ENDPOINT_DESC), ENDPOINT_DESC));
    cfgBox.appendChild(withDesc(mkRow('API Key', 'key', DSE.t('（用页面里填的官方 Key）'), KEY_DESC, true), KEY_DESC));
    cfgBox.appendChild(mkRow('模型', 'model', DSE.t('deepseek-flash（官方默认）'),
      DSE.t('留空 = 官方默认 deepseek-flash；只更换请求中的 model 字段'), false, DemoApi.HINTS, 'dse-model-hints'));
    // 模型测试：一发极小请求验证端点/Key/模型是否可用，并让模型自述身份——
    // DeepSeek 会答"我是DeepSeek"，第三方模型会答出自己的真实身份，用户据此
    // 确认切换真的生效了
    var testRow = document.createElement('div');
    testRow.setAttribute('data-dse-api-row', 'test');
    testRow.style.cssText = rowBase;
    var testLabel = document.createElement('div');
    testLabel.textContent = DSE.t('测试连接与模型身份');
    testLabel.style.cssText = 'flex:1;font-size:' + (labelCss.fontSize || '14px') + ';color:' + (labelCss.color || 'inherit');
    var testBtn = document.createElement('button');
    testBtn.type = 'button';
    testBtn.textContent = DSE.t('测试');
    var accent = getComputedStyle(document.documentElement).getPropertyValue('--dse-accent').trim() || '#3b6cf6';
    testBtn.style.cssText = 'box-sizing:border-box;height:36px;border:none;outline:none;cursor:pointer;' +
      'border-radius:18px;padding:0 20px;font-size:14px;background:' + accent + ';color:#fff;flex:0 0 auto';
    var testResult = document.createElement('div');
    testResult.setAttribute('data-dse-test-result', '1');
    testResult.style.cssText = 'display:none;box-sizing:border-box;font-size:12px;line-height:1.6;padding:2px 0 8px;white-space:pre-wrap;word-break:break-all';
    testBtn.addEventListener('click', function () {
      testResult.style.display = 'block';
      testResult.style.color = 'inherit';
      testResult.textContent = DSE.t('测试中…');
      var t0 = Date.now();
      var base = self.base() || DemoApi.DEFAULT_BASE;
      var u = /\/messages$/.test(base) ? base : base.replace(/\/+$/, '') + '/messages';
      var model = (DSE.config.get('demoModel') || '').trim() || 'deepseek-flash';
      // Key：覆盖值优先；否则取页面里填的官方 Key（demo 存于 localStorage）
      var key = (DSE.config.get('demoKey') || '').trim();
      if (!key) { try { key = localStorage.getItem('chat-demo:api-key') || ''; } catch (e) {} }
      var headers = { 'Content-Type': 'application/json' };
      if (key) {
        if ((DSE.config.get('demoKeyHeader') || 'x-api-key') === 'authorization') headers['Authorization'] = 'Bearer ' + key;
        else headers['x-api-key'] = key;
      }
      (DemoApi._origFetch || window.fetch)(u, {
        method: 'POST', headers: headers,
        body: JSON.stringify({
          model: model, max_tokens: 1024, thinking: { type: 'disabled' },
          messages: [{ role: 'user', content: DSE.t('你是什么AI模型？请用一句话直接说明你的模型名称和开发方，不要复述这个问题。') }]
        })
      }).then(function (resp) {
        var ms = Date.now() - t0;
        if (!resp.ok) {
          return resp.text().then(function (t) {
            var m = t; try { var j = JSON.parse(t); m = (j.error && j.error.message) || t; } catch (e) {}
            testResult.style.color = '#f87171';
            testResult.textContent = '❌ ' + DSE.t('连接失败') + '（HTTP ' + resp.status + '，' + ms + 'ms）\n' + String(m).slice(0, 200);
          });
        }
        return resp.json().then(function (j) {
          var txt = (j.content || []).filter(function (b) { return b.type === 'text'; })
            .map(function (b) { return b.text || ''; }).join('').trim();
          testResult.style.color = '#4ade80';
          testResult.textContent = '✅ ' + DSE.t('连接成功') + '（' + ms + 'ms）· ' + DSE.t('模型') + '：' + (j.model || model) +
            '\n' + DSE.t('模型自述') + '：' + (txt ||
            (DSE.t('（未获得文本回复') + '，stop_reason=' + (j.stop_reason || '?') + '，内容块=' + (j.content || []).map(function (b) { return b.type; }).join(',') + '）'));
        });
      }).catch(function (e) {
        testResult.style.color = '#f87171';
        var hint = (e && e.name === 'TypeError') ? DSE.t('（浏览器安全策略拦截了跨域请求，可在高级选项切换鉴权头试试）') : '';
        testResult.textContent = '❌ ' + DSE.t('请求失败') + '：' + String(e && e.message || e).slice(0, 150) + hint;
      });
    });
    testRow.appendChild(testLabel); testRow.appendChild(testBtn);
    cfgBox.appendChild(testRow);
    cfgBox.appendChild(testResult);

    // 高级选项：默认折叠，配人话说明（这两个是排障开关，不是常规配置）
    var advToggle = document.createElement('div');
    advToggle.setAttribute('data-dse-api-row', 'advanced');
    advToggle.style.cssText = rowBase + 'cursor:pointer;user-select:none';
    var advLabel = document.createElement('div');
    advLabel.textContent = DSE.t('高级选项');
    advLabel.style.cssText = 'flex:1;font-size:' + (labelCss.fontSize || '14px') + ';color:' + (labelCss.color || 'inherit');
    var advArrow = document.createElement('span');
    advArrow.textContent = '⌄';
    advArrow.style.cssText = 'transition:transform .15s;opacity:.6;font-size:16px;width:24px;text-align:center';
    advToggle.appendChild(advLabel); advToggle.appendChild(advArrow);
    var advBox = document.createElement('div');
    advBox.setAttribute('data-dse-advanced', '1');
    advBox.style.display = 'none';
    advToggle.addEventListener('click', function () {
      var open = advBox.style.display !== 'none';
      advBox.style.display = open ? 'none' : 'block';
      advArrow.style.transform = open ? '' : 'rotate(180deg)';
    });
    // 工具调用方式：选项文本已自明（native：模型自己搜 / searchapi：只付搜索费），
    // 可见描述行给一句人话结论，完整差异（计费/能力）放 hover 提示
    var TOOLMODE_TITLE = DSE.t('模型要搜索时，谁来执行：native=交给 DeepSeek 的模型在对话里完成，能多轮搜、能读网页，但每轮搜索另付约 2 分钱模型费；searchapi=直接调 DeepSeek 的搜索接口，一次约 0.00075 美元、不经模型，搜什么由当前模型决定。两种在界面上看起来一样');
    var TOOLMODE_DESC = DSE.t('模型要搜索时谁来执行：native=DeepSeek 的模型自己搜，另付约 2 分钱/轮模型费；searchapi=直调搜索接口，每次约 0.00075 美元、不经模型');
    advBox.appendChild(withDesc(mkSelect('工具调用方式', 'toolMode',
      [['native', 'native：模型自己搜'], ['searchapi', 'searchapi：只付搜索费']], 'native', TOOLMODE_TITLE), TOOLMODE_DESC));
    // 起名来源：官方页的 title 通道第三方端点没有，用一条极小腿补。来源三选一
    // ——deepseek=官方端点起名腿（title 参数、约 $0.001/次、标题质量官方级）；
    // model=当前自定义模型按提示词起名（费用走当前端点、不经 DeepSeek）；
    // off=不起名（首条消息截断）。任一来源失败都退回首条消息截断
    var TITLE_SOURCE_TITLE = DSE.t('新对话首轮回答后生成会话标题的来源：deepseek=打 DeepSeek 官方端点用 title 参数起名（约 $0.001/次、标题质量官方级、用页面里那把 DeepSeek Key）；model=让当前自定义模型按提示词起名（一次极小非流式请求、费用走当前端点、不经 DeepSeek）；off=不起名，用首条消息截断。任一来源失败都退回首条消息截断');
    var TITLE_SOURCE_DESC = DSE.t('deepseek：官方起名腿，约 $0.001/次；model：自定义模型起名，费用走当前端点；off：用首条消息截断');
    advBox.appendChild(withDesc(mkSelect('起名来源', 'titleSource',
      [['deepseek', 'deepseek：官方起名腿'], ['model', 'model：自定义模型起名'], ['off', 'off：用首条消息截断']], 'deepseek', TITLE_SOURCE_TITLE), TITLE_SOURCE_DESC));
    advBox.appendChild(withDesc(mkRow('上下文窗口', 'ctxLimit', '128000',
      DSE.t('所用模型的上下文窗口（tokens）。输入框旁的圆圈按 占用/窗口 显示百分比'), false, null, null),
      DSE.t('所用模型的上下文窗口（tokens）。输入框旁的圆圈按 占用/窗口 显示百分比')));
    advBox.appendChild(withDesc(mkSelect('Key 请求头', 'keyHeader',
      [['x-api-key', 'x-api-key（默认）'], ['authorization', 'authorization（Bearer）']], 'x-api-key'),
      '个别网站（如 StepFun）的浏览器安全策略只认 Authorization 请求头，连不上时改选 authorization'));
    advBox.appendChild(withDesc(mkSelect('搜索来源', 'bridge',
      [['auto', 'auto：DeepSeek 原生搜索'], ['off', 'off：用模型自带的']], 'auto'),
      'auto=换第三方模型时，搜索仍由 DeepSeek 原生执行、界面原样呈现（推荐）；off=完全使用第三方自己的能力（多数没有搜索）'));
    cfgBox.appendChild(advToggle);
    cfgBox.appendChild(advBox);

    var mkList = function (id, items) {
      if (document.getElementById(id)) return;
      var dl = document.createElement('datalist');
      dl.id = id;
      items.forEach(function (m) {
        var o = document.createElement('option');
        o.value = m;
        dl.appendChild(o);
      });
      document.body.appendChild(dl);
    };
    mkList('dse-model-hints', this.HINTS);

    // 配置块作为内容容器的直接子级（与原生行同列，天然对齐）
    content.appendChild(wrap);

    /* ---------- 自建「自定义模型」tab ---------- */
    // 导航按钮复制原生按钮的 className（构建哈希运行时复制，官方重建自动跟随）；
    // 激活态令牌 = 激活按钮与未激活按钮类名差集里的那一项
    var refNav = navBtns.filter(function (b) { return !/Active/.test(b.className); })[0] || navBtns[0];
    var activeItem = navBtns.filter(function (b) { return /Active/.test(b.className); })[0] || null;
    var activeToken = null;
    if (activeItem && activeItem !== refNav) {
      var at = activeItem.className.split(/\s+/), it = refNav.className.split(/\s+/);
      activeToken = at.filter(function (t) { return t && it.indexOf(t) === -1; })[0] || null;
    }
    var nav = document.createElement('button');
    nav.id = 'dse-demo-tab';
    nav.type = 'button';
    nav.className = refNav.className;
    var navIco = document.createElement('span');
    navIco.style.cssText = 'display:inline-flex;flex:0 0 auto';
    navIco.innerHTML = this.ICON_TAB;
    nav.appendChild(navIco);
    nav.appendChild(document.createTextNode(DSE.t('自定义模型')));
    rail.appendChild(nav);

    var applyState = function (on) {
      if (activeToken) {
        nav.classList.toggle(activeToken, !!on);
        // 只夺不还：原生 tab 的激活态由 React 自己管，我们开机时从原生激活项
        // 手上摘掉令牌即可；点回原生 tab 时 React 会重新打上
        if (on && activeItem) activeItem.classList.remove(activeToken);
      }
      Array.prototype.forEach.call(content.children, function (c) {
        if (c === wrap) c.style.display = on ? '' : 'none';
        else c.style.display = on ? 'none' : '';
      });
    };
    // 我们的 tab 被点 → 藏原生行、显示配置块
    nav.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); applyState(true); });
    // 原生 tab 被点（capture 先行于 React 处理器）→ 回到原生显隐
    var onNativeClick = function (e) {
      if (e.target === nav || (nav.contains && nav.contains(e.target))) return;
      applyState(false);
    };
    rail.addEventListener('click', onNativeClick, true);
    // React 重换内容子级时（重渲染/切 tab），我们的 tab 开着就立刻重新藏原生行
    var mo = new MutationObserver(function () { if (ctl.on) applyState(true); });
    mo.observe(content, { childList: true });
    var ctl = { rail: rail, content: content, nav: nav, wrap: wrap, mo: mo, onNativeClick: onNativeClick, on: false,
      sync: function () { if (ctl.on) applyState(true); } };
    this._tabCtl = ctl;
    applyState(false);
  },

  // demo 页左上角的应用名是纯文字“API 使用 demo”，与 DeepSeek 官方标识不一致。
  // 官方主站的标识是内联 SVG（鲸鱼 + DeepSeek 字标，143×23）——fe-static 上没有
  // 对应静态文件、只存在于主站 bundle，故以资源文件随脚本分发、构建时内联。
  // SVG 的 fill 用 var(--dsw-alias-brand-primary)，该变量由标识元素自身携带
  // （#5686fe，官方主站同款），整套 markup 原样可用、无需替换颜色

  // 自建 tab 的图标：官方「深度思考」原子图标（viewBox 0 0 14 14，原样提取），
  // 渲染 16x16 与导航栏其他图标对齐
  ICON_TAB: '<svg width="16" height="16" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M7.06431 5.93342C7.68763 5.93342 8.19307 6.43904 8.19322 7.06233C8.19322 7.68573 7.68772 8.19123 7.06431 8.19123C6.44099 8.19113 5.9354 7.68567 5.9354 7.06233C5.93555 6.43911 6.44108 5.93353 7.06431 5.93342Z" fill="currentColor"></path>' +
    '<path fill-rule="evenodd" clip-rule="evenodd" d="M8.6815 0.963693C10.1169 0.447019 11.6266 0.374829 12.5633 1.31135C13.5 2.24805 13.4277 3.75776 12.911 5.19319C12.7126 5.74431 12.4386 6.31796 12.0965 6.89729C12.4969 7.54638 12.8141 8.19018 13.036 8.80647C13.5527 10.2419 13.6251 11.7516 12.6883 12.6883C11.7516 13.625 10.242 13.5527 8.8065 13.036C8.19022 12.8141 7.54641 12.4969 6.89732 12.0965C6.31797 12.4386 5.74435 12.7125 5.19322 12.911C3.75777 13.4276 2.2481 13.5 1.31138 12.5633C0.374859 11.6266 0.447049 10.1168 0.963724 8.68147C1.17185 8.10338 1.46321 7.50063 1.82896 6.8924C1.52182 6.35711 1.27235 5.82825 1.08872 5.31819C0.572068 3.88278 0.499714 2.37306 1.43638 1.43635C2.37308 0.499655 3.8828 0.572044 5.31822 1.08869C5.82828 1.27232 6.35715 1.5218 6.89243 1.82893C7.50066 1.46318 8.10341 1.17181 8.6815 0.963693ZM11.3573 8.01154C10.9083 8.62253 10.3901 9.22873 9.80943 9.8094C9.22877 10.3901 8.62255 10.9083 8.01158 11.3572C8.4257 11.5841 8.8287 11.7688 9.21275 11.9071C10.5456 12.3868 11.4246 12.2547 11.8397 11.8397C12.2548 11.4246 12.3869 10.5456 11.9071 9.21272C11.7688 8.82866 11.5841 8.42568 11.3573 8.01154ZM2.56529 8.02912C2.37344 8.39322 2.21495 8.74796 2.09263 9.08772C1.61291 10.4204 1.74512 11.2995 2.16001 11.7147C2.57505 12.1297 3.45415 12.2618 4.78697 11.7821C5.11057 11.6656 5.44786 11.5164 5.7938 11.3367C5.249 10.9223 4.70922 10.4533 4.19029 9.9344C3.57578 9.31987 3.03169 8.67633 2.56529 8.02912ZM6.90708 3.2469C6.24065 3.70479 5.5646 4.26321 4.91392 4.91389C4.26325 5.56456 3.70482 6.24063 3.24693 6.90705C3.72674 7.63325 4.32777 8.37459 5.03892 9.08576C5.64943 9.69627 6.28183 10.2265 6.90806 10.6678C7.59368 10.2025 8.2908 9.63076 8.96079 8.96076C9.6308 8.29075 10.2025 7.59366 10.6678 6.90803C10.2265 6.2818 9.69631 5.6494 9.08579 5.03889C8.37462 4.32773 7.63328 3.72672 6.90708 3.2469ZM11.7147 2.15998C11.2996 1.74509 10.4204 1.61288 9.08775 2.0926C8.74835 2.21479 8.39382 2.37271 8.03013 2.56428C8.67728 3.03065 9.31995 3.5758 9.93443 4.19026C10.4534 4.7092 10.9223 5.24896 11.3368 5.79377C11.5164 5.44785 11.6656 5.11052 11.7821 4.78694C12.2618 3.45416 12.1297 2.57502 11.7147 2.15998ZM4.91197 2.2176C3.57922 1.73788 2.70004 1.86995 2.28501 2.28498C1.87001 2.70003 1.73791 3.5792 2.21763 4.91194C2.31709 5.18822 2.44112 5.47427 2.58677 5.7674C3.01931 5.1887 3.51474 4.6158 4.06529 4.06526C4.61584 3.5147 5.18872 3.01928 5.76743 2.58674C5.47431 2.4411 5.18824 2.31706 4.91197 2.2176Z" fill="currentColor"></path></svg>',
  OFFICIAL_LOGO: '__DSE_LOGO_SVG__',

  fixLogo: function () {
    if (location.hostname !== 'cdn.deepseek.com') return;
    if (document.querySelector('[data-dse-logo]')) return;    // 已替换
    // 按文本找应用名元素——类名是 bundle 哈希会变，页面自己的文本稳定
    var el = null;
    Array.prototype.forEach.call(document.querySelectorAll('div,span,a'), function (n) {
      if (el || n.children.length) return;
      if ((n.textContent || '').trim() !== 'API 使用 demo') return;
      if (n.offsetParent === null) return;                    // 只要可见的那个
      el = n;
    });
    if (!el) return;
    el.textContent = '';
    var host = document.createElement('span');
    host.setAttribute('data-dse-logo', '1');
    // 与官方一致：品牌色变量随标识自身携带；inline-flex + line-height:0 消除
    // 行内 SVG 的基线间隙
    host.style.cssText = '--dsw-alias-brand-primary:#5686fe;display:inline-flex;line-height:0;vertical-align:middle';
    host.innerHTML = this.OFFICIAL_LOGO;
    el.appendChild(host);
  },

  init: function () {
    var self = this;
    this.patchFetch();
    this.fixFavicon();
    Utils.onReady(function () {
      self.injectUI();
      self.fixLogo();      // 应用名可能还没被 React 渲染出来——下面的 observer 会补
      // 弹窗是 React 组件，开合/切 tab 会重建 DOM——有弹窗时才补注入；
      // 应用名被重绘恢复成文字时也靠这里补。
      // 用节流（带前缘）而非防抖：防抖在弹窗打开时会因 React 连续变 DOM 而
      // 不断重置计时，注入要等变动停 300ms 才发生（实测开弹窗到 tab 出现
      // ~310ms，反复开尤其明显）；节流前缘让弹窗 DOM 一就绪就注入，尾部再补
      // 一次兜底。已注入时 injectUI 是几个 querySelector 的早退，代价可忽略
      new MutationObserver(Utils.throttle(function () {
        if (document.querySelector('[class*="dialogMain-"]')) self.injectUI();
        self.fixLogo();
      }, 100)).observe(document.body, { childList: true, subtree: true });
    });
  },

  // demo 页（cdn.deepseek.com/chat-demo）的 head 里没有任何 favicon 声明，
  // 所在主机也没有 /favicon.ico（实测 404），浏览器只能显示默认空白图标。
  // 官方主站声明的是 fe-static.deepseek.com/chat/favicon.svg（鲸鱼）——
  // 照搬同一份官方资源，不自己画图标
  fixFavicon: function () {
    if (location.hostname !== 'cdn.deepseek.com') return;
    if (document.querySelector('link[rel*="icon"]')) return;   // 页面自己有时不干预
    var link = document.createElement('link');
    link.rel = 'icon';
    link.type = 'image/x-icon';
    link.href = 'https://fe-static.deepseek.com/chat/favicon.svg';
    (document.head || document.documentElement).appendChild(link);
  }
};
DSE.modules.demoApi = DemoApi;
