/* ==========================================================
 * 字卡听力测验 —— 前端逻辑（原生 JS，无框架、无外部依赖）
 * 模块：Api / Speech / 路由 / 首页 / 配置页 / 测试页 / 结算页 / 词库页
 * ========================================================== */
(function () {
  'use strict';

  /* ------------------------- 常量 ------------------------- */
  var SPEECH_RATE = 0.6;      // 正文朗读语速（默认 0.6×，另有 1.0× 原速可选）
  var SPEECH_PITCH = 1.0;
  var SPEECH_LANG = 'en-US';
  var SPEECH_VOLUME = 1.0;    // 浏览器朗读最大音量（Web Speech 上限就是 1.0）
  var FEEDBACK_RATE = 0.6;    // Correct / Incorrect 反馈语速
  var ZH_RATE = 0.5;          // 汉字读音语速（比英文略慢，听得更清）
  var ZH_PITCH = 1.06;        // 汉字读音音高略抬，提升可辨识度
  var ZH_REPEAT = 2;          // 汉字读音重复遍数（默认读 2 遍，解决"几乎听不清"）
  var ZH_PREROLL_MS = 400;    // 汉字读音前的预停顿，避免被上一段吃掉
  var SPEAK_DELAY_MS = 120;   // cancel() 后延迟再 speak，规避 Chrome 丢音的已知问题
  var WATCHDOG_MS = 2500;     // 静默检测阈值：只有完全没声音才判定音色不可用
  var PROBE_TIMEOUT_MS = 3200; // 音色自检等待上限（volume=0 静默读一个音节）
  var OPTION_COUNT = 30;      // 待选汉字总数（1 正确 + 29 干扰）
  var READ_ROUNDS = 2;        // 每道题整体朗读遍数
  var ROUND_GAP_MS = 3000;    // 两遍之间的间隔
  var STEP_GAP_MS = 300;      // 四段语音之间的自然停顿
  var FEEDBACK_MS = 900;      // 对错动画展示时长
  var REVEAL_DELAY_MS = 520;  // 动画后展开字卡的延迟
  var LS_VOICE = 'zika.voiceURI';
  var LS_RATE = 'zika.rate.v2';          // v2：默认语速改为 0.6×，旧记录不再沿用
  var LS_ZHVOICE = 'zika.zhVoiceURI.v2'; // v2：中文音色候选改为 2 女 + 2 男，旧记录不再沿用
  var LS_ZHREPEAT = 'zika.zhRepeat';
  // 在线音源相关的偏好只存 localStorage：cebsb_settings 表没有对应列，
  // 写进去既会报错，也会覆盖系统音色偏好（后者要留在云端表里）。
  var LS_SOURCE = 'zika.source';                 // 发音来源：online / system
  var LS_ONLINE_VOICE = 'zika.onlineVoice';      // 在线英文音色 id
  var LS_ONLINE_VOICE_ZH = 'zika.onlineVoiceZh';  // 在线中文音色 id

  // 构建版本号：显示在测试配置页底部。
  // 用途：确认手机上跑的是哪一版代码 —— 手机浏览器会顽固缓存 app.js，
  // 曾经出现过"合并了新版本却完全没生效"的误判，有这个数字就能一眼确认。
  var BUILD_VERSION = '1.4';

  /** 读 localStorage；不可用时返回默认值。 */
  function lsGet(k, d) {
    try {
      var v = window.localStorage.getItem(k);
      return (v === null || v === undefined) ? d : v;
    } catch (e) { return d; }
  }

  /** 写 localStorage；不可用时静默忽略。 */
  function lsSet(k, v) {
    try { window.localStorage.setItem(k, String(v)); } catch (e) { /* 忽略 */ }
  }

  // 词性缩写 → 英文全称（用于语音朗读）
  var POS_MAP = {
    'n': 'noun', 'n.': 'noun', 'noun': 'noun',
    'v': 'verb', 'v.': 'verb', 'verb': 'verb',
    'adj': 'adjective', 'adj.': 'adjective', 'adjective': 'adjective',
    'adv': 'adverb', 'adv.': 'adverb', 'adverb': 'adverb',
    'prep': 'preposition', 'prep.': 'preposition', 'preposition': 'preposition',
    'conj': 'conjunction', 'conj.': 'conjunction', 'conjunction': 'conjunction',
    'pron': 'pronoun', 'pron.': 'pronoun', 'pronoun': 'pronoun',
    'num': 'numeral', 'num.': 'numeral', 'numeral': 'numeral',
    'quant': 'quantifier', 'quant.': 'quantifier', 'quantifier': 'quantifier',
    'int': 'interjection', 'int.': 'interjection', 'interjection': 'interjection',
    'art': 'article', 'art.': 'article', 'article': 'article',
    'aux': 'auxiliary verb', 'aux.': 'auxiliary verb',
    'pref': 'prefix', 'suf': 'suffix',
    'morpheme': 'morpheme', 'particle': 'particle',
    'phr': 'phrase', 'phr.': 'phrase', 'idiom': 'idiom', 'ono': 'onomatopoeia'
  };

  /* ------------------------- 全局状态 ------------------------- */
  var state = {
    cards: [],
    overview: { total: 0, tested: 0, overall_accuracy: 0, pool_all: 0, pool_err50: 0, pool_err80: 0 },
    config: { count: 100, time: 0, mode: 'all', style: 'parts' },
    lastConfig: null,
    session: null,
    timerId: null,
    library: { keyword: '', sort: 'seq', filter: 'all' },
    speechReady: false
  };

  /* ------------------------- 工具函数 ------------------------- */
  function $(id) { return document.getElementById(id); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function clampInt(v, lo, hi, fallback) {
    var n = parseInt(v, 10);
    if (isNaN(n)) return fallback;
    if (n < lo) return lo;
    if (n > hi) return hi;
    return n;
  }

  function fmtClock(ms) {
    if (ms < 0) ms = 0;
    var total = Math.ceil(ms / 1000);
    var m = Math.floor(total / 60);
    var s = total % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  function fmtDuration(ms) {
    var total = Math.round(ms / 1000);
    var m = Math.floor(total / 60);
    var s = total % 60;
    if (m <= 0) return s + ' 秒';
    return m + ' 分 ' + (s < 10 ? '0' : '') + s + ' 秒';
  }

  /** 把词性缩写（支持 "v. n." 这类组合）转换为英文全称，多个用 " and " 连接。 */
  function posToSpeech(pos) {
    var raw = String(pos || '').trim();
    if (!raw) return 'unknown';
    var tokens = raw.split(/[\s、,，;；\/|]+/).filter(function (t) { return t.length > 0; });
    var out = [];
    for (var i = 0; i < tokens.length; i++) {
      var key = tokens[i].toLowerCase();
      var word = POS_MAP[key] || POS_MAP[key.replace(/\.$/, '')] || tokens[i];
      if (out.indexOf(word) === -1) out.push(word);
    }
    if (!out.length) return 'unknown';
    return out.join(' and ');
  }

  /**
   * 构造一道题要朗读的段落。
   * 读音段做中英拼接：英文句子用英文音色朗读，汉字本身调用中文音色朗读。
   * @param {Object} card 字卡
   * @param {boolean} hasZhVoice 系统是否有可用的中文音色；没有时退回用英文音色读拼音。
   */
  function buildSpeechTexts(card, hasZhVoice) {
    var segs = [];
    if (hasZhVoice && card.char) {
      segs.push({ text: 'The pronunciation is', lang: 'en', step: 0 });
      // 汉字用中文音色朗读，并按设置重复 N 遍（默认 2 遍）以便听清
      segs.push({ text: card.char, lang: 'zh', step: 0, repeat: Speech.zhRepeats || ZH_REPEAT });
    } else {
      segs.push({ text: 'The pronunciation is ' + (card.pinyin || ''), lang: 'en', step: 0 });
    }
    segs.push({ text: 'The part of speech is ' + posToSpeech(card.pos), lang: 'en', step: 1 });
    segs.push({ text: 'The meaning is ' + (card.meaning || ''), lang: 'en', step: 2 });
    segs.push({ text: 'The sentence is ' + (card.sentence || ''), lang: 'en', step: 3 });
    return segs;
  }

  var toastTimer = null;
  function toast(msg) {
    var el = $('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () { el.classList.add('hidden'); }, 2200);
  }

  /**
   * 节流版提示：同一条消息在 ms 毫秒内只提示一次。
   * 用于「在线音色不可用、已改用其他音色」这类会逐题触发的降级，避免刷屏。
   */
  var onceMarks = {};
  function toastOnce(msg, ms) {
    var now = Date.now();
    var gap = (typeof ms === 'number') ? ms : 60000;
    if (onceMarks[msg] && (now - onceMarks[msg]) < gap) return;
    onceMarks[msg] = now;
    toast(msg);
  }

  /* ------------------------- 模态弹窗 ------------------------- */
  /**
   * 显示模态弹窗。
   * @param {{title:string, body:string, buttons:Array<{label:string,value:string,kind:string}>}} opts
   * @returns {Promise<string|null>} 被点击按钮的 value；点击遮罩返回 null。
   */
  function showModal(opts) {
    return new Promise(function (resolve) {
      var root = $('modal-root');
      $('modal-title').textContent = opts.title || '提示';
      $('modal-body').innerHTML = opts.body || '';
      var actions = $('modal-actions');
      actions.innerHTML = '';
      (opts.buttons || []).forEach(function (b) {
        var btn = document.createElement('button');
        btn.className = 'btn ' + (b.kind === 'primary' ? 'btn-primary' : (b.kind === 'quiet' ? 'btn-quiet' : 'btn-ghost'));
        btn.textContent = b.label;
        btn.addEventListener('click', function () {
          root.classList.add('hidden');
          resolve(b.value);
        });
        actions.appendChild(btn);
      });
      $('modal-mask').onclick = function () {
        root.classList.add('hidden');
        resolve(null);
      };
      root.classList.remove('hidden');
    });
  }

  /* ------------------------- 语音模块 ------------------------- */
  // 女声 / 男声关键词：用于挑选音色清晰的女声（先用 \b 避免 female 命中 male）
  var FEMALE_HINT = /(\bfemale\b|aria|zira|jenny|samantha|karen|moira|tessa|fiona|catherine|linda|susan|serena|allison|\bava\b|emma|\bamy\b|kathy|victoria|nora|laura|amber|hazel|女声|女生)/i;
  var MALE_HINT = /(\bmale\b|david|\bmark\b|george|james|richard|ryan|daniel|\bfred\b|brian|\bguy\b|男声)/i;
  var CLEAR_HINT = /(natural|neural|premium|enhanced)/i;
  // 中文音色（用于朗读汉字读音）
  var ZH_FEMALE = /(huihui|yaoyao|xiaoxiao|xiaoyi|xiaohan|xiaomeng|xiaoxia|wanwan|tingting|meijia|mei-?jia|female|女)/i;
  var ZH_MALE = /(kangkang|kang-?kang|yunyang|yunjian|yunxi|yunye|yunhao|liang|kunkun|\bmale\b|男)/i;
  // 已知 Windows 音色的性别（兜底：正则没匹配上时用它判定，保证"英男→中男"配对）
  var GENDER_MAP = {
    'zira': 'f', 'aria': 'f', 'jenny': 'f', 'samantha': 'f', 'karen': 'f', 'moira': 'f',
    'tessa': 'f', 'fiona': 'f', 'catherine': 'f', 'linda': 'f', 'susan': 'f', 'serena': 'f',
    'allison': 'f', 'ava': 'f', 'emma': 'f', 'amy': 'f', 'kathy': 'f', 'victoria': 'f',
    'nora': 'f', 'laura': 'f', 'amber': 'f', 'hazel': 'f', 'female': 'f',
    'david': 'm', 'mark': 'm', 'george': 'm', 'james': 'm', 'richard': 'm', 'ryan': 'm',
    'daniel': 'm', 'fred': 'm', 'brian': 'm', 'guy': 'm', 'male': 'm',
    'huihui': 'f', 'yaoyao': 'f', 'xiaoxiao': 'f', 'xiaoyi': 'f', 'xiaohan': 'f',
    'xiaomeng': 'f', 'xiaoxia': 'f', 'wanwan': 'f', 'tingting': 'f', 'meijia': 'f', 'yunxia': 'f',
    'kangkang': 'm', 'yunyang': 'm', 'yunjian': 'm', 'yunxi': 'm', 'yunye': 'm', 'yunhao': 'm', 'liang': 'm'
  };
  // 中文音色偏好（排在前面的优先入选）：
  //   女声：晓晓（自然播音）→ 慧慧 → 瑶瑶 → 晓伊 …
  //   男声：云扬（新闻播音腔）→ 云健 → 云希 → 云野 → 云皓 → 康康（放最后，曾有"发不出声"的反馈）
  var ZH_PREF_F = ['xiaoxiao', 'huihui', 'yaoyao', 'xiaoyi', 'xiaohan', 'xiaomeng', 'xiaoxia', 'wanwan', 'tingting', 'meijia'];
  var ZH_PREF_M = ['yunyang', 'yunjian', 'yunxi', 'yunye', 'yunhao', 'kangkang', 'liang', 'kunkun'];
  var VOICE_QUOTA_F = 2;  // 下拉里保留的女声数量
  var VOICE_QUOTA_M = 2;  // 下拉里保留的男声数量

  function voiceText(v) { return (v.name || '') + ' ' + (v.voiceURI || ''); }
  function isFemale(v) { return FEMALE_HINT.test(voiceText(v)); }
  function isMale(v) { return MALE_HINT.test(voiceText(v)); }

  /** 判定音色性别：'f' 女 / 'm' 男 / 'u' 未知（先查表再正则，避免 Kangkang 之类被判成女声）。 */
  function voiceGender(v) {
    var text = voiceText(v);
    var m = text.match(/([a-z]+)/gi) || [];
    for (var i = 0; i < m.length; i++) {
      var g = GENDER_MAP[String(m[i]).toLowerCase()];
      if (g) return g;
    }
    if (isFemale(v)) return 'f';
    if (isMale(v)) return 'm';
    return 'u';
  }

  /** 下拉里显示的简短音色名（去掉 Microsoft / Desktop / - English 等冗余后缀）。 */
  function shortVoiceName(v) {
    var n = String(v.name || v.voiceURI || '');
    n = n.split(' - ')[0];                          // 去掉 "- English (United States)"
    n = n.replace(/\(.*?\)/g, '');                  // 去掉括号内容
    n = n.replace(/^Microsoft\s+|^\s*Google\s+/i, '').replace(/Desktop|Online|Mobile/i, '').trim();
    if (!n) n = String(v.voiceURI || '语音');
    var g = voiceGender(v);
    var tag = g === 'f' ? '女声' : (g === 'm' ? '男声' : '');
    var clear = CLEAR_HINT.test(voiceText(v)) ? '·清晰' : '';
    return n + (tag ? '（' + tag + clear + '）' : '');
  }

  /** 英文语音评分：本地可用 > 女声 > 清晰音色 > en-US；云端/男声降权。 */
  function scoreVoice(v) {
    var text = voiceText(v);
    var lang = String(v.lang || '').toLowerCase();
    var s = 0;
    if (/^en[-_]us/.test(lang)) s += 40;
    else if (/^en/.test(lang)) s += 20;
    var g = voiceGender(v);
    if (g === 'f') s += 30;
    else if (g === 'm') s -= 20;
    if (CLEAR_HINT.test(text)) s += 15;
    // 本地语音无需联网，稳定性最重要；云端（Online/Google）容易静默失败，降权
    if (v.localService === true) s += 60;
    else s -= 30;
    return s;
  }

  /** 中文音色偏好序：按 ZH_PREF_F / ZH_PREF_M 中的先后取名次，不在名单里返回 99。 */
  function zhPrefRank(v) {
    var n = String(v.name || v.voiceURI || '').toLowerCase();
    var lists = [ZH_PREF_F, ZH_PREF_M], r = 99;
    for (var i = 0; i < lists.length; i++) {
      for (var k = 0; k < lists[i].length; k++) {
        if (n.indexOf(lists[i][k]) >= 0) { r = Math.min(r, k); break; }
      }
    }
    return r;
  }

  /** 中文语音评分：偏好顺序（播音腔男声云扬优先）> 本地 > 清晰；同偏好时本地音色排前面。 */
  function scoreZhVoice(v) {
    var s = 100 - zhPrefRank(v) * 100;
    if (v.localService === true) s += 60; else s += 0;
    if (CLEAR_HINT.test(voiceText(v))) s += 15;
    return s;
  }

  /** 云端音色标记（需联网，可能静默无声；下拉里会标注）。 */
  function isCloudVoice(v) { return v.localService !== true; }

  /** 估算朗读耗时（毫秒）：在收不到 onend 的浏览器上用于兜底推进，不靠它做静默判定。 */
  function estimateSpeakMs(text, rate) {
    var r = (rate > 0 ? rate : 1);
    var cjk = (String(text).match(/[\u4e00-\u9fa5]/g) || []).length;
    var words = (String(text).match(/[A-Za-z']+/g) || []).length;
    var ms = cjk * 430 / r + words * 380 / r;
    return Math.max(1500, ms + 2000);
  }

  /* ------------------------- 在线音源 ------------------------- */
  /*
   * 为什么需要：手机端浏览器（Edge 移动版等）常未安装可用的 TTS 语音包，
   * speechSynthesis.getVoices() 返回空列表 → 页面显示「自动（未检测到音色）」
   * 「自动配对（无中文音色）」，汉字只能用英文腔读拼音，发音不准。
   *
   * 关键约束（实测）：有道与百度接口都不返回 CORS 头，
   *   所以只能用 <audio src> 直接播放，不能用 fetch/XHR 下载成 Blob（会被拦截）。
   *   缓存因此靠两点：① 复用同一个 Audio 元素（倒回 0 重播，不发新请求）；
   *                    ② 浏览器 HTTP 缓存（百度返回 Cache-Control: max-age=3600）。
   * 有道对长英文例句会间歇性返回 500，故与百度互备；全部失败再退回系统音色。
   */

  /*
   * 在线音色目录：英文 4 个 / 中文 3 个。
   *
   * 【如实说明，勿再写成男声/女声】
   * 免密钥的公开朗读接口（百度 gettts / 有道 dictvoice）每种语言只提供**一个**发音人，
   * 没有可用的男女声切换参数。实测结论（2026-10-29）：
   *   - 百度 `person` 参数无效：中文 person=0..4 返回的音频字节数完全一致（均为 11232），
   *     英文各值字节数在 ±5% 内随机抖动且区间相互重叠 —— 都是同一个发音人，
   *     差异只是 MP3 编码层面的字节抖动，听感上无法区分。
   *   - 百度 `spd`（语速）确实有效：中文 spd=2/3/4/5/6 -> 12672/11232/10080/9216/8352 字节。
   *   - 有道 `type=1/2` 可在英音/美音间切换，但接口限流明显（连续请求第二条起返回 500）。
   *
   * 所以下面的选项是「不同引擎 × 语速/口音」的组合，标签只描述真实存在的差异。
   * 百度与有道是两套不同的 TTS 引擎，中文/英文音色本身确有听感区别；
   * 同引擎内的两个选项则是语速快慢之别。
   */
  var ONLINE_VOICES = [
    { id: 'en-baidu-std', lang: 'en', provider: 'baidu', spd: 3, label: '百度 · 英文（标准语速）' },
    { id: 'en-baidu-slow', lang: 'en', provider: 'baidu', spd: 2, label: '百度 · 英文（慢速）' },
    { id: 'en-youdao-uk', lang: 'en', provider: 'youdao', accent: 'uk', label: '有道 · 英文（英音）' },
    { id: 'en-youdao-us', lang: 'en', provider: 'youdao', accent: 'us', label: '有道 · 英文（美音）' },
    { id: 'zh-baidu-std', lang: 'zh', provider: 'baidu', spd: 3, label: '百度 · 中文（标准语速）' },
    { id: 'zh-baidu-slow', lang: 'zh', provider: 'baidu', spd: 2, label: '百度 · 中文（慢速）' },
    { id: 'zh-youdao', lang: 'zh', provider: 'youdao', label: '有道 · 中文' }
  ];

  /** 取某语言的在线音色列表。 */
  function onlineVoicesOf(lang) {
    return ONLINE_VOICES.filter(function (v) { return v.lang === lang; });
  }

  /** 取某语言的默认在线音色。 */
  function defaultOnlineVoice(lang) {
    return onlineVoicesOf(lang)[0] || null;
  }

  /** 按 id 找在线音色（找不到返回该语言默认）。 */
  function findOnlineVoice(lang, id) {
    var hit = onlineVoicesOf(lang).filter(function (v) { return v.id === id; })[0];
    return hit || defaultOnlineVoice(lang);
  }

  /** 把长文本切成 <= max 字符的小段，优先在标点/空格处断开。 */
  function chunkText(text, max) {
    var s = String(text || '').trim();
    if (!s) return [];
    if (s.length <= max) return [s];
    var out = [], buf = '';
    for (var i = 0; i < s.length; i++) {
      buf += s.charAt(i);
      var atBreak = /[，,。.；;！!？?、\s]/.test(s.charAt(i));
      if (buf.length >= max && atBreak) { out.push(buf.trim()); buf = ''; }
      else if (buf.length >= max + 25) { out.push(buf.trim()); buf = ''; }
    }
    if (buf.trim()) out.push(buf.trim());
    return out.filter(function (x) { return x.length > 0; });
  }

  /** 等待 audio 播完；成功 resolve，失败/超时 reject。 */
  function waitAudioEnd(el, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = window.setTimeout(function () { finish(false); }, timeoutMs || 30000);
      function finish(ok) {
        if (done) return;
        done = true;
        window.clearTimeout(timer);
        el.removeEventListener('ended', onend);
        el.removeEventListener('error', onerror);
        if (ok) { resolve(); } else { reject(new Error('audio failed')); }
      }
      function onend() { finish(true); }
      function onerror() { finish(false); }
      el.addEventListener('ended', onend);
      el.addEventListener('error', onerror);
    });
  }

  var OnlineTTS = {
    cache: {},     // key -> HTMLAudioElement（复用重播，不产生新请求）
    order: [],
    limit: 80,
    failed: {},    // provider 连续失败计数（用于自动降级）
    lastUsed: '',        // 本次实际发声的音色 id
    lastFallback: false, // 本次是否因首选不可用而用了替补

    buildUrl: function (text, lang, v) {
      var t = encodeURIComponent(text);
      if (v.provider === 'baidu') {
        return 'https://fanyi.baidu.com/gettts?lan=' + (lang === 'zh' ? 'zh' : 'en') +
               '&text=' + t + '&spd=' + (v.spd || 3) + '&source=web';
      }
      var u = 'https://dict.youdao.com/dictvoice?audio=' + t + '&le=' + (lang === 'zh' ? 'zh' : 'en');
      if (lang !== 'zh') { u += '&type=' + (v.accent === 'uk' ? '1' : '2'); }
      return u;
    },

    /** 取出（或新建）某段文本的 Audio 元素。 */
    _el: function (text, lang, v) {
      var key = v.id + '|' + text;
      var el = this.cache[key];
      if (!el) {
        el = new Audio();
        el.preload = 'auto';
        el.src = this.buildUrl(text, lang, v);
        this.cache[key] = el;
      }
      var i = this.order.indexOf(key);
      if (i >= 0) { this.order.splice(i, 1); }
      this.order.push(key);
      while (this.order.length > this.limit) {
        var old = this.order.shift();
        try { var e = this.cache[old]; if (e) { e.pause(); e.src = ''; } } catch (err) { /* 忽略 */ }
        delete this.cache[old];
      }
      return el;
    },

    /**
     * 播放一段文本（长文本自动分片顺序播放）。
     * @returns {Promise<boolean>} true 成功；false 表示在线音源不可用，调用方应降级。
     */
    speak: function (text, lang, voiceId, rate) {
      var self = this;
      var pool = onlineVoicesOf(lang);
      // 容错：既允许传音色 id 字符串，也允许直接传音色对象
      var wantId = (voiceId && typeof voiceId === 'object') ? voiceId.id : voiceId;
      var first = pool.filter(function (v) { return v.id === wantId; })[0];
      var queue = [];
      if (first) { queue.push(first); }
      pool.forEach(function (v) { if (queue.indexOf(v) < 0) { queue.push(v); } });

      // 长文本分片：有道接口对长句不稳，统一按 provider 上限切段
      var playOne = function (v) {
        var maxChars = (v.provider === 'youdao') ? 10 : 120;
        var chunks = chunkText(text, maxChars);
        if (!chunks.length) { return Promise.resolve(true); }
        var step = function (idx) {
          if (idx >= chunks.length) { return Promise.resolve(true); }
          var el = self._el(chunks[idx], lang, v);
          try { el.currentTime = 0; } catch (e) { /* 忽略 */ }
          try { el.playbackRate = Math.max(0.25, Math.min(2, Number(rate) || 1)); } catch (e) { /* 忽略 */ }
          var p = el.play();
          if (p && typeof p.then === 'function') {
            return p.then(function () { return waitAudioEnd(el); })
                    .then(function () { return step(idx + 1); },
                          function () { return Promise.reject(new Error('play failed')); });
          }
          return waitAudioEnd(el).then(function () { return step(idx + 1); });
        };
        return step(0);
      };

      var attempt = function (idx) {
        if (idx >= queue.length) {
          self.lastUsed = '';
          self.lastFallback = false;
          return Promise.resolve(false);
        }
        return playOne(queue[idx]).then(function () {
          // 记录实际发声的音色：idx>0 说明首选音色不可用，播放的是替补。
          // 调用方据此提示用户，避免"换了选项但听起来一样"却查不出原因。
          self.lastUsed = queue[idx].id;
          self.lastFallback = (idx > 0);
          return true;
        }, function () { return attempt(idx + 1); });
      };
      return attempt(0);
    },

    stop: function () {
      var self = this;
      Object.keys(this.cache).forEach(function (k) {
        try { var e = self.cache[k]; if (e) { e.pause(); } } catch (err) { /* 忽略 */ }
      });
    },

    /**
     * 自检用：真实拉一次音频并报告结果（不进入缓存，不影响正常播放）。
     * 返回 { ok, err, url }。err 会把 <audio> 的 error.code 翻成人话，
     * 因为「接口返回 0 字节 HTML」和「被 CORS 拦」「解码失败」都会表现成"没声音"，
     * 只有 code 能区分，排查时必须看得到。
     */
    probe: function (text, lang, v) {
      v = v || defaultOnlineVoice(lang);
      if (!v) { return Promise.resolve({ ok: false, err: '没有可用音色', url: '' }); }
      var url = this.buildUrl(text, lang, v);
      return new Promise(function (resolve) {
        var el = new Audio();
        var done = false;
        var timer = window.setTimeout(function () { finish(false, '12 秒内没有开始播放'); }, 12000);
        function finish(ok, err) {
          if (done) return;
          done = true;
          window.clearTimeout(timer);
          try { el.pause(); el.src = ''; } catch (e) { /* 忽略 */ }
          resolve({ ok: ok, err: err || '', url: url });
        }
        el.addEventListener('playing', function () { finish(true); }, { once: true });
        el.addEventListener('error', function () {
          var c = (el.error && el.error.code) || 0;
          var map = {
            1: '加载被中断',
            2: '网络错误（可能被拦截或断网）',
            3: '解码失败',
            4: '地址无效或返回的不是音频（多半被接口的 Referer 校验挡了）'
          };
          finish(false, (map[c] || '未知错误') + ' code=' + c);
        }, { once: true });
        el.preload = 'auto';
        el.src = url;
        var p = el.play();
        if (p && typeof p.catch === 'function') {
          p.catch(function (e) {
            finish(false, 'play() 被拒绝：' + ((e && e.name) || e));
          });
        }
      });
    }
  };

  /* ------------------------- 打包本地中文字音 ------------------------- */
  /*
   * 为什么需要：在线朗读接口在平台沙箱里多次实测不可用（百度校验 Referer 白名单、
   * 有道英文句随机 500），而系统 TTS 在手机上常常没有语音包、读音也不准。
   * 430 个汉字的标准普通话读音已离线打包成 audio_zh.js（data:audio/mpeg;base64），
   * 播放它不发出任何网络请求 —— Referer、CSP、限流、断网全都影响不到。
   *
   * 数据结构：window.AUDIO_ZH = { "<汉字>": "data:audio/mpeg;base64,..." }。
   * 由 ../audio_zh_raw/build.py 生成，汉字读音更新后重跑该脚本即可。
   */
  var BundledAudio = {
    el: null,   // 复用同一个 Audio 元素（data: URI 无需缓存管理）

    /** 取某汉字的打包读音（data URI）；没有返回 ''。 */
    get: function (ch) {
      try {
        var m = window.AUDIO_ZH || {};
        var v = m[ch];
        return (typeof v === 'string' && v.indexOf('data:audio') === 0) ? v : '';
      } catch (e) { return ''; }
    },

    /** 是否已打包（用于自检显示）。 */
    count: function () {
      try { return Object.keys(window.AUDIO_ZH || {}).length; } catch (e) { return 0; }
    },

    /**
     * 播放某汉字的打包读音，times 遍（遍间隔 350ms，模拟原来「汉，汉」的停顿节奏）。
     * @returns {Promise<boolean>} true=播完；false=播放失败（调用方应降级到在线/系统链路）
     */
    speak: function (ch, times) {
      var self = this;
      var src = this.get(ch);
      if (!src) { return Promise.resolve(false); }
      times = Math.max(1, Math.floor(times) || 1);
      if (!this.el) { this.el = new Audio(); }
      var el = this.el;
      var n = 0;

      var playOne = function () {
        el.src = src;   // data: URI 瞬时可用
        var p = el.play();
        if (p && typeof p.then === 'function') {
          return p.then(function () { return waitAudioEnd(el, 15000); });
        }
        return waitAudioEnd(el, 15000);
      };
      var step = function () {
        if (n >= times) { return Promise.resolve(true); }
        n += 1;
        return playOne().then(function () {
          return new Promise(function (resolve) { window.setTimeout(resolve, 350); });
        }).then(step, function () {
          // 第一遍就放不出来（权限/解码问题）才算失败；中途失败也按已播处理，避免重复降级
          return Promise.resolve(n > 1);
        });
      };
      return step();
    },

    stop: function () {
      if (this.el) { try { this.el.pause(); } catch (e) { /* 忽略 */ } }
    }
  };

  var Speech = {
    supported: typeof window.speechSynthesis !== 'undefined',
    voice: null,
    voices: [],        // 精简后的英文候选（2 女 + 2 男）
    zhCandidates: [],  // 中文候选（用于朗读汉字读音）
    zhFemales: [],     // 中文女声候选
    zhMales: [],       // 中文男声候选
    zhVoice: null,     // 与英文音色性别配对的中文音色
    zhMismatch: false, // 是否没找到同性别中文音色而退回其他性别
    zhRepeats: ZH_REPEAT, // 汉字读音重复遍数（提升听清度）
    rate: SPEECH_RATE,
    items: [],
    perRound: 0,
    rounds: 1,
    roundGap: STEP_GAP_MS,
    index: -1,
    playing: false,
    stopped: false,
    current: null,
    handlers: {},
    onVoicesReady: null,

    /** 初始化：异步获取语音列表（Chrome 需监听 onvoiceschanged）。 */
    init: function () {
      if (!this.supported) return;
      var self = this;
      var load = function () {
        var all = window.speechSynthesis.getVoices() || [];
        if (!all.length) return;

        // 1) 英文候选：先本地后云端，按性别配额挑选（2 女 + 2 男），云端音色排在同性别后面
        var en = all.filter(function (v) { return /^en/i.test(v.lang || ''); });
        var byScore = function (list) {
          return list.slice().sort(function (a, b) { return scoreVoice(b) - scoreVoice(a); });
        };
        var females = byScore(en.filter(function (v) { return voiceGender(v) === 'f'; }));
        var males = byScore(en.filter(function (v) { return voiceGender(v) === 'm'; }));
        var rest = byScore(en.filter(function (v) { return voiceGender(v) === 'u'; }));
        var picked = [];
        // 女声：先本地（稳定），不足时补云端自然音色（Aria/Jenny，播音腔更清晰）
        ['local', 'cloud'].forEach(function (kind) {
          if (picked.filter(function (v) { return voiceGender(v) === 'f'; }).length >= VOICE_QUOTA_F) return;
          females.forEach(function (v) {
            if (picked.indexOf(v) >= 0) return;
            if (picked.filter(function (x) { return voiceGender(x) === 'f'; }).length >= VOICE_QUOTA_F) return;
            if (kind === 'local' ? isCloudVoice(v) : !isCloudVoice(v)) return;
            picked.push(v);
          });
        });
        // 男声：同样先本地后云端
        ['local', 'cloud'].forEach(function (kind) {
          if (picked.filter(function (v) { return voiceGender(v) === 'm'; }).length >= VOICE_QUOTA_M) return;
          males.forEach(function (v) {
            if (picked.indexOf(v) >= 0) return;
            if (picked.filter(function (x) { return voiceGender(x) === 'm'; }).length >= VOICE_QUOTA_M) return;
            if (kind === 'local' ? isCloudVoice(v) : !isCloudVoice(v)) return;
            picked.push(v);
          });
        });
        // 性别无法判定的音色补位（保证下拉不为空）
        rest.forEach(function (v) {
          if (picked.indexOf(v) < 0 && picked.length < VOICE_QUOTA_F + VOICE_QUOTA_M) picked.push(v);
        });
        self.voices = picked;

        // 2) 中文候选：与英文一致取 2 女 + 2 男（按偏好顺序，播音腔男声"云扬"优先，康康排最后）
        var zh = all.filter(function (v) { return /^zh/i.test(v.lang || ''); });
        var zhPool = zh.slice().sort(function (a, b) { return scoreZhVoice(b) - scoreZhVoice(a); });
        var zhF = zhPool.filter(function (v) { return voiceGender(v) === 'f'; });
        var zhM = zhPool.filter(function (v) { return voiceGender(v) === 'm'; });
        var zhU = zhPool.filter(function (v) { return voiceGender(v) === 'u'; });
        var zhPick = zhF.slice(0, VOICE_QUOTA_F).concat(zhM.slice(0, VOICE_QUOTA_M));
        zhU.forEach(function (v) {
          if (zhPick.length < VOICE_QUOTA_F + VOICE_QUOTA_M) zhPick.push(v);
        });
        if (!zhPick.length) zhPick = zhPool.slice(0, 2);  // 保底，避免"自动配对"无音色可用
        self.zhCandidates = zhPick;
        self.zhFemales = zhF;
        self.zhMales = zhM;

        // 3) 选中音色：用户选过的优先，否则选最清晰的女声
        var saved = null;
        saved = Store.get('voice_uri');
        var chosen = null;
        if (saved) {
          chosen = self.voices.filter(function (v) { return v.voiceURI === saved; })[0] || null;
          if (!chosen) { chosen = all.filter(function (v) { return v.voiceURI === saved; })[0] || null; }
        }
        self.voice = chosen || self._bestFemale() || self.voices[0] || null;
        if (chosen && self.voices.indexOf(chosen) === -1) self.voices.unshift(chosen);  // 保留用户已选的
        self._applyZhVoice();

        // 在线音源不依赖系统语音包，所以即使 getVoices() 为空也应视为"可用"
        state.speechReady = this._onlineOn() ? true : !!self.voice;
        var w = $('speech-warn');
        if (!self.voice && !this._onlineOn() && w) {
          w.textContent = '未检测到英文语音包，朗读可能不可用。请在系统中安装 English(US) TTS 语音。';
          w.classList.remove('hidden');
        }
        if (self.onVoicesReady) self.onVoicesReady();
        // 首次加载后静默自检一次当前音色（装了但发不出声的云端音色会被自动换掉），
        // 随后再把候选列表里的每个音色都自检一遍，真实不可用的才会标「无响应」
        if (!self._probed) {
          self._probed = true;
          window.setTimeout(function () {
            self.ensureVoiceWorks(function () {
              if (self.onVoicesReady) self.onVoicesReady();
              // 把候选音色逐个静默自检一遍，全部检完后重新配对中文音色并复核，
              // 确保"已判定无响应"的音色不会一直占着自动选中的位置
              self.probeAll(function () {
                self._applyZhVoice();
                self.ensureVoiceWorks(function () { if (self.onVoicesReady) self.onVoicesReady(); });
              });
            });
          }, 900);
        }
      };
      load();
      try {
        window.speechSynthesis.onvoiceschanged = load;
      } catch (e) { /* 某些浏览器不支持该事件，忽略 */ }
      window.setTimeout(load, 300);
      window.setTimeout(load, 1500);
    },

    /** 发音来源：'online' 联网音源（默认，手机端靠它出声）/ 'system' 系统音色。 */
    source: 'online',
    /** 选中的英文在线音色 id（复用已有的 voice_uri 列存储，不新增表字段）。 */
    onlineVoice: '',
    /** 选中的中文在线音色 id（复用已有的 zh_voice_uri 列存储）。 */
    onlineVoiceZh: '',

    /** 是否走在线音源。 */
    _onlineOn: function () {
      return this.source === 'online';
    },

    /** 取某语言当前选中的在线音色；未选则用该语言默认音色。 */
    _voiceOf: function (lang) {
      return lang === 'zh' ? findOnlineVoice('zh', this.onlineVoiceZh)
                           : findOnlineVoice('en', this.onlineVoice);
    },

    /** 设置发音来源：online / system（存 localStorage，不动云端表结构）。 */
    setSource: function (s) {
      this.source = (s === 'system') ? 'system' : 'online';
      // 平台运行在 sandbox iframe（无 allow-same-origin）里，localStorage 会直接抛异常，
      // 所以偏好以云端表 cebsb_settings 为准，localStorage 只作无害的镜像。
      Store.set('source', this.source);
      lsSet(LS_SOURCE, this.source);
      return this.source;
    },

    /** 设置英文在线音色 id（存云端表，避免覆写系统音色偏好字段）。 */
    setOnlineVoice: function (id) {
      this.onlineVoice = id || '';
      Store.set('online_voice', this.onlineVoice);
      lsSet(LS_ONLINE_VOICE, this.onlineVoice);
      return this.onlineVoice;
    },

    /** 设置中文在线音色 id（存云端表）。 */
    setOnlineVoiceZh: function (id) {
      this.onlineVoiceZh = id || '';
      Store.set('online_voice_zh', this.onlineVoiceZh);
      lsSet(LS_ONLINE_VOICE_ZH, this.onlineVoiceZh);
      return this.onlineVoiceZh;
    },

    /** 候选里分数最高的本地女声（默认音色；云端音色不作默认，避免离线无声）。 */
    _bestFemale: function () {
      var females = this.voices.filter(function (v) { return voiceGender(v) === 'f' && v.__ok !== false; });
      var local = females.filter(function (v) { return !isCloudVoice(v); });
      return local[0] || females[0] || this.voices[0] || null;
    },

    /**
     * 按英文音色的性别配对中文音色（英女→中女，英男→中男）。
     * 优先用用户在下拉里手动指定的中文音色；找不到同性别中文音色时退回任一中文音色，
     * 并把 zhMismatch 置为 true，页面会提示"系统未安装同性别中文语音"。
     */
    _applyZhVoice: function () {
      var manual = null;
      manual = Store.get('zh_voice_uri');
      if (manual) {
        var hit = this.zhCandidates.filter(function (v) { return v.voiceURI === manual; })[0];
        if (hit) { this.zhVoice = hit; this.zhMismatch = false; return this.zhVoice; }
      }
      if (!this.zhCandidates.length) { this.zhVoice = null; this.zhMismatch = false; return null; }
      var g = this.voice ? voiceGender(this.voice) : 'f';
      var same = (g === 'm') ? this.zhMales : this.zhFemales;
      // 已确认发不出声的音色不参与自动配对
      var okSame = same.filter(function (v) { return v.__ok !== false; });
      if (okSame.length) same = okSame;
      if (same && same.length) { this.zhVoice = same[0]; this.zhMismatch = false; return this.zhVoice; }
      // 没有同性别的中文音色：退回任一中文音色并标记，页面给出提示
      this.zhVoice = this.zhCandidates[0] || null;
      this.zhMismatch = !!this.zhVoice;
      return this.zhVoice;
    },

    /**
     * 静默自检某个音色是否真能发声：用 volume=0 读一个短促音节，只看事件能否回来。
     * 为减少误判：①超时前先看引擎是否已在朗读（onstart 不触发但引擎在响也算可用）；
     * ②失败后自动重试一次，连续两次都无响应才标记为不可用。结果缓存在 v.__ok 上。
     */
    probeVoice: function (v, cb) {
      if (!this.supported || !v) { if (cb) cb(false); return; }
      if (v.__ok === true || v.__ok === false) { if (cb) cb(v.__ok); return; }
      if (this.playing) { if (cb) cb(true); return; }   // 正在朗读时不打扰
      var self = this;
      var attempt = 0;       // 已尝试次数（最多 2 次）
      var done = false;
      var timer = null;
      var poll = null;
      var finish = function (ok) {
        if (done) return;
        if (!ok && attempt < 1) {
          // 第一次失败：清空队列后重试一次（Chrome 偶发丢音，一次失败不能下结论）
          attempt = 1;
          try { window.speechSynthesis.cancel(); } catch (e) { /* 忽略 */ }
          window.setTimeout(run, 350);
          return;
        }
        done = true;
        if (timer) { window.clearTimeout(timer); timer = null; }
        if (poll) { window.clearInterval(poll); poll = null; }
        v.__ok = !!ok;
        if (cb) cb(!!ok);
      };
      var run = function () {
        if (self.playing) { finish(true); return; }     // 播放开始后不再探测
        var u = new SpeechSynthesisUtterance(/^zh/i.test(v.lang || '') ? '好' : 'a');
        u.voice = v;
        u.lang = v.lang || SPEECH_LANG;
        u.volume = 0;
        u.rate = 1;
        u.onstart = function () { finish(true); };
        u.onend = function () { finish(true); };
        u.onerror = function () { finish(false); };
        try {
          window.speechSynthesis.speak(u);
        } catch (e) {
          finish(false);
          return;
        }
        // 引擎已经在朗读（只是 onstart 事件没回调）视为可用，避免云端音色被误标
        poll = window.setInterval(function () {
          var busy = false;
          try { busy = !!(window.speechSynthesis.speaking || window.speechSynthesis.pending); } catch (e) { /* 忽略 */ }
          if (busy) finish(true);
        }, 400);
        timer = window.setTimeout(function () { finish(false); }, PROBE_TIMEOUT_MS);
      };
      run();
    },

    /**
     * 逐个自检候选列表里的每个音色（英文 + 中文），把结果写进 v.__ok，
     * 完成后回调，用于刷新下拉里的「无响应」标注。已判定过的音色跳过。
     */
    probeAll: function (done) {
      var self = this;
      if (!this.supported) { if (done) done(); return; }
      var list = this.voices.concat(this.zhCandidates).filter(function (v, i, a) {
        return a.indexOf(v) === i && v.__ok === undefined;
      });
      var i = 0;
      var next = function () {
        if (self.stopped || self.playing) { if (done) done(); return; }  // 用户开始朗读就中止探测
        if (i >= list.length) { if (done) done(); return; }
        self.probeVoice(list[i++], function () { window.setTimeout(next, 150); });
      };
      next();
    },

    /**
     * 确保当前音色真的可用（如云端 Ava 之类装了却发不出声的情况）：
     * 自检失败就自动换下一个候选（同性别优先），并把不可用的音色标注出来。
     */
    ensureVoiceWorks: function (onChanged) {
      var self = this;
      if (!this.supported || !this.voice || this.playing) return;
      this.probeVoice(this.voice, function (ok) {
        if (ok) {
          self._ensureZhWorks(onChanged);
          return;
        }
        var g = voiceGender(self.voice);
        var idx = self.voices.indexOf(self.voice);
        var next = null, i;
        // 先找同性别且未判定不可用的
        for (i = idx + 1; i < self.voices.length; i++) {
          if (self.voices[i].__ok !== false && voiceGender(self.voices[i]) === g) { next = self.voices[i]; break; }
        }
        if (!next) {
          for (i = 0; i < self.voices.length; i++) {
            if (self.voices[i] !== self.voice && self.voices[i].__ok !== false) { next = self.voices[i]; break; }
          }
        }
        if (!next) { self._ensureZhWorks(onChanged); return; }
        var oldName = shortVoiceName(self.voice);
        self.voice = next;
        self._applyZhVoice();
        try {
          toast('音色 ' + oldName + ' 不可用，已自动切换到 ' + shortVoiceName(next));
          if (self.onVoiceFail) self.onVoiceFail();
        } catch (e) { /* 忽略 */ }
        if (onChanged) onChanged();
        self.ensureVoiceWorks(onChanged);
      });
    },

    /** 中文配音音色同样自检一次，不可用则换下一个中文音色。 */
    _ensureZhWorks: function (onChanged) {
      var self = this;
      if (!this.zhVoice) { if (onChanged) onChanged(); return; }   // 没有中文音色：直接放行后续链路
      if (this.playing) return;
      this.probeVoice(this.zhVoice, function (ok) {
        if (ok || self.zhVoice.__ok !== false) {
          if (onChanged) onChanged();   // 自检通过也要回调，保证后续链路（如全量自检）能继续
          return;
        }
        var oldName = shortVoiceName(self.zhVoice);
        if (self._demote('zh')) {
          try {
            toast('中文音色 ' + oldName + ' 不可用，已切换到 ' + shortVoiceName(self.zhVoice));
            if (self.onVoiceFail) self.onVoiceFail();
          } catch (e) { /* 忽略 */ }
        }
        if (onChanged) onChanged();   // 无论是否换成功都放行后续链路
      });
    },

    /** 手动指定中文配音音色（uri 为空表示恢复自动配对）。 */
    setZhVoice: function (uri) {
      Store.set('zh_voice_uri', uri || '');
      this._applyZhVoice();
      return this.zhVoice;
    },

    /** 某音色读不出声音时，切换到下一个候选（用于自动降级）。 */
    _demote: function (lang) {
      var self = this;
      if (lang === 'zh') {
        // 只在同性别的中文音色里换，避免"英文男声配到中文女声"这种错配
        var g = this.zhVoice ? voiceGender(this.zhVoice) : (this.voice ? voiceGender(this.voice) : 'f');
        var same = (g === 'm') ? this.zhMales : this.zhFemales;
        var i = same.indexOf(this.zhVoice);
        var k;
        // 往后找第一个"没有确认不可用"的同性别音色，找不到再从头找
        for (k = i + 1; k < same.length; k++) {
          if (same[k].__ok !== false) { this.zhVoice = same[k]; return true; }
        }
        for (k = 0; k < i; k++) {
          if (same[k].__ok !== false) { this.zhVoice = same[k]; return true; }
        }
        // 同性别的都用不了：退而求其次选任一中文音色（保证不出"哑巴"），并标记性别不匹配
        var other = this.zhCandidates.filter(function (v) {
          return v !== self.zhVoice && v.__ok !== false;
        })[0];
        if (other) { this.zhVoice = other; this.zhMismatch = true; return true; }
        return false;
      }
      var k = this.voices.indexOf(this.voice);
      if (k >= 0 && k + 1 < this.voices.length) {
        this.voice = this.voices[k + 1];
        this._applyZhVoice();
        return true;
      }
      return false;
    },

    /** 按 voiceURI 切换语音，并记住选择；同时重新配对中文音色。 */
    setVoice: function (uri) {
      var v = this.voices.filter(function (x) { return x.voiceURI === uri; })[0] || null;
      this.voice = v || this._bestFemale() || this.voices[0] || null;
      Store.set('voice_uri', uri || '');
      this._applyZhVoice();
      // 切换后立刻静默自检：选到"装了但发不出声"的音色时自动换掉
      var self = this;
      this.ensureVoiceWorks(function () { if (self.onVoicesReady) self.onVoicesReady(); });
      return this.voice;
    },

    /** 设置汉字读音的重复遍数（增强听清度）。 */
    setZhRepeats: function (n) {
      var v = parseInt(n, 10);
      this.zhRepeats = (v >= 1 && v <= 3) ? v : ZH_REPEAT;
      Store.set('zh_repeat', String(this.zhRepeats));
      return this.zhRepeats;
    },

    setRate: function (r) {
      var n = parseFloat(r);
      this.rate = (isFinite(n) && n > 0) ? n : SPEECH_RATE;
      Store.set('rate', String(r));   // 存原始字符串，保证 1.0 这类档位能正确回显
    },

    /**
     * 依次播放多段文本；每段开始时回调 onStep(i)，全部结束回调 onDone()。
     * @param {Array<string>} items 一遍要读的文本
     * @param {Object} handlers {onStep, onDone}
     * @param {Object=} opts {rounds: 朗读遍数, roundGapMs: 两遍之间的间隔}
     */
    play: function (items, handlers, opts) {
      this.stop();
      if (!this.supported) {
        if (handlers && handlers.onDone) handlers.onDone();
        return;
      }
      opts = opts || {};
      var self = this;
      var rounds = Math.max(1, parseInt(opts.rounds, 10) || 1);
      var merged = [];
      for (var r = 0; r < rounds; r++) { merged = merged.concat(items); }
      this.items = merged;
      this.perRound = items.length;
      this.rounds = rounds;
      this.roundGap = opts.roundGapMs || STEP_GAP_MS;
      this.handlers = handlers || {};
      this.stopped = false;
      this.playing = true;
      this._gen = (this._gen || 0) + 1;   // 代次：防止上一题的延迟启动跑到本题，造成两条朗读链并发
      var gen = this._gen;
      // cancel() 之后立刻 speak() 在 Chrome 上常出现"静默丢失/不触发 onstart"，延迟一拍再读第一段
      window.setTimeout(function () {
        if (!self.stopped && self._gen === gen) self._next(0);
      }, SPEAK_DELAY_MS);
    },

    _next: function (i) {
      var self = this;
      if (this.stopped) { return; }
      if (i >= this.items.length) {
        this.playing = false;
        this.index = -1;
        if (this.handlers.onStep) this.handlers.onStep(-1);
        if (this.handlers.onDone) this.handlers.onDone();
        return;
      }
      this.index = i;
      if (this.handlers.onStep) this.handlers.onStep(i);

      // 段可以是字符串，也可以是 {text, lang, step}：读音段用中文音色朗读
      var seg = this.items[i];
      var isSeg = (seg && typeof seg === 'object');
      var text = isSeg ? String(seg.text || '') : String(seg);
      var rawText = text;   // 原始单字（未被下面的「重复 N 遍」改写成"汉，汉"），打包字音按它查表
      var lang = (isSeg && seg.lang === 'zh') ? 'zh' : 'en';
      var voice = lang === 'zh' ? (this.zhVoice || this.voice) : this.voice;

      var u = new SpeechSynthesisUtterance(text);
      if (voice) { u.voice = voice; }
      u.lang = lang === 'zh'
        ? ((voice && voice.lang) || 'zh-CN')
        : (voice ? (voice.lang || SPEECH_LANG) : SPEECH_LANG);
      // 汉字读音：放慢、抬高音高、重复 N 遍，解决"声音小、听不清"
      var segRepeat = (isSeg && typeof seg.repeat === 'number' && seg.repeat > 1) ? seg.repeat : 1;
      if (lang === 'zh') {
        if (segRepeat > 1) {
          var parts = [];
          for (var k = 0; k < segRepeat; k++) parts.push(text);
          text = parts.join('，');   // 用逗号分隔，强制引擎逐字给出完整声调
          u.text = text;
        }
        u.rate = Math.min(this.rate > 0 ? this.rate : ZH_RATE, ZH_RATE);
        u.pitch = ZH_PITCH;
      } else {
        u.rate = this.rate;
        u.pitch = SPEECH_PITCH;
      }
      u.volume = SPEECH_VOLUME;

      // 段间停顿：一遍读完（且后面还有内容）时按遍间间隔停顿；汉字读音前额外预停顿
      var nextIndex = i + 1;
      var gap;
      if (nextIndex >= this.items.length) gap = 0;
      else if (this.perRound > 0 && nextIndex % this.perRound === 0) gap = this.roundGap;
      else {
        var nxt = this.items[nextIndex];
        gap = (nxt && typeof nxt === 'object' && nxt.lang === 'zh') ? ZH_PREROLL_MS : STEP_GAP_MS;
      }
      var rate0 = u.rate;   // 交给 <audio> 的 playbackRate 用

      var started = false;   // 是否真的开始发声（onstart 或引擎处于朗读中）
      var ended = false;     // 是否已结束/出错
      var watchdog = null;   // 静默检测
      var fallback = null;   // 引擎在朗读但收不到 onend 时的兜底推进
      var retried = false;   // 是否已重试过一次
      var gen0 = this._gen || 0;   // 本次朗读链所属代次：被 stop() 作废后所有异步回调都必须停下
      var clearTimers = function () {
        if (watchdog) { window.clearTimeout(watchdog); watchdog = null; }
        if (fallback) { window.clearTimeout(fallback); fallback = null; }
      };
      var advance = function (delay) {
        clearTimers();
        if (self.stopped) return;
        window.setTimeout(function () {
          if (self.stopped || self._gen !== gen0) return;
          self._next(nextIndex);
        }, delay);
      };
      u.onstart = function () { started = true; };
      u.onend = function () { if (ended) return; ended = true; advance(gap); };
      u.onerror = function () { if (ended) return; ended = true; advance(200); };
      this.current = u;

      var speakOnce = function () {
        try {
          // Chrome 偶发"合成器挂起"，读之前唤醒一次（不唤醒时表现为完全无声）
          if (window.speechSynthesis.paused) { window.speechSynthesis.resume(); }
          window.speechSynthesis.speak(u);
        } catch (e) {
          advance(200);
          return;
        }
        // 静默检测：只有"确实一点声音都没有"才判定音色不可用
        watchdog = window.setTimeout(function () {
          if (self.stopped || self._gen !== gen0 || ended || started) return;
          // Chrome 常有 onstart 不触发的情况，只要引擎在朗读就视为正常，不能误判成音色不可用
          var busy = false;
          try { busy = !!(window.speechSynthesis.speaking || window.speechSynthesis.pending); } catch (e) { /* 忽略 */ }
          if (busy) {
            started = true;
            // 收不到 onend 时按估算时长兜底推进，避免整条朗读卡死
            fallback = window.setTimeout(function () {
              if (ended || self.stopped || self._gen !== gen0) return;
              ended = true;
              advance(120);
            }, estimateSpeakMs(text, u.rate));
            return;
          }
          // 首次静默先重试一次（cancel() 后立即 speak() 是 Chrome 已知会丢音的场景）
          if (!retried) {
            retried = true;
            try { window.speechSynthesis.cancel(); } catch (e) { /* 忽略 */ }
            window.setTimeout(function () {
              if (self.stopped || self._gen !== gen0) return;
              speakOnce();
            }, 150);
            return;
          }
          var oldName = shortVoiceName(lang === 'zh' ? self.zhVoice : self.voice);
          if (self._demote(lang)) {
            try {
              toast('音色 ' + oldName + ' 无响应，已切换到 ' + shortVoiceName(lang === 'zh' ? self.zhVoice : self.voice));
              if (self.onVoiceFail) self.onVoiceFail();
            } catch (e) { /* 忽略 */ }
            clearTimers();
            self._next(i);
          } else {
            advance(200);
          }
        }, WATCHDOG_MS);
      };
      // —— 打包本地中文字音优先 ——
      // 联网朗读在平台沙箱里被 Referer 校验 / 安全策略挡住的可能性高（v1.3 实测用户端仍不发声），
      // 打包音频是 data: URI，不发出任何网络请求，从根上绕开这些问题。
      // 失败（极少见，如解码异常）再走在线 / 系统链路，保证一定有声。
      var speakOnline = function () {
        // —— 在线音源 ——
        // 手机端系统没有 TTS 语音包时，改走联网朗读；成功则按原节奏推进下一段。
        // 失败（限流 503/500、断网、接口变更）自动降级回系统音色链路，
        // 因此 PC 端已有的正常行为不会被破坏。
        if (!self._onlineOn()) { speakOnce(); return; }
        // 注意：这里必须传音色 id 字符串，不能传音色对象，
        // 否则 speak() 里 v.id === voiceId 永远为假，首选音色不生效（表现为换音色没反应）。
        var ov = self._voiceOf(lang);
        OnlineTTS.speak(text, lang, ov ? ov.id : '', rate0).then(function (ok) {
          if (ok) {
            // 首选音色不可用、实际用了替补时明确告知，
            // 避免"换了选项却听着一样"而查不到原因。
            if (ov && OnlineTTS.lastUsed && OnlineTTS.lastUsed !== ov.id) {
              toastOnce('所选音色暂时不可用，已改用其他在线音色');
            }
            advance(gap); return;
          }
          if (self.stopped || self._gen !== gen0) return;
          toastOnce('在线音源不可用，已改用系统音色');
          try { u.rate = rate0; } catch (e) { /* 忽略 */ }
          speakOnce();   // 降级：系统音色
        });
      };
      if (lang === 'zh' && BundledAudio.get(rawText)) {
        BundledAudio.speak(rawText, segRepeat).then(function (ok) {
          if (ok) { advance(gap); return; }
          if (self.stopped || self._gen !== gen0) return;
          speakOnline();
        });
        return;
      }
      speakOnline();
    },

    /** 停止朗读（不触发 onDone）。 */
    stop: function () {
      this.stopped = true;
      this.playing = false;
      this.index = -1;
      this._gen = (this._gen || 0) + 1;   // 作废上一题尚未启动的朗读
      if (this.supported) {
        try { window.speechSynthesis.cancel(); } catch (e) { /* 忽略 */ }
      }
      try { OnlineTTS.stop(); } catch (e) { /* 忽略 */ }
      try { BundledAudio.stop(); } catch (e) { /* 忽略 */ }
      this.current = null;
    },

    /** 单句朗读（用于 Correct / Incorrect 反馈）。 */
    say: function (text) {
      if (!this.supported) return;
      var u = new SpeechSynthesisUtterance(text);
      if (this.voice) { u.voice = this.voice; u.lang = this.voice.lang || SPEECH_LANG; }
      else { u.lang = SPEECH_LANG; }
      u.rate = FEEDBACK_RATE;
      u.pitch = SPEECH_PITCH;
      u.volume = SPEECH_VOLUME;
      this.current = u;
      try { window.speechSynthesis.speak(u); } catch (e) { /* 忽略 */ }
    }
  };

  /* ------------------------- 平台数据层 ------------------------- */
  /* 所有数据一律通过平台运行时 window.applet.data(表名) 读写，平台按登录用户隔离。
     本应用用到三张表：
       cebsb_stats    每个汉字的累计统计（每字一行）
       cebsb_answers  每次作答流水（一次作答一行）
       cebsb_settings 用户偏好（音色 / 语速 / 配字方式，一行）
  */
  var T_STATS = 'cebsb_stats';
  var T_ANSWERS = 'cebsb_answers';
  var T_SETTINGS = 'cebsb_settings';

  /** 平台返回的列表结果统一成数组（兼容 {rows:[]} / {items:[]} / 直接数组三种形态）。 */
  function toRows(res) {
    if (!res) return [];
    if (Array.isArray(res)) return res;
    return res.rows || res.items || res.data || [];
  }

  /** 等待平台把 token 注入运行时（iframe 内由父窗口 postMessage 传入）。 */
  function waitForRuntime() {
    return new Promise(function (resolve, reject) {
      var tries = 0;
      var tick = function () {
        if (window.applet && window.applet.ready) { resolve(); return; }
        tries += 1;
        if (tries > 120) { reject(new Error('平台运行时未就绪')); return; }   // 最多等 12 秒
        window.setTimeout(tick, 100);
      };
      tick();
    });
  }

  var Store = {
    ready: false,       // 运行时是否已就绪
    settings: null,     // 偏好行（含 id）
    statsById: {},      // seq -> 统计行

    /** 偏好默认值（首次使用时写入平台）。 */
    settingsDefaults: function () {
      return {
        voice_uri: '', zh_voice_uri: '', rate: '0.6', zh_repeat: '2',
        style: 'parts', mode: 'all', count: 100,
        // 在线音源偏好：沙箱内 localStorage 不可用，必须和系统音色一样走云端表
        source: 'online', online_voice: '', online_voice_zh: ''
      };
    },
    /** 读偏好；未初始化时返回默认值。 */
    get: function (k) {
      var d = this.settingsDefaults();
      var s = this.settings || d;
      var v = s[k];
      if (v === undefined || v === null) v = d[k];
      return v === undefined ? '' : v;
    },
    /** 写偏好（同步更新内存并异步写回平台，写失败不影响界面使用）。 */
    set: function (k, v) {
      if (!this.settings) { return; }
      this.settings[k] = v;
      if (!this.ready || this.settings.id === undefined) { return; }
      var patch = {}; patch[k] = v;
      try {
        window.applet.data(T_SETTINGS).update(this.settings.id, patch).catch(function () { /* 忽略 */ });
      } catch (e) { /* 忽略 */ }
    },

    /** 连接平台：等 token → 读/建偏好行 → 读全部统计。 */
    connect: function () {
      var self = this;
      return waitForRuntime().then(function () {
        self.ready = true;
        return self.loadSettings();
      }).then(function () {
        return self.loadStats();
      });
    },

    loadSettings: function () {
      var self = this;
      return window.applet.data(T_SETTINGS).list({ limit: 1, offset: 0 }).then(function (res) {
        var rows = toRows(res);
        if (rows.length) { self.settings = rows[0]; return self.settings; }
        return window.applet.data(T_SETTINGS).create(self.settingsDefaults()).then(function (r) {
          var row = (r && r.row) || self.settingsDefaults();
          if (r && r.id !== undefined && r.id !== null && row.id === undefined) { row.id = r.id; }
          self.settings = row;
          return self.settings;
        });
      }).catch(function () {
        self.settings = self.settingsDefaults();   // 兜底：仅内存生效
        return self.settings;
      });
    },

    /** 分页读取统计表（平台单次默认 100 条，这里按 200 一页读全）。 */
    loadStats: function () {
      var self = this;
      var page = 200;
      var index = {};
      var step = function (offset) {
        return window.applet.data(T_STATS).list({ limit: page, offset: offset }).then(function (res) {
          var rows = toRows(res);
          rows.forEach(function (r) {
            if (r && r.seq !== undefined && r.seq !== null) { index[String(r.seq)] = r; }
          });
          if (rows.length < page || offset > 4000) { self.statsById = index; return index; }
          return step(offset + page);
        });
      };
      return step(0).catch(function () { self.statsById = {}; return {}; });
    },

    /** 记录一次作答：更新该字累计统计 + 追加一条流水。 */
    recordAnswer: function (card, correct) {
      var self = this;
      var now = new Date().toISOString();
      var row = this.statsById[String(card.seq)];
      var total = (row ? Number(row.total) || 0 : 0) + 1;
      var okN = (row ? Number(row.correct) || 0 : 0) + (correct ? 1 : 0);
      var badN = (row ? Number(row.wrong) || 0 : 0) + (correct ? 0 : 1);
      var patch = {
        seq: card.seq, char: card.char, pinyin: card.pinyin,
        total: total, correct: okN, wrong: badN, updated_at: now
      };
      var p;
      if (row && row.id !== undefined && row.id !== null) {
        p = window.applet.data(T_STATS).update(row.id, patch).then(function () {
          row.total = total; row.correct = okN; row.wrong = badN; row.updated_at = now;
          return row;
        });
      } else {
        p = window.applet.data(T_STATS).create(patch).then(function (r) {
          // 平台返回 { ok, id }（部分版本回 { row }）：把 id 记下来，
          // 否则同一汉字下次作答会被当成新行再插一条，统计就翻倍了
          var nr = (r && r.row) || patch;
          if (r && r.id !== undefined && r.id !== null && nr.id === undefined) { nr.id = r.id; }
          self.statsById[String(card.seq)] = nr;
          return nr;
        });
      }
      // 作答流水：失败不影响主流程
      try {
        window.applet.data(T_ANSWERS).create({
          seq: card.seq, char: card.char, correct: correct ? 1 : 0,
          // 字段名不能用 created_at（平台托管列），统一叫 answered_at
          style: (state.config && state.config.style) || 'parts', answered_at: now
        }).catch(function () { /* 忽略 */ });
      } catch (e) { /* 忽略 */ }
      return p;
    }
  };

  /* ------------------------- 视图路由 ------------------------- */
  var VIEWS = ['home', 'setup', 'quiz', 'result', 'library'];
  function show(view) {
    VIEWS.forEach(function (v) {
      var el = $('view-' + v);
      if (el) el.classList.toggle('hidden', v !== view);
    });
    state.view = view;
    if (view === 'home') { renderLearnStat(); }   // 回到首页时刷新学习统计
  }

  /* ------------------------- 数据装配 ------------------------- */
  /** 词库（cards.js 内置）+ 平台统计 → 页面用的卡片数组。 */
  function buildCards() {
    var stats = Store.statsById || {};
    return (window.CEB_CARDS || []).map(function (c) {
      var s = stats[String(c.seq)];
      var total = s ? (Number(s.total) || 0) : 0;
      var right = s ? (Number(s.correct) || 0) : 0;
      var wrong = s ? (Number(s.wrong) || 0) : 0;
      return Object.assign({}, c, {
        total: total,
        correct: right,
        wrong: wrong,
        accuracy: total ? Math.round(right / total * 100) : 0,
        error_rate: total ? Math.round(wrong / total * 100) : 100,   // 未测过的字按 100% 计
        updated_at: s ? (s.updated_at || '') : ''
      });
    });
  }

  /** 刷新总览（全部在本地汇总，不再依赖自建后端）。 */
  function refreshOverview() {
    state.cards = buildCards();
    var sumTotal = 0, sumRight = 0, tested = 0;
    state.cards.forEach(function (c) {
      sumTotal += c.total || 0;
      sumRight += c.correct || 0;
      if (c.total) tested += 1;
    });
    state.overview = {
      total: state.cards.length,
      tested: tested,
      learned: tested,                                   // 已在统计表里有练习记录的字
      mastered: state.cards.filter(function (c) {
        return (Number(c.correct) || 0) >= 2;            // 累计答对 ≥2 次视为已掌握
      }).length,
      answered_total: sumTotal,
      overall_accuracy: sumTotal ? Math.round(sumRight / sumTotal * 1000) / 10 : 0,
      pool_all: state.cards.length
    };
    if ($('home-total')) $('home-total').textContent = state.cards.length;
    if ($('count-max')) $('count-max').textContent = state.cards.length;
    renderLearnStat();
    return Promise.resolve();
  }

  /** 首页顶部的「学习统计」面板：数据源为平台表 cebsb_stats / cebsb_answers。 */
  function renderLearnStat() {
    // 直接从当前装配好的卡片数组汇总，答完题 / 回到首页都能立刻反映最新数据
    var learned = 0, mastered = 0, sumTotal = 0, sumRight = 0;
    (state.cards || []).forEach(function (c) {
      var n = Number(c.correct) || 0;
      var t = Number(c.total) || 0;
      if (t > 0) learned += 1;                  // 统计表里有练习记录 = 已录入
      if (n >= 2) mastered += 1;                // 累计答对 ≥2 次 = 已掌握
      sumTotal += t;
      sumRight += n;
    });
    var acc = sumTotal ? Math.round(sumRight / sumTotal * 1000) / 10 : 0;
    if (state.overview) {
      state.overview.learned = learned;
      state.overview.mastered = mastered;
      state.overview.answered_total = sumTotal;
      state.overview.overall_accuracy = acc;
    }
    if ($('stat-learned')) $('stat-learned').textContent = learned;
    if ($('stat-mastered')) $('stat-mastered').textContent = mastered;
    if ($('stat-accuracy')) {
      $('stat-accuracy').textContent = sumTotal ? (acc + '%') : '--';   // 没答过时不显示 0%
    }
  }

  /** 重新装配卡片数组（切换页面时刷新统计）。 */
  function refreshCards() {
    state.cards = buildCards();
    return Promise.resolve(state.cards);
  }

  /** 错误率：未测试过的字视为 100%（这样它会被所有档位的筛选包含）。 */
  function errRateOf(c) {
    if (!c || !c.total) return 1;
    return c.wrong / c.total;
  }

  /** 模式 → 阈值（mode 形如 all / err10 / err20 ... err90）。 */
  function thresholdOf(mode) {
    var m = /^err(\d{1,3})$/.exec(String(mode || ''));
    return m ? (parseInt(m[1], 10) / 100) : 0;
  }

  /** 按模式取可用池子（口径与后端一致：错误率 ≥ 阈值，未测过的字按 100% 计入）。 */
  function poolOf(mode) {
    var cards = state.cards || [];
    var th = thresholdOf(mode);
    if (th > 0) {
      return cards.filter(function (c) { return errRateOf(c) + 1e-9 >= th; });
    }
    return cards.slice();
  }

  function poolSize(mode) { return poolOf(mode).length; }

  function modeLabel(mode) {
    var th = thresholdOf(mode);
    if (th > 0) return '错误率 ≥ ' + Math.round(th * 100) + '%';
    return '随机挑选（全部字卡）';
  }

  function updatePoolLabels() {
    var mode = $('select-mode') ? $('select-mode').value : 'all';
    var pool = poolOf(mode);
    var untested = pool.filter(function (c) { return !c.total; }).length;
    if ($('pool-all')) $('pool-all').textContent = (state.cards || []).length;
    if ($('pool-current')) $('pool-current').textContent = pool.length;
    if ($('pool-untested')) $('pool-untested').textContent = untested;
    if ($('pool-mode-label')) $('pool-mode-label').textContent = modeLabel(mode);
  }

  /* ------------------------- 首页 ------------------------- */
  function bindHome() {
    $('btn-go-setup').addEventListener('click', function () {
      refreshCards().then(function () {
        updatePoolLabels();
        renderSetupWarn();
        show('setup');
      }).catch(function () {
        toast('词库加载失败，请检查服务是否运行');
      });
    });
    $('btn-go-library').addEventListener('click', function () {
      refreshCards().then(function () { renderLibrary(); show('library'); });
    });
    // 平台内嵌运行，无需「退出程序」按钮
  }

  /* ------------------------- 配置页 ------------------------- */
  function currentMode() {
    var sel = $('select-mode');
    return sel ? (sel.value || 'all') : 'all';
  }

  /** 配置页「配字方式」的说明与可用数量。 */
  function updateStyleNote() {
    var el = $('style-note');
    if (!el) return;
    var pool = poolOf(currentMode());
    var n = pool.filter(canSplit).length;
    if (currentStyle() === 'parts') {
      el.textContent = '当前筛选下可拆的字共 ' + n + ' 个（独体字等无法拆分的字会自动跳过）。每栏 12 个部件，两栏都选对才算答对。';
    } else {
      el.textContent = '每道题给出 30 个整字，从中选出正确的 1 个。';
    }
  }

  function renderSetupWarn() {
    var mode = currentMode();
    var p = poolOf(mode);
    if (currentStyle() === 'parts') { p = p.filter(canSplit); }
    var n = p.length;
    var warn = $('setup-warn');
    if (!warn) return;
    if (thresholdOf(mode) === 0) {
      warn.textContent = '';
      return;
    }
    var untested = p.filter(function (c) { return !c.total; }).length;
    if (n === 0) {
      warn.textContent = '当前没有符合条件的字（该池为空），请换一个档位或选择「随机挑选」。';
    } else {
      warn.textContent = '该池当前可用 ' + n + ' 个字（其中未测试过 ' + untested + ' 个）；设定数量超过可用数时会提示你选择处理方式。';
    }
  }

  function bindSetup() {
    $$('[data-nav="home"]').forEach(function (b) {
      b.addEventListener('click', function () { show('home'); });
    });

    var input = $('input-count');
    $('count-minus').addEventListener('click', function () {
      var maxMinus = state.overview.total || 430;
      input.value = Math.max(1, clampInt(input.value, 1, maxMinus, 100) - 1);
      renderSetupWarn();
    });
    $('count-plus').addEventListener('click', function () {
      var max = state.overview.total || 430;
      input.value = Math.min(max, clampInt(input.value, 1, max, 100) + 1);
      renderSetupWarn();
    });
    input.addEventListener('change', function () {
      var max = state.overview.total || 430;
      input.value = clampInt(input.value, 1, max, 100);
      renderSetupWarn();
    });

    $$('#chips-time .chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        $$('#chips-time .chip').forEach(function (c) { c.classList.remove('chip-on'); });
        chip.classList.add('chip-on');
        state.config.time = parseInt(chip.getAttribute('data-time'), 10) || 0;
      });
    });

    var selMode = $('select-mode');
    if (selMode) {
      selMode.addEventListener('change', function () {
        state.config.mode = currentMode();
        Store.set('mode', state.config.mode);
        updatePoolLabels();
        renderSetupWarn();
        updateStyleNote();
      });
    }

    var selStyle = $('select-style');
    if (selStyle) {
      selStyle.addEventListener('change', function () {
        state.config.style = currentStyle();
        Store.set('style', state.config.style);
        updateStyleNote();
        renderSetupWarn();
      });
    }

    var selSource = $('select-source');
    if (selSource) {
      selSource.addEventListener('change', function () {
        Speech.setSource(this.value);
        populateVoiceSelect();   // 在线/系统两套候选互斥，切换后重建下拉
        renderBuildVersion();
        toast(Speech._onlineOn() ? '发音来源：在线音源' : '发音来源：系统音色');
      });
    }

    var selVoice = $('select-voice');
    if (selVoice) {
      selVoice.addEventListener('change', function () {
        if (Speech._onlineOn()) {
          Speech.setOnlineVoice(this.value);
          var v = Speech._voiceOf('en');
          toast('已切换语音：' + (v ? v.label : '默认'));
          return;
        }
        Speech.setVoice(this.value);
        updateZhNote();
        if (Speech.voice) { toast('已切换语音：' + shortVoiceName(Speech.voice)); }
      });
    }

    var selZh = $('select-zh-voice');
    if (selZh) {
      selZh.addEventListener('change', function () {
        if (Speech._onlineOn()) {
          Speech.setOnlineVoiceZh(this.value);
          var v = Speech._voiceOf('zh');
          toast('汉字配音已设为 ' + (v ? v.label : '默认'));
          return;
        }
        Speech.setZhVoice(this.value);
        updateZhNote();
        toast(this.value ? '汉字配音已设为 ' + shortVoiceName(Speech.zhVoice) : '汉字配音恢复自动配对');
      });
    }

    var selZhRep = $('select-zh-repeat');
    if (selZhRep) {
      selZhRep.addEventListener('change', function () {
        Speech.setZhRepeats(this.value);
        updateZhNote();
        toast('汉字读音连读 ' + Speech.zhRepeats + ' 遍');
      });
    }

    var btnTest = $('btn-voice-test');
    if (btnTest) {
      btnTest.addEventListener('click', function () {
        var rep = Speech.zhRepeats || ZH_REPEAT;
        var segs = (Speech._onlineOn() || Speech.zhVoice)
          ? [{ text: 'The pronunciation is', lang: 'en', step: 0 },
             { text: '汉', lang: 'zh', step: 0, repeat: rep },
             { text: 'The part of speech is noun', lang: 'en', step: 1 }]
          : [{ text: 'The pronunciation is hàn', lang: 'en', step: 0 },
             { text: 'The part of speech is noun', lang: 'en', step: 1 }];
        Speech.play(segs, {});
        var en, zh;
        if (Speech._onlineOn()) {
          var ve = Speech._voiceOf('en'), vz2 = Speech._voiceOf('zh');
          en = ve ? ve.label : '英文音色';
          zh = vz2 ? vz2.label : '中文音色';
        } else {
          en = Speech.voice ? shortVoiceName(Speech.voice) : '英文音色';
          zh = Speech.zhVoice ? shortVoiceName(Speech.zhVoice) : '（无中文音色，读拼音）';
        }
        toast('试听中：英文 ' + en + ' + 中文 ' + zh + '；听不到再换一个音色');
      });
    }

    var selRate = $('select-rate');
    if (selRate) {
      selRate.addEventListener('change', function () {
        Speech.setRate(this.value);
        toast('朗读速度已设为 ' + this.value + '×');
      });
    }

    // 声音自检：把「实际能不能发声、用的哪个音色、失败原因」直接印在页面上。
    // 加上它是因为「没声音 / 换音色无效」在手机上表现完全一样，看不到内部状态就没法定位。
    var btnCheck = $('btn-sound-check');
    if (btnCheck) {
      btnCheck.addEventListener('click', function () { runSoundCheck(); });
    }
    renderBuildVersion();

    $('btn-start').addEventListener('click', startFromSetup);
  }

  /** 在配置页底部显示构建版本，用来确认手机上跑的是哪一版代码。 */
  function renderBuildVersion() {
    var el = $('build-version');
    if (!el) return;
    el.textContent = '版本 v' + BUILD_VERSION +
      (Speech._onlineOn() ? '　在线音源' : '　系统音色');
  }

  /** 声音自检：联网拉一段真实音频并报告结果。 */
  function runSoundCheck() {
    var out = $('sound-check-out');
    if (!out) return;
    var parts = [];

    // 1) 打包本地字音：不依赖网络，永远可用
    var bundledN = BundledAudio.count();
    parts.push('内置中文字音：' + (bundledN ? bundledN + ' 字（离线可用）' : '未打包'));
    if (!bundledN) {
      parts.push('⚠ 本页代码是旧版本缓存：请完全关闭浏览器后重新打开（内置字音在 v1.4 起生效）');
    }
    out.textContent = parts.join('；') + '｜正在测试内置字音…';

    // 2) 实测播放一个打包字音（动态取表里的第一个字；注意词库是生僻字，「汉」并不在其中）
    var probeCh = '';
    try { probeCh = Object.keys(window.AUDIO_ZH || {})[0] || ''; } catch (e) { /* 忽略 */ }
    if (!probeCh) {
      parts.push('无法测试（表为空）');
      out.textContent = parts.join('；');
      return;
    }
    BundledAudio.speak(probeCh, 1).then(function (ok) {
      parts.push(ok ? '内置字音播放：成功' : '内置字音播放：失败');
      if (!ok) {
        out.textContent = parts.join('；');
        return;
      }
      // 3) 再测联网链路（英文走这里）
      if (!Speech._onlineOn()) {
        parts.push('发音来源：系统音色（英文用设备语音包）');
        parts.push('设备语音包：' + (Speech.voices.length ? Speech.voices.length + ' 个可用' : '一个都没检测到'));
        out.textContent = parts.join('；');
        return;
      }
      var v = Speech._voiceOf('en') || defaultOnlineVoice('en');
      parts.push('正在用 ' + (v ? v.label : '默认音色') + ' 联网试听英文…');
      out.textContent = parts.join('；');
      OnlineTTS.probe('Hello', 'en', v).then(function (r) {
        parts.push(r.ok
          ? '联网英文：成功'
          : '联网英文：失败（' + r.err + '）—— 中文不受影响，英文会退回系统语音');
        out.textContent = parts.join('；');
      });
    });
  }

  /** 填充「朗读语音」下拉：在线模式给在线英文音色；系统模式沿用系统音色。 */
  function populateVoiceSelect() {
    var sel = $('select-voice');
    if (!sel) return;
    sel.innerHTML = '';

    if (Speech._onlineOn()) {
      // 在线音源：不同引擎 × 语速/口音的组合（免密钥接口不提供男女声切换，故不标性别）
      var g = document.createElement('optgroup');
      g.label = '在线英文音色';
      onlineVoicesOf('en').forEach(function (v) {
        var op = document.createElement('option');
        op.value = v.id;
        op.textContent = v.label;
        g.appendChild(op);
      });
      sel.appendChild(g);
      var d = defaultOnlineVoice('en');
      sel.value = Speech.onlineVoice || (d ? d.id : '');
      populateZhVoiceSelect();
      updateZhNote();
      return;
    }

    if (!Speech.supported) return;
    var auto = document.createElement('option');
    auto.value = '';
    auto.textContent = '自动' + (Speech.voice ? '（' + shortVoiceName(Speech.voice) + '）' : '（未检测到音色）');
    sel.appendChild(auto);
    // 已确认无响应的音色排到末尾，避免排在前面被默认选中
    var list = Speech.voices.slice().sort(function (a, b) {
      return (a.__ok === false ? 1 : 0) - (b.__ok === false ? 1 : 0);
    });
    list.forEach(function (v) {
      var op = document.createElement('option');
      op.value = v.voiceURI;
      op.textContent = shortVoiceName(v) + (isCloudVoice(v) ? ' · 云端（需联网）' : ' · 本地') +
        (v.__ok === false ? ' · 无响应' : '');
      sel.appendChild(op);
    });
    var saved = Store.get('voice_uri');
    sel.value = saved || '';
    populateZhVoiceSelect();
    updateZhNote();
  }

  /** 填充「汉字读音配音」下拉：在线模式给在线中文音色；系统模式给系统中文音色。 */
  function populateZhVoiceSelect() {
    var sel = $('select-zh-voice');
    if (!sel) return;
    sel.innerHTML = '';

    if (Speech._onlineOn()) {
      var g = document.createElement('optgroup');
      g.label = '在线中文音色';
      onlineVoicesOf('zh').forEach(function (v) {
        var op = document.createElement('option');
        op.value = v.id;
        op.textContent = v.label;
        g.appendChild(op);
      });
      sel.appendChild(g);
      var d = defaultOnlineVoice('zh');
      sel.value = Speech.onlineVoiceZh || (d ? d.id : '');
      return;
    }

    var auto = document.createElement('option');
    auto.value = '';
    auto.textContent = '自动配对（' + (Speech.zhVoice ? shortVoiceName(Speech.zhVoice) : '无中文音色') + '）';
    sel.appendChild(auto);
    var list = Speech.zhCandidates.slice().sort(function (a, b) {
      return (a.__ok === false ? 1 : 0) - (b.__ok === false ? 1 : 0);
    });
    list.forEach(function (v) {
      var op = document.createElement('option');
      op.value = v.voiceURI;
      op.textContent = shortVoiceName(v) + (isCloudVoice(v) ? ' · 云端' : ' · 本地') +
        (v.__ok === false ? ' · 无响应' : '');
      sel.appendChild(op);
    });
    var saved = Store.get('zh_voice_uri');
    sel.value = saved || '';
  }

  /** 显示与英文音色配对的中文音色（用于朗读汉字读音）。 */
  function updateZhNote() {
    var el = $('zh-voice-note');
    if (!el) return;
    if (Speech._onlineOn()) {
      var vz = Speech._voiceOf('zh');
      el.textContent = '汉字读音配音：' + (vz ? vz.label : '默认') +
        '（联网合成，发音更准；接口不可用时自动退回系统音色）';
      return;
    }
    var g = Speech.voice ? voiceGender(Speech.voice) : 'f';
    var want = g === 'm' ? '男声' : '女声';
    if (Speech.zhVoice && Speech.zhMismatch) {
      el.textContent = '英文选的是' + want + '，但系统没装中文' + want + '语音，暂用 ' + shortVoiceName(Speech.zhVoice) +
        ' 朗读汉字；可在 Windows「设置 → 时间和语言 → 语音」添加中文' + want + '语音，或在上方手动指定。';
    } else if (Speech.zhVoice) {
      el.textContent = '汉字读音配音：' + shortVoiceName(Speech.zhVoice) + '（英文' + want + ' → 中文' + want + '，自动配对，已连读 '
        + (Speech.zhRepeats || ZH_REPEAT) + ' 遍）';
    } else {
      el.textContent = '未检测到中文语音包，汉字读音将用英文音色朗读拼音；可在 Windows「设置 → 时间和语言 → 语音」添加中文语音。';
    }
  }

  /** 应用已保存的语速偏好。 */
  function applyRatePref() {
    var sel = $('select-rate');
    var saved = Store.get('rate');
    var r = parseFloat(saved);
    if (isFinite(r) && r > 0) { Speech.rate = r; }
    if (sel) { sel.value = String(saved || Speech.rate); }   // 用保存的原始字符串回显档位

    // 汉字读音重复遍数偏好
    var repSaved = Store.get('zh_repeat');
    var n = parseInt(repSaved, 10);
    if (n >= 1 && n <= 3) { Speech.zhRepeats = n; }
    var selRep = $('select-zh-repeat');
    if (selRep) { selRep.value = String(Speech.zhRepeats); }
  }

  /** 应用「发音来源 / 在线音色」偏好（优先读云端表，localStorage 只作兜底）。 */
  function applySourcePref() {
    var src = Store.get('source');
    if (src !== 'online' && src !== 'system') { src = lsGet(LS_SOURCE, 'online'); }
    Speech.source = (src === 'system') ? 'system' : 'online';
    Speech.onlineVoice = Store.get('online_voice') || lsGet(LS_ONLINE_VOICE, '');
    Speech.onlineVoiceZh = Store.get('online_voice_zh') || lsGet(LS_ONLINE_VOICE_ZH, '');
    var sel = $('select-source');
    if (sel) { sel.value = Speech.source; }
  }

  /** 应用平台里保存的配字方式偏好。 */
  function applyStylePref() {
    var v = Store.get('style');
    var sel = $('select-style');
    if (sel && (v === 'parts' || v === 'whole')) { sel.value = v; }
    state.config.style = currentStyle();
    var m = Store.get('mode');
    var selMode = $('select-mode');
    if (selMode && m) { selMode.value = m; }
    state.config.mode = currentMode();
  }

  /** 从配置页启动测试（含数量不足时的模态选择）。 */
  function startFromSetup() {
    var max = state.overview.total || state.cards.length || 430;
    var count = clampInt($('input-count').value, 1, max, 100);
    var time = state.config.time || 0;
    var mode = currentMode();
    var style = currentStyle();

    var pool = poolOf(mode);
    if (style === 'parts') { pool = pool.filter(canSplit); }
    if (!pool.length) {
      showModal({
        title: '暂无可用题目',
        body: '<p>当前筛选条件下没有可用的字。</p><p>请先选择「随机挑选」完成一些测试，产生错误记录后再使用该筛选。</p>',
        buttons: [{ label: '知道了', value: 'ok', kind: 'primary' }]
      });
      return;
    }

    var want = count;
    var allowRepeat = false;

    var proceed = Promise.resolve();
    if (pool.length < want) {
      proceed = showModal({
        title: '可用字数不足',
        body: '<p>当前符合条件的字只有 <b>' + pool.length + '</b> 个，少于设定的 <b>' + want + '</b> 个。</p>' +
              '<p>你可以重复出题以填满数量，或按可用数量进行测试。</p>',
        buttons: [
          { label: '重复出题以填满数量', value: 'repeat', kind: 'primary' },
          { label: '按可用数量测试（' + pool.length + ' 个）', value: 'shrink', kind: 'ghost' },
          { label: '取消', value: 'cancel', kind: 'quiet' }
        ]
      }).then(function (choice) {
        if (choice === 'repeat') { allowRepeat = true; }
        else if (choice === 'shrink') { want = pool.length; }
        else { throw new Error('cancel'); }
      });
    }

    proceed.then(function () {
      var config = { count: want, time: time, mode: mode, style: style, allowRepeat: allowRepeat };
      state.lastConfig = { count: want, time: time, mode: mode, style: style, allowRepeat: allowRepeat };
      beginSession(config);
    }).catch(function (err) {
      if (String(err && err.message) !== 'cancel') {
        toast('启动测试失败：' + err.message);
      }
    });
  }

  /* ------------------------- 出题 ------------------------- */
  /** 从池子中抽 n 个字（不足且允许重复时循环补齐）。 */
  function sampleCards(pool, n, allowRepeat) {
    var bag = shuffle(pool);
    if (!allowRepeat || bag.length >= n) {
      return bag.slice(0, Math.min(n, bag.length));
    }
    var out = bag.slice();
    while (out.length < n) {
      bag = shuffle(pool);
      out = out.concat(bag);
      if (out.length > n) out = out.slice(0, n);
    }
    return out;
  }

  /**
   * 为一道题生成 30 个待选项（1 正确 + 29 干扰，按汉字去重，顺序打乱）。
   * @param {Object} card 正确答案卡片
   * @returns {Array<{cardId:number, char:string, answer:boolean}>}
   */
  function buildOptions(card) {
    var others = state.cards.filter(function (c) {
      return c.id !== card.id && c.char !== card.char;
    });
    var picks = shuffle(others).slice(0, Math.max(0, OPTION_COUNT - 1));
    var options = picks.map(function (c) {
      return { cardId: c.id, char: c.char, answer: false };
    });
    options.push({ cardId: card.id, char: card.char, answer: true });
    return shuffle(options);
  }

  /* ------------------------- 拆字配字 ------------------------- */
  var PART_PER_COL = 12;   // 拆字模式下每栏的待选部件数（含 1 个正确部件）

  var STRUCT_LABEL = { lr: '左右结构', tb: '上下结构', surround: '包围结构', single: '独体字' };

  /** 该字是否可用于拆字模式（有结构且拆出了两块）。 */
  function canSplit(c) {
    return !!c && !!c.p1 && !!c.p2 && (c.structure === 'lr' || c.structure === 'tb' || c.structure === 'surround');
  }

  /** 当前配字方式：whole（整字 30 选 1）/ parts（拆字，左右各 12 选 1）。 */
  function currentStyle() {
    var sel = $('select-style');
    return sel && sel.value === 'parts' ? 'parts' : 'whole';
  }

  /** 全部部件库（所有字拆分后的第一块 + 第二块，去重）。 */
  function componentLibrary() {
    var seen = {}, out = [];
    (state.cards || []).forEach(function (c) {
      [c.p1, c.p2].forEach(function (p) {
        if (p && !seen[p]) { seen[p] = 1; out.push(p); }
      });
    });
    return out;
  }

  /**
   * 为一道题生成双栏部件选项：每栏 12 个（1 正确 + 11 干扰），栏内去重、顺序打乱。
   * @returns {{left: Array, right: Array}} 每项 {text, answer}
   */
  function buildParts(card) {
    var lib = componentLibrary();
    var make = function (right, exclude) {
      var picks = shuffle(lib.filter(function (p) { return p !== right && p !== exclude; }))
        .slice(0, Math.max(0, PART_PER_COL - 1));
      var arr = picks.map(function (p) { return { text: p, answer: false }; });
      arr.push({ text: right, answer: true });
      return shuffle(arr);
    };
    // 两块相同时（如 圭 = 土 + 土）避免两栏干扰项互相撞车
    return { left: make(card.p1, card.p2), right: make(card.p2, card.p1) };
  }

  /* ------------------------- 测试流程 ------------------------- */
  function beginSession(config) {
    var pool = poolOf(config.mode);
    if (config.style === 'parts') {
      pool = pool.filter(canSplit);
    }
    var picked = sampleCards(pool, config.count, !!config.allowRepeat);
    if (!picked.length) {
      toast('没有可测的字');
      return;
    }
    state.session = {
      config: config,
      questions: picked.map(function (c) {
        return config.style === 'parts'
          ? { card: c, parts: buildParts(c), pick: { left: null, right: null } }
          : { card: c, options: buildOptions(c) };
      }),
      index: 0,
      answers: [],
      startedAt: Date.now(),
      deadline: config.time > 0 ? Date.now() + config.time * 60000 : 0,
      answered: false,
      finished: false
    };
    show('quiz');
    renderQuestion();
    startTimer();
  }

  function renderQuestion() {
    var s = state.session;
    if (!s) return;
    var q = s.questions[s.index];

    $('quiz-progress').textContent = '第 ' + (s.index + 1) + ' / ' + s.questions.length;
    updateAccuracyPill();

    // 重置卡片与选项区
    $('card-cover').classList.remove('hidden');
    $('reveal').classList.add('hidden');
    $('feedback').classList.add('hidden');
    setStep(-1);
    setRound(0, 1);
    s.answered = false;

    var isParts = s.config.style === 'parts';
    var grid = $('options-grid');
    var partsArea = $('parts-area');
    var partsTip = $('parts-tip');
    grid.innerHTML = '';
    grid.classList.toggle('hidden', isParts);
    if (partsArea) partsArea.classList.toggle('hidden', !isParts);
    if (partsTip) partsTip.classList.toggle('hidden', !isParts);

    if (isParts) {
      q.pick = { left: null, right: null };
      renderPartCol('parts-left', q.parts.left, 'left');
      renderPartCol('parts-right', q.parts.right, 'right');
    } else {
      q.options.forEach(function (opt) {
        var b = document.createElement('button');
        b.className = 'opt';
        b.type = 'button';
        b.textContent = opt.char;
        b.setAttribute('data-card-id', String(opt.cardId));
        b.addEventListener('click', function () { onAnswer(opt, b); });
        grid.appendChild(b);
      });
    }

    // 限时显示
    var timer = $('quiz-timer');
    if (s.deadline) {
      timer.classList.remove('hidden');
      updateTimer();
    } else {
      timer.classList.add('hidden');
    }

    // 自动依次朗读四段
    window.setTimeout(function () {
      if (!state.session || state.session !== s || s.answered) return;
      playCardSpeech(q.card);
    }, 450);
  }

  /** 渲染拆字模式的一栏部件（点击即选中，两栏都选齐后自动判题）。 */
  function renderPartCol(colId, items, side) {
    var col = $(colId);
    if (!col) return;
    col.innerHTML = '';
    items.forEach(function (it) {
      var b = document.createElement('button');
      b.className = 'opt opt-part';
      b.type = 'button';
      b.textContent = it.text;
      b.setAttribute('data-part', it.text);
      b.setAttribute('data-answer', it.answer ? '1' : '0');
      b.addEventListener('click', function () { onPickPart(side, it, b); });
      col.appendChild(b);
    });
  }

  /** 选中某一栏的部件；两栏都选齐则自动判定。 */
  function onPickPart(side, item, btn) {
    var s = state.session;
    if (!s || s.answered || s.config.style !== 'parts') return;
    var q = s.questions[s.index];
    q.pick[side] = item.text;

    var colId = side === 'left' ? 'parts-left' : 'parts-right';
    $$('#' + colId + ' .opt').forEach(function (b) {
      b.classList.toggle('opt-picked', b === btn);
    });

    if (q.pick.left && q.pick.right) {
      onAnswerParts(q);
    }
  }

  /** 拆字模式的作答判定：两块都对才算对。 */
  function onAnswerParts(q) {
    var s = state.session;
    var card = q.card;
    var correct = (q.pick.left === card.p1 && q.pick.right === card.p2);
    s.answered = true;

    Speech.stop();

    [['parts-left', q.pick.left], ['parts-right', q.pick.right]].forEach(function (pair) {
      var colId = pair[0], picked = pair[1];
      $$('#' + colId + ' .opt').forEach(function (b) {
        b.disabled = true;
        b.classList.remove('opt-picked');
        if (b.getAttribute('data-answer') === '1') {
          b.classList.add('opt-correct');
        } else if (b.getAttribute('data-part') === picked) {
          b.classList.add('opt-wrong', 'opt-shake');
        } else {
          b.classList.add('opt-dim');
        }
      });
    });

    showFeedback(correct);
    Speech.say(correct ? 'Correct' : 'Incorrect');
    s.answers.push({ card: card, correct: correct, picked: q.pick.left + ' + ' + q.pick.right });
    saveAnswer(card, correct);
    updateAccuracyPill();
    window.setTimeout(function () { revealCard(card, correct); }, REVEAL_DELAY_MS);
  }

  function playCardSpeech(card) {
    // 在线音源自带中文音色，不依赖系统是否安装中文语音包；
    // 打包字音更进一步：读音就放在本地（audio_zh.js），连网络都不需要。
    // 否则手机端 zhVoice 为空会误判成"无中文音色"，退回用英文腔读拼音（即发音不准的根因）。
    var hasZh = Speech._onlineOn() || !!Speech.zhVoice || !!BundledAudio.get(card.char);
    var texts = buildSpeechTexts(card, hasZh);
    var per = texts.length;
    Speech.play(texts, {
      onStep: function (i) {
        if (i < 0) { setStep(-1); setRound(0, 1); return; }
        var seg = texts[i % per];
        setStep(seg && typeof seg.step === 'number' ? seg.step : (i % per));
        setRound(Math.floor(i / per) + 1, Speech.rounds || 1);
      }
    }, { rounds: READ_ROUNDS, roundGapMs: ROUND_GAP_MS });
  }

  function setStep(i) {
    $$('#steps .step').forEach(function (el) {
      var idx = parseInt(el.getAttribute('data-step'), 10);
      el.classList.toggle('step-on', idx === i);
      el.classList.toggle('step-done', i >= 0 && idx < i);
    });
  }

  /** 显示"第 n / N 遍朗读"。 */
  function setRound(n, total) {
    var el = $('round-tag');
    if (!el) return;
    if (!n || total <= 1) { el.classList.add('hidden'); return; }
    el.textContent = '第 ' + n + ' / ' + total + ' 遍朗读';
    el.classList.remove('hidden');
  }

  function updateAccuracyPill() {
    var s = state.session;
    if (!s) return;
    var done = s.answers.length;
    if (!done) {
      $('quiz-acc').textContent = '正确率 --';
      return;
    }
    var ok = s.answers.filter(function (a) { return a.correct; }).length;
    $('quiz-acc').textContent = '正确率 ' + Math.round(ok * 100 / done) + '%';
  }

  function updateTimer() {
    var s = state.session;
    if (!s || !s.deadline) return;
    var left = s.deadline - Date.now();
    var el = $('quiz-timer');
    el.textContent = fmtClock(left);
    el.classList.toggle('pill-danger', left <= 30000);
    if (left <= 0) {
      el.textContent = '00:00';
      finishSession(true);
    }
  }

  function startTimer() {
    stopTimer();
    if (!state.session || !state.session.deadline) return;
    state.timerId = window.setInterval(updateTimer, 500);
  }
  function stopTimer() {
    if (state.timerId) { window.clearInterval(state.timerId); state.timerId = null; }
  }

  /** 点击某个汉字后的作答处理。 */
  function onAnswer(opt, btn) {
    var s = state.session;
    if (!s || s.answered) return;
    s.answered = true;

    Speech.stop();

    var q = s.questions[s.index];
    var card = q.card;
    var correct = !!opt.answer;

    // 选项状态
    $$('#options-grid .opt').forEach(function (b) {
      b.disabled = true;
      if (b.getAttribute('data-card-id') === String(card.id)) {
        b.classList.add('opt-correct');
      } else if (b === btn) {
        b.classList.add('opt-wrong', 'opt-shake');
      } else {
        b.classList.add('opt-dim');
      }
    });

    // 动画 + 语音反馈
    showFeedback(correct);
    Speech.say(correct ? 'Correct' : 'Incorrect');

    s.answers.push({ card: card, correct: correct, picked: opt.char });
    saveAnswer(card, correct);
    updateAccuracyPill();
    window.setTimeout(function () { revealCard(card, correct); }, REVEAL_DELAY_MS);
  }

  /** 立即把一次作答写入数据库（每答一题一次，中途退出也已落库）。 */
  /** 立即把一次作答写入平台数据表（每答一题一次，中途退出也已落库）。 */
  function saveAnswer(card, correct) {
    if (!Store.ready) { return; }
    Store.recordAnswer(card, correct).then(function (row) {
      // 同步内存统计，题池与词库页即时反映最新成绩
      for (var i = 0; i < state.cards.length; i++) {
        if (state.cards[i].seq === card.seq) {
          var c = state.cards[i];
          c.total = Number(row.total) || 0;
          c.correct = Number(row.correct) || 0;
          c.wrong = Number(row.wrong) || 0;
          c.updated_at = row.updated_at || '';
          c.accuracy = c.total ? Math.round(c.correct / c.total * 100) : 0;
          c.error_rate = c.total ? Math.round(c.wrong / c.total * 100) : 100;
          break;
        }
      }
      renderLearnStat();   // 每答一题即时更新首页学习统计
    }).catch(function () {
      toast('成绩保存失败，请稍后重试');
    });
  }

  function showFeedback(correct) {
    var box = $('feedback');
    var icon = $('feedback-icon');
    var text = $('feedback-text');
    icon.textContent = correct ? '✓' : '✗';
    icon.className = 'feedback-icon ' + (correct ? 'feedback-ok' : 'feedback-bad');
    text.textContent = correct ? 'Correct' : 'Incorrect';
    text.className = 'feedback-text ' + (correct ? 'feedback-ok-text' : 'feedback-bad-text');
    box.classList.remove('hidden');
    // 重播动画
    icon.style.animation = 'none';
    void icon.offsetWidth;
    icon.style.animation = '';
    window.setTimeout(function () { box.classList.add('hidden'); }, FEEDBACK_MS);
  }

  function revealCard(card, correct) {
    $('card-cover').classList.add('hidden');
    var r = $('reveal');
    $('reveal-char').textContent = card.char || '';
    $('reveal-py').textContent = card.pinyin || '';
    $('reveal-pos').textContent = card.pos || '';
    $('reveal-en').textContent = card.meaning || '';
    $('reveal-zi').textContent = card.zi || '（无）';
    $('reveal-sent').textContent = card.sentence || '（无）';
    $('reveal-tr').textContent = card.translation || '';
    var wordsBlock = $('reveal-words-block');
    if (card.words && card.words.trim()) {
      $('reveal-words').textContent = card.words;
      wordsBlock.classList.remove('hidden');
    } else {
      $('reveal-words').textContent = '';
      wordsBlock.classList.add('hidden');
    }
    // 拆字模式：展示该字的拆分结果
    var pb = $('reveal-parts-block');
    if (state.session && state.session.config.style === 'parts') {
      var formula = (card.p1 || '?') + ' + ' + (card.p2 || '?');
      $('reveal-parts').innerHTML = '<span class="part-box">' + esc(card.p1 || '?') + '</span>' +
        '<span class="part-plus">+</span>' +
        '<span class="part-box">' + esc(card.p2 || '?') + '</span>' +
        '<span class="part-struct">' + esc(STRUCT_LABEL[card.structure] || '') + '</span>';
      pb.classList.remove('hidden');
    } else {
      $('reveal-parts').innerHTML = '';
      pb.classList.add('hidden');
    }

    var v = $('reveal-verdict');
    v.textContent = correct ? '答对' : '答错';
    v.className = 'reveal-verdict ' + (correct ? 'verdict-ok' : 'verdict-bad');
    r.classList.remove('hidden');

    var isLast = state.session && state.session.index >= state.session.questions.length - 1;
    $('btn-next').textContent = isLast ? '查看结算（空格）' : '下一个（空格）';
    $('btn-next').focus();
  }

  function nextQuestion() {
    var s = state.session;
    if (!s) return;
    if (!s.answered) return;      // 未作答不允许跳题
    Speech.stop();
    if (s.index >= s.questions.length - 1) {
      finishSession(false);
      return;
    }
    s.index += 1;
    renderQuestion();
  }

  function finishSession(timeout) {
    var s = state.session;
    if (!s || s.finished) return;
    s.finished = true;
    Speech.stop();
    stopTimer();
    renderResult(timeout);
    show('result');
    // 刷新全局统计（词库页/配置页数据同步）
    refreshOverview();
    refreshCards();
  }

  /* ------------------------- 结算页 ------------------------- */
  function renderResult(timeout) {
    var s = state.session;
    var total = s.answers.length;
    var ok = s.answers.filter(function (a) { return a.correct; }).length;
    var wrongs = s.answers.filter(function (a) { return !a.correct; });
    var pct = total ? Math.round(ok * 100 / total) : 0;

    $('result-pct').textContent = pct;
    $('result-detail').textContent = '答对 ' + ok + ' 个 / 共 ' + total + ' 个';
    var used = Date.now() - s.startedAt;
    var sub = '用时 ' + fmtDuration(used);
    if (timeout) sub += ' · 时间到，已自动结算';
    if (s.config.allowRepeat) sub += ' · 含重复出题';
    $('result-sub').textContent = sub;

    $('result-stats').innerHTML =
      '<div class="rs-item"><div class="rs-num">' + total + '</div><div class="rs-label">已作答</div></div>' +
      '<div class="rs-item"><div class="rs-num">' + ok + '</div><div class="rs-label">答对</div></div>' +
      '<div class="rs-item"><div class="rs-num">' + wrongs.length + '</div><div class="rs-label">答错</div></div>';

    $('wrong-title').textContent = '答错的字（' + wrongs.length + '）';
    var list = $('wrong-list');
    list.innerHTML = '';
    if (!wrongs.length) {
      list.innerHTML = '<p class="lib-empty">太棒了，本次没有答错的字 🎉</p>';
      return;
    }
    wrongs.forEach(function (a) {
      var item = document.createElement('div');
      item.className = 'wrong-item';
      item.innerHTML =
        '<div class="wrong-top"><span class="wrong-char">' + esc(a.card.char) + '</span>' +
        '<span class="wrong-py">' + esc(a.card.pinyin) + '</span>' +
        '<span class="lib-pos">' + esc(a.card.pos) + '</span></div>' +
        '<div class="wrong-en">' + esc(a.card.meaning) + '</div>' +
        '<div class="wrong-zi">' + esc(a.card.zi) + '</div>' +
        '<div class="wrong-full">' + cardDetailHtml(a.card) + '</div>';
      item.addEventListener('click', function () { item.classList.toggle('open'); });
      list.appendChild(item);
    });
  }

  /** 字卡的完整信息 HTML（词库页与结算页共用）。 */
  function cardDetailHtml(c) {
    var words = c.words && c.words.trim()
      ? '<div class="reveal-block"><div class="reveal-k">陌生单词</div><div class="reveal-v words">' + esc(c.words) + '</div></div>'
      : '';
    return '<div class="reveal-block"><div class="reveal-k">例句</div>' +
      '<div class="reveal-v en">' + esc(c.sentence || '（无）') + '</div>' +
      '<div class="reveal-v sub">' + esc(c.translation || '') + '</div></div>' + words +
      '<div class="reveal-block"><div class="reveal-k">练习记录</div><div class="reveal-v">' +
      '测试 ' + c.total + ' 次 · 正确 ' + c.correct + ' · 错误 ' + c.wrong +
      ' · 正确率 ' + c.accuracy + '% · 错误率 ' + c.error_rate + '%' +
      (c.updated_at ? ' · 最近 ' + esc(c.updated_at) : '') + '</div></div>';
  }

  function bindResult() {
    $('btn-result-home').addEventListener('click', function () { show('home'); });
    $('btn-result-again').addEventListener('click', function () {
      var cfg = state.lastConfig;
      if (!cfg) { show('setup'); return; }
      refreshCards().then(function () {
        // 沿用上次配置，池子数量可能已变化，重新走一次数量校验
        var pool = poolOf(cfg.mode);
        var style = cfg.style || 'whole';
        if (style === 'parts') { pool = pool.filter(canSplit); }
        if (!pool.length) { toast('上次筛选条件已无可用字，请重新配置'); show('setup'); return; }
        var want = cfg.count;
        var allowRepeat = !!cfg.allowRepeat;
        if (pool.length < want) {
          if (allowRepeat) { want = cfg.count; }
          else { want = pool.length; }
        }
        beginSession({ count: want, time: cfg.time, mode: cfg.mode, style: style, allowRepeat: allowRepeat });
      });
    });
  }

  /* ------------------------- 词库页 ------------------------- */
  function libFiltered() {
    var kw = state.library.keyword.trim().toLowerCase();
    var filter = state.library.filter;
    var list = state.cards.filter(function (c) {
      if (kw && c.char.toLowerCase().indexOf(kw) === -1 && String(c.pinyin).toLowerCase().indexOf(kw) === -1) {
        return false;
      }
      if (filter === 'untested') return c.total === 0;
      if (filter === 'err50') return errRateOf(c) + 1e-9 >= 0.5;
      if (filter === 'err80') return errRateOf(c) + 1e-9 >= 0.8;
      return true;
    });
    var sort = state.library.sort;
    if (sort === 'err_desc') {
      list.sort(function (a, b) { return (b.error_rate - a.error_rate) || (a.seq - b.seq); });
    } else if (sort === 'acc_desc') {
      list.sort(function (a, b) {
        var av = a.total > 0 ? a.accuracy : -1;
        var bv = b.total > 0 ? b.accuracy : -1;
        return (bv - av) || (a.seq - b.seq);
      });
    } else if (sort === 'total_desc') {
      list.sort(function (a, b) { return (b.total - a.total) || (a.seq - b.seq); });
    } else {
      list.sort(function (a, b) { return a.seq - b.seq; });
    }
    return list;
  }

  function renderLibrary() {
    var cards = state.cards || [];
    var tested = cards.filter(function (c) { return c.total > 0; });
    var sumTotal = 0, sumCorrect = 0;
    cards.forEach(function (c) { sumTotal += c.total; sumCorrect += c.correct; });
    var acc = sumTotal ? Math.round(sumCorrect * 100 / sumTotal) : 0;

    $('lib-stats').innerHTML =
      '<div class="rs-item"><div class="rs-num">' + cards.length + '</div><div class="rs-label">总字数</div></div>' +
      '<div class="rs-item"><div class="rs-num">' + tested.length + '</div><div class="rs-label">已测字数</div></div>' +
      '<div class="rs-item"><div class="rs-num">' + sumTotal + '</div><div class="rs-label">总测试次数</div></div>' +
      '<div class="rs-item"><div class="rs-num">' + acc + '%</div><div class="rs-label">总体正确率</div></div>';

    var list = libFiltered();
    var box = $('lib-list');
    box.innerHTML = '';
    $('lib-empty').classList.toggle('hidden', list.length > 0);

    list.forEach(function (c) {
      var item = document.createElement('div');
      item.className = 'lib-item';
      var nums;
      if (c.total === 0) {
        nums = '<span class="tag tag-none">未测过</span>';
      } else {
        nums =
          '<span class="tag">测试 ' + c.total + '</span>' +
          '<span class="tag tag-ok">对 ' + c.correct + '</span>' +
          '<span class="tag tag-bad">错 ' + c.wrong + '</span>' +
          '<span class="tag tag-ok">正确率 ' + c.accuracy + '%</span>' +
          '<span class="tag tag-bad">错误率 ' + c.error_rate + '%</span>';
      }
      item.innerHTML =
        '<div class="lib-top"><div class="lib-char">' + esc(c.char) + '</div>' +
        '<div class="lib-main">' +
        '<div><span class="lib-py">' + esc(c.pinyin) + '</span><span class="lib-pos">' + esc(c.pos) + '</span></div>' +
        '<div class="lib-en">' + esc(c.meaning) + '</div></div></div>' +
        '<div class="lib-nums">' + nums + '</div>' +
        (c.updated_at ? '<div class="lib-time">最后测试：' + esc(c.updated_at) + '</div>' : '');
      item.addEventListener('click', function () {
        if (item.querySelector('.lib-full')) {
          item.removeChild(item.querySelector('.lib-full'));
          return;
        }
        var full = document.createElement('div');
        full.className = 'lib-full';
        full.innerHTML = cardDetailHtml(c);
        item.appendChild(full);
      });
      box.appendChild(item);
    });
  }

  function bindLibrary() {
    $('lib-search').addEventListener('input', function () {
      state.library.keyword = this.value;
      renderLibrary();
    });
    $('lib-sort').addEventListener('change', function () {
      state.library.sort = this.value;
      renderLibrary();
    });
    $$('#lib-filter .chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        $$('#lib-filter .chip').forEach(function (c) { c.classList.remove('chip-on'); });
        chip.classList.add('chip-on');
        state.library.filter = chip.getAttribute('data-filter');
        renderLibrary();
      });
    });
  }

  /* ------------------------- 测试页交互绑定 ------------------------- */
  function bindQuiz() {
    $('btn-replay').addEventListener('click', function () {
      var s = state.session;
      if (!s || s.answered) return;
      playCardSpeech(s.questions[s.index].card);
    });
    $('btn-stop').addEventListener('click', function () {
      Speech.stop();
      setStep(-1);
      setRound(0, 1);
    });
    $('btn-next').addEventListener('click', nextQuestion);
    $('btn-quit-quiz').addEventListener('click', function () {
      showModal({
        title: '结束本次测试？',
        body: '<p>已作答 <b>' + (state.session ? state.session.answers.length : 0) + '</b> 题，成绩均已保存。</p>',
        buttons: [
          { label: '查看结算', value: 'finish', kind: 'primary' },
          { label: '继续测试', value: 'continue', kind: 'ghost' }
        ]
      }).then(function (v) {
        if (v === 'finish') finishSession(false);
      });
    });

    document.addEventListener('keydown', function (e) {
      if (state.view !== 'quiz') return;
      if (e.code === 'Space' || e.key === ' ') {
        var s = state.session;
        if (s && s.answered) {
          e.preventDefault();
          nextQuestion();
        }
      }
    });
  }

  /* ------------------------- 启动 ------------------------- */
  function init() {
    Speech.onVoicesReady = function () { populateVoiceSelect(); };
    Speech.onVoiceFail = function () { populateVoiceSelect(); };
    Speech.init();
    applySourcePref();
    populateVoiceSelect();
    applyRatePref();
    bindHome();
    bindSetup();
    bindQuiz();
    bindResult();
    bindLibrary();
    show('home');

    // 先连平台运行时（等 token），再装配数据；未就绪时界面仍可浏览，只是不记录成绩
    $('home-tip').textContent = '正在连接平台…';
    Store.connect()
      .then(refreshOverview)
      .then(function () {
        // 平台里的偏好（音色 / 语速 / 配字方式）加载后再刷一次界面
        applyRatePref();
        applySourcePref();
        renderBuildVersion();
        populateVoiceSelect();
        applyStylePref();
        updatePoolLabels();
        updateStyleNote();
        renderSetupWarn();
        $('home-tip').textContent = state.cards.length
          ? '练习数据保存在你的平台账户下（共 ' + state.cards.length + ' 字）'
          : '词库为空，请检查 cards.js';
      })
      .catch(function () {
        refreshOverview();
        updatePoolLabels();
        updateStyleNote();
        renderSetupWarn();
        $('home-tip').textContent = '未获取到平台数据（练习成绩暂不保存），请刷新页面重试';
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
