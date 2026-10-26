// applet-runtime.js — 平台内置运行时（/app-runtime.js 内联响应）
// 职责：接收平台 postMessage 注入的 token，暴露 window.applet.data(table) CRUD
(function () {
  var state = { token: null, ready: false };

  function headers() {
    return {
      'content-type': 'application/json',
      authorization: 'Bearer ' + state.token,
    };
  }

  function request(method, path, body) {
    return fetch('/api/data/' + path, {
      method: method,
      headers: headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(function (res) {
      if (!res.ok) {
        return res.json().catch(function () { return {}; }).then(function (json) {
          var err = new Error(json.error || ('HTTP_' + res.status));
          err.code = json.error || ('HTTP_' + res.status);
          err.status = res.status;
          throw err;
        });
      }
      return res.json();
    });
  }

  window.applet = {
    get ready() { return state.ready; },
    data: function (table) {
      var base = table; // Data API 路径由平台按 applet 路由，table 为清单声明的表名
      return {
        list: function (opts) {
          opts = opts || {};
          var qs = '?limit=' + (opts.limit || 100) + '&offset=' + (opts.offset || 0);
          return request('GET', base + qs);
        },
        create: function (row) { return request('POST', base, row); },
        update: function (id, patch) { return request('PUT', base + '/' + id, patch); },
        remove: function (id) { return request('DELETE', base + '/' + id); },
        batch: function (rows) { return request('POST', base + '/batch', { rows: rows }); },
      };
    },
  };

  // 平台 → iframe：注入 token（父容器 postMessage，targetOrigin '*' 由沙箱保证来源唯一）
  window.addEventListener('message', function (event) {
    var data = event.data;
    if (data && data.type === 'applet-token' && typeof data.token === 'string') {
      state.token = data.token;
      state.ready = true;
    }
  });
})();
