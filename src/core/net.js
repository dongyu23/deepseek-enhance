/* ============================================================
 * core/net：统一网络层（只 patch 一次）
 *  - 请求体改写管线（系统提示词/防撤回回填的注入点：prompt 字段）
 *  - SSE 事件解析工具 parseSSE（由防撤回层在拿到最终文本后调用）
 *  - 历史文本工具：剥离 ⟦DSE⟧ 注入块、发出 history:loaded
 *  注意：response/responseText 的实例改写统一由 modules/antirecall.js
 *  按最初可用版本（v7.2）的方式拥有，本文件不再重复定义 getter，避免两层互相覆盖。
 * ============================================================ */
var Net = {
  _reqMutators: [],
  _patched: false,
  // 最后一份命中数据：拦截层在 document-start 就装好，但 history/SSE 响应可能
  // 早于 context 模块 init 到达（事件发了没人听）——这里各留一份，init 时补放
  lastHistory: null,
  lastTokens: null,

  isGenUrl: function (u) {
    return /\/api\/v0\/chat\/(completion|regenerate|edit_message|continue|resume_stream)/.test(u || '');
  },
  isHistoryUrl: function (u) {
    return /\/api\/v0\/(chat\/history_messages|chat_session\/fetch_page)/.test(u || '');
  },
  addRequestMutator: function (fn) { this._reqMutators.push(fn); },

  // fetch 兜底：站点部分链路（如 resume_stream）走 fetch 而非 XHR，以前只改写
  // 请求体、响应整段漏掉——用量统计在这些链路上永远不激活。这里对命中 URL 的
  // 响应做 clone 旁路解析：原响应照常返回给站点，clone 只读来发事件，互不干扰
  _patchFetch: function () {
    var self = this;
    var origFetch = window.fetch;
    if (!origFetch) return;
    window.fetch = function (input, init) {
      var url = '', isGen = false, isHist = false, ctx = null;
      try {
        url = typeof input === 'string' ? input : (input && input.url) || '';
        isGen = self.isGenUrl(url); isHist = self.isHistoryUrl(url);
        if (isGen || isHist) {
          ctx = {
            url: url, isGen: isGen, isHistory: isHist, sid: '',
            sse: { reqMid: null, respMid: null, tokens: 0, finished: false, rawLast: 0, ev: '' }
          };
          if (init && typeof init.body === 'string' && init.body.charAt(0) === '{') {
            try {
              var obj = JSON.parse(init.body);
              ctx.sid = obj.chat_session_id || '';
              self._reqMutators.forEach(function (fn) { try { fn(obj, ctx); } catch (e) { console.error('[DSE reqMutator]', e); } });
              init = Object.assign({}, init, { body: JSON.stringify(obj) });
            } catch (e) {}
          }
          DSE.emit('net:send', ctx);
        }
      } catch (e) {}
      var p = origFetch.call(this, input, init);
      if (!ctx || !p || typeof p.then !== 'function') return p;
      return p.then(function (resp) {
        try {
          if (resp && typeof resp.clone === 'function') {
            var c = resp.clone();
            if (isHist) c.text().then(function (txt) { self.handleHistory(txt, ctx); }, function () {});
            else c.text().then(function (txt) { self.parseSSE(txt, ctx); }, function () {});
          }
        } catch (e) {}
        return resp;
      });
    };
  },

  init: function () {
    if (this._patched) return; this._patched = true;
    var self = this;
    var origOpen = XMLHttpRequest.prototype.open;
    var origSend = XMLHttpRequest.prototype.send;
    var origSetHeader = XMLHttpRequest.prototype.setRequestHeader;

    XMLHttpRequest.prototype.open = function (method, url) {
      this._dseUrl = (url || '').split('?')[0];
      this._dseMethod = method;
      this._dseHeaders = {};
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
      try { if (this._dseHeaders) this._dseHeaders[k] = v; } catch (e) {}
      return origSetHeader.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
      var xhr = this, url = xhr._dseUrl || '';
      var isGen = self.isGenUrl(url), isHist = self.isHistoryUrl(url);
      if (!isGen && !isHist) return origSend.apply(this, arguments);
      var ctx = {
        url: url, isGen: isGen, isHistory: isHist,
        sid: '', sse: { reqMid: null, respMid: null, tokens: 0, finished: false, rawLast: 0, ev: '' }
      };
      if (typeof body === 'string' && body.charAt(0) === '{') {
        try {
          var obj = JSON.parse(body);
          ctx.sid = obj.chat_session_id || '';
          self._reqMutators.forEach(function (fn) { try { fn(obj, ctx); } catch (e) { console.error('[DSE reqMutator]', e); } });
          body = JSON.stringify(obj);
        } catch (e) {}
      }
      DSE.emit('net:send', ctx);
      xhr._dseCtx = ctx;
      xhr.addEventListener('load', function () { DSE.emit('net:load', ctx); });
      return origSend.call(this, body);
    };

    this._patchFetch();
  },

  // 由防撤回层对【最终 SSE 文本】增量解析事件（token/ready/finished）
  parseSSE: function (text, ctx) {
    var s = ctx.sse;
    try {
      var tail = text.substring(s.rawLast);
      // 只处理到最后一个完整行为止，末尾半行留给下一次读取（站点自己的解析器
      // 也是 lastIndexOf('\n') 这么干）。以前一律 rawLast = text.length，分片
      // 恰好从一行中间切开时那条事件被永久吞掉——accumulated_token_usage 偶尔
      // 不更新、实时用量卡住，就是这里漏的
      var cut = tail.lastIndexOf('\n');
      if (cut < 0) return;
      var lines = tail.substring(0, cut).split('\n');
      s.rawLast += cut + 1;
      for (var li = 0; li < lines.length; li++) {
        var ln = lines[li];
        if (ln.indexOf('event:') === 0) s.ev = ln.slice(6).trim();
        if (ln.indexOf('data:') !== 0) continue;
        var payload = ln.replace(/^data:\s*/, '');
        if (!payload || payload === '[DONE]') continue;
        var data; try { data = JSON.parse(payload); } catch (e) { continue; }
        // 新会话首条消息：请求体 chat_session_id 为空、URL 还没切成新会话，
        // 但流里会带会话 id——先补进 ctx，setServer 才落得了库
        if (!ctx.sid && typeof data.chat_session_id === 'string' && data.chat_session_id) ctx.sid = data.chat_session_id;
        if (s.ev === 'ready' && data.request_message_id) {
          s.reqMid = data.request_message_id; s.respMid = data.response_message_id;
          DSE.emit('sse:ready', { ctx: ctx, data: data });
        }
        var used = this._pickTokens(data);
        if (used != null) {
          s.tokens = used;
          this.lastTokens = { used: used, ctx: ctx };
          DSE.emit('sse:tokens', { used: used, ctx: ctx });
        }
        var finished = (data.p === 'response/status' && data.v === 'FINISHED') ||
          (data.p === 'response' && data.o === 'BATCH' && Array.isArray(data.v) &&
            data.v.some(function (x) { return x.p === 'status' && x.v === 'FINISHED'; })) ||
          s.ev === 'close';
        if (finished && !s.finished) { s.finished = true; DSE.emit('sse:finished', { ctx: ctx }); }
        DSE.emit('sse:data', { data: data, ctx: ctx, event: s.ev });
      }
    } catch (e) {}
  },

  _pickTokens: function (data) {
    if (data.v && data.v.response && typeof data.v.response.accumulated_token_usage === 'number')
      return data.v.response.accumulated_token_usage;
    if (data.p === 'response' && data.o === 'BATCH' && Array.isArray(data.v)) {
      var best = null;
      for (var i = 0; i < data.v.length; i++)
        if (data.v[i].p === 'accumulated_token_usage' && typeof data.v[i].v === 'number') best = data.v[i].v;
      return best;
    }
    if (data.p === 'response/accumulated_token_usage' && typeof data.v === 'number') return data.v;
    return null;
  },

  // 去掉历史里服务端原样存下的注入指令块（⟦DSE⟧…⟦/DSE⟧）
  _stripInjected: function (node) {
    var RE = /⟦DSE⟧[\s\S]*?⟦\/DSE⟧\n?/g;
    var walk = function (n) {
      if (typeof n === 'string') {
        if (n.indexOf('⟦DSE⟧') === -1) return n;
        return n.replace(RE, '').replace(/\n{3,}/g, '\n\n').replace(/^\s+|\s+$/g, '');
      }
      if (Array.isArray(n)) { for (var i = 0; i < n.length; i++) n[i] = walk(n[i]); return n; }
      if (n && typeof n === 'object') { Object.keys(n).forEach(function (k) { n[k] = walk(n[k]); }); return n; }
      return n;
    };
    return walk(node);
  },

  // 历史响应：剥离注入块 + 发出 history:loaded，返回处理后的数据
  // raw 可以是字符串（responseType=text，站点默认）也可以是已解析对象
  // （responseType=json）——后者以前整段跳过，history:loaded 从不触发，
  // 面板用量永远停在 0
  handleHistory: function (raw, ctx) {
    var parsed = null, wasString = typeof raw === 'string';
    if (wasString) {
      try { parsed = JSON.parse(raw); } catch (e) { return raw; }
    } else if (raw && typeof raw === 'object') {
      parsed = raw;
    } else return raw;
    parsed = this._stripInjected(parsed);
    this.lastHistory = { json: parsed, ctx: ctx };
    DSE.emit('history:loaded', { json: parsed, ctx: ctx });
    return wasString ? JSON.stringify(parsed) : parsed;
  }
};
DSE.net = Net;
DSE.register('net', Net);
