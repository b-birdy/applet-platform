// 背单词 — 通过平台运行时 window.applet 存取当前用户的数据
(function () {
  var listEl = document.getElementById('list');
  var emptyEl = document.getElementById('empty');
  var statsEl = document.getElementById('stats');
  var errEl = document.getElementById('error');
  var form = document.getElementById('add-form');
  var wordInput = document.getElementById('word');
  var meaningInput = document.getElementById('meaning');

  // 等运行时就绪（app-runtime.js 注入凭据后置 ready）
  function onReady(fn) {
    if (window.applet && window.applet.ready) return fn();
    var t = setInterval(function () {
      if (window.applet && window.applet.ready) { clearInterval(t); fn(); }
    }, 50);
  }

  function showError(msg) {
    errEl.textContent = msg;
    errEl.hidden = !msg;
  }

  function render(rows) {
    listEl.innerHTML = '';
    var done = 0;
    rows.forEach(function (row) {
      if (row.status) done++;
      var li = document.createElement('li');
      li.className = row.status ? 'done' : '';
      var w = document.createElement('span'); w.className = 'word'; w.textContent = row.word;
      var m = document.createElement('span'); m.className = 'meaning'; m.textContent = row.meaning || '';
      var sp = document.createElement('span'); sp.className = 'spacer';
      var toggle = document.createElement('button');
      toggle.className = 'btn ghost'; toggle.type = 'button'; toggle.textContent = row.status ? '重来' : '记住了';
      toggle.addEventListener('click', function () {
        store.update(row.id, { status: row.status ? 0 : 1 }).then(load).catch(showError);
      });
      var del = document.createElement('button');
      del.className = 'btn ghost'; del.type = 'button'; del.textContent = '删除';
      del.addEventListener('click', function () {
        store.remove(row.id).then(load).catch(showError);
      });
      li.appendChild(w); li.appendChild(m); li.appendChild(sp); li.appendChild(toggle); li.appendChild(del);
      listEl.appendChild(li);
    });
    emptyEl.hidden = rows.length > 0;
    statsEl.textContent = rows.length ? (done + ' / ' + rows.length + ' 已记住') : '';
  }

  var store;

  function load() {
    store.list({ limit: 200 }).then(function (res) {
      showError('');
      render(res.rows);
    }).catch(function (e) { showError('加载失败: ' + e.code); });
  }

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var word = wordInput.value.trim();
    if (!word) return;
    store.create({ word: word, meaning: meaningInput.value.trim() }).then(function () {
      wordInput.value = ''; meaningInput.value = '';
      load();
    }).catch(function (e) { showError('添加失败: ' + e.code); });
  });

  onReady(function () {
    store = window.applet.data('words');
    load();
  });
})();
