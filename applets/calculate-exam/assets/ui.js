/* =========================================================
   ui.js · 卡通界面组件：排行榜渲染、Banner 轮播、庆祝特效、轻提示
   ========================================================= */
(function (global) {
  'use strict';

  var C = global.CalcCore;
  var $ = C.$;

  /* ---------- 排行榜行渲染 ---------- */
  var MEDALS = ['🥇', '🥈', '🥉'];

  function boardRow(rank, row, meName) {
    var isMe = meName && row.player === meName;
    var node = C.el('div', 'board-row' + (isMe ? ' is-me' : ''));
    node.style.animationDelay = (rank * 30) + 'ms';
    var rankText = rank < 3 ? MEDALS[rank] : String(rank + 1);
    node.innerHTML =
      '<span class="br-rank">' + rankText + '</span>' +
      '<span class="br-name">' + C.escapeHtml(row.player) + '</span>' +
      '<span class="br-score">' + Number(row.score) + '</span>' +
      '<span class="br-time">' + C.fmtClock(Number(row.time_ms)) + '</span>';
    return node;
  }

  function renderBoard(container, rows, meName) {
    container.innerHTML = '';
    if (!rows.length) {
      var empty = C.el('div', 'br-empty', '🫧 还没有人上榜，等你来霸榜～');
      container.appendChild(empty);
      return;
    }
    rows.forEach(function (row, i) {
      container.appendChild(boardRow(i, row, meName));
    });
  }

  /* ---------- Banner 轮播：5 秒自动切换 + 手动左右滑动 ---------- */
  function Banner(opts) {
    this.track = opts.track;
    this.viewport = opts.viewport;
    this.dotsBox = opts.dots;
    this.titleBox = opts.title;
    this.onChange = opts.onChange || function () {};
    this.count = opts.count;
    this.interval = opts.interval || 5000;
    this.index = 0;
    this.timer = null;
    this.dragging = false;
    this.startX = 0;
    this.deltaX = 0;
    this.width = 1;
    this._buildDots();
    this._bindDrag();
    this._apply(false);
  }

  Banner.prototype._buildDots = function () {
    var self = this;
    this.dotsBox.innerHTML = '';
    this.dots = [];
    for (var i = 0; i < this.count; i++) {
      (function (idx) {
        var dot = C.el('button', 'dot');
        dot.type = 'button';
        dot.title = '第 ' + (idx + 1) + ' 个榜单';
        dot.addEventListener('click', function () {
          self.go(idx);
          self.restart();
        });
        self.dotsBox.appendChild(dot);
        self.dots.push(dot);
      })(i);
    }
  };

  Banner.prototype._apply = function (animate) {
    this.track.style.transition = animate ? 'transform .45s cubic-bezier(.22,.9,.25,1)' : 'none';
    this.track.style.transform = 'translate3d(' + (-this.index * 100) + '%, 0, 0)';
    for (var i = 0; i < this.dots.length; i++) {
      this.dots[i].className = 'dot' + (i === this.index ? ' is-on' : '');
    }
    this.onChange(this.index);
  };

  Banner.prototype.go = function (idx) {
    if (idx < 0) { idx = this.count - 1; }
    if (idx >= this.count) { idx = 0; }
    this.index = idx;
    this._apply(true);
  };

  Banner.prototype.next = function () {
    this.go(this.index + 1);
  };

  Banner.prototype.start = function () {
    var self = this;
    this.stop();
    this.timer = setInterval(function () { self.next(); }, this.interval);
  };

  Banner.prototype.stop = function () {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  };

  Banner.prototype.restart = function () {
    this.stop();
    this.start();
  };

  Banner.prototype._bindDrag = function () {
    var self = this;
    var vp = this.viewport;

    function down(x) {
      self.dragging = true;
      self.startX = x;
      self.deltaX = 0;
      self.width = vp.clientWidth || 1;
      self.track.style.transition = 'none';
      vp.classList.add('dragging');
      self.stop();
    }
    function move(x) {
      if (!self.dragging) { return; }
      self.deltaX = x - self.startX;
      var pct = (self.deltaX / self.width) * 100;
      self.track.style.transform = 'translate3d(' + (-self.index * 100 + pct) + '%, 0, 0)';
    }
    function up() {
      if (!self.dragging) { return; }
      self.dragging = false;
      vp.classList.remove('dragging');
      var threshold = Math.max(36, self.width * 0.18);
      if (self.deltaX <= -threshold) { self.index = self.index + 1; }
      else if (self.deltaX >= threshold) { self.index = self.index - 1; }
      if (self.index < 0) { self.index = self.count - 1; }
      if (self.index >= self.count) { self.index = 0; }
      self._apply(true);
      self.restart();
    }

    if (global.PointerEvent) {
      vp.addEventListener('pointerdown', function (e) { down(e.clientX); });
      vp.addEventListener('pointermove', function (e) { move(e.clientX); });
      vp.addEventListener('pointerup', up);
      vp.addEventListener('pointercancel', up);
      vp.addEventListener('pointerleave', function (e) { if (self.dragging) { move(e.clientX); up(); } });
    } else {
      vp.addEventListener('touchstart', function (e) { down(e.touches[0].clientX); });
      vp.addEventListener('touchmove', function (e) { move(e.touches[0].clientX); });
      vp.addEventListener('touchend', up);
      vp.addEventListener('mousedown', function (e) { down(e.clientX); });
      vp.addEventListener('mousemove', function (e) { move(e.clientX); });
      vp.addEventListener('mouseup', up);
    }
  };

  /* ---------- 庆祝特效：彩带 / 光环 / 火花 ---------- */
  var CONFETTI_COLORS = ['#ff5ea8', '#7c5cff', '#35c6ff', '#21e6a4', '#ffcc45', '#ff8a3d'];

  function confetti(layer, amount) {
    for (var i = 0; i < amount; i++) {
      var piece = C.el('i', 'fx-piece');
      piece.style.left = (Math.random() * 100) + '%';
      piece.style.background = C.pick(CONFETTI_COLORS);
      piece.style.animationDuration = (1.6 + Math.random() * 1.6) + 's';
      piece.style.animationDelay = (Math.random() * 0.9) + 's';
      piece.style.width = (6 + Math.random() * 8) + 'px';
      piece.style.height = (10 + Math.random() * 14) + 'px';
      layer.appendChild(piece);
    }
  }

  function firework(layer, amount) {
    for (var i = 0; i < amount; i++) {
      (function (delay) {
        setTimeout(function () {
          var x = 12 + Math.random() * 76;
          var y = 14 + Math.random() * 46;
          var ring = C.el('i', 'fx-ring');
          ring.style.left = x + '%';
          ring.style.top = y + '%';
          ring.style.background = 'radial-gradient(circle, ' + C.pick(CONFETTI_COLORS) + ', transparent 70%)';
          layer.appendChild(ring);
          for (var k = 0; k < 8; k++) {
            var spark = C.el('i', 'fx-spark', C.pick(['✨', '🌟', '💫', '⭐']));
            spark.style.left = x + '%';
            spark.style.top = y + '%';
            var ang = (Math.PI * 2 * k) / 8;
            spark.style.transform = 'translate(-50%, -50%)';
            spark.style.marginLeft = (Math.cos(ang) * 46) + 'px';
            spark.style.marginTop = (Math.sin(ang) * 46) + 'px';
            layer.appendChild(spark);
          }
          setTimeout(function () {
            if (ring.parentNode) { ring.parentNode.removeChild(ring); }
          }, 1000);
        }, delay);
      })(i * 260);
    }
  }

  /** 按名次给出不同强度的庆祝：TOP10 彩带、TOP3 加强、TOP1 全屏烟花 */
  function celebrate(layer, rank) {
    layer.innerHTML = '';
    if (rank >= 1 && rank <= 10) {
      confetti(layer, 60);
    }
    if (rank >= 1 && rank <= 3) {
      confetti(layer, 80);
      firework(layer, 5);
    }
    if (rank === 1) {
      confetti(layer, 140);
      firework(layer, 12);
    }
  }

  function clearFx(layer) {
    layer.innerHTML = '';
  }

  /* ---------- 轻提示 ---------- */
  var toastTimer = null;
  function toast(node, text, ms) {
    node.textContent = text;
    node.classList.add('is-on');
    if (toastTimer) { clearTimeout(toastTimer); }
    toastTimer = setTimeout(function () { node.classList.remove('is-on'); }, ms || 2000);
  }

  global.CalcUI = {
    renderBoard: renderBoard,
    boardRow: boardRow,
    Banner: Banner,
    celebrate: celebrate,
    clearFx: clearFx,
    toast: toast
  };
})(window);
