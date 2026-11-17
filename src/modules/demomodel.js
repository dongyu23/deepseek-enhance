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
 * 协议实测（2026-11-17，bundle 分析）：demo 用 Anthropic Messages API，
 * POST {api.deepseek.com}/anthropic/v1/messages，头 x-api-key，SSE 流式。
 * 该 URL 模式只存在于 demo 页，主站（/api/v0/chat/completion）不受影响。
 * ============================================================ */
var DemoModel = {
  KEY: 'demoModel',

  // 当前配置的模型（空 = 不干预）
  model: function () {
    var v = (DSE.config.get(this.KEY) || '').trim();
    return v;
  },

  init: function () {
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
            init = {};
            // 复制原 init 的其余字段（method/headers/signal 等）
            for (var k in arguments[1]) if (Object.prototype.hasOwnProperty.call(arguments[1], k)) init[k] = arguments[1][k];
            init.body = JSON.stringify(body);
          }
        }
      } catch (e) {}
      return orig.call(this, input, init);
    };
  }
};
DSE.modules.demoModel = DemoModel;
