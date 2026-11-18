/* ============================================================
 * modules/demobridge：chat-demo 换模型时的「原生工具桥接」
 *
 * 背景：demo 把端点/模型写死（api.deepseek.com + deepseek-flash），工具
 * （deepseek_web_search / deepseek_read_url）是 DeepSeek 服务端工具，
 * 与模型调用同在一个请求里。换成第三方端点后，第三方不认这些私有工具
 * 类型——于是把工具执行拆成「客户端工具循环」：
 *
 *   1. 出站改写（打第三方端点）：剥 DeepSeek 私有字段（tools/safety_check/
 *      title/thinking）、latest_reminder 私有角色折叠进 system、声明标准
 *      客户端工具（web_search/read_url）、system 追加工具使用规程；
 *   2. 第三方模型吐 tool_use → 用一次【极小请求】打 DeepSeek 官方端点
 *      （thinking enabled + 原生双工具声明，无历史无 system）→ DeepSeek
 *      后端原生执行深度搜索/读网页 → 原样剥出 server_tool_use /
 *      web_search_tool_result / web_fetch_tool_result / thinking 块；
 *   3. 这些块【原样转发】给 demo（id 天然满足 demo 的 id===tool_use_id
 *      硬约束，呈现 100% 原生）；腿产出的调研报告浓缩成 tool_result
 *      喂回第三方模型；
 *   4. 循环至模型不再调工具，合成 message_delta/message_stop
 *      收尾；最终轮文本实时流式转发（保原生打字机效果）；
 *   5. 会话起名：demo 官方行为是请求带 title:{enabled:true}、服务端在
 *      message_delta 里回 delta.title——第三方端点没这个能力，由起名腿补上
 *      （与主回答并行，见 runTitleLeg / runTitleLegModel）。来源可配
 *      （demoTitleSource）：deepseek=官方端点起名腿 / model=自定义模型
 *      提示词起名 / off=首条消息截断
 *
 * 实测依据（2026-11-17 三份全链路追踪）：
 *  - 极小请求完整复现原生深度搜索（11 次工具调用/50 结果/9 全文页）；
 *  - 原生历史自清洗（工具块不进后续请求）→ 本模块不做历史清洗；
 *  - demo 解析器规范见 modules/think.js 注释与 docs/dom-research.md。
 *
 * 端点=DeepSeek（含未配端点）时本模块不激活，走 demoapi 原样透传。
 * ============================================================ */
var DemoBridge = {
  LEG_TIMEOUT: 60000,
  LEG_TEXT_CAP: 6000,          // 喂回模型的腿报告上限（字符）
  DS_LEG_BASE: 'https://api.deepseek.com/anthropic/v1',

  // 自定义模型起名的系统提示词（source=model）。规则式写法参照 OpenWebUI
  // 默认标题模板与 Claude Code /rename：短、准确、跟随语言、只输出 JSON
  TITLE_SYSTEM_PROMPT: '你是会话标题生成器。根据用户给出的对话首条消息，生成一个简洁的会话标题。\n' +
    '规则：\n' +
    '- 不超过 12 个汉字或 6 个英文单词\n' +
    '- 准确概括主题，优先准确而非创意\n' +
    '- 使用该消息本身的语言\n' +
    '- 不要引号、书名号、emoji、句末标点\n' +
    '- 只输出一个 JSON 对象，不要任何解释：{"title":"标题"}',

  /* ---------- 激活判定 ---------- */
  active: function () {
    if (!DSE.config.get('demoCustom')) return false;   // 总开关关闭 = 完全官方逻辑
    var ep = (DSE.config.get('demoEndpoint') || '').trim();
    if (!ep) return false;
    if (/deepseek\.com/i.test(ep)) return false;    // 官方端点 → 原生透传（工具原生工作）
    var mode = DSE.config.get('demoBridge') || 'auto';
    return mode !== 'off';
  },

  // 原生 fetch（未经 demoapi 补丁）——桥接的出站请求（第三方端点 + DeepSeek 腿）
  // 必须走它，否则腿的 URL 会被 demoapi 的补丁改写成第三方端点
  nativeFetch: function () {
    return (DSE.modules.demoApi && DSE.modules.demoApi._origFetch) || window.fetch;
  },

  keyHeader: function (headers) {
    var style = DSE.config.get('demoKeyHeader') || 'x-api-key';
    var key = (DSE.config.get('demoKey') || '').trim();
    var h = {};
    for (var k in headers) if (Object.prototype.hasOwnProperty.call(headers, k)) h[k] = headers[k];
    // anthropic-beta 必须剥掉：页面**只在请求引用了上传文件时**才加这个头
    // （DeepSeek Files API 的 beta 标志，官方文档要求引用 file_id 时带上）。
    // 第三方端点既不认它、CORS 预检白名单里也没有它——带着发出去，浏览器在
    // 预检阶段直接拦掉，表现为一条莫名的 "Failed to fetch"（2026-11-18 实测：
    // 带头 100% 被拒、不带 200；这正是"纯文本能发、一带附件就发不出去"的真因）。
    // 端点仍是 DeepSeek 自己时保留（那边要靠这个头才能用 document 块）
    var ep = (DSE.config.get('demoEndpoint') || '').toLowerCase();
    if (ep && ep.indexOf('api.deepseek.com') === -1) {
      delete h['anthropic-beta']; delete h['Anthropic-Beta']; delete h['ANTHROPIC-BETA'];
    }
    if (!key) return h;                       // 未覆盖 Key 时用 demo 原样头
    delete h['x-api-key']; delete h['Authorization']; delete h['authorization'];
    if (style === 'authorization') h['Authorization'] = 'Bearer ' + key;
    else h['x-api-key'] = key;
    return h;
  },

  /* ---------- 出站请求构造（第三方端点） ---------- */
  buildOutbound: function (body, origHeaders) {
    var messages = [];
    var reminder = '';
    (body.messages || []).forEach(function (m) {
      if (m.role === 'latest_reminder') { reminder = typeof m.content === 'string' ? m.content : ''; return; }
      messages.push(m);
    });
    // 附件内联：页面上传文件后只拿到 file_id，而 DeepSeek 明确不支持下载原文件/
    // 解析结果（GET .../files/{id} 只回元数据、.../content 404，官方文档原话
    // 「上传的原始文件和解析结果都不支持下载」）——document/file_id 块只有
    // DeepSeek 自己的模型认，第三方模型收到直接 400（StepFun 实测
    // input_invalid，且该 400 不带 CORS 头，浏览器只报 Failed to fetch）。
    // 上传时 demoapi 已把能当文本读的正文按 file_id 记下（见 captureFile），
    // 这里换成文本块；记不下的（图片/PDF/Office）换成一行说明——留着死引用
    // 只会让整条请求失败，说明至少能让对话继续
    var fileTexts = (DSE.modules.demoApi && DSE.modules.demoApi._fileTexts) || {};
    messages = messages.map(function (m) {
      if (!Array.isArray(m.content)) return m;
      var changed = false;
      var blocks = m.content.map(function (c) {
        if (!c || c.type !== 'document' || !c.source || c.source.type !== 'file') return c;
        changed = true;
        var rec = fileTexts[c.source.file_id];
        var nm = (rec && rec.name) || c.source.file_id || 'file';
        if (rec && typeof rec.text === 'string') {
          return { type: 'text', text: '【附件：' + nm + '】\n' + rec.text };
        }
        return { type: 'text', text: '【附件：' + nm + '，当前模型无法读取该类型文件的内容，已忽略】' };
      });
      return changed ? Object.assign({}, m, { content: blocks }) : m;
    });
    var system = typeof body.system === 'string' ? body.system : '';
    // 系统提示词：只删掉官方内置的 DeepSeek 自述（"该助手为DeepSeek，由深度
    // 求索公司创造。"）——换第三方模型时保留它，模型会在思维链里引用该句并
    // 自称 DeepSeek（2026-11-17 实测）。仅删除，不替换成任何自造人设；
    // 官方端点不走桥接，不受影响
    system = system.replace(/该助手为DeepSeek[^。]*。?/g, '').trim();
    if (reminder) {
      var p = reminder.split(',');
      system += '\n\n当前时间：' + (p[0] || '') + ' ' + (p[1] || '') + '；语言：' + (p[4] || '中文') + '；平台：' + (p[3] || 'Web') + '。';
    }
    // 两种工具调用方式在**出站形状**上就分道：
    //
    // searchapi（原生搜索）：只声明第三方端点自己的服务端搜索工具
    // （StepFun 是 web_search_20250305，实测只认这一个 type，其余一律 400）。
    // 模型用它原生的通道表达搜索意图——不吐 tool_use JSON、由服务端在执行前
    // 把意图块吐出来（实测：块收尾时 query 已完整，此刻 abort 则结果块不会
    // 出现，模型看不到上游搜索结果）。桥接截获这个意图，改由 DeepSeek 的
    // 独立搜索 API 执行，再把结果按官方同形状合成块喂回模型和界面。
    // 客户端工具（web_search/read_url + 中文 description + 提示词规程）整套
    // 不再需要——那套正是模型漏用 read_url、每轮反复吐 JSON 的来源。
    //
    // native：保持原状——声明标准客户端工具，模型吐 tool_use，桥接跑
    // DeepSeek 模型腿做真正的多跳调研（含模型 token 费）
    var mode = DSE.config.get('demoToolMode') || 'native';
    var out = {
      model: (DSE.config.get('demoModel') || '').trim() || body.model,
      max_tokens: 8192,
      stream: true,
      system: system,
      messages: messages
    };
    if (mode === 'searchapi') {
      out.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
      return { url: this.normUrl((DSE.config.get('demoEndpoint') || '').trim()), headers: this.keyHeader(origHeaders), body: out };
    }
    // 工具规程：两个工具是**配合**使用的，必须把分工写明白。此前只点名两个
    // 工具名、不说怎么配合，模型会在思维链里把 read_url 当成"文本提到但函数
    // 列表里没有"的东西、从而整轮不调用它（2026-11-18 用户实测反馈）——工具
    // 本身两种模式都声明了，缺的是这段指引
    system += '\n\n你可以使用 web_search / read_url 工具获取实时信息，结果会以 tool_result 返回。' +
      '需要最新或外部信息时必须调用工具，不要凭空回答。两个工具配合使用：先用 web_search 找到相关网页，' +
      '需要核实细节（日期、数字、原文表述）时再用 read_url 读取其中网页全文。' +
      '同一轮回答中 web_search 不超过 2 次，尽量一次搜准。调用工具前不要输出面向用户的文本。';
    out.system = system;
    var tools = [
      { name: 'web_search', description: '搜索网页获取实时信息，返回标题/链接/摘要列表。需要最新或外部信息时先用本工具。',
        input_schema: { type: 'object', properties: { query: { type: 'string', description: '搜索查询词' } }, required: ['query'] } }
    ];
    // read_url 两种模式都声明：native 走模型对话内的读网页工具；searchapi
    // 直调独立 Fetch API（/v1/tools/fetch）
    tools.push({ name: 'read_url', description: '读取指定网页的全文内容。搜索结果里需要核实细节（日期、数字、原文表述）时，用本工具打开对应链接。',
      input_schema: { type: 'object', properties: { url: { type: 'string', description: '网页 URL' } }, required: ['url'] } });
    out.tools = tools;
    return { url: this.normUrl((DSE.config.get('demoEndpoint') || '').trim()), headers: this.keyHeader(origHeaders), body: out };
  },

  // 端点 URL 归一：与 demoapi.patchFetch 同一套逻辑——配置可以带或不带
  // /messages（界面说明是不带），两种填法都归一成完整接口地址。此前
  // buildOutbound 直接用配置原值，不带 /messages 时会 404（只因历史配置
  // 带了后缀才没暴露）
  normUrl: function (ep) {
    ep = String(ep || '').replace(/\/+$/, '');
    if (!ep) return '';
    return /\/messages$/.test(ep) ? ep : ep + '/messages';
  },

  /* ---------- SSE 工具 ---------- */
  sseEvent: function (type, obj) {
    return 'event: ' + type + '\ndata: ' + JSON.stringify(obj) + '\n\n';
  },

  // 通用 SSE 读取器：逐事件回调；返回累积的块/usage/stop_reason
  pump: function (stream, onEvent, signal) {
    var reader = stream.getReader();
    var dec = new TextDecoder();
    var buf = '';
    return (async function () {
      while (true) {
        if (signal && signal.aborted) {
          // cancel() 返回 promise，流已 abort 时它会 reject——不接就是 unhandled
          // rejection（每次劫持搜索都往控制台抛一条 "BodyStreamBuffer was
          // aborted"）。try/catch 只拦同步抛，接不住 promise 拒绝
          try { reader.cancel().catch(function () {}); } catch (e) {}
          throw new DOMException('Aborted', 'AbortError');
        }
        var r = await reader.read();
        if (r.done) break;
        buf += dec.decode(r.value, { stream: true });
        var idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          var ev = buf.slice(0, idx); buf = buf.slice(idx + 2);
          var data = null;
          var lines = ev.split('\n');
          for (var i = 0; i < lines.length; i++) if (lines[i].indexOf('data: ') === 0) data = lines[i].slice(6);
          if (!data) continue;
          var j = null;
          try { j = JSON.parse(data); } catch (e) { continue; }
          if (j.type === 'error' || (j.error && j.error.message)) throw new Error((j.error && j.error.message) || 'stream error');
          onEvent(j);
        }
      }
    })();
  },

  /* ---------- 从模型的工具调用意图里取出查询词 ---------- */
  // 意图块有三种形状（服务端 server_tool_use / 客户端 tool_use / DeepSeek 方言），
  // 且模型在历史里见过合成块后有概率把 queries 写成字符串化的数组。统一在这里
  // 归一，调用方只管拿字符串
  firstQuery: function (intent) {
    if (!intent || typeof intent !== 'object') return '';
    var o = intent.input && typeof intent.input === 'object' ? intent.input : intent;
    var qs = o.queries;
    if (typeof qs === 'string') {
      // 字符串化的数组：按数组解析；解析不动就整串当查询词
      try { var p = JSON.parse(qs); if (Array.isArray(p) && p.length) qs = p; } catch (e) {}
      if (typeof qs === 'string') return qs.trim();
    }
    if (Array.isArray(qs) && qs.length) return String(qs[0] || '').trim();
    return String(o.query || '').trim();
  },

  /* ---------- DeepSeek 独立搜索腿（searchapi 模式：只付搜索费） ---------- */
  // 直调 POST https://api.deepseek.com/v1/tools/search（Bearer 鉴权，用页面里
  // 同一把 DeepSeek Key），不发起模型对话——没有模型 token 费，只按次计搜索
  // 费（$0.75/1000 次，空结果不计费）。结果按 demo 解析器规范合成原生形状的
  // server_tool_use / web_search_tool_result 块：一份推给界面，一份由调用方
  // 塞回请求历史当模型的 grounding。
  //
  // 只做字段搬运，不加料：块里只有官方 web_search_result 本就有的那几个字段
  // （type/title/url/snippet/site_name/site_icon/page_age），snippet 直接用
  // 接口回的摘要。曾把网页全文塞进额外的 content 字段让模型"不必再读网页"——
  // 那是我们自己加的东西，官方协议里没有，已删（2026-11-18 用户指出"我让你
  // 做的只有转发、路由"）。于是 searchapi 只有搜索、没有读网页：官方那对是
  // 「搜索给摘要 + read_url 补全文」，而 StepFun 没有服务端读网页工具可劫持
  // （web_fetch_20250305 实测 400），与其加料不如让模型自己决定再搜几次
  runLegSearchApi: function (query, dsKey, push, nextIdx, signal) {
    var self = this;
    var q = String(query || '').slice(0, 128);
    if (!q) return Promise.reject(new Error('empty query'));
    var ac = new AbortController();
    var timer = setTimeout(function () { ac.abort(); }, 20000);
    if (signal) signal.addEventListener('abort', function () { ac.abort(); }, { once: true });
    return this.nativeFetch()('https://api.deepseek.com/v1/tools/search', {
      method: 'POST', signal: ac.signal,
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + dsKey },
      body: JSON.stringify({ query: q, count: 10, need_content: false })
    }).then(function (resp) {
      clearTimeout(timer);
      if (!resp.ok) throw new Error('search api http ' + resp.status);
      return resp.json();
    }).then(function (j) {
      var id = 'srvtoolu_sa_' + Math.random().toString(36).slice(2, 10);
      var i1 = nextIdx(), i2 = nextIdx();
      var items = ((j && j.results) || []).slice(0, 10).map(function (r) {
        return { type: 'web_search_result', title: r.title || '', url: r.url || '',
          snippet: r.snippet || r.summary || '', site_name: r.site_name || '',
          site_icon: r.site_icon || '', page_age: r.date || '' };
      });
      var useBlock = { type: 'server_tool_use', id: id, name: 'deepseek_web_search', kind: 'search',
        input: { action: 'search', queries: [q] } };
      var resultBlock = { type: 'web_search_tool_result', tool_use_id: id, kind: 'search', content: items };
      push(self.sseEvent('content_block_start', { type: 'content_block_start', index: i1, content_block: useBlock }));
      push(self.sseEvent('content_block_stop', { type: 'content_block_stop', index: i1 }));
      push(self.sseEvent('content_block_start', { type: 'content_block_start', index: i2, content_block: resultBlock }));
      push(self.sseEvent('content_block_stop', { type: 'content_block_stop', index: i2 }));
      return { blocks: [useBlock, resultBlock] };
    }).catch(function (e) {
      clearTimeout(timer);
      throw e;
    });
  },

  /* ---------- searchapi 原生搜索流 ----------
   * 模型用第三方端点自己的服务端搜索工具表达意图（不吐 tool_use JSON），桥接
   * 截获意图 → abort 该轮 → 用模型自己决定的查询词调 DeepSeek 搜索 → 合成
   * 原生块（界面一份、历史一份）→ 带收尾 user 消息重发。
   *
   * 四个都已实测的关键点：
   * 1. server_tool_use 块收尾时 input.query 才完整（input_json_delta 流式到
   *    达），必须等 content_block_stop 再 abort，否则拿到空 query
   * 2. 此刻 abort，web_search_tool_result 不会出现——模型看不到上游那次搜索
   *    的结果，grounding 完全来自 DeepSeek
   * 3. 重发必须补一条 user 收尾消息：只有 [user, assistant[块]] 时模型会自己
   *    再去搜（上游搜索照执行、照计费）；补上「请基于上面的搜索结果回答」后
   *    实测直接依据注入结果作答、不重复搜
   * 4. 不设轮数上限：模型还想搜就再截一次，与原生多跳同构；要停用页面自带
   *    的停止按钮（abort 经 signal 传到在途请求）
   */
  flowSearchApi: function (o) {
    var self = this;
    var messages = o.messages.slice();
    var stopReason = 'end_turn', lastUsage = null, respModel = '';
    var acc = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    // 官方「深度思考」开关。关着时官方端点不回思考块，这里也把第三方模型的
    // 思考块丢掉——StepFun 忽略 thinking:{disabled} 照样回思考，原样转发等于
    // 用户关着开关却看到满屏思考（还常是英文 Meta 独白），那是我们多加的
    var thinkOn = !!o.thinkOn;
    return (async function () {
      while (true) {
        if (o.ac.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        // 每轮独立 controller：截到意图只断这一轮，不影响整个交换的 signal
        var roundAc = new AbortController();
        o.ac.signal.addEventListener('abort', function () { roundAc.abort(); }, { once: true });
        var resp = await self.nativeFetch()(o.url, {
          method: 'POST', signal: roundAc.signal,
          headers: Object.assign({ 'Content-Type': 'application/json', 'Accept': 'text/event-stream' }, o.headers),
          body: JSON.stringify(Object.assign({}, o.body, { messages: messages }))
        });
        if (!resp.ok) {
          var et = await resp.text().catch(function () { return ''; });
          var em = et; try { var ej = JSON.parse(et); em = (ej.error && ej.error.message) || et; } catch (e) {}
          o.push(self.sseEvent('error', { type: 'error', error: { type: 'api_error',
            message: '模型端点错误 ' + resp.status + '：' + String(em).slice(0, 200) } }));
          return { stopReason: 'end_turn', usage: acc, lastUsage: null, model: '', messages: messages };
        }
        var intent = null, openIdx = -1, curType = '', partial = '', aborted = false;
        // 意图块有两种形状：声明服务端工具时模型吐 server_tool_use；但历史里
        // 一旦出现我们合成的 server_tool_use 块，模型有概率改吐客户端形状的
        // tool_use（实测：某一轮突然变成 tool_use，stop_reason=tool_use）。两种
        // 都要当意图接住，否则那一轮会被当成"答完了"直接返回，页面挂在生成中、
        // 答案只剩搜索前那一句话（2026-11-18 实测踩到）
        var isIntent = function (t) { return t === 'server_tool_use' || t === 'tool_use'; };
        await self.pump(resp.body, function (j) {
          if (j.type === 'message_start' && j.message && j.message.model) respModel = j.message.model;
          if (j.type === 'content_block_start') {
            var cb = j.content_block || {};
            curType = cb.type; partial = ''; openIdx = -1;
            // index 必须走统一的 nextIdx()：早先直接转发上游的 j.index，而合成
            // 块用另一套计数器——两套编号撞车，demo 按 index 存块时互相覆盖，
            // 存进库的消息会丢掉整段搜索（实测 3 次搜索只剩 1 组块）
            // 意图块不转发、也**不占用 index**：吞掉 START 却仍推 STOP 是畸形
            // SSE，页面解析到就停止累积，后面所有搜索块整段丢失（实测 5 次搜索
            // 只存进 1 组）
            if (cb.type === 'text' || (cb.type === 'thinking' && thinkOn)) {
              openIdx = o.nextIdx();
              o.push(self.sseEvent('content_block_start', { type: 'content_block_start', index: openIdx, content_block: cb }));
            }
          } else if (j.type === 'content_block_delta') {
            var d = j.delta || {};
            if (d.type === 'input_json_delta') {
              if (isIntent(curType)) partial += d.partial_json || '';
              return;
            }
            if (d.type === 'text_delta' || d.type === 'thinking_delta' || d.type === 'signature_delta') {
              if (openIdx >= 0 && (curType === 'text' || (curType === 'thinking' && thinkOn))) {
                o.push(self.sseEvent('content_block_delta', { type: 'content_block_delta', index: openIdx, delta: d }));
              }
            }
          } else if (j.type === 'content_block_stop') {
            if (isIntent(curType) && !aborted) {
              aborted = true;
              try { intent = JSON.parse(partial || '{}'); } catch (e) { intent = {}; }
              roundAc.abort();     // 拿到完整查询词立刻断，结果块不会漏给模型
            } else if (openIdx >= 0 && (curType === 'text' || (curType === 'thinking' && thinkOn))) {
              o.push(self.sseEvent('content_block_stop', { type: 'content_block_stop', index: openIdx }));
              openIdx = -1;
            }
            curType = '';
          } else if (j.type === 'message_delta') {
            lastUsage = j.usage || lastUsage;
            if (j.delta && j.delta.stop_reason) stopReason = j.delta.stop_reason;
          }
        }, roundAc.signal).catch(function (e) {
          if (e && e.name !== 'AbortError') throw e;
        });
        if (lastUsage) {
          ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'].forEach(function (k) {
            if (typeof lastUsage[k] === 'number') acc[k] += lastUsage[k];
          });
        }
        // 被主动 abort 的轮次：文本/思考块可能还开着，补一个 stop 让界面闭合
        if (openIdx >= 0) {
          o.push(self.sseEvent('content_block_stop', { type: 'content_block_stop', index: openIdx }));
        }
        // 查询词兼容三种形状：服务端工具的 {query}、DeepSeek 方言的
        // {action:'search',queries:[..]}、客户端工具的 {query}。
        // 坑：模型一旦在历史里见过我们合成的 DeepSeek 方言块，有概率把 queries
        // 写成**字符串化的数组**（实测 "[\"黄仁勋 NVIDIA 消息\"]"）——此时
        // queries[0] 取到的是字符串第 0 个字符 "["，整次搜索就废了。必须先按
        // 数组解析，解析不动才整串当查询词
        var q = self.firstQuery(intent);
        if (!q) {
          // 模型说"我要调工具"却一个可执行的搜索意图都没给出——不能悄悄当答完
          // （页面会永远转圈、答案只剩搜索前那句话），把错误显式推给界面
          if (stopReason === 'tool_use') {
            o.push(self.sseEvent('error', { type: 'error', error: { type: 'api_error',
              message: '模型请求了工具调用但未给出可执行的搜索关键词，已中止本次回答' } }));
          }
          return { stopReason: stopReason, usage: acc, lastUsage: lastUsage, model: respModel, messages: messages };
        }
        var leg = await self.runLegSearchApi(q, o.dsKey, o.push, o.nextIdx, o.ac.signal);
        // 新块并进**同一条** assistant 消息——原生就是一条 assistant 消息里串着
        // 一次次搜索的块；追加成两条连续 assistant 消息多数 provider 不接受。
        // 也不补任何 user 收尾消息：补一句"请基于上面的搜索结果回答"等于替用户
        // 决定"别再搜了"，用户明说"搜索5次"也会被这句话按死（2026-11-18 实测
        // 踩到）。模型自己判断够不够，想再搜就再截一次
        var last = messages[messages.length - 1];
        if (last && last.role === 'assistant' && Array.isArray(last.content)) {
          last.content = last.content.concat(leg.blocks);
        } else {
          messages.push({ role: 'assistant', content: leg.blocks });
        }
      }
    })();
  },

  /* ---------- 极小起名腿（补官方页的 title:{enabled:true} 通道） ---------- */
  // demo 页官方行为：请求带 title:{enabled:true}（仅会话还没标题时），服务端
  // 在同一次流式响应的 message_delta 里回 delta.title，侧边栏直接采用。第三方
  // 端点不认这个字段、不会回标题——故桥接补一条极小 DeepSeek 腿：同样的
  // title:{enabled:true} + 首条用户消息打官方端点，把服务端生成的标题按官方
  // 同一条通道（message_delta.delta.title）转发给 demo。成本约 55 in/16 out
  // token（≈$0.001）；腿与主回答并行发起，延迟被主回答掩盖。失败时退回首条
  // 消息截断（桥接此前行为）
  runTitleLeg: function (firstUser, dsKey, signal) {
    var self = this;
    var ac = new AbortController();
    var timer = setTimeout(function () { ac.abort(); }, 15000);
    if (signal) signal.addEventListener('abort', function () { ac.abort(); }, { once: true });
    var title = '';
    var body = {
      model: 'deepseek-flash', stream: true, max_tokens: 32,
      system: '该助手为DeepSeek，由深度求索公司创造。',
      messages: [{ role: 'user', content: String(firstUser).replace(/\s+/g, ' ').trim().slice(0, 500) }],
      title: { enabled: true }
    };
    return this.nativeFetch()(this.DS_LEG_BASE + '/messages', {
      method: 'POST', signal: ac.signal,
      headers: { 'Content-Type': 'application/json', 'x-api-key': dsKey, 'Accept': 'text/event-stream' },
      body: JSON.stringify(body)
    }).then(function (resp) {
      if (!resp.ok) throw new Error('title leg http ' + resp.status);
      return self.pump(resp.body, function (j) {
        if (j.type === 'message_delta' && j.delta && j.delta.title) title = String(j.delta.title).trim();
      }, ac.signal);
    }).then(function () {
      clearTimeout(timer);
      return title.slice(0, 30);
    }).catch(function (e) {
      clearTimeout(timer);
      throw e;
    });
  },

  /* ---------- 起名来源（demoTitleSource） ---------- */
  // deepseek=起名腿打 DeepSeek 官方端点（title 参数，官方通道，约 $0.001/次）
  // model=当前自定义模型按提示词起名（费用走第三方端点，不经 DeepSeek）
  // off=不起名，退回首条消息截断
  titleSource: function () {
    var s = DSE.config.get('demoTitleSource');
    return (s === 'model' || s === 'off') ? s : 'deepseek';
  },

  // 自定义模型起名的输出清洗（LibreChat sanitizeTitle 同思路）：
  // 第三方模型不保证干净输出——推理模型可能把 <think> 吐进正文、可能包引号/
  // 代码围栏/寒暄。链路：剥思考 → 优先取 JSON 里的 title（围栏不挡匹配，
  // 顺序不能反）→ 没有 JSON 时按行挑（扔围栏、丢寒暄前缀与过长行）→ 去
  // 首尾包裹符号与句末标点 → 码点安全截断 → 空则返回 ''（交由上层兜底）
  cleanTitle: function (raw) {
    var t = String(raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '');
    var m = t.match(/"title"\s*:\s*"([^"]{1,60})"/);
    if (m) {
      t = m[1];
    } else {
      var j = t.match(/\{[\s\S]*\}/);
      if (j) { try { var o = JSON.parse(j[0]); if (o && o.title) t = String(o.title); } catch (e) {} }
      if (!m) {
        t = t.replace(/```[\s\S]*?```/g, ' ');
        var lines = t.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
        var pick = '';
        for (var i = 0; i < lines.length; i++) {
          var l = lines[i];
          if (/^(当然|好的|以下是|这是|根据|希望|标题|如下|为你)/.test(l)) continue;  // 寒暄前缀
          if (Array.from(l).length > 24) continue;                                   // 标题不会这么长
          pick = l; break;
        }
        t = pick || lines[0] || '';
      }
    }
    t = t.replace(/^["'`“”‘’「『\[\(【〔{]+/, '').replace(/["'`“”‘’」』\]\)】〕}.。.，,！!？?；;：:\s]+$/, '').trim();
    var cps = Array.from(t);
    if (cps.length > 30) t = cps.slice(0, 30).join('') + '…';
    return t.trim();
  },

  /* ---------- 极小起名腿：自定义模型（提示词起名） ---------- */
  // source=model 时用当前第三方端点起名：非流式单发。两个实测约束：
  // ① max_tokens 不能小——StepFun 实测 <256 返 HTTP 200 但 content 空串
  //    （见 stepfun-api-gotchas）；② step-5-preview 实测忽略
  //    thinking:{disabled}（响应仍只回 thinking 块），256 预算会被思考全吃光、
  //    文本块轮不到（stop_reason=max_tokens）→ 故取 1024（与设置里测试按钮
  //    同款，实测思考+文本都放得下）。URL/headers 复用主出站（已按
  //    demoKeyHeader 处理过 Key），不另起配置。与主回答并行发起，延迟被掩盖；
  //    失败/空结果退回首条消息截断。费用走第三方端点，不产生 DeepSeek 模型费
  runTitleLegModel: function (firstUser, outbound, signal) {
    var self = this;
    var ac = new AbortController();
    var timer = setTimeout(function () { ac.abort(); }, 15000);
    if (signal) signal.addEventListener('abort', function () { ac.abort(); }, { once: true });
    var body = {
      model: outbound.body.model,
      max_tokens: 1024,
      stream: false,
      thinking: { type: 'disabled' },
      system: this.TITLE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: String(firstUser).replace(/\s+/g, ' ').trim().slice(0, 500) }]
    };
    return this.nativeFetch()(outbound.url, {
      method: 'POST', signal: ac.signal,
      headers: Object.assign({ 'Content-Type': 'application/json', 'Accept': 'application/json' }, outbound.headers),
      body: JSON.stringify(body)
    }).then(function (resp) {
      if (!resp.ok) throw new Error('title(model) http ' + resp.status);
      return resp.json();
    }).then(function (j) {
      clearTimeout(timer);
      var txt = (j.content || []).filter(function (b) { return b.type === 'text'; })
        .map(function (b) { return b.text || ''; }).join('');
      return self.cleanTitle(txt);
    }).catch(function (e) {
      clearTimeout(timer);
      throw e;
    });
  },

  // native 模式专用：让 DeepSeek 的模型（deepseek-flash）带着它自己的服务端
  // 搜索/读网页工具去调研，腿内的工具块与思考块原样转发 demo，报告文本走
  // tool_result 喂回第三方模型。searchapi 模式不走这里——它截获的是第三方
  // 模型的原生意图，由 flowSearchApi 直接调 runLegSearchApi
  runLeg: function (toolName, toolInput, dsKey, push, nextIdx, signal) {
    var self = this;
    var q = toolName === 'read_url' ? ('请读取并详细总结这个网页的内容：' + (toolInput.url || ''))
                                    : ('请深入调研以下问题，搜索并阅读相关网页，然后给出有据可查的结论：\n' + (toolInput.query || ''));
    var tools = toolName === 'read_url'
      ? [{ name: 'deepseek_read_url', type: 'deepseek_read_url' }]
      : [{ name: 'deepseek_read_url', type: 'deepseek_read_url' }, { name: 'deepseek_web_search', type: 'deepseek_web_search' }];
    var body = { model: 'deepseek-flash', stream: true, thinking: { type: 'enabled' }, max_tokens: 4096, tools: tools, messages: [{ role: 'user', content: q }] };
    var ac = new AbortController();
    var timer = setTimeout(function () { ac.abort(); }, this.LEG_TIMEOUT);
    if (signal) signal.addEventListener('abort', function () { ac.abort(); }, { once: true });
    return this.nativeFetch()(this.DS_LEG_BASE + '/messages', {
      method: 'POST', signal: ac.signal,
      headers: { 'Content-Type': 'application/json', 'x-api-key': dsKey, 'Accept': 'text/event-stream' },
      body: JSON.stringify(body)
    }).then(function (resp) {
      if (!resp.ok) return resp.text().then(function (t) { throw new Error('leg http ' + resp.status + ': ' + t.slice(0, 200)); });
      var out = { blocks: [], text: '', usage: null };
      return self.pump(resp.body, function (j) {
        if (j.type === 'content_block_start') {
          var cb = j.content_block || {};
          var b = { index: nextIdx(), raw: cb, fwd: false };
          out.blocks.push(b);
          // 工具块与思考块原样转发 demo（id/kind/tool_use_id 保持腿内原值）；
          // 腿的报告文本不转发——它走 tool_result 喂回模型
          if (cb.type === 'server_tool_use' || cb.type === 'web_search_tool_result' ||
              cb.type === 'web_fetch_tool_result' || cb.type === 'thinking') {
            b.fwd = true;
            push(self.sseEvent('content_block_start', { type: 'content_block_start', index: b.index, content_block: cb }));
          }
        } else if (j.type === 'content_block_delta') {
          var d = j.delta || {};
          var blk = out.blocks[out.blocks.length - 1];
          if (blk && blk.fwd && (d.type === 'thinking_delta' || d.type === 'signature_delta')) {
            push(self.sseEvent('content_block_delta', { type: 'content_block_delta', index: blk.index, delta: d }));
          }
          if (blk && blk.raw.type === 'text' && d.type === 'text_delta') out.text += d.text || '';
        } else if (j.type === 'content_block_stop') {
          var b2 = out.blocks[out.blocks.length - 1];
          if (b2 && b2.fwd) push(self.sseEvent('content_block_stop', { type: 'content_block_stop', index: b2.index }));
        } else if (j.type === 'message_delta') {
          out.usage = j.usage || out.usage;
        }
      }, ac.signal).then(function () { clearTimeout(timer); return out; });
    }).catch(function (e) {
      clearTimeout(timer);
      throw e;
    });
  },

  /* ---------- 主流程 ---------- */
  intercept: function (url, init, dsKey) {
    var self = this;
    var body = null;
    try { body = JSON.parse(init.body); } catch (e) { return null; }
    if (!body || !body.messages) return null;

    var outbound = this.buildOutbound(body, init.headers || {});
    var enc = new TextEncoder();
    var q = [], done = false, wake = null;
    var push = function (s) { q.push(s); if (wake) { var w = wake; wake = null; w(); } };
    var finish = function () { done = true; if (wake) { var w = wake; wake = null; w(); } };
    var ac = new AbortController();
    if (init.signal) init.signal.addEventListener('abort', function () { ac.abort(); }, { once: true });

    var stream = new ReadableStream({
      pull: function (c) {
        if (q.length) { c.enqueue(enc.encode(q.shift())); return; }
        if (done) { c.close(); return; }
        return new Promise(function (r) { wake = r; });
      },
      cancel: function () { ac.abort(); }
    });

    (async function () {
      var idx = 0;
      var nextIdx = function () { return idx++; };
      var usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
      var addUsage = function (u) {
        if (!u) return;
        ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'].forEach(function (k) {
          if (typeof u[k] === 'number') usage[k] += u[k];
        });
      };
      var wantTitle = !!(body.title && body.title.enabled);
      // 起名腿与主回答并行发起（标题只需首条用户消息，不必等回答完）——
      // 官方端点上标题由服务端在同一次请求里顺手生成，第三方端点没这个
      // 能力，用一条极小腿补上，延迟被主回答掩盖掉。来源由 demoTitleSource
      // 决定：deepseek=官方端点 title 参数腿；model=自定义模型提示词腿；
      // off=不起腿（收尾处退回首条消息截断）。
      // 注意：本闭包是无接收者调用的 async IIFE（bootstrap 还有 'use strict'），
      // 里面的 this 不是 DemoBridge（严格模式下为 undefined）——必须用函数顶部
      // 捕获的 self，否则 this.titleSource 直接 TypeError；且该段在下方 try 之前，
      // 异常会变成 unhandled rejection，表现为流既不推数据也不发请求、页面永远
      // 挂在"停止生成"（本次开发实测踩到）
      var titleSrc = self.titleSource();
      var titleLeg = null;
      if (wantTitle && titleSrc !== 'off') {
        var firstUser0 = '';
        for (var fi = 0; fi < (body.messages || []).length; fi++) {
          var fm = body.messages[fi];
          if (fm && fm.role === 'user' && typeof fm.content === 'string') { firstUser0 = fm.content; break; }
        }
        if (firstUser0) {
          titleLeg = (titleSrc === 'model'
            ? self.runTitleLegModel(firstUser0, outbound, ac.signal)
            : self.runTitleLeg(firstUser0, dsKey, ac.signal)
          ).catch(function () { return ''; });
        }
      }
      try {
        push(self.sseEvent('message_start', {
          type: 'message_start',
          message: { id: 'msg_bridge_' + Math.random().toString(36).slice(2, 10), type: 'message', role: 'assistant',
            model: outbound.body.model, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }
        }));
        var messages = outbound.body.messages.slice();
        var stopReason = 'end_turn';
        var roundUsage = null, respModel = '';
        if ((DSE.config.get('demoToolMode') || 'native') === 'searchapi') {
          // 原生搜索流：模型用第三方端点自己的服务端搜索工具表达意图（不吐
          // tool_use JSON），桥接截获意图后改由 DeepSeek 的独立搜索 API 执行。
          // 与 native 那条循环的区别不只是"谁执行"——native 是声明客户端工具、
          // 模型吐 JSON、桥接跑 DeepSeek 模型腿；这里模型走原生通道，桥接只
          // 负责换执行者。两条路都不设轮数上限，停止一律交给页面停止按钮
          var sa = await self.flowSearchApi({
            messages: messages, url: outbound.url, headers: outbound.headers, body: outbound.body,
            push: push, nextIdx: nextIdx, ac: ac, dsKey: dsKey,
            // 「深度思考」开关：官方关着时端点不回思考块，这里也跟着丢，别把
            // 第三方模型（忽略 thinking:disabled）硬回来的思考展示给用户
            thinkOn: !!(body.thinking && body.thinking.type === 'enabled')
          });
          stopReason = sa.stopReason; roundUsage = sa.lastUsage; respModel = sa.model;
          messages = sa.messages;
          addUsage(sa.usage);
        } else while (true) {
          var resp = await self.nativeFetch()(outbound.url, {
            method: 'POST', signal: ac.signal,
            headers: Object.assign({ 'Content-Type': 'application/json', 'Accept': 'text/event-stream' }, outbound.headers),
            body: JSON.stringify(Object.assign({}, outbound.body, { messages: messages }))
          });
          if (!resp.ok) {
            var et = await resp.text().catch(function () { return ''; });
            var em = et; try { var ej = JSON.parse(et); em = (ej.error && ej.error.message) || et; } catch (e) {}
            push(self.sseEvent('error', { type: 'error', error: { type: 'api_error', message: '模型端点错误 ' + resp.status + '：' + String(em).slice(0, 200) } }));
            finish(); return;
          }
          var blocks = [];       // 本轮完整块（供下一轮历史）
          var partial = {};      // index → 累积 input_json
          var roundStop = 'end_turn';
          await self.pump(resp.body, function (j) {
            if (j.type === 'message_start' && j.message && j.message.model) respModel = j.message.model;
            if (j.type === 'content_block_start') {
              var cb = j.content_block || {};
              var b = { type: cb.type, raw: cb, index: nextIdx() };
              blocks.push(b); partial[b.index] = '';
              if (cb.type === 'text' || cb.type === 'thinking' || cb.type === 'tool_use') {
                push(self.sseEvent('content_block_start', { type: 'content_block_start', index: b.index, content_block: cb }));
              }
            } else if (j.type === 'content_block_delta') {
              var d = j.delta || {};
              var blk = blocks[blocks.length - 1];
              if (!blk) return;
              if (d.type === 'input_json_delta') { partial[blk.index] += d.partial_json || ''; return; }
              if (d.type === 'text_delta' || d.type === 'thinking_delta' || d.type === 'signature_delta') {
                if (blk.type === 'tool_use') return;
                push(self.sseEvent('content_block_delta', { type: 'content_block_delta', index: blk.index, delta: d }));
              }
            } else if (j.type === 'content_block_stop') {
              var b2 = blocks[blocks.length - 1];
              if (b2) {
                if (b2.type === 'tool_use') {
                  try { b2.raw.input = JSON.parse(partial[b2.index] || '{}'); } catch (e) { b2.raw.input = {}; }
                }
                push(self.sseEvent('content_block_stop', { type: 'content_block_stop', index: b2.index }));
              }
            } else if (j.type === 'message_delta') {
              roundUsage = j.usage || roundUsage;
              if (j.delta && j.delta.stop_reason) roundStop = j.delta.stop_reason;
            }
          }, ac.signal);
          addUsage(roundUsage);
          var toolUses = blocks.filter(function (b) { return b.type === 'tool_use'; });
          if (roundStop !== 'tool_use' || !toolUses.length) { stopReason = roundStop; break; }
          // 有工具调用 → 逐个跑 DeepSeek 原生腿
          var results = [];
          for (var ti = 0; ti < toolUses.length; ti++) {
            var tu = toolUses[ti];
            var leg;
            try {
              leg = await self.runLeg(tu.raw.name, tu.raw.input || {}, dsKey, push, nextIdx, ac.signal);
              addUsage(leg.usage);
            } catch (le) {
              // 腿失败 → 原生失败形状的搜索块 + 空结果喂回
              var fidx = nextIdx();
              push(self.sseEvent('content_block_start', { type: 'content_block_start', index: fidx,
                content_block: { type: 'server_tool_use', id: 'srvtoolu_b_' + Math.random().toString(36).slice(2, 8), name: 'deepseek_web_search', input: { action: 'search', queries: [String((tu.raw.input || {}).query || '').slice(0, 80)] }, kind: 'search' } }));
              push(self.sseEvent('content_block_stop', { type: 'content_block_stop', index: fidx }));
              var ridx = nextIdx();
              push(self.sseEvent('content_block_start', { type: 'content_block_start', index: ridx,
                content_block: { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_b_x', kind: 'search', content: [{ type: 'web_search_tool_result_error', error_code: 'search_unavailable' }] } }));
              push(self.sseEvent('content_block_stop', { type: 'content_block_stop', index: ridx }));
              leg = { text: '（搜索失败：' + String(le && le.message || le).slice(0, 120) + '）' };
            }
            results.push({ type: 'tool_result', tool_use_id: tu.raw.id, content: String(leg.text || '').slice(0, self.LEG_TEXT_CAP) || '（无结果）' });
          }
          // 历史追加：assistant 原样 + user tool_result（tool_result 在前，无文本）
          messages = messages.concat([
            { role: 'assistant', content: blocks.map(function (b) { return b.raw; }) },
            { role: 'user', content: results }
          ]);
        }
        // 精确上下文占用：最后一轮响应的 usage（input + cache_read + cache_creation）
        // ——即本次请求模型实际收到的全部内容（系统/工具/历史），非估算
        if (roundUsage) {
          var uIn = roundUsage.input_tokens || 0;
          var uCacheRead = roundUsage.cache_read_input_tokens || 0;
          var uCacheCreate = roundUsage.cache_creation_input_tokens || 0;
          var used = uIn + uCacheRead + uCacheCreate;
          if (used > 0) {
            // 构成估算：请求是我们构造的，系统/工具/消息三块的 token 占比可算
            // （精确总量来自 usage；占比为估算，面板内已标注）
            var estSys = Utils.estimateTokens(outbound.body.system || '');
            var estTool = Utils.estimateTokens(JSON.stringify(outbound.body.tools || []));
            var estMsg = Utils.estimateTokens(JSON.stringify(messages));
            DSE.emit('ctx:api', {
              used: used, input: uIn, cacheRead: uCacheRead, cacheCreate: uCacheCreate,
              estSys: estSys, estTool: estTool, estMsg: estMsg,
              model: respModel || outbound.body.model || ''
            });
          }
        }
        // 收尾
        var sr = (stopReason === 'end_turn' || stopReason === 'max_tokens' || stopReason === 'refusal') ? stopReason : 'end_turn';
        var delta = { stop_reason: sr, stop_sequence: null };
        if (wantTitle) {
          // 优先起名腿拿到的标题（deepseek 源是服务端生成的官方同款；model
          // 源是自定义模型输出、已过 cleanTitle 清洗）；腿关闭/失败时退回首条
          // 消息截断——桥接此前行为
          var title = '';
          if (titleLeg) { try { title = (await titleLeg) || ''; } catch (e) { title = ''; } }
          if (!title) {
            for (var mi = 0; mi < messages.length; mi++) {
              if (messages[mi].role === 'user' && typeof messages[mi].content === 'string') {
                title = messages[mi].content.replace(/\s+/g, ' ').trim().slice(0, 20); break;
              }
            }
          }
          if (title) delta.title = title;
        }
        push(self.sseEvent('message_delta', { type: 'message_delta', delta: delta, usage: usage }));
        push(self.sseEvent('message_stop', { type: 'message_stop' }));
      } catch (e) {
        if (e && e.name === 'AbortError') { finish(); return; }
        push(self.sseEvent('error', { type: 'error', error: { type: 'api_error', message: String(e && e.message || e).slice(0, 200) } }));
      }
      finish();
    })();

    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' } });
  }
};
DSE.modules.demoBridge = DemoBridge;
