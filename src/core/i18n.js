/* ============================================================
 * core/i18n：界面中英文（以中文字符串为 key，缺省回退中文）
 *  - lang = auto：按 navigator.language 自动判定（zh* → 中文，其余 → English）
 *  - lang = zh / en：手动覆盖
 *  - 只做中英文；未收录的 key 原样返回中文，保证不出现空串
 * ============================================================ */
var I18N = {
  dict: {
    // ---------- 通用 ----------
    '外观': 'Appearance',
    '对话': 'Chat',
    '提示词': 'Prompt',
    '其他': 'More',
    '界面': 'Interface',
    '关于': 'About',
    '上传': 'Upload',
    '默认图': 'Default',
    '关闭背景': 'Disable',
    '模糊': 'Blur',
    '亮度': 'Brightness',
    '页面缩放': 'Page zoom',
    '恢复默认': 'Reset',
    '展开': 'Expand',
    '收起': 'Collapse',

    // ---------- 外观 ----------
    '背景图片': 'Background image',
    '图片 URL，留空用默认图': 'Image URL, leave empty for default',
    '气泡材质': 'Bubble style',
    '默认': 'Default',
    '清爽浅色气泡': 'Clean light bubbles',
    'iOS 磨砂': 'iOS Frosted',
    '高饱和毛玻璃': 'High-saturation blur',
    '水玻璃': 'Aqua glass',
    '通透高光（推荐）': 'Translucent highlight (recommended)',
    '输入框悬浮磨砂': 'Floating frosted input',
    '统一顶栏': 'Unified top bar',
    '消除分享按钮单独底色/标题黑条': 'Remove the share-button patch and title bar',
    '磨砂': 'Frosted',
    '背景透出': 'Transparent',
    '隐藏“下载应用”': 'Hide "Download app"',
    '仅欢迎页，不影响新建对话/侧栏按钮': 'Welcome page only; keeps other buttons',

    // ---------- 对话 ----------
    '消息呈现': 'Messages',
    '思考区自动折叠': 'Auto-collapse thinking',
    '默认收起 DeepSeek 思考过程': 'Collapse DeepSeek reasoning by default',
    '代码块自动折叠': 'Auto-collapse code blocks',
    '超过设定行数自动收起，点击展开': 'Collapse when longer than the limit; click to expand',
    '代码块显示行数': 'Code lines shown',
    '隐藏 AI 生成标识': 'Hide AI notice',
    '底部“内容由 AI 生成”等': 'The "AI-generated" notice at the bottom',
    'Markdown 排版美化': 'Markdown styling',
    '只改本地样式，不向 AI 发送任何指令': 'Local styling only; sends nothing to the AI',
    'LaTeX 公式渲染': 'LaTeX rendering',
    '离线 KaTeX，渲染 \\( \\)、\\[ \\]、$ 公式': 'Offline KaTeX for \\( \\), \\[ \\], $ formulas',
    '隐式时间注入': 'Implicit time injection',
    // ---------- chat-demo 模型切换 ----------
    'API 端点': 'API endpoint',
    '自定义模型': 'Custom model',
    '工具调用方式': 'Tool invocation',
    '只填消息接口地址：到 /messages 为止，不要包含 /messages 本身（例：https://api.stepfun.com/step_plan/v1）。留空 = 官方 https://api.deepseek.com/anthropic/v1': 'Messages endpoint only: up to but excluding /messages itself (e.g. https://api.stepfun.com/step_plan/v1). Leave empty for the official https://api.deepseek.com/anthropic/v1',
    '模型要搜索时，谁来执行：native=交给 DeepSeek 的模型在对话里完成，能多轮搜、能读网页，但每轮搜索另付约 2 分钱模型费；searchapi=直接调 DeepSeek 的搜索接口，一次约 0.00075 美元、不经模型，搜什么由当前模型决定。两种在界面上看起来一样': 'Who runs the search when the model asks for one: native = the DeepSeek model does it inside the conversation (multi-round search and page reads; each round costs about 2 cents in model tokens). searchapi = call the DeepSeek search API directly, about $0.00075 per call, no model involved; the current model decides what to search. Both look identical in the UI',
    '模型要搜索时谁来执行：native=DeepSeek 的模型自己搜，另付约 2 分钱/轮模型费；searchapi=直调搜索接口，每次约 0.00075 美元、不经模型': 'Who runs a search when the model asks: native = the DeepSeek model searches itself (about 2 cents per round in model fees); searchapi = call the search API directly (about $0.00075 per call, no model involved)',
    '起名来源': 'Title source',
    'deepseek：官方起名腿': 'deepseek: official title leg',
    'model：自定义模型起名': 'model: custom model titles it',
    'off：用首条消息截断': 'off: truncated first message',
    '新对话首轮回答后生成会话标题的来源：deepseek=打 DeepSeek 官方端点用 title 参数起名（约 $0.001/次、标题质量官方级、用页面里那把 DeepSeek Key）；model=让当前自定义模型按提示词起名（一次极小非流式请求、费用走当前端点、不经 DeepSeek）；off=不起名，用首条消息截断。任一来源失败都退回首条消息截断': 'Who generates the session title after the first reply of a new chat: deepseek = a title leg against the official DeepSeek endpoint using the title parameter (about $0.001 per call, official-quality titles, uses the DeepSeek key entered on the page); model = the current custom model titles it from a prompt (one tiny non-streaming request, billed to the current endpoint, no DeepSeek involved); off = no title, truncated first message. Any source falls back to the truncated first message on failure',
    'deepseek：官方起名腿，约 $0.001/次；model：自定义模型起名，费用走当前端点；off：用首条消息截断': 'deepseek: official title leg, about $0.001 per call; model: titled by the custom model, billed to the current endpoint; off: truncated first message',
    // 会话搜索（官方主站同款文案）
    '搜索对话内容...': 'Search conversation content...',
    '暂无相关结果': 'No matching results',
    '新对话': 'New chat',
    'native：模型自己搜': 'native: model-driven',
    'searchapi：只付搜索费': 'searchapi: search fee only',
    'native（原生）': 'native (native tools)',
    '上下文容量': 'Context capacity',
    '消息': 'Messages',
    '系统提示词': 'System prompt',
    '系统工具': 'Tools',
    '平均缓存命中率': 'Avg cache hit rate',
    '总量与缓存命中率为接口 usage 精确值；构成占比按请求结构估算': 'Total and cache hit rate are exact values from the API usage; the composition split is estimated from the request structure',
    '上下文占用': 'Context usage',
    '上下文窗口': 'Context window',
    '所用模型的上下文窗口（tokens）。输入框旁的圆圈按 占用/窗口 显示百分比': 'The context window of the model in use (tokens). The ring beside the input box shows usage / window as a percentage',
    '来自模型接口返回的 usage 精确值（系统提示 + 工具 + 完整历史）': 'Exact value from the usage field returned by the model API (system prompt + tools + full history)',
    '测试连接与模型身份': 'Test connection & model identity',
    '测试': 'Test',
    '测试中…': 'Testing…',
    '连接成功': 'Connected',
    '连接失败': 'Connection failed',
    '请求失败': 'Request failed',
    '模型自述': 'Model says',
    '（未获得文本回复）': '(no text reply)',
    '（浏览器安全策略拦截了跨域请求，可在高级选项切换鉴权头试试）': '(blocked by browser CORS policy — try switching the auth header in Advanced options)',
    '你是什么AI模型？请用一句话直接说明你的模型名称和开发方，不要复述这个问题。': 'What AI model are you? State your model name and developer in one sentence. Do not repeat this question.',
    '鉴权头': 'Auth header',
    '工具桥接': 'Tool bridge',
    'x-api-key（默认）或 authorization（Bearer）。StepFun 等端点的 CORS 只放行 Authorization': 'x-api-key (default) or authorization (Bearer). StepFun and similar endpoints only allow Authorization via CORS',
    'auto=端点非 deepseek 时启用（默认）；on=强制启用；off=关闭（工具随端点丢失）': 'auto = enabled when the endpoint is not deepseek (default); on = force; off = disabled (tools lost with the endpoint)',
    'API Key': 'API key',
    '（用页面里填的官方 Key）': '(use the official key entered on the page)',
    '留空 = 用官方设置里填的 Key；填写则替换请求头 x-api-key': 'Leave empty to use the key entered in the official settings; a value here replaces the x-api-key request header',
    '模型': 'Model',
    'deepseek-flash（官方默认）': 'deepseek-flash (official default)',
    '留空 = 官方默认 deepseek-flash；只更换请求中的 model 字段，端点 / Key / 工具一律不变': 'Leave empty for the official default (deepseek-flash). Only the model field in the request is swapped; endpoint, key and tools stay untouched',
    '本会话上下文用量': 'Session context usage',
    '提醒阈值': 'Warning threshold',
    '当前模型上下文约 1M；用量达到该百分比时弹一次提醒。': 'The current model context is about 1M. A reminder pops up when usage reaches this percentage.',
    '（已达提醒阈值）': ' (warning threshold reached)',
    '立即重新统计（拉取本会话历史）': 'Recount now (fetch this session history)',
    '约': 'About',
    '（估算）': ' (estimated)',
    '本会话上下文已使用 {p}%，达到提醒阈值 {t}%，可考虑开启新对话': 'Context usage of this session reached {p}% (warning threshold {t}%). Consider starting a new chat.',

    // ---------- 提示词 ----------
    '本会话系统提示词': 'Session system prompt',
    '只对当前这一个会话生效；切换到其它会话互不影响、互不可见。': 'Applies to this session only; each session is independent and private.',
    '启用本会话系统提示词': 'Enable session system prompt',
    '写给当前会话 AI 的系统设定…': 'System setup for this session\'s AI…',
    '高级：实际注入内容预览 / 模板': 'Advanced: injected preview / templates',
    '撤回后简短回应（模板，可编辑）': 'Brief reply after recall (editable template)',
    '预览实际注入': 'Preview injection',

    // ---------- 其他 ----------
    '防撤回 / 隐私': 'Anti-recall / Privacy',
    '关闭': 'Off',
    '智能': 'Smart',
    '全量': 'Full',
    '智能：连续撤回连续补回；服务端重载上下文后只补最新缺失轮次。全量：每次发送都拼接本地历史。': 'Smart: refill recalled rounds continuously; after the server reloads context only the latest missing round is refilled. Full: attach local history to every message.',
    '撤回后提示 AI 简短回应': 'Ask AI for a brief reply after recall',
    '降低再次撤回概率与 prompt 压力': 'Lower re-recall risk and prompt load',
    '全量历史条数': 'History messages (full mode)',
    '清除本会话本地历史': 'Clear local history for this session',
    '便捷功能': 'Shortcuts',
    '消息上下导航按钮': 'Message navigation buttons',
    '一键全屏按钮': 'Fullscreen button',
    '语言': 'Language',
    '自动': 'Auto',
    '中文': '中文',
    '界面语言（跟随系统 / 中文 / English）': 'Interface language (system / Chinese / English)',
    '本地记录 {n} 条': 'Local records: {n}',
    '，待回填撤回 {n} 条': ', to refill {n}',

    // ---------- 按钮 title / toast ----------
    '上一条消息': 'Previous message',
    '下一条消息': 'Next message',
    '一键全屏': 'Fullscreen',
    'DeepSeek Enhance 设置': 'DeepSeek Enhance settings',
    '图片不要超过 8MB': 'Image must be under 8MB',
    '请先进入一个对话': 'Open a conversation first',
    '正在重新统计…': 'Recounting…',
    '统计完成：约': 'Done: about ',
    'tokens': 'tokens',
    '统计失败（可能需要联网）': 'Failed (network required?)',
    '已拦截一次撤回，真实内容已本地保留': 'Recall intercepted; content kept locally',

    // ---------- 关于 ----------
    'GitHub 仓库': 'GitHub repo',
    '个人主页': 'Homepage'
  },
  _lang: null,
  resolve: function () {
    var pref = (DSE.config && DSE.config.get('lang')) || 'auto';
    if (pref === 'zh' || pref === 'en') return pref;
    var nav = String((navigator.language || navigator.userLanguage || 'en')).toLowerCase();
    return nav.indexOf('zh') === 0 ? 'zh' : 'en';
  },
  lang: function () { if (!this._lang) this._lang = this.resolve(); return this._lang; },
  refresh: function () { this._lang = this.resolve(); return this._lang; },
  t: function (key, params) {
    var l = this.lang();
    var d = this.dict;
    var s;
    if (l === 'en' && typeof d[key] === 'string') s = d[key];
    else s = key;
    if (params) {
      s = s.replace(/\{(\w+)\}/g, function (m, k) { return (params[k] != null ? params[k] : m); });
    }
    return s;
  }
};
DSE.i18n = I18N;
DSE.t = function (k, p) { return I18N.t(k, p); };
DSE.register('i18n', I18N);
