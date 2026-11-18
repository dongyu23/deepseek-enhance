/* ============================================================
 * modules/context：会话上下文用量（设置面板展示 + 达阈值轻提示）
 *
 * 用量口径（2026-10-11 官网实测复核）：
 *  - GET /api/v0/chat/history_messages 的每条 chat_message 自带 accumulated_token_usage，
 *    它是【该消息生成时整段上下文的累计 token】。沿当前分支（叶子取
 *    chat_session.current_message_id，向上走 parent_id）取最大值即当前会话真实占用；
 *    不取全局 max——regenerate 会产生分支，老分支叶子上的值可能比当前分支高。
 *    脚本注入前就存在的旧对话也能精确算出，无需文本估算。
 *  - 实时对话 SSE 亦回报 accumulated_token_usage（同一口径），取最新值即可。
 *  - 文本估算（estimateTokens）仅在接口没有真值时兜底；一旦拿到真值就不再参与，
 *    避免把渲染文本（含思考过程/排版标记）算进去而虚高。
 *  - 官网当前模型上下文为 1M（1048576），故固定使用该上限；不再让用户填上限，
 *    改为让用户设定“提醒阈值百分比”，使用量达到即弹一次轻提示。
 *  - 全部按会话 id 隔离。
 * ============================================================ */
var Context = {
  sid: '', live: 0, busy: false, warned: false,
  LIMIT: 1048576,            // 官网当前模型上下文 ≈ 1M
  // 新会话首条消息的挂起用量：那时请求体 chat_session_id 为空、URL 还没切成
  // 新会话、SSE 的 ready/update_session 也不带会话 id——sid 根本拿不到。
  // 以前这段用量整段丢弃，新对话发完第一条面板一直显示 0；现在挂起，等
  // loadSid 见到 sid 再落库
  _pending: 0, _pendingAt: 0, _pendingNoUrl: false,
  // sid 是从在途流（而非 URL）里拿到的：新对话首条消息期间 URL 仍是 /
  _sidFromStream: false,

  loadSid: function (sid) {
    if (!sid) {
      // 欢迎页/新对话：没有会话就清掉上一个会话的占用，别留着旧数字。
      // 但 sid 是从在途流里拿到的时候不能清——新对话首条消息期间 URL 还是 /，
      // 流里已经拿到新 sid 并落了库，这一清会把刚统计到的用量连显示一起抹掉
      if (this.sid && !this._sidFromStream) { this.sid = ''; this.live = 0; this.warned = false; this.emit(); }
      return;
    }
    if (sid !== this.sid) {
      this.sid = sid; this.warned = false;
      this.live = DSE.config.session(sid).serverTokens || 0;
    }
    if (!this._sidFromStream || sid === Utils.currentSid()) this._sidFromStream = false;   // URL 追上来了
    this._applyPending(sid);
    this.emit();
  },
  // 挂起的首条用量落库：30s 内有效，且只落到「还没有任何用量/历史数据的新会话」上
  // ——不能简单要求「存储里没有该 sid」：新对话若预填了系统提示词，prompt 模块的
  // adoptPending 会先把会话条目建出来（只有 assistantSystemPrompt），那样这份用量
  // 就被永远挡死了。反过来，已有用量或历史说明是老会话，不能把这份记到它头上
  _applyPending: function (sid) {
    if (!(this._pending > 0)) return;
    var v = this._pending, fresh = this._pendingNoUrl && Date.now() - this._pendingAt < 30000;
    this._pending = 0; this._pendingNoUrl = false;
    if (!fresh) return;
    var s0 = DSE.config.sessions()[sid];
    if (s0 && ((s0.serverTokens || 0) > 0 || (s0.hist || []).length > 0)) return;
    if (v > this.live) {
      this.live = v;
      var s = DSE.config.session(sid);
      s.serverTokens = v;
      DSE.config.saveSessions();
    }
  },
  setServer: function (sid, v) {
    if (!(v > 0)) return;
    if (!sid) {
      if (!Utils.currentSid()) { this._pending = Math.max(this._pending || 0, v); this._pendingAt = Date.now(); this._pendingNoUrl = true; }
      return;
    }
    if (sid !== Utils.currentSid()) this._sidFromStream = true;   // sid 来自流/请求体，URL 还没切
    this.loadSid(sid);
    if (v !== this.live) {
      this.live = v;
      var s = DSE.config.session(sid);
      s.serverTokens = v;      // 以最新真值为准（刷新后可用更小值纠正）
      DSE.config.saveSessions();
      this.emit();
    }
  },
  // 从历史响应里取权威用量（当前分支叶子节点向上取最大值 = 当前真实占用）
  onHistory: function (payload) {
    try {
      var biz = payload.json && payload.json.data && payload.json.data.biz_data;
      var msgs = biz && biz.chat_messages;
      if (!Array.isArray(msgs)) return;
      var sid = (biz.chat_session && biz.chat_session.id) || this.sid;
      if (!sid) return;
      this.loadSid(sid);
      var text = '';
      msgs.forEach(function (m) { (m.fragments || []).forEach(function (f) { text += f.content || ''; }); });
      // 按当前分支算，不按全局最大值：regenerate 会产生分支，老分支叶子上的
      // accumulated_token_usage 可能比当前分支高，取全局 max 会虚高（官网自己
      // 也是按分支读的）。叶子优先用 chat_session.current_message_id（官网口径），
      // 缺失退数组最后一条，再取不到才退回全局 max
      var byId = {}, last = null;
      msgs.forEach(function (m) { if (m && m.message_id) byId[m.message_id] = m; last = m; });
      var leafId = (biz.chat_session && biz.chat_session.current_message_id) || (last && last.message_id) || '';
      var maxTok = 0, node = byId[leafId], guard = 0;
      while (node && guard++ < 2000) {
        if (typeof node.accumulated_token_usage === 'number') maxTok = Math.max(maxTok, node.accumulated_token_usage);
        node = node.parent_id ? byId[node.parent_id] : null;
      }
      if (!(maxTok > 0)) {
        msgs.forEach(function (m) {
          if (typeof m.accumulated_token_usage === 'number') maxTok = Math.max(maxTok, m.accumulated_token_usage);
        });
      }
      var s = DSE.config.session(sid), changed = false;
      if (maxTok > 0) {
        if (maxTok !== (s.serverTokens || 0)) { s.serverTokens = maxTok; changed = true; }
      } else {
        // 接口无真值时才用文本估算兜底（一般不会走到）
        var est = Utils.estimateTokens(text);
        if (est > 0 && est !== (s.usedTokensEst || 0)) { s.usedTokensEst = est; changed = true; }
      }
      if (changed) { DSE.config.saveSessions(); this.emit(); }
    } catch (e) {}
  },
  getUsage: function () {
    var sid = this.sid || Utils.currentSid();
    var s = sid ? DSE.config.session(sid) : { serverTokens: 0, usedTokensEst: 0 };
    var server = Math.max(s.serverTokens || 0, this.live || 0);
    var used, source;
    if (server > 0) { used = server; source = 'server'; }          // 权威真值优先
    else if (s.usedTokensEst > 0) { used = s.usedTokensEst; source = 'estimate'; }
    else { used = 0; source = 'empty'; }
    var limit = this.LIMIT;
    var pct = Math.max(0, Math.min(100, Math.round(used / limit * 100)));
    var warnPct = DSE.config.get('ctxWarnPct');
    if (!(warnPct > 0)) warnPct = 80;
    return {
      used: used, limit: limit, pct: pct, warnPct: warnPct,
      level: pct >= warnPct ? 'danger' : (pct >= Math.round(warnPct * 0.7) ? 'warn' : 'ok'),
      source: source
    };
  },
  // 达到阈值弹一次轻提示；用量回落后重新武装，避免反复打扰
  checkWarn: function (u) {
    if (!u || u.source === 'empty') return;
    var warnPct = u.warnPct || 80;
    if (u.pct >= warnPct) {
      if (!this.warned) {
        this.warned = true;
        Utils.toast(DSE.t('本会话上下文已使用 {p}%，达到提醒阈值 {t}%，可考虑开启新对话', { p: u.pct, t: warnPct }), 4200);
      }
    } else if (u.pct < warnPct - 5) {
      this.warned = false;
    }
  },
  emit: function () {
    var u = this.getUsage();
    this.checkWarn(u);
    DSE.emit('ctx:update', u);
  },

  // 主动重新统计：拉一次当前会话的 history_messages（与官网同接口），实时重算
  recompute: function () {
    var self = this, sid = Utils.currentSid();
    if (!sid) { Utils.toast(DSE.t('请先进入一个对话')); return Promise.resolve(); }
    if (this.busy) return Promise.resolve();
    this.busy = true; Utils.toast(DSE.t('正在重新统计…'));
    return fetch('/api/v0/chat/history_messages?chat_session_id=' + encodeURIComponent(sid), {
      method: 'GET', credentials: 'include', headers: { 'Accept': 'application/json' }
    }).then(function (r) { return r.text(); }).then(function (txt) {
      var json = JSON.parse(txt);
      var s = DSE.config.session(sid); s.serverTokens = 0; s.usedTokensEst = 0; self.live = 0;
      self.onHistory({ json: json });
      // DOM 兜底：仅当接口没有真值时，才用当前已渲染消息文本估算
      if (!(s.serverTokens > 0)) {
        var domText = '';
        document.querySelectorAll('.ds-markdown, .fbb737a4').forEach(function (n) { domText += n.innerText || ''; });
        var est = Utils.estimateTokens(domText);
        if (est > 0) { s.usedTokensEst = est; DSE.config.saveSessions(); }
      }
      self.loadSid(sid);
      var u = self.getUsage();
      Utils.toast(DSE.t('统计完成：约') + ' ' + (u.used >= 1000 ? (u.used / 1000).toFixed(1) + 'K' : u.used) + ' ' + DSE.t('tokens'));
    }).catch(function () { Utils.toast(DSE.t('统计失败（可能需要联网）')); })
      .then(function () { self.busy = false; });
  },

  init: function () {
    var self = this;
    // 拦截层在 document-start 就装好了，history/SSE 响应可能早于本模块 init 到达
    // （事件发了没人听）——把 net 记住的最后一份补放一次，否则那一段用量整段丢失
    if (DSE.net) {
      if (DSE.net.lastHistory) this.onHistory(DSE.net.lastHistory);
      if (DSE.net.lastTokens) this.setServer((DSE.net.lastTokens.ctx && DSE.net.lastTokens.ctx.sid) || Utils.currentSid(), DSE.net.lastTokens.used);
    }
    DSE.on('sse:tokens', function (p) { self.setServer(p.ctx.sid || Utils.currentSid(), p.used); });
    DSE.on('history:loaded', function (p) {
      self.loadSid(p.ctx.sid || Utils.currentSid()); self.onHistory(p);
    });
    // 轮询改为一律调用：loadSid('') 会清掉上一个会话的占用（欢迎页不该显示
    // 旧会话数字），顺带把挂起的首条用量在 sid 一出现时落库
    setInterval(function () { self.loadSid(Utils.currentSid()); }, 1000);
    DSE.on('cfg:change', function (e) { if (e.path === 'ctxWarnPct') { self.warned = false; self.emit(); } });
  }
};
DSE.modules.context = Context;
