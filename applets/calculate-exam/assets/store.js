/* =========================================================
   store.js · 成绩存取与排行榜
   说明：全部数据只通过平台运行时 window.applet.data('records') 读写；
   若运行时不可用（如本地单独打开调试），回落到内存缓存，保证界面仍能跑通。
   ========================================================= */
(function (global) {
  'use strict';

  var TABLE = 'records';
  var cache = {};            // levelId -> 行数组（内存镜像，用于渲染与排名）
  var playerName = '';       // 当前玩家昵称
  var seeded = false;        // 是否已尝试写入示例对手

  function nowText() {
    var d = new Date();
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
           ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  /** 等待平台运行时就绪（最多等待约 3 秒） */
  function waitRuntime() {
    return new Promise(function (resolve) {
      var waited = 0;
      (function tick() {
        var rt = global.applet;
        if (rt && rt.ready && typeof rt.data === 'function') { resolve(rt); return; }
        if (waited >= 3000) { resolve(rt || null); return; }
        waited += 60;
        setTimeout(tick, 60);
      })();
    });
  }

  /** 取得数据表访问对象 */
  function storeOf(rt) {
    return rt.data(TABLE);
  }

  /** 读取某级别全部成绩行 */
  function fetchLevel(levelId, rt) {
    var runtime = rt || global.applet;
    if (runtime && runtime.ready && typeof runtime.data === 'function') {
      return storeOf(runtime).list({ limit: 1000, offset: 0 }).then(function (res) {
        return (res && res.rows ? res.rows : []).filter(function (r) {
          return Number(r.level) === Number(levelId);
        });
      }).catch(function () {
        return cache[levelId] || [];
      });
    }
    return Promise.resolve(cache[levelId] || []);
  }

  /** 排行榜排序：分数高者优先，同分则用时短者优先 */
  function sortRows(rows) {
    return rows.slice().sort(function (a, b) {
      var d = Number(b.score) - Number(a.score);
      if (d !== 0) { return d; }
      return Number(a.time_ms) - Number(b.time_ms);
    });
  }

  /** 取某级别 TOP10 */
  function top10(levelId) {
    return fetchLevel(levelId).then(function (rows) {
      return sortRows(rows).slice(0, 10);
    });
  }

  /** 写入一条成绩，返回 { rank, total } */
  function submit(row, rt) {
    var payload = {
      player: row.player,
      level: Number(row.level),
      score: Number(row.score),
      time_ms: Number(row.time_ms),
      accuracy: Number(row.accuracy),
      correct_count: Number(row.correct_count),
      answered_at: nowText()
    };
    var runtime = rt || global.applet;
    var fallback = function () {
      var list = cache[payload.level] || [];
      list.push(payload);
      cache[payload.level] = list;
      var sorted = sortRows(list);
      return { rank: sorted.indexOf(payload) + 1, total: sorted.length, offline: true };
    };

    if (runtime && runtime.ready && typeof runtime.data === 'function') {
      return storeOf(runtime).create(payload).then(function () {
        return fetchLevel(payload.level, runtime).then(function (rows) {
          var sorted = sortRows(rows);
          var rank = sorted.length;
          for (var i = 0; i < sorted.length; i++) {
            var r = sorted[i];
            if (Number(r.score) === payload.score && Number(r.time_ms) === payload.time_ms &&
                r.player === payload.player) { rank = i + 1; break; }
          }
          return { rank: rank, total: sorted.length, offline: false };
        });
      }).catch(fallback);
    }
    return Promise.resolve(fallback());
  }

  /** 首次上榜人数不足时，写入若干示例对手，让榜单更热闹（仅一次） */
  function seedIfEmpty(rt) {
    if (seeded) { return Promise.resolve(); }
    seeded = true;
    var seeds = [
      { player: '闪电小狐', level: 1, score: 1180, time_ms: 142000, accuracy: 96, correct_count: 96 },
      { player: '算数喵喵', level: 1, score: 960, time_ms: 178000, accuracy: 92, correct_count: 92 },
      { player: '速算小豹', level: 2, score: 860, time_ms: 205000, accuracy: 90, correct_count: 90 },
      { player: '心算达人', level: 3, score: 760, time_ms: 232000, accuracy: 88, correct_count: 88 },
      { player: '数字博士', level: 4, score: 660, time_ms: 268000, accuracy: 85, correct_count: 85 },
      { player: '算术之神', level: 5, score: 520, time_ms: 305000, accuracy: 80, correct_count: 80 }
    ];
    var runtime = rt || global.applet;
    if (!(runtime && runtime.ready && typeof runtime.data === 'function')) {
      seeds.forEach(function (s) {
        var list = cache[s.level] || [];
        list.push(s);
        cache[s.level] = list;
      });
      return Promise.resolve();
    }
    return storeOf(runtime).list({ limit: 50, offset: 0 }).then(function (res) {
      var rows = (res && res.rows) ? res.rows : [];
      if (rows.length >= 3) { return; }   // 已有成绩就不打扰
      return storeOf(runtime).batch(seeds.map(function (s) {
        return {
          player: s.player, level: s.level, score: s.score,
          time_ms: s.time_ms, accuracy: s.accuracy,
          correct_count: s.correct_count, answered_at: nowText()
        };
      }));
    }).catch(function () { /* 示例数据写入失败不影响主流程 */ });
  }

  /** 玩家昵称：首次提交时询问一次，之后记住 */
  function getPlayer() {
    return playerName;
  }
  function setPlayer(name) {
    playerName = name;
    return playerName;
  }
  function defaultPlayer() {
    return '心算小能手' + (100 + Math.floor(Math.random() * 900));
  }

  global.CalcStore = {
    waitRuntime: waitRuntime,
    top10: top10,
    fetchLevel: fetchLevel,
    sortRows: sortRows,
    submit: submit,
    seedIfEmpty: seedIfEmpty,
    getPlayer: getPlayer,
    setPlayer: setPlayer,
    defaultPlayer: defaultPlayer
  };
})(window);
