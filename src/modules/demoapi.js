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

  /* ---------- UI：注入官方设置弹窗（通用设置 tab 末尾） ---------- */
  injectUI: function () {
    var dlg = document.querySelector('[class*="dialogMain-"]');
    if (!dlg) return;
    // 锚点 = 当前可见的「通用设置最后一个分区」（主题/语言/朗读音色/位置信息，
    // 前缀匹配——位置信息行全文是"位置信息请选择省份/地区请选择市"）。
    // 要求可见：渲染中途/数据管理 tab 下通用分区是隐藏的，此时注入会落错位置
    var anchor = null;
    Array.prototype.forEach.call(dlg.querySelectorAll('[class*="cell-"]'), function (c) {
      var t = (c.textContent || '').replace(/\s/g, '');
      if (/^(主题|语言|朗读音色|位置信息)/.test(t) && c.offsetParent !== null) anchor = c;
    });
    var existing = dlg.querySelector('[data-dse-api-wrap]');
    if (!anchor) return;                       // 没有可见锚点：不注入（已有的留着，tab 同步会藏）
    if (existing) {
      // 位置自愈：React 重排（切 tab 等）会把外来节点挤到前面——不对就重注
      if (existing.isConnected && existing.previousElementSibling === anchor) return;
      existing.remove();
    }
    var refRow = anchor;
    var content = anchor.parentElement;
    if (!content) return;
    var pick = function (el, props) {
      var cs = getComputedStyle(el), o = {};
      props.forEach(function (p) { o[p] = cs[p]; });
      return o;
    };
    var refLabel = refRow.querySelector('[class*="label-"]') || refRow;
    var refCtrl = refRow.querySelector('button') || refRow;
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

    anchor.after(wrap);
    //  tab 同步：锚定行（语言）被隐藏说明当前在数据管理 tab → 连同我们的行一起藏。
    //  用锚定行可见性判断而非 tab 类名——不猜官方的隐藏机制
    // tab 同步：当前 DOM 里找不到「语言」行（或它被隐藏）说明在数据管理 tab
    // → 连同我们的行一起藏。每次重新查询——tab 切换时官方会移除/重建分区，
    // 持有旧引用会因元素 detached 而永远判断为“该藏”
    (function syncTab() {
      if (!wrap.isConnected) return;
      var lang = null;
      Array.prototype.forEach.call(dlg.querySelectorAll('[class*="cell-"]'), function (r) {
        if (lang) return;
        var t = (r.textContent || '').replace(/\s/g, '');
        if (t.indexOf('语言') !== -1 && t.length < 12) lang = r;
      });
      wrap.style.display = (!lang || lang.offsetParent === null) ? 'none' : '';
      setTimeout(syncTab, 400);
    })();
  },

  // demo 页左上角的应用名是纯文字“API 使用 demo”，与 DeepSeek 官方标识不一致。
  // 官方主站的标识是内联 SVG（鲸鱼 + DeepSeek 字标，143×23）——fe-static 上没有
  // 对应静态文件、只存在于主站 bundle，故以资源文件随脚本分发、构建时内联。
  // SVG 的 fill 用 var(--dsw-alias-brand-primary)，该变量由标识元素自身携带
  // （#5686fe，官方主站同款），整套 markup 原样可用、无需替换颜色
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
      // 应用名被重绘恢复成文字时也靠这里补
      new MutationObserver(Utils.debounce(function () {
        if (document.querySelector('[class*="dialogMain-"]')) self.injectUI();
        self.fixLogo();
      }, 300)).observe(document.body, { childList: true, subtree: true });
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
