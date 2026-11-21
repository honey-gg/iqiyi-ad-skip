/**
 * 爱奇艺广告跳过 — 页面上下文（MAIN world）注入脚本
 *
 * 为什么走这条路：
 *   广告由播放器内嵌的 Cupid SDK（@iqiyi-ad-fe/cupid-mars）向
 *   https://t7z.cupid.iqiyi.com/mixer 发 JSONP 请求取回，响应形如
 *       Q<32位hex>({ ... "adSlots":[{ duration:61, ads:[...] }] ... })
 *   播放器【不校验响应来源】，只要 HTTP 200 且响应结构合法就照数据播放。
 *
 *   直接拦掉这个请求会触发平台的"广告被拦截"检测（实测要白等约 40 秒）；
 *   拦广告素材会让播放器卡死。所以这里什么都不拦——
 *   只在 JSONP 回调即将拿到数据的那一刻，把广告数据清空。
 *   请求照常成功，检测器认为一切正常，播放器平静地进正片。
 *
 * 时序依据：
 *   JSONP 的执行顺序是「注册回调 → 插入 script → 响应到达 → 执行回调」。
 *   script 从插入 DOM 到真正执行，中间必然隔着一次网络往返（宏任务），
 *   而 MutationObserver 回调是微任务，因此我们总能在回调执行前完成包装。
 */

(() => {
  'use strict';

  const TAG = '[ad-skip]';
  const MIXER_RE = /^https?:\/\/(?:[a-z0-9-]+\.)?cupid\.iqiyi\.com\/mixer(?:[/?#]|$)/i;
  const WRAPPED_FLAG = '__iqiyiAdSkipWrapped__';
  const AD_LIST_KEYS = ['adSlots', 'slots'];
  const AD_MAP_KEYS = ['midrollPoints', 'futureSlots'];

  const patched = new WeakSet();

  /**
   * 清空广告数据：保留响应结构（播放器依赖其余字段），只把"有广告"变成"没广告"。
   * @returns {number} 被改动的条目数，仅用于日志
   */
  function neutralize(payload) {
    if (!payload || typeof payload !== 'object') return 0;
    let touched = 0;

    for (const key of AD_LIST_KEYS) {
      const list = payload[key];
      if (!Array.isArray(list)) continue;
      for (const slot of list) {
        if (!slot || typeof slot !== 'object') continue;
        if (Array.isArray(slot.ads) && slot.ads.length > 0) {
          slot.ads = [];
          touched += 1;
        }
        // duration 是播放器用来卡住"广告时段"的时长，一并归零
        if (typeof slot.duration === 'number' && slot.duration > 0) {
          slot.duration = 0;
        }
      }
    }

    for (const key of AD_MAP_KEYS) {
      const map = payload[key];
      if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
      for (const k of Object.keys(map)) {
        delete map[k];
        touched += 1;
      }
    }

    return touched;
  }

  /**
   * 把 window[name] 换成一层包装：先中和数据，再交给播放器自己的回调。
   * 用 accessor 而不是简单赋值，是为了覆盖"回调在 script 插入之后才注册"的实现。
   */
  function wrapJsonpCallback(name) {
    if (!name || typeof name !== 'string') return;

    let inner = window[name];
    if (inner && typeof inner === 'function' && inner[WRAPPED_FLAG]) return; // 已包装
    if (inner && inner[WRAPPED_FLAG]) return;

    const wrapper = function (payload) {
      try {
        const n = neutralize(payload);
        if (n > 0) console.log(TAG, `已中和 ${n} 处广告数据`);
      } catch (err) {
        // 中和失败也不能影响正常播放
      }
      return typeof inner === 'function' ? inner.apply(this, arguments) : undefined;
    };
    wrapper[WRAPPED_FLAG] = true;

    try {
      Object.defineProperty(window, name, {
        configurable: true,
        enumerable: true,
        get() {
          return wrapper;
        },
        set(fn) {
          inner = fn;
        },
      });
    } catch (err) {
      // 极少数情况下 window 上已有不可配置属性，退化为直接覆盖
      try {
        window[name] = wrapper;
      } catch (err2) {
        console.log(TAG, '无法包装 JSONP 回调', name);
      }
    }
  }

  function handleScript(node) {
    if (!node || node.nodeType !== 1 || node.tagName !== 'SCRIPT') return;
    if (patched.has(node)) return;
    patched.add(node);

    const src = node.src || node.getAttribute('src') || '';
    if (!src || !MIXER_RE.test(src)) return;

    let cb = null;
    try {
      cb = new URL(src, location.href).searchParams.get('cb');
    } catch (err) {
      /* URL 解析失败则放弃 */
    }

    if (cb) {
      wrapJsonpCallback(cb);
    } else {
      console.log(TAG, 'mixer 请求未携带 cb 参数，跳过');
    }
  }

  function scan(node) {
    if (!node || node.nodeType !== 1) return;
    if (node.tagName === 'SCRIPT') {
      handleScript(node);
      return;
    }
    if (typeof node.querySelectorAll === 'function') {
      node.querySelectorAll('script').forEach(handleScript);
    }
  }

  /* ---- 主线：监测 script 插入 ---- */

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) scan(node);
    }
  });

  const root = document.documentElement || document;
  try {
    observer.observe(root, { childList: true, subtree: true });
  } catch (err) {
    try {
      observer.observe(document, { childList: true, subtree: true });
    } catch (err2) {
      console.log(TAG, 'MutationObserver 初始化失败');
    }
  }

  /* ---- 兜底：万一某天改成 XHR/fetch 取回再 JSON.parse ---- */

  const nativeParse = JSON.parse;
  JSON.parse = function (text) {
    const result = nativeParse.apply(this, arguments);
    try {
      if (typeof text === 'string' && text.indexOf('"adSlots"') !== -1) {
        neutralize(result);
      }
    } catch (err) {
      /* 忽略 */
    }
    return result;
  };
})();
