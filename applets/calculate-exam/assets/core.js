/* =========================================================
   core.js · 通用工具：DOM 助手、卡通音效、时间/文本格式化
   说明：音效使用 Web Audio 实时合成，无需外部音频文件，
   保证离线、无第三方依赖、无额外网络请求。
   ========================================================= */
(function (global) {
  'use strict';

  /* ---------- DOM 助手 ---------- */
  function $(sel, root) {
    return (root || document).querySelector(sel);
  }
  function $$(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }
  function el(tag, cls, html) {
    var node = document.createElement(tag);
    if (cls) { node.className = cls; }
    if (html != null) { node.innerHTML = html; }
    return node;
  }

  /* ---------- 数学 / 文本 ---------- */
  function randInt(min, max) {
    return min + Math.floor(Math.random() * (max - min + 1));
  }
  function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }
  /** 把毫秒格式化成「X分Y秒」或「M:SS」 */
  function fmtCost(ms) {
    var total = Math.max(0, Math.round(ms / 1000));
    var m = Math.floor(total / 60);
    var s = total % 60;
    return m + '分' + s + '秒';
  }
  function fmtClock(ms) {
    var total = Math.max(0, Math.round(ms / 1000));
    var m = Math.floor(total / 60);
    var s = total % 60;
    return m + ':' + (s < 10 ? '0' + s : s);
  }
  /** 上标数字：用于平方 / 立方的卡通显示 */
  var SUP = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };
  function sup(n) {
    return String(n).split('').map(function (ch) { return SUP[ch] || ch; }).join('');
  }
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------- 卡通音效（Web Audio 合成） ---------- */
  var audioCtx = null;
  function ensureAudio() {
    if (audioCtx) { return audioCtx; }
    var Ctor = global.AudioContext || global.webkitAudioContext;
    if (!Ctor) { return null; }
    try {
      audioCtx = new Ctor();
    } catch (e) {
      audioCtx = null;
    }
    return audioCtx;
  }

  /** 单个音符：类型 / 频率 / 起始时间 / 时长 / 音量 */
  function tone(type, freq, start, dur, gainPeak) {
    var ctx = ensureAudio();
    if (!ctx) { return; }
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, ctx.currentTime + start);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime + start);
    gain.gain.exponentialRampToValueAtTime(gainPeak, ctx.currentTime + start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + dur);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(ctx.currentTime + start);
    osc.stop(ctx.currentTime + start + dur + 0.05);
  }

  var Sound = {
    /** 首次用户交互时解锁音频上下文 */
    unlock: function () {
      var ctx = ensureAudio();
      if (ctx && ctx.state === 'suspended') { ctx.resume(); }
    },
    /** 答对：清脆上行三音阶 */
    right: function () {
      tone('triangle', 660, 0.00, 0.14, 0.22);
      tone('triangle', 880, 0.09, 0.14, 0.22);
      tone('sine', 1320, 0.18, 0.22, 0.18);
    },
    /** 答错：低沉下行提示 */
    wrong: function () {
      tone('sawtooth', 220, 0.00, 0.20, 0.16);
      tone('sawtooth', 155, 0.12, 0.26, 0.14);
    },
    /** 结算小号角 */
    fanfare: function () {
      var notes = [523, 659, 784, 1047];
      for (var i = 0; i < notes.length; i++) {
        tone('triangle', notes[i], i * 0.11, 0.26, 0.20);
      }
    },
    /** 登顶：更长的华丽琶音 */
    champion: function () {
      var notes = [523, 659, 784, 1047, 880, 1047, 1319];
      for (var i = 0; i < notes.length; i++) {
        tone('triangle', notes[i], i * 0.10, 0.30, 0.20);
        tone('sine', notes[i] * 2, i * 0.10 + 0.02, 0.22, 0.08);
      }
    },
    /** 界面点击 */
    tap: function () {
      tone('sine', 740, 0, 0.07, 0.10);
    }
  };

  global.CalcCore = {
    $: $, $$: $$, el: el,
    randInt: randInt, pick: pick,
    fmtCost: fmtCost, fmtClock: fmtClock,
    sup: sup, escapeHtml: escapeHtml,
    Sound: Sound
  };
})(window);
