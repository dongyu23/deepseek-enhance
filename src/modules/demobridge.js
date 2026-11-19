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
  // 不再对腿报告设字符上限（2026-11-19 用户要求去掉）：搜索/读网页的完整内容
  // 原样作为 tool_result 喂回模型。代价是连续搜索时上下文涨得快——工具块不像
  // 官方端点那样被服务端清洗，会一直留在后续请求里（见模块头「本模块不做历史
  // 清洗」）。想要上限改回来只需把下面两处 slice 恢复
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

  // 出站头：只发最小必要集，绝不照抄页面原始头。
  // 2026-11-18 实测（StepFun）：页面请求自带 anthropic-version、x-ds-trace-id
  // 和一个小写 content-type，桥接原先连它们一起转发——而这些头不在 StepFun 的
  // CORS allow-headers 里，浏览器预检直接失败、只报 TypeError: Failed to fetch，
  // 用户完全看不出是哪个头被拒。只发 Content-Type / Accept / Authorization
  // 三个头，同一条请求立刻 200。
  // Key 一律放 Authorization: Bearer：DeepSeek 文档原话「x-api-key 或
  // Authorization 任一种」、Anthropic 官方两个都收，而 Authorization 几乎在每个
  // 站点的 CORS allow-headers 里，x-api-key 经常不在（StepFun 就是）
  keyHeader: function (headers) {
    var key = (DSE.config.get('demoKey') || '').trim();
    if (!key) {
      // 没覆盖 Key：取页面原始请求里那个，但同样换成 Authorization
      key = (headers && (headers['x-api-key'] || headers['X-API-Key'] || headers['X-Api-Key'])) || '';
    }
    var h = { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' };
    if (key) h['Authorization'] = 'Bearer ' + key;
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
          return { type: 'text', text: '【附件：' + nm + '】\n' + rec.text + (rec.truncated ? '\n（正文过长，已截断）' : '') };
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
    // 工具规程：两个工具是**配合**使用的，必须把分工写明白。此前只点名两个
    // 工具名、不说怎么配合，模型会在思维链里把 read_url 当成"文本提到但函数
    // 列表里没有"的东西、从而整轮不调用它（2026-11-18 用户实测反馈）——工具
    // 本身两种模式都声明了，缺的是这段指引
    system += '\n\n你可以使用 web_search / read_url 工具获取实时信息，结果会以 tool_result 返回。' +
      '需要最新或外部信息时必须调用工具，不要凭空回答。两个工具配合使用：先用 web_search 找到相关网页，' +
      '需要核实细节（日期、数字、原文表述）时再用 read_url 读取其中网页全文。' +
      '同一轮回答中 web_search 不超过 2 次，尽量一次搜准。调用工具前不要输出面向用户的文本。';
    var tools = [
      // web_search 的参数口径与 DeepSeek Search API 对齐（2026-11-19 按其文档补全）：
      // query 1~128 字符且支持整套搜索语法；count 1~50 且**不影响费用**（按次计费，
      // 填 50 和填 5 一个价）——此前只声明一个 query，模型既不知道能限定站点/语言/
      // 时间，也没法多要结果，等于白放一半能力
      { name: 'web_search',
        description: '搜索网页获取实时信息，返回标题/链接/摘要列表。需要最新或外部信息时先用本工具。' +
          'query 支持搜索语法（可组合）：site:example.com 限定站点；多个站点用 site:a.com OR site:b.com；' +
          '-site:x.com 排除站点；-关键词 排除；"精确短语" 精确匹配；lang:zh-CN 限定语言；' +
          'after:2026-01-01 / before:2026-06-01 限定发布时间。查近期事件时优先用 after: 收窄。',
        input_schema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '搜索词，1~128 个字符，支持 site: / -site: / -排除词 / "精确短语" / lang: / after: / before: 语法' },
            count: { type: 'integer', description: '返回条数，1~50，默认 10。条数不影响费用，可按需多要' },
            need_content: { type: 'boolean', description: '是否在结果中返回网页正文，默认 false。需要引用原文细节时设 true' },
            ori_question: { type: 'string', description: '触发本次搜索的用户原始问题，1~128 字符，能帮助搜索服务理解意图' }
          },
          required: ['query']
        } }
    ];
    // read_url 两种模式都声明：native 走模型对话内的读网页工具；searchapi
    // 直调独立 Fetch API（/v1/tools/fetch）
    tools.push({ name: 'read_url', description: '读取指定网页的全文内容。搜索结果里需要核实细节（日期、数字、原文表述）时，用本工具打开对应链接。',
      input_schema: { type: 'object', properties: { url: { type: 'string', description: '网页 URL' } }, required: ['url'] } });
    var out = {
      model: (DSE.config.get('demoModel') || '').trim() || body.model,
      max_tokens: 8192,
      stream: true,
      system: system,
      messages: messages,
      tools: tools
    };
    return { url: this.normUrl((DSE.config.get('demoEndpoint') || '').trim()), headers: this.keyHeader(origHeaders), body: out };
  },

  // 端点 URL 归一。三种填法都要认（2026-11-18 实测：StepFun 官方文档给的 Base
  // URL 就是第一种「只到 /step_plan」，旧代码只会补 /messages，于是被补成
  // .../step_plan/messages——真实地址是 .../step_plan/v1/messages，直接 404；
  // 而 StepFun 的 404 不带 CORS 头，浏览器只报 Failed to fetch，用户完全看不出
  // 是地址填错了）：
  //   ① 完整地址  .../v1/messages                        → 原样用
  //   ② 到版本号  .../v1                                 → 补 /messages
  //   ③ 只给 base https://api.stepfun.com/step_plan      → 补 /v1/messages（Anthropic 约定）
  normUrl: function (ep) {
    ep = String(ep || '').replace(/\/+$/, '');
    if (!ep) return '';
    if (/\/messages$/.test(ep)) return ep;
    if (/\/v\d+$/.test(ep)) return ep + '/messages';
    return ep + '/v1/messages';
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
        if (signal && signal.aborted) { try { reader.cancel(); } catch (e) {} throw new DOMException('Aborted', 'AbortError'); }
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

  /* ---------- DeepSeek 极小搜索腿 ---------- */
  // 返回 {blocks:[...原生工具/思考块...], text:腿的报告, usage}
  /* ---------- DeepSeek 独立搜索腿（searchapi 模式：只付搜索费） ---------- */
  // 直调 POST https://api.deepseek.com/v1/tools/search（Bearer 鉴权，用页面里
  // 同一把 DeepSeek Key），不发起模型对话——没有模型 token 费，只按次计搜索
  // 费（$0.75/1000 次，空结果不计费）。结果按 demo 解析器规范合成原生形状的
  // server_tool_use / web_search_tool_result 块转发，界面呈现与 native 一致
  runLegSearchApi: function (toolName, toolInput, dsKey, push, nextIdx, signal) {
    var self = this;
    var isRead = toolName === 'read_url';
    var ti = toolInput || {};
    var q = isRead ? String(ti.url || '') : String(ti.query || '').slice(0, 128);
    if (!q) return Promise.reject(new Error('empty input'));
    // count：按模型给的走，夹在 API 允许的 1~50；按次计费，多要不加钱
    var cnt = parseInt(ti.count, 10);
    if (!(cnt >= 1)) cnt = 10;
    if (cnt > 50) cnt = 50;
    // need_content：模型要正文才给（默认 false，此时 API 的 content 恒为空串）
    var wantContent = ti.need_content === true;
    // ori_question：模型没传就用会话首条用户消息兜底——官方文档说带上原始问题
    // 能改善查询理解（智能体内部的检索词往往是压缩过的关键词串）
    var oriQ = String(ti.ori_question || self._firstUser || '').replace(/\s+/g, ' ').trim().slice(0, 128);
    var ac = new AbortController();
    var timer = setTimeout(function () { ac.abort(); }, 20000);
    if (signal) signal.addEventListener('abort', function () { ac.abort(); }, { once: true });
    var url = isRead ? 'https://api.deepseek.com/v1/tools/fetch' : 'https://api.deepseek.com/v1/tools/search';
    var reqBody = isRead ? { url: q }
      : { query: q, count: cnt, need_content: wantContent, ori_question: oriQ || null };
    return this.nativeFetch()(url, {
      method: 'POST', signal: ac.signal,
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + dsKey },
      body: JSON.stringify(reqBody)
    }).then(function (resp) {
      clearTimeout(timer);
      if (!resp.ok) throw new Error((isRead ? 'fetch' : 'search') + ' api http ' + resp.status);
      return resp.json();
    }).then(function (j) {
      var id = 'srvtoolu_sa_' + Math.random().toString(36).slice(2, 10);
      var i1 = nextIdx(), i2 = nextIdx();
      var toolResultText;
      if (isRead) {
        // 读网页：open_page 动作块 + web_fetch_tool_result（content 为单对象）
        var title = (j && j.title) || q;
        var content = (j && j.content) || '';
        push(self.sseEvent('content_block_start', { type: 'content_block_start', index: i1,
          content_block: { type: 'server_tool_use', id: id, name: 'deepseek_read_url', kind: 'read_link',
            input: { action: 'open_page', url: q } } }));
        push(self.sseEvent('content_block_stop', { type: 'content_block_stop', index: i1 }));
        push(self.sseEvent('content_block_start', { type: 'content_block_start', index: i2,
          content_block: { type: 'web_fetch_tool_result', tool_use_id: id, kind: 'read_link',
            content: { type: 'web_fetch_result', url: q, content: { title: title }, published_at: '' } } }));
        push(self.sseEvent('content_block_stop', { type: 'content_block_stop', index: i2 }));
        toolResultText = (title ? title + '\n' : '') + String(content);
      } else {
        var results = (j && j.results) || [];
        push(self.sseEvent('content_block_start', { type: 'content_block_start', index: i1,
          content_block: { type: 'server_tool_use', id: id, name: 'deepseek_web_search', kind: 'search',
            input: { action: 'search', queries: [q] } } }));
        push(self.sseEvent('content_block_stop', { type: 'content_block_stop', index: i1 }));
        push(self.sseEvent('content_block_start', { type: 'content_block_start', index: i2,
          content_block: { type: 'web_search_tool_result', tool_use_id: id, kind: 'search',
            content: results.slice(0, cnt).map(function (r) {
              return { type: 'web_search_result', title: r.title || '', url: r.url || '',
                snippet: r.snippet || r.summary || '', site_name: r.site_name || '',
                site_icon: r.site_icon || '', page_age: r.date || '' };
            }) } }));
        push(self.sseEvent('content_block_stop', { type: 'content_block_stop', index: i2 }));
        // 喂回模型的文本：默认只给标题/URL/摘要（snippet 给人看、summary 给模型读），
        // 模型显式要正文（need_content）时把 content 也带上
        toolResultText = results.slice(0, cnt).map(function (r, i) {
          var s = (i + 1) + '. ' + (r.title || '') + '\n' + (r.url || '') + '\n' + (r.snippet || r.summary || '');
          if (wantContent && r.content) s += '\n' + String(r.content);
          return s;
        }).join('\n\n') || '（未搜索到结果）';
      }
      return { text: toolResultText };
    }).catch(function (e) {
      clearTimeout(timer);
      throw e;
    });
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
  // keyHeader 已统一处理 Key），不另起配置。与主回答并行发起，延迟被掩盖；
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

  runLeg: function (toolName, toolInput, dsKey, push, nextIdx, signal) {
    if ((DSE.config.get('demoToolMode') || 'native') === 'searchapi') {
      return this.runLegSearchApi(toolName, toolInput, dsKey, push, nextIdx, signal);
    }
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
      // 同主流程：input 类 usage 可能只在 message_start 给
      var mergeLegUsage = function (u) {
        if (!u) return;
        out.usage = out.usage || {};
        ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'].forEach(function (k) {
          if (typeof u[k] === 'number' && (out.usage[k] == null || u[k] > 0)) out.usage[k] = u[k];
        });
      };
      return self.pump(resp.body, function (j) {
        if (j.type === 'message_start' && j.message) mergeLegUsage(j.message.usage);
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
          mergeLegUsage(j.usage);
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
    // 会话首条用户消息：搜索腿的 ori_question 兜底（官方文档说带上原始问题能改善
    // 查询理解——智能体内部的检索词往往是压缩过的关键词串）
    self._firstUser = (function () {
      var ms = (body && body.messages) || [];
      for (var i = 0; i < ms.length; i++) {
        var m = ms[i];
        if (m && m.role === 'user' && typeof m.content === 'string' && m.content.trim()) return m.content;
        if (m && m.role === 'user' && Array.isArray(m.content)) {
          for (var j = 0; j < m.content.length; j++) {
            if (m.content[j] && m.content[j].type === 'text' && m.content[j].text) return m.content[j].text;
          }
        }
      }
      return '';
    })();
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
        // 工具循环：与原生行为一致——模型持续调用工具就持续供给结果，
        // 直到它自己停止调用（给出最终文本回答）。不设轮数上限、不加
        // 无进展检测之类的认为中断；需要停止时用页面自身的停止按钮
        // （abort 经 signal 传到在途请求，流关闭，demo 显示“已停止”）
        var messages = outbound.body.messages.slice();
        var stopReason = 'end_turn';
        while (true) {
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
          var roundUsage = null, roundStop = 'end_turn', respModel = '';
          // usage 合并：Anthropic 系把 input 类放在 message_start.message.usage、
          // output 放在 message_delta.usage，很多第三方端点只给其中一个——
          // 以前只读 message_delta，遇到「只在 message_start 给 input_tokens」
          // 的端点就算出 used=0，圆圈永远显示 0%。这里按字段合并，0 不覆盖已有值
          var mergeUsage = function (u) {
            if (!u) return;
            roundUsage = roundUsage || {};
            ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'].forEach(function (k) {
              if (typeof u[k] === 'number' && (roundUsage[k] == null || u[k] > 0)) roundUsage[k] = u[k];
            });
          };
          await self.pump(resp.body, function (j) {
            if (j.type === 'message_start' && j.message && j.message.model) respModel = j.message.model;
            if (j.type === 'message_start' && j.message) mergeUsage(j.message.usage);
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
              mergeUsage(j.usage);
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
            results.push({ type: 'tool_result', tool_use_id: tu.raw.id, content: String(leg.text || '') || '（无结果）' });
          }
          // 历史追加：assistant 原样 + user tool_result（tool_result 在前，无文本）
          messages = messages.concat([
            { role: 'assistant', content: blocks.map(function (b) { return b.raw; }) },
            { role: 'user', content: results }
          ]);
        }
        // 上下文占用：优先取最后一轮响应的 usage（input + cache_read + cache_creation）
        // ——即本次请求模型实际收到的全部内容（系统/工具/历史）。端点不回 usage、
        // 或只回 output_tokens（不少第三方/中转就这样）时，以前这里 used=0 直接不发
        // ctx:api，圆圈永远停在 0%——用户根本分不清是「没数据」还是「真的没占用」。
        // 改为按请求体估算兜底（与主站 estimateTokens 同一套路），面板标「估算」
        var uIn = (roundUsage && roundUsage.input_tokens) || 0;
        var uCacheRead = (roundUsage && roundUsage.cache_read_input_tokens) || 0;
        var uCacheCreate = (roundUsage && roundUsage.cache_creation_input_tokens) || 0;
        var used = uIn + uCacheRead + uCacheCreate;
        var estSys = Utils.estimateTokens(outbound.body.system || '');
        var estTool = Utils.estimateTokens(JSON.stringify(outbound.body.tools || []));
        var estMsg = Utils.estimateTokens(JSON.stringify(messages));
        var estimated = false;
        if (!(used > 0)) {
          var estTotal = estSys + estTool + estMsg;
          if (estTotal > 0) { used = estTotal; estimated = true; }
        }
        if (used > 0) {
          DSE.emit('ctx:api', {
            used: used, input: uIn, cacheRead: uCacheRead, cacheCreate: uCacheCreate,
            estSys: estSys, estTool: estTool, estMsg: estMsg, estimated: estimated,
            model: respModel || outbound.body.model || ''
          });
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
