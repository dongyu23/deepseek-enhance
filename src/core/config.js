/* ============================================================
 * core/config：统一配置（全局 + 按会话隔离），带出厂默认与缺省补齐
 *  设计原则：只做“单会话助手”，系统提示词按会话隔离，绝不跨会话混淆。
 * ============================================================ */
var CFG_KEY = 'dse_config_v1';
var SESS_KEY = 'dse_sessions_v1';

var DEFAULT_BG = 'https://t.alcy.cc/ycy';

// 出厂默认 = 正常 AI 助手
var DEFAULT_CONFIG = {
  // 外观
  bg: { enabled: true, url: DEFAULT_BG, blur: 0, brightness: 100, upload: '' }, // upload=本地dataURL，优先于url
  bubblePreset: 'frosted',               // default / frosted / water
  inputFrosted: true,                    // 输入框悬浮磨砂玻璃
  zoom: 100,
  fixTopbar: true,                       // 顶栏统一开关
  topbarStyle: 'transparent',            // frosted=磨砂统一 / transparent=背景直接透出
  hideDownloadApp: true,                 // 仅隐藏欢迎页“下载应用”（保留其它按钮）
  navButtons: true,                      // 消息上下导航
  fullscreenBtn: true,

  // 对话
  thinkAutoCollapse: true,               // 思考区自动折叠（默认折叠）
  codeFold: true,                        // 代码块超行数自动折叠
  codeFoldLines: 10,                     // 代码块默认显示行数
  hideAiBadge: true,                     // 隐藏“内容由 AI 生成”等标识
  markdownPretty: true,                  // 仅本地美化官网 markdown 渲染，不向 AI 发任何指令
  latexRender: true,                     // KaTeX 公式渲染（官网默认不渲染 \( \)/\[ \]/$...$）
  timeInject: false,                     // 时间注入
  ctxWarnPct: 80,                        // 上下文用量提醒阈值（百分比，达阈值弹提示）
  demoCustom: false,                      // chat-demo 页自定义模型总开关：关=完全官方逻辑（DeepSeek 模型/端点/搜索，脚本零干预）
  demoEndpoint: '',                      // chat-demo 页 API 端点覆盖（空=官方 api.deepseek.com/anthropic/v1；不含 /messages）
  demoKey: '',                           // chat-demo 页 API Key 覆盖（空=用页面里填的官方 Key）
  demoModel: '',                         // chat-demo 页模型覆盖（空=用官方默认 deepseek-flash）
  demoMultimodal: true,                  // 自定义模型是否支持图片：开=图片转 base64 内联发出；关=换成文字说明（纯文本模型开着也是白搭 token）
  demoCtxLimit: 128000,                   // 自定义模型的上下文窗口（tokens，用于占用环百分比；按所用模型自行调整）
  demoToolMode: 'native',                // 自定义端点时的工具调用方式：native=DeepSeek 模型在对话中驱动搜索（含模型 token 费）/ searchapi=直调独立搜索 API（仅付 $0.75/1000 次）
  demoBridge: 'auto',                   // 第三方端点时的工具桥接：auto(端点非 deepseek 即启用) / on / off
  demoTitleSource: 'deepseek',          // 第三方端点时的会话标题来源：deepseek=起名腿打 DeepSeek 官方端点（title 参数，约 $0.001/次）/ model=当前自定义模型按提示词起名（费用走第三方）/ off=不起名，用首条消息截断

  // 单会话系统提示词（独立开关，按会话隔离）
  systemPromptEnabled: false,

  // 隐私 / 防撤回：off / smart / full
  privacyMode: 'smart',
  privacyCtxMessages: 30,                // 全量模式拼接历史条数
  recallBriefHint: true,                 // 提示 AI 遇到已撤回消息时简短回应

  // 可编辑注入模板（prompt 模块首次运行时用默认值补齐）
  templates: {}
};

function cloneDefaults() { return JSON.parse(JSON.stringify(DEFAULT_CONFIG)); }

var Config = {
  _cache: null,
  _sessCache: null,
  defaults: DEFAULT_CONFIG,
  load: function () {
    if (this._cache) return this._cache;
    var saved = Bridge.get(CFG_KEY, null);
    var cfg = cloneDefaults();
    if (saved && typeof saved === 'object') {
      this._merge(cfg, saved);
      // 旧配置迁移：demoAutoTitle（布尔开关）→ demoTitleSource（三选一）。
      // _merge 只合并在 defaults 里存在的键，旧键会被静默丢弃——不在这里显式
      // 映射的话，"关过起名"的用户升级后会被默认值重新打开
      if (saved.demoAutoTitle === false && !('demoTitleSource' in saved)) cfg.demoTitleSource = 'off';
    }
    this._cache = cfg;
    return cfg;
  },
  _merge: function (base, over) {
    Object.keys(over).forEach(function (k) {
      if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) &&
          base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
        this._merge(base[k], over[k]);
      } else if (k in base) {
        base[k] = over[k];
      }
    }.bind(this));
  },
  save: function () { Bridge.set(CFG_KEY, this._cache); },
  get: function (path) {
    var c = this.load();
    if (!path) return c;
    var ps = path.split('.'); var cur = c;
    for (var i = 0; i < ps.length; i++) { if (cur == null) return undefined; cur = cur[ps[i]]; }
    return cur;
  },
  set: function (path, val) {
    var c = this.load();
    var ps = path.split('.'); var cur = c;
    for (var i = 0; i < ps.length - 1; i++) cur = cur[ps[i]];
    cur[ps[ps.length - 1]] = val;
    this.save();
    DSE.emit('cfg:change', { path: path, value: val });
  },
  reset: function () { this._cache = cloneDefaults(); this.save(); },

  /* ---- 按会话存储（系统提示词/防撤回历史/上下文用量），严格按 sid 隔离 ---- */
  sessions: function () {
    if (!this._sessCache) this._sessCache = Bridge.get(SESS_KEY, {}) || {};
    return this._sessCache;
  },
  session: function (sid) {
    if (!sid && DSE.utils) sid = DSE.utils.currentSid();
    var all = this.sessions();
    if (!all[sid]) all[sid] = { assistantSystemPrompt: '', hist: [], usedTokens: 0, serverTokens: 0 };
    return all[sid];
  },
  saveSessions: function () { Bridge.set(SESS_KEY, this._sessCache); },
  setSession: function (sid, patch) {
    var s = this.session(sid);
    Object.assign(s, patch);
    this.saveSessions();
  }
};

DSE.config = Config;
DSE.DEFAULT_BG = DEFAULT_BG;
DSE.register('config', Config);
