/* =========================================================
   app.js · 主流程：首页 → 设置 → 答题 → 结算
   ========================================================= */
(function (global) {
  'use strict';

  var C = global.CalcCore;
  var Q = global.CalcQuestions;
  var S = global.CalcStore;
  var U = global.CalcUI;
  var $ = C.$;

  var TOTAL = 100;          // 每次测试固定题量
  var FEEDBACK_MS = 1000;   // 对错反馈展示时长（约 1 秒）

  var state = {
    page: 'home',
    level: 1,
    paper: [],
    index: 0,
    answers: [],
    startedAt: 0,
    totalMs: 0,
    locked: false,
    lastResult: null,
    bannerIndex: 0
  };

  var dom = {};
  var boardCache = {};   // levelId -> TOP10 行
  var slideNodes = [];
  var banner = null;

  /* ---------- 页面切换 ---------- */
  function show(page) {
    state.page = page;
    ['home', 'setup', 'quiz', 'result'].forEach(function (name) {
      var node = dom['page-' + name];
      if (!node) { return; }
      var on = name === page;
      node.classList.toggle('is-active', on);
    });
    if (page === 'home') {
      refreshBanner();
      if (banner) { banner.restart(); }
    } else if (banner) {
      banner.stop();
    }
  }

  /* ---------- 首页：五档排行榜 Banner ---------- */
  function buildBanner() {
    var track = dom.bannerTrack;
    track.innerHTML = '';
    slideNodes = [];
    Q.LEVELS.forEach(function (lv) {
      var slide = C.el('div', 'banner-slide');
      var box = C.el('div', 'mb-list');
      box.appendChild(C.el('div', 'br-empty', '⏳ 加载中…'));
      slide.appendChild(box);
      track.appendChild(slide);
      slideNodes.push(box);
    });

    banner = new U.Banner({
      track: track,
      viewport: dom.bannerViewport,
      dots: dom.bannerDots,
      title: dom.bannerTitle,
      count: Q.LEVELS.length,
      interval: 5000,
      onChange: function (idx) {
        state.bannerIndex = idx;
        var lv = Q.LEVELS[idx];
        dom.bannerTitle.textContent = lv.emoji + ' ' + lv.name + '榜';
      }
    });
  }

  function refreshBanner() {
    Q.LEVELS.forEach(function (lv, i) {
      loadBoard(lv.id).then(function (rows) {
        U.renderBoard(slideNodes[i], rows, S.getPlayer());
      });
    });
  }

  function loadBoard(levelId) {
    return S.top10(levelId).then(function (rows) {
      boardCache[levelId] = rows;
      return rows;
    }).catch(function () {
      return boardCache[levelId] || [];
    });
  }

  /* ---------- 设置页：五个级别卡片 ---------- */
  function buildLevels() {
    var box = dom.levelList;
    box.innerHTML = '';
    Q.LEVELS.forEach(function (lv, i) {
      var card = C.el('div', 'level-card' + (lv.id === state.level ? ' is-on' : ''));
      card.style.animationDelay = (i * 60) + 'ms';
      card.title = lv.name + ' · ' + lv.operands + ' 个数 · ' +
                   (lv.digits === 3 ? '三位数以内' : '两位数以内') +
                   (lv.power ? ' · 含平方立方' : '') + (lv.group ? ' · 含括号' : '');
      card.innerHTML =
        '<span class="lc-emoji" style="--c1:' + lv.color[0] + ';--c2:' + lv.color[1] + '">' + lv.emoji + '</span>' +
        '<span class="lc-body">' +
          '<span class="lc-name">' + lv.name + ' <span class="lc-stars">' + lv.stars + '</span></span>' +
          '<span class="lc-demo" data-demo="' + lv.id + '"></span>' +
        '</span>' +
        '<span class="lc-check">✅</span>';
      card.addEventListener('click', function () {
        state.level = lv.id;
        C.$$('.level-card', box).forEach(function (n) { n.classList.remove('is-on'); });
        card.classList.add('is-on');
        C.Sound.tap();
      });
      box.appendChild(card);
    });
    refreshDemos();
  }

  /** 每个级别卡片下方展示一道真实随机的示例题（悬浮可见完整说明） */
  function refreshDemos() {
    C.$$('.lc-demo').forEach(function (node) {
      var id = Number(node.getAttribute('data-demo'));
      var q = Q.generate(id);
      node.textContent = '例：' + q.display.replace(/<sup>/g, '^').replace(/<\/sup>/g, '') + ' = ?';
      node.title = node.textContent;
    });
  }

  /* ---------- 答题流程 ---------- */
  function startQuiz() {
    state.paper = Q.generatePaper(state.level, TOTAL);
    state.index = 0;
    state.answers = new Array(TOTAL);
    state.locked = false;
    state.startedAt = Date.now();
    state.totalMs = 0;
    var lv = Q.level(state.level);
    dom.quizLevelName.textContent = lv.emoji + ' ' + lv.name;
    show('quiz');
    renderQuestion();
    tick();
  }

  function tick() {
    if (state.page !== 'quiz') { return; }
    dom.quizTimer.textContent = C.fmtClock(Date.now() - state.startedAt);
    setTimeout(tick, 250);
  }

  function renderQuestion() {
    var q = state.paper[state.index];
    state.locked = false;
    dom.qIndex.textContent = '第 ' + (state.index + 1) + ' 题 / ' + TOTAL;
    dom.qExpr.innerHTML = q.display;
    dom.qInput.value = '';
    dom.qInput.disabled = false;
    dom.feedback.classList.remove('is-on', 'is-right', 'is-wrong');
    dom.btnNext.classList.remove('is-hidden');
    updateProgress();
    // 光标自动锁定输入框
    setTimeout(function () {
      try { dom.qInput.focus(); } catch (e) { /* 忽略聚焦失败 */ }
    }, 30);
  }

  function updateProgress() {
    var done = state.index;
    var left = TOTAL - done;
    var correct = 0;
    var judged = 0;
    for (var i = 0; i < state.index; i++) {
      var a = state.answers[i];
      if (!a) { continue; }
      judged++;
      if (a.ok) { correct++; }
    }
    dom.progressFill.style.width = (done / TOTAL * 100) + '%';
    dom.doneCount.textContent = done;
    dom.leftCount.textContent = left;
    dom.accRate.textContent = judged ? Math.round(correct / judged * 100) + '%' : '--';
  }

  /** 提交当前题答案：判定 → 音效 + 动态图像 → 约 1 秒后进入下一题 */
  function submitAnswer() {
    if (state.locked) { return; }
    var raw = dom.qInput.value.trim();
    if (raw === '') {
      U.toast(dom.toast, '⌨️ 先写下答案，再按空格或点「下一题」');
      return;
    }
    state.locked = true;
    dom.qInput.disabled = true;              // 打过的题不允许再修改

    var q = state.paper[state.index];
    var ok = Number(raw) === Number(q.answer);
    state.answers[state.index] = { value: raw, ok: ok };

    if (ok) { C.Sound.right(); } else { C.Sound.wrong(); }

    dom.feedback.classList.add('is-on', ok ? 'is-right' : 'is-wrong');
    dom.fbEmoji.textContent = ok ? '🎉' : '💥';
    dom.fbWord.textContent = ok ? '答对了！' : '答错了';
    dom.fbTruth.textContent = '正确答案：' + q.answer;
    // 重新触发动画
    dom.fbEmoji.style.animation = 'none';
    void dom.fbEmoji.offsetWidth;
    dom.fbEmoji.style.animation = '';

    setTimeout(function () {
      state.index++;
      if (state.index >= TOTAL) {
        state.totalMs = Date.now() - state.startedAt;
        finish();
      } else {
        renderQuestion();
      }
    }, FEEDBACK_MS);
  }

  /* ---------- 结算 ---------- */
  function finish() {
    var correct = 0;
    for (var i = 0; i < TOTAL; i++) {
      if (state.answers[i] && state.answers[i].ok) { correct++; }
    }
    var wrong = TOTAL - correct;
    var seconds = Math.max(1, Math.round(state.totalMs / 1000));
    var accScore = correct * 3 - wrong * 2;
    var timeScore = Math.floor(100000 / seconds);
    var total = accScore + timeScore;
    var accuracy = Math.round(correct / TOTAL * 100);

    var result = {
      level: state.level,
      correct: correct,
      wrong: wrong,
      accuracy: accuracy,
      accScore: accScore,
      timeScore: timeScore,
      total: total,
      costMs: state.totalMs,
      seconds: seconds
    };
    state.lastResult = result;

    // 首次结算时询问昵称（唯一一次文字输入，之后自动记住）
    var name = S.getPlayer();
    if (!name) {
      var input = global.prompt('给自己起个上榜的名字吧', S.defaultPlayer());
      name = (input && String(input).trim()) ? String(input).trim().slice(0, 16) : S.defaultPlayer();
      S.setPlayer(name);
    }

    S.submit({
      player: name,
      level: result.level,
      score: result.total,
      time_ms: result.costMs,
      accuracy: result.accuracy,
      correct_count: result.correct
    }).then(function (res) {
      result.rank = res.rank;
      result.total_players = res.total;
      if (res.offline) {
        U.toast(dom.toast, '📴 运行时未就绪，本局成绩仅保存在当前页面');
      } else if (res.rank > 10) {
        U.toast(dom.toast, '💪 差一点就进前十，再来一局冲榜！');
      }
      renderResult(result);
    });
  }

  function renderResult(result) {
    var rank = result.rank || 0;
    var lv = Q.level(result.level);

    dom.rbNum.textContent = rank > 0 ? rank : '--';
    dom.rbCrown.textContent = rank === 1 ? '👑' : (rank <= 3 ? '🏆' : (rank <= 10 ? '🎖️' : '🎯'));
    dom.rbLabel.textContent = rank > 0 ? '名' : '';

    // 炫酷标语：进前十 / 前三 / 登顶，强度递增
    dom.cheer.innerHTML = '';
    if (rank === 1) {
      dom.cheer.innerHTML = '<div class="cheer-line">🏆 封神！你是本级别的算数之神 🏆</div>';
      C.Sound.champion();
    } else if (rank <= 3) {
      dom.cheer.innerHTML = '<div class="cheer-line">🔥 杀入三甲！手速与脑力双爆表 🔥</div>';
      C.Sound.fanfare();
    } else if (rank <= 10) {
      dom.cheer.innerHTML = '<div class="cheer-line">🎉 恭喜杀入十强 🎉</div>';
      C.Sound.fanfare();
    } else {
      dom.cheer.innerHTML = '<div class="cheer-line">💪 再练一局，前十就在眼前</div>';
    }

    dom.totalScore.textContent = result.total;
    dom.accScore.textContent = result.accScore;
    dom.timeScore.textContent = result.timeScore;
    dom.costTime.textContent = C.fmtCost(result.costMs);
    dom.accFinal.textContent = result.accuracy + '%';

    dom.mbTitle.textContent = lv.emoji + ' ' + lv.name + '榜';
    show('result');
    U.celebrate(dom.fxLayer, rank);

    // 榜单：进前十展示完整 TOP10；未进前十展示前五 + 自己的名次
    loadBoard(result.level).then(function (rows) {
      dom.mbList.innerHTML = '';
      if (rank > 0 && rank <= 10) {
        U.renderBoard(dom.mbList, rows.slice(0, 10), S.getPlayer());
        return;
      }
      dom.mbTitle.textContent = lv.emoji + ' ' + lv.name + '榜 · 前五';
      U.renderBoard(dom.mbList, rows.slice(0, 5), S.getPlayer());
      var mine = U.boardRow(5, {
        player: S.getPlayer(),
        score: result.total,
        time_ms: result.costMs
      }, S.getPlayer());
      mine.querySelector('.br-rank').textContent = rank > 0 ? rank : '--';
      dom.mbList.appendChild(mine);
    });
  }

  /* ---------- 事件绑定 ---------- */
  function bind() {
    dom.btnStart.addEventListener('click', function () {
      C.Sound.unlock();
      C.Sound.tap();
      buildLevels();
      show('setup');
    });

    dom.btnSetupBack.addEventListener('click', function () {
      C.Sound.tap();
      show('home');
    });

    dom.btnGo.addEventListener('click', function () {
      C.Sound.unlock();
      C.Sound.tap();
      startQuiz();
    });

    dom.btnNext.addEventListener('click', function () {
      C.Sound.unlock();
      submitAnswer();
    });

    dom.qInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        C.Sound.unlock();
        submitAnswer();
      }
    });

    dom.btnQuizQuit.addEventListener('click', function () {
      U.toast(dom.toast, '👋 已放弃本局，回到首页');
      show('home');
    });

    dom.btnAgain.addEventListener('click', function () {
      C.Sound.tap();
      U.clearFx(dom.fxLayer);
      startQuiz();
    });

    dom.btnHome.addEventListener('click', function () {
      C.Sound.tap();
      U.clearFx(dom.fxLayer);
      show('home');
    });

    // 切到后台时暂停轮播，回来再继续
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        if (banner) { banner.stop(); }
      } else if (state.page === 'home' && banner) {
        banner.restart();
      }
    });
  }

  /* ---------- 启动 ---------- */
  function boot() {
    ['page-home', 'page-setup', 'page-quiz', 'page-result'].forEach(function (id) {
      dom[id] = document.getElementById(id);
    });
    ['banner', 'bannerTrack', 'bannerViewport', 'bannerDots', 'bannerTitle',
     'btnStart', 'levelList', 'btnSetupBack', 'btnGo',
     'quizLevelName', 'quizTimer', 'progressFill', 'doneCount', 'leftCount', 'accRate',
     'qIndex', 'qExpr', 'qInput', 'btnNext', 'btnQuizQuit',
     'feedback', 'fbEmoji', 'fbWord', 'fbTruth', 'fbBurst',
     'rankBadge', 'rbCrown', 'rbNum', 'rbLabel', 'cheer',
     'totalScore', 'accScore', 'timeScore', 'costTime', 'accFinal',
     'mbTitle', 'mbList', 'btnAgain', 'btnHome', 'fxLayer', 'toast'
    ].forEach(function (id) {
      dom[id] = document.getElementById(id);
    });

    buildBanner();
    bind();
    show('home');

    // 等待平台运行时就绪后再拉榜单数据
    S.waitRuntime().then(function () {
      S.seedIfEmpty();
      refreshBanner();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);
