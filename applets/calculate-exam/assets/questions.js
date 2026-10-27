/* =========================================================
   questions.js · 五个难度级别的随机出题器
   规则要点：
   - 除法一律「能除尽且答案为整数」（按从左到右的运算顺序校验）
   - 减法保证被减数大于减数，避免出现负数中间结果
   - 平方 / 立方以「操作数^2 / 操作数^3」的形式出现
   ========================================================= */
(function (global) {
  'use strict';

  var C = global.CalcCore;

  /** 五个级别定义：名称 / 表情 / 星级 / 主题色 / 出题参数 */
  var LEVELS = [
    {
      id: 1, name: '菜鸟', emoji: '🐣', stars: '★☆☆☆☆', color: ['#21e6a4', '#35c6ff'],
      operands: 2, digits: 2, ops: ['+', '-', '*', '/'], power: false, group: false
    },
    {
      id: 2, name: '学徒', emoji: '🐰', stars: '★★☆☆☆', color: ['#35c6ff', '#7c5cff'],
      operands: 3, digits: 2, ops: ['+', '-', '*', '/'], power: false, group: true
    },
    {
      id: 3, name: '高手', emoji: '🦊', stars: '★★★☆☆', color: ['#ffcc45', '#ff8a3d'],
      operands: 2, digits: 2, ops: ['+', '-', '*', '/'], power: true, group: false
    },
    {
      id: 4, name: '精英', emoji: '🦉', stars: '★★★★☆', color: ['#ff8a3d', '#ff5ea8'],
      operands: 3, digits: 2, ops: ['+', '-', '*', '/'], power: true, group: true
    },
    {
      id: 5, name: '大神', emoji: '🐲', stars: '★★★★★', color: ['#ff5ea8', '#7c5cff'],
      operands: 3, digits: 3, ops: ['+', '-', '*', '/'], power: true, group: true
    }
  ];

  function maxVal(digits) {
    return digits === 3 ? 999 : 99;
  }

  /**
   * 从左到右生成表达式，全程维护「当前累计值」。
   * 乘法 / 除法严格保证能整除且答案为整数；减法保证被减数更大。
   * 幂运算在生成阶段就并入操作数，因此除法约束对最终结果同样成立。
   */
  function buildExpression(cfg) {
    var hi = maxVal(cfg.digits);
    var opCount = cfg.operands - 1;
    var values = [];
    var texts = [];
    var powered = [];

    var first = C.randInt(1, hi);
    values.push(first);
    texts.push(String(first));
    powered.push(false);

    var cur = first;
    var ops = [];

    for (var i = 0; i < opCount; i++) {
      // 依次尝试若干运算符，找到满足整除约束的那个
      var order = shuffle(cfg.ops.slice());
      var picked = null;
      for (var t = 0; t < order.length; t++) {
        var candidate = makeOperand(order[t], cur, hi, cfg);
        if (candidate) { picked = candidate; break; }
      }
      if (!picked) {
        // 兜底用加法，保证一定能凑出题目
        var fallback = C.randInt(1, hi);
        picked = { op: '+', value: fallback, text: String(fallback), isPower: false };
      }
      ops.push(picked.op);
      values.push(picked.value);
      texts.push(picked.text);
      powered.push(picked.isPower);
      cur = applyOp(cur, picked.op, picked.value);
    }

    return { values: values, texts: texts, ops: ops, powered: powered, value: cur };
  }

  /** 数组洗牌（原地） */
  function shuffle(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = C.randInt(0, i);
      var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  }

  /** 生成下一个操作数：op 为运算符，cur 为当前累计值 */
  function makeOperand(op, cur, hi, cfg) {
    if (op === '+') {
      var add = C.randInt(1, hi);
      return { op: '+', value: add, text: String(add), isPower: false };
    }
    if (op === '-') {
      var top = Math.max(1, Math.min(hi, cur - 1));
      var sub = C.randInt(1, top);
      return { op: '-', value: sub, text: String(sub), isPower: false };
    }
    if (op === '*') {
      var mul = C.randInt(2, Math.min(9, hi));
      // 幂运算优先：先把平方 / 立方放进来，再乘一个普通数
      if (cfg.power && Math.random() < 0.45) {
        var pbase = C.randInt(2, 9);
        var pexp = C.randInt(2, 3);
        return {
          op: '*', value: Math.pow(pbase, pexp),
          text: pbase + '^' + pexp, isPower: true
        };
      }
      return { op: '*', value: mul, text: String(mul), isPower: false };
    }
    // 除法：只在当前累计值能被整除时才出「÷」，保证答案一定是整数
    var picks = divisorsOf(cur);
    if (!picks.length) { return null; }
    if (cfg.power && Math.random() < 0.4) {
      // 用「幂的结果」当除数，同样要求能整除
      var pw = [];
      for (var b = 2; b <= 9; b++) {
        for (var e = 2; e <= 3; e++) {
          var v = Math.pow(b, e);
          if (Math.abs(cur) % v === 0) { pw.push({ b: b, e: e, v: v }); }
        }
      }
      if (pw.length) {
        var one = C.pick(pw);
        return { op: '/', value: one.v, text: one.b + '^' + one.e, isPower: true };
      }
    }
    var div = C.pick(picks);
    return { op: '/', value: div, text: String(div), isPower: false };
  }

  /** 找出能让当前值整除的候选除数（不含 1 与自身） */
  function divisorsOf(n) {
    var v = Math.abs(Math.round(n));
    var out = [];
    for (var d = 2; d <= Math.min(12, v); d++) {
      if (v % d === 0) { out.push(d); }
    }
    return out;
  }

  function applyOp(a, op, b) {
    if (op === '+') { return a + b; }
    if (op === '-') { return a - b; }
    if (op === '*') { return a * b; }
    return a / b;
  }

  /** 渲染表达式：把内部 ^ 记号换成上标，并按需补括号 */
  function render(groups, ops, cfg, parens) {
    var parts = groups.map(function (g) {
      if (typeof g === 'string' && g.indexOf('^') > 0) {
        var seg = g.split('^');
        return seg[0] + '<sup>' + C.sup(seg[1]) + '</sup>';
      }
      return String(g);
    });

    var text = parts[0];
    for (var i = 0; i < ops.length; i++) {
      text += ' ' + ops[i] + ' ' + parts[i + 1];
    }

    // 三个操作数时按需给「后两项」加括号（仅当优先级确实需要时）
    if (parens && ops.length === 2) {
      text = parts[0] + ' ' + ops[0] + ' (' + parts[1] + ' ' + ops[1] + ' ' + parts[2] + ')';
    }
    return text;
  }

  /** 按优先级（含可选的括号）求值 */
  function compute(values, ops, parens) {
    if (parens && ops.length === 2) {
      var inner = applyOp(values[1], ops[1], values[2]);
      return applyOp(values[0], ops[0], inner);
    }
    var cur = values[0];
    for (var i = 0; i < ops.length; i++) {
      cur = applyOp(cur, ops[i], values[i + 1]);
    }
    return cur;
  }

  function applyOp(a, op, b) {
    if (op === '+') { return a + b; }
    if (op === '-') { return a - b; }
    if (op === '*') { return a * b; }
    return a / b;
  }

  /** 交换运算数位置：用于把负数结果翻正（保持难度不变） */
  function swapFirst(values, texts) {
    var last = values.length - 1;
    var tv = values[0]; values[0] = values[last]; values[last] = tv;
    var tt = texts[0]; texts[0] = texts[last]; texts[last] = tt;
  }

  /** 生成一道题：返回 { display, answer } */
  function generate(levelId) {
    var cfg = LEVELS[levelId - 1] || LEVELS[0];
    var hi = maxVal(cfg.digits);

    // 最多重试若干次，确保不出现「除不尽 / 负数 / 过于平凡」的题
    for (var attempt = 0; attempt < 60; attempt++) {
      var built = buildExpression(cfg);
      var values = built.values;
      var texts = built.texts;
      var ops = built.ops;

      // 该级别要求出现平方 / 立方，本次没抽到就重来
      if (cfg.power && !built.powered.some(function (p) { return p; })) { continue; }

      // 括号只加在「后两项优先级确实更高」的位置，避免出现无意义括号
      var parens = false;
      if (cfg.group && ops.length === 2 &&
          (ops[1] === '*' || ops[1] === '/') &&
          (ops[0] === '+' || ops[0] === '-') &&
          Math.random() < 0.55) {
        parens = true;
      }

      var value = compute(values, ops, parens);

      // 减出一个负数时，把首尾操作数对调，让结果为正（难度不变）
      if (value < 0 && ops.length > 0 && ops[0] === '-') {
        swapFirst(values, texts);
        value = compute(values, ops, parens);
      }
      if (!isValid(values, ops, parens, hi)) { continue; }

      return {
        display: render(texts, ops, cfg, parens),
        answer: Math.round(value),
        level: cfg.id
      };
    }
    // 兜底：保证一定有题可答
    return { display: '7 + 8', answer: 15, level: cfg.id };
  }

  /** 合法性校验：整除、整数、非负、非零、规模适中 */
  function isValid(values, ops, parens, hi) {
    var limit = Math.max(hi * hi, 999);
    var big = values.some(function (v) { return Math.abs(v) > limit; });
    if (big) { return false; }

    var result;
    if (parens && ops.length === 2) {
      if (ops[1] === '/' && values[1] % values[2] !== 0) { return false; }
      var inner = applyOp(values[1], ops[1], values[2]);
      if (ops[0] === '/' && values[0] % inner !== 0) { return false; }
      result = applyOp(values[0], ops[0], inner);
    } else {
      result = values[0];
      for (var i = 0; i < ops.length; i++) {
        var b = values[i + 1];
        if (ops[i] === '/' && result % b !== 0) { return false; }
        result = applyOp(result, ops[i], b);
      }
    }
    return isFinite(result) && result === Math.round(result) &&
           result > 0 && Math.abs(result) <= 999999;
  }

  /** 生成整套测试题（默认 100 道） */
  function generatePaper(levelId, count) {
    var total = count || 100;
    var paper = [];
    for (var i = 0; i < total; i++) {
      paper.push(generate(levelId));
    }
    return paper;
  }

  global.CalcQuestions = {
    LEVELS: LEVELS,
    generate: generate,
    generatePaper: generatePaper,
    level: function (id) { return LEVELS[id - 1] || LEVELS[0]; }
  };
})(window);
