/* ============================================================
 * modules/pastescroll：粘贴 / 拖放后输入框自动滚动到光标处
 *  - 官网输入框增高到上限后转为内部滚动，长文粘贴后视口停在顶部，
 *    光标（粘贴落点）在视野外，要手动拖滚动条才能确认落点。
 *  - 用镜像 div 复刻输入框排版来测算光标的像素位置；仅当光标超出
 *    可视区时才滚动（滚到可视区中部），无内部滚动的小粘贴零感知。
 * ============================================================ */
var PasteScroll = {
  MIRROR_PROPS: ['width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderLeftWidth', 'borderRightWidth',
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant',
    'letterSpacing', 'wordSpacing', 'lineHeight', 'textTransform', 'textIndent',
    'boxSizing', 'tabSize'],

  // 光标在内容坐标系（未滚动）中的 y 像素位置
  caretY: function (ta, pos) {
    var cs = getComputedStyle(ta);
    var div = document.createElement('div');
    for (var i = 0; i < this.MIRROR_PROPS.length; i++) {
      div.style[this.MIRROR_PROPS[i]] = cs[this.MIRROR_PROPS[i]];
    }
    div.style.position = 'absolute';
    div.style.visibility = 'hidden';
    div.style.left = '-9999px';
    div.style.top = '0';
    div.style.height = 'auto';
    div.style.whiteSpace = 'pre-wrap';
    div.style.overflowWrap = 'break-word';
    document.body.appendChild(div);
    div.textContent = ta.value.slice(0, pos);
    var marker = document.createElement('span');
    marker.textContent = '\u200b';
    div.appendChild(marker);
    var y = marker.getBoundingClientRect().top - div.getBoundingClientRect().top;
    div.remove();
    return y;
  },

  scrollToCaret: function (ta) {
    var pos = ta.selectionStart;
    if (pos == null || !ta.isConnected) return;
    if (ta.scrollHeight <= ta.clientHeight + 4) return; // 无内部滚动，无需定位
    var cs = getComputedStyle(ta);
    var lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4 || 20;
    var y = this.caretY(ta, pos);
    var visibleTop = ta.scrollTop + lh;
    var visibleBottom = ta.scrollTop + ta.clientHeight - lh * 2;
    if (y >= visibleTop && y <= visibleBottom) return; // 光标已可见，不打扰
    ta.scrollTop = Math.max(0, Math.round(y + lh / 2 - ta.clientHeight / 2)); // 滚到中部
  },

  // 粘贴默认行为写入 value 之后才能读到 selectionStart；
  // 官网是 React 受控组件，下一拍可能重写 value，双 rAF 再校正一次
  onSettle: function (ta) {
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { PasteScroll.scrollToCaret(ta); });
    });
  },

  isTargetTextarea: function (e) {
    var t = e.target;
    if (!t || t.tagName !== 'TEXTAREA' || t.disabled || t.readOnly) return false;
    if (t.closest && t.closest('#dse-panel')) return false; // 设置面板自家的输入框不处理
    return true;
  },

  init: function () {
    var self = this;
    ['paste', 'drop'].forEach(function (type) {
      document.addEventListener(type, function (e) {
        if (!DSE.config.get('pasteScroll')) return;
        if (self.isTargetTextarea(e)) self.onSettle(e.target);
      }, true);
    });
  }
};
DSE.modules.pasteScroll = PasteScroll;
