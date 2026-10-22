//<script>
// 猫猫 TProxy Plus — 基于原版猫猫_TProxy_1.2.js 独立增强，面向 ZTE F50：Mihomo 透明代理（br0 TCP/UDP，IPv4/IPv6）。
// 多订阅与定时更新、热重载、端口防护、设备分流、崩溃自恢复、在线校验更新、诊断和内置面板。
// 由 build-plugin.py 生成；请修改源文件后重新构建。
(() => {
  'use strict';
  const PLUGIN_VERSION = __VERSION_JSON__;
  const RELEASE_VERSION = __RELEASE_VERSION_JSON__;
  const ID = 'kano-mm-tproxy';
  const BASE = '/data/clash';
  const SERVICE = BASE + '/Scripts/Clash.Service';
  const UPLOADS = '/data/data/com.minikano.f50_sms/files/uploads';
  const CTRL_PORT = 7788;
  const STORE = 'kano_mm_tproxy_';
  const PINNED = __PINNED_JSON__;
  const SERVICE_SOURCE = __SERVICE_JSON__;
  const NORMALIZER_SOURCE = __NORMALIZER_JSON__;
  const DASHBOARD_SOURCE = __DASHBOARD_JSON__;
  const DOCS_URL = 'https://wiki.metacubex.one/config/';
  const TEST_URL = 'https://www.gstatic.com/generate_204';
  const GROUP_TYPES = ['Selector', 'URLTest', 'Fallback', 'LoadBalance', 'Relay'];

  // Re-injection (plugin re-saved without reload) must not leave timers or a second card behind.
  window.__kanoMmTproxy?.dispose?.();
  const disposers = [];
  window.__kanoMmTproxy = {dispose: () => { while (disposers.length) { try { disposers.pop()(); } catch (e) { /* ignore */ } } }};

  // ------------------------------------------------------------------ helpers
  class MmError extends Error {
    constructor(message, extra) { super(message); Object.assign(this, extra || {}); }
  }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const q = (v) => "'" + String(v).replaceAll("'", "'\\''") + "'";
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  const toast = (text, color, ms) => { try { createToast(esc(text), color || '', ms || 3500); } catch (e) { /* ignore */ } };
  const store = {
    get: (k, d) => { try { const v = localStorage.getItem(STORE + k); return v === null ? d : v; } catch (e) { return d; } },
    set: (k, v) => { try { localStorage.setItem(STORE + k, v); } catch (e) { /* ignore */ } },
  };

  const h = (tag, attrs, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid instanceof Node ? kid : String(kid));
    }
    return el;
  };

  const fmtBytes = (n) => {
    n = Number(n) || 0;
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n.toFixed(0) : n < 10 ? n.toFixed(2) : n < 100 ? n.toFixed(1) : n.toFixed(0)) + ' ' + units[i];
  };
  const fmtRate = (n) => fmtBytes(n) + '/s';
  const fmtDuration = (s) => {
    s = Math.max(0, Math.floor(Number(s) || 0));
    const d = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    if (d) return d + '天' + hh + '小时';
    if (hh) return hh + '小时' + m + '分';
    if (m) return m + '分' + (s % 60) + '秒';
    return s + '秒';
  };
  const fmtAgo = (epoch, now) => {
    if (!Number(epoch)) return '从未';
    const s = (Number(now) || Date.now() / 1000) - Number(epoch);
    return s < 60 ? '刚刚' : fmtDuration(s) + '前';
  };
  const fmtDate = (epoch) => {
    const d = new Date(Number(epoch) * 1000);
    if (!Number(epoch) || isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  };
  const b64dec = (s) => {
    try { return new TextDecoder().decode(Uint8Array.from(atob(s || ''), (c) => c.charCodeAt(0))); } catch (e) { return ''; }
  };
  const byteLength = (text) => new Blob([text]).size;
  const versionCmp = (a, b) => {
    const pa = String(a).replace(/^v/, '').split('.').map(Number), pb = String(b).replace(/^v/, '').split('.').map(Number);
    for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d > 0 ? 1 : -1; }
    return 0;
  };

  // Machine lines from the service: "@key=value" and records "@type k=v k=v".
  const parseOut = (out) => {
    const kv = {}, rec = {}, text = [];
    for (const line of String(out || '').split('\n')) {
      let m;
      if ((m = /^@([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line))) kv[m[1]] = m[2];
      else if ((m = /^@([a-z]+) (.*)$/.exec(line))) (rec[m[1]] = rec[m[1]] || []).push(m[2]);
      else text.push(line);
    }
    return {kv, rec, text: text.join('\n').trim()};
  };
  const fields = (s) => Object.fromEntries(String(s).split(' ').filter(Boolean).map((t) => {
    const i = t.indexOf('=');
    return i < 0 ? [t, ''] : [t.slice(0, i), t.slice(i + 1)];
  }));
  const userinfo = (s) => {
    const r = {};
    for (const part of String(s || '').split(';')) {
      const [k, v] = part.split('=');
      if (k && /^\d+$/.test(v || '')) r[k.trim().toLowerCase()] = Number(v);
    }
    return r;
  };
  const errorLines = (out) => {
    const lines = String(out || '').split('\n');
    const err = lines.filter((l) => l.startsWith('ERROR:')).map((l) => l.slice(6).trim());
    if (err.length) return [...new Set(err)].join('\n');
    return lines.filter((l) => !l.startsWith('@')).slice(-14).join('\n').trim();
  };
  const lastLine = (log) => String(log || '').split('\n').filter((l) => l && !l.startsWith('@')).pop() || '';

  // ------------------------------------------------------------------ device access
  const rootFailure = (text) => {
    const t = String(text || '');
    if (/socat|\.sock|高级功能/i.test(t)) return '无法执行 root 命令：请先在 UFI-TOOLS 中开启“高级功能”。\n' + t;
    if (/abort|timeout|超时/i.test(t)) return '设备命令超时或连接中断，请稍后重试。\n' + t;
    return '设备命令失败：' + (t || '未知错误');
  };

  // runShellWithRoot reports transport errors only; collect the real exit status with a marker.
  const root = async (cmd, timeout) => {
    if (typeof runShellWithRoot !== 'function') throw new MmError('当前页面缺少 runShellWithRoot，无法管理设备。');
    const marker = '__MM2_RC_' + Math.random().toString(36).slice(2) + '__';
    const res = await runShellWithRoot('/system/bin/sh -c ' + q(cmd) + ' 2>&1\nprintf "\\n' + marker + '%s\\n" $?', Math.min(timeout || 30000, 98000));
    const out = String(res?.content ?? '');
    if (!res?.success) throw new MmError(rootFailure(out), {transport: true});
    const i = out.lastIndexOf(marker);
    if (i < 0) throw new MmError('设备命令未返回结果（可能超时）。\n' + out.slice(-600), {transport: true});
    return {code: parseInt(out.slice(i + marker.length), 10), out: out.slice(0, i).replace(/\n$/, '')};
  };
  const svc = async (args, timeout) => {
    const r = await root(q(SERVICE) + ' ' + args, timeout);
    return Object.assign(r, parseOut(r.out));
  };
  const svcOk = async (args, timeout) => {
    const r = await svc(args, timeout);
    if (r.code !== 0) throw new MmError(errorLines(r.out) || ('命令失败（退出码 ' + r.code + '）'), {output: r.out});
    return r;
  };
  const shOk = async (cmd, timeout) => {
    const r = await root(cmd, timeout);
    if (r.code !== 0) throw new MmError(errorLines(r.out) || ('命令失败（退出码 ' + r.code + '）'), {output: r.out});
    return r;
  };

  const uploadBlob = async (blob, name) => {
    const form = new FormData();
    form.append('file', blob, name);
    let res;
    try { res = await fetch(KANO_baseURL + '/upload_img', {method: 'POST', headers: common_headers, body: form}); }
    catch (e) { throw new MmError('上传失败：' + e.message); }
    let json = {};
    try { json = await res.json(); } catch (e) { /* keep empty */ }
    if (!res.ok || !/^\/?uploads\/[A-Za-z0-9-]+\.[A-Za-z0-9]+$/.test(json.url || '')) {
      throw new MmError('上传失败：' + (json.error || ('HTTP ' + res.status)));
    }
    return UPLOADS + '/' + json.url.replace(/^\/?uploads\//, '');
  };
  const uploadText = (text, name) => uploadBlob(new Blob([text], {type: 'application/octet-stream'}), name);

  // Jobs run detached on the device; poll their files directly (works before/while the service is replaced).
  const jobPoll = (id) => 'j=' + BASE + '/jobs/' + id + '; n=0; while [ ! -s "$j.rc" ] && [ "$n" -lt 72 ]; do sleep 0.25; n=$((n + 1)); done; ' +
    'if [ -s "$j.rc" ]; then echo "@job_state=done"; echo "@job_rc=$(cat "$j.rc")"; elif [ -e "$j.log" ]; then echo "@job_state=running"; else echo "@job_state=missing"; fi; ' +
    'echo "@job_log_b64=$(tail -n 80 "$j.log" 2>/dev/null | tail -c 9000 | base64 -w 0)"';
  const runJob = async (args, opts) => {
    const {runner, onLog, minutes} = Object.assign({runner: q(SERVICE), minutes: 15}, opts || {});
    const id = 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const start = await root(runner + ' job ' + id + ' ' + args, 20000);
    if (start.code !== 0) throw new MmError(errorLines(start.out) || '无法启动设备任务');
    const deadline = Date.now() + minutes * 60000;
    let failures = 0, last = '';
    while (Date.now() < deadline) {
      let r;
      try { r = parseOut((await root(jobPoll(id), 45000)).out); failures = 0; }
      catch (e) { if (!e.transport || ++failures > 5) throw e; await sleep(2000); continue; }
      const log = b64dec(r.kv.job_log_b64);
      if (log !== last) { last = log; if (onLog) onLog(log); }
      if (r.kv.job_state === 'done') return Object.assign({rc: parseInt(r.kv.job_rc, 10), log}, parseOut(log));
      if (r.kv.job_state === 'missing') throw new MmError('设备任务未能启动（找不到任务日志）');
    }
    throw new MmError('任务超过 ' + minutes + ' 分钟仍未完成；它可能仍在设备上运行，请稍后查看日志。');
  };
  const jobOk = async (args, label, opts) => {
    const res = await runJob(args, Object.assign({onLog: (log) => progress(label + '：' + lastLine(log))}, opts || {}));
    if (res.rc === 75) throw new MmError('已有安装或订阅任务正在进行，请稍后重试。');
    if (res.rc !== 0) throw new MmError(label + '失败：\n' + (errorLines(res.log) || ('退出码 ' + res.rc)), {output: res.log});
    return res;
  };

  // Upload the service, filter and dashboard into a root-only staging directory.
  const stageComponents = async () => {
    const r = await shOk('mkdir -p ' + BASE + ' && chmod 700 ' + BASE + ' && mktemp -d ' + BASE + '/.stage.XXXXXX', 15000);
    const stage = r.out.trim().split('\n').pop();
    if (!/^\/data\/clash\/\.stage\.[A-Za-z0-9]+$/.test(stage)) throw new MmError('无法创建暂存目录：' + r.out);
    const files = [['Clash.Service', SERVICE_SOURCE], ['normalize.awk', NORMALIZER_SOURCE], ['index.html', DASHBOARD_SOURCE]];
    const paths = [];
    for (const [name, text] of files) paths.push(await uploadText(text, name));
    const moves = files.map(([name], i) => 'mv -f ' + q(paths[i]) + ' ' + q(stage + '/' + name)).join(' && ');
    const sizes = (await shOk(moves + ' && chown 0:0 ' + q(stage) + '/* && chmod 600 ' + q(stage) + '/* && wc -c ' +
      files.map(([name]) => q(stage + '/' + name)).join(' '), 20000)).out;
    for (const [name, text] of files) {
      const line = sizes.split('\n').find((l) => l.trim().endsWith(stage + '/' + name));
      if (!line || Number(line.trim().split(/\s+/)[0]) !== byteLength(text)) throw new MmError('组件上传不完整：' + name);
    }
    return stage;
  };
  const installComponents = async (opts, label) => {
    progress(label + '：上传组件…');
    const stage = await stageComponents();
    return jobOk('install --stage ' + q(stage) + ' ' + opts, label, {runner: '/system/bin/sh ' + q(stage + '/Clash.Service'), minutes: 20});
  };

  // ------------------------------------------------------------------ state
  const S = {
    phase: 'init', info: {}, live: {}, busy: false, open: false, timer: 0, failures: 0,
    groups: null, groupsAt: 0, secret: '', rate: {t: 0, up: 0, down: 0, upTotal: 0, downTotal: 0},
    mainGroup: store.get('group', ''), progress: '', lastError: '',
  };
  let card, ui = {};

  const progress = (text) => {
    S.progress = text || '';
    if (ui.progress) { ui.progress.textContent = S.progress; ui.progress.hidden = !S.progress; }
  };

  // ------------------------------------------------------------------ dialogs
  const dialog = (id, title, width) => {
    const t = createFixedToast('mm_dlg_' + id,
      '<div class="mm-dlg" role="dialog" aria-modal="true" style="pointer-events:all;display:flex;flex-direction:column;box-sizing:border-box;width:calc(100vw - 44px);max-width:' + (width || 720) + 'px;max-height:84vh;overflow:hidden;text-align:left;font-size:13px;line-height:1.55">' +
      '<div class="title mm-dlg-title" style="flex-shrink:0;margin:0 0 8px"></div><div class="mm-dlg-body" style="overflow:auto;min-height:0"></div>' +
      '<div class="mm-dlg-foot" style="display:flex;flex-shrink:0;gap:8px;flex-wrap:wrap;justify-content:flex-end;margin-top:12px"></div></div>');
    if (!t || !t.el) throw new MmError('无法创建对话框');
    const cleanups = [];
    const api = {
      el: t.el,
      body: t.el.querySelector('.mm-dlg-body'),
      foot: t.el.querySelector('.mm-dlg-foot'),
      close: () => { while (cleanups.length) { try { cleanups.pop()(); } catch (e) { /* ignore */ } } t.close(); },
      onClose: (fn) => cleanups.push(fn),
      button: (text, fn, primary) => {
        const b = h('button', {class: 'btn mm-btn' + (primary ? ' mm-primary' : ''), text, type: 'button'});
        b.addEventListener('click', fn);
        api.foot.append(b);
        return b;
      },
    };
    t.el.querySelector('.mm-dlg-title').textContent = title;
    t.el.querySelector('.mm-dlg').setAttribute('aria-label', title);
    disposers.push(() => { if (t.el.isConnected) api.close(); });
    return api;
  };
  const confirmBox = (title, message, okText) => new Promise((resolve) => {
    const d = dialog('confirm', title, 520);
    let done = false;
    const finish = (v) => { if (done) return; done = true; clearInterval(watch); d.close(); resolve(v); };
    // The host replaces toasts that share an id; a vanished dialog must not leave the action waiting.
    const watch = setInterval(() => { if (!d.el.isConnected) finish(false); }, 1000);
    d.body.append(h('div', {style: 'white-space:pre-wrap', text: message}));
    d.button(okText || '确认', () => finish(true), true);
    d.button('取消', () => finish(false));
  });
  const download = (text, filename) => {
    const url = URL.createObjectURL(new Blob([text], {type: 'text/plain;charset=utf-8'}));
    const a = h('a', {href: url, download: filename, style: 'display:none'});
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };
  const copyText = async (text) => {
    try { await navigator.clipboard.writeText(text); toast('已复制', 'green'); return; } catch (e) { /* fall back */ }
    const ta = h('textarea', {style: 'position:fixed;left:-9999px'});
    ta.value = text;
    document.body.append(ta);
    ta.select();
    try { document.execCommand('copy'); toast('已复制', 'green'); } catch (e) { toast('复制失败，请手动选择文本', 'red'); }
    ta.remove();
  };
  const pre = (text, extra) => h('pre', {class: 'mm-pre', style: extra || '', text: text || ''});
  const textDialog = (title, text, filename) => {
    const d = dialog('text', title, 900);
    d.body.append(pre(text, 'max-height:62vh'));
    d.button('复制', () => copyText(text));
    if (filename) d.button('下载', () => download(text, filename));
    d.button('关闭', d.close, true);
    return d;
  };
  const showError = (title, error) => {
    const message = error && error.message ? error.message : String(error);
    S.lastError = message;
    const d = dialog('error', title, 760);
    d.body.append(pre(message, 'max-height:50vh;color:#fca5a5'));
    if (error && error.output && error.output !== message) {
      const det = h('details', {}, h('summary', {text: '完整输出'}), pre(error.output, 'max-height:40vh'));
      d.body.append(det);
    }
    d.button('复制', () => copyText(message + (error && error.output ? '\n\n' + error.output : '')));
    d.button('关闭', d.close, true);
  };

  // Runs one UI action at a time; always refreshes the card afterwards.
  const action = (label, fn, opts) => async (event) => {
    if (S.busy) { toast('请等待当前操作完成', 'red'); return; }
    S.busy = true;
    render();
    progress(label + '…');
    try {
      await fn(event);
      progress('');
    } catch (e) {
      progress(label + '失败');
      showError(label + '失败', e);
    } finally {
      S.busy = false;
      if (!(opts && opts.noRefresh)) await refresh().catch(() => { /* shown by refresh */ });
      render();
    }
  };

  // ------------------------------------------------------------------ status
  const panelHost = () => {
    const host = location.hostname;
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host) || /^\[?[0-9a-f:]+\]?$/i.test(host) || host === 'localhost') return host.replace(/^\[|\]$/g, '');
    return (window.UFI_DATA && UFI_DATA.lan_ipaddr) || '192.168.0.1';
  };
  const panelBase = () => {
    const host = panelHost();
    return 'http://' + (host.includes(':') ? '[' + host + ']' : host) + ':' + CTRL_PORT;
  };
  const panelUrl = (path, secret, extra) => panelBase() + path + '#secret=' + enc(secret) + (extra || '');

  const refresh = async () => {
    let r;
    try {
      r = await svc('info', 30000);
    } catch (e) {
      S.phase = e.transport && /高级功能/.test(e.message) ? 'noroot' : 'error';
      S.lastError = e.message;
      render();
      throw e;
    }
    if (r.kv.service_version) {
      S.info = r.kv;
      const cmp = versionCmp(r.kv.service_version, PLUGIN_VERSION);
      S.phase = r.kv.core !== 'present' ? 'nocore' : cmp < 0 ? 'outdated' : cmp > 0 ? 'newer' : 'ready';
      Object.assign(S.live, {state: r.kv.state, pid: r.kv.pid, uptime: r.kv.uptime, rss_kb: r.kv.rss_kb, busy: r.kv.busy, now: r.kv.now,
        net_stale: r.kv.net_stale, watchdog: r.kv.watchdog, last_error_b64: r.kv.last_error_b64});
    } else {
      const d = parseOut((await root('if [ -f ' + q(SERVICE) + ' ]; then echo "@service=legacy"; else echo "@service=none"; fi; ' +
        'if [ -x ' + q(BASE + '/Proxy/Clash.Core') + ' ]; then echo "@core=present"; else echo "@core=missing"; fi; ' +
        'if [ -s ' + q(BASE + '/Proxy/config.yaml') + ' ]; then echo "@config=present"; fi; ' +
        'if [ -f ' + q(SERVICE) + ' ] && /system/bin/sh ' + q(SERVICE) + ' status >/dev/null 2>&1; then echo "@legacy_running=1"; fi', 70000)).out).kv;
      S.info = d;
      S.phase = d.service === 'legacy' ? 'legacy' : d.core === 'present' ? 'broken' : 'absent';
    }
    render();
    if (S.open && S.phase === 'ready' && S.live.state === 'running') loadGroups().catch(() => { /* optional */ });
    return S.phase;
  };

  const applyLive = (kv) => {
    const now = Date.now();
    const up = Number(kv.up_total) || 0, down = Number(kv.down_total) || 0;
    if (S.rate.t && kv.state === 'running' && up >= S.rate.upTotal && down >= S.rate.downTotal) {
      const dt = (now - S.rate.t) / 1000;
      if (dt > 0.5) { S.rate.up = (up - S.rate.upTotal) / dt; S.rate.down = (down - S.rate.downTotal) / dt; }
    } else {
      S.rate.up = 0; S.rate.down = 0;
    }
    Object.assign(S.rate, {t: now, upTotal: up, downTotal: down});
    const wasRunning = S.live.state === 'running';
    S.live = kv;
    if (kv.service_version && versionCmp(kv.service_version, PLUGIN_VERSION) !== 0) { refresh().catch(() => { /* ignore */ }); return; }
    render();
    if (kv.state === 'running' && (!wasRunning || Date.now() - S.groupsAt > 60000)) loadGroups().catch(() => { /* optional */ });
  };

  const pollActive = () => card && card.isConnected && S.open && S.phase === 'ready' && document.visibilityState === 'visible';
  const schedulePoll = (ms) => {
    clearTimeout(S.timer);
    if (pollActive()) S.timer = setTimeout(poll, ms);
  };
  const poll = async () => {
    if (!pollActive()) return;
    if (!S.busy) {
      try { applyLive((await svc('live', 15000)).kv); S.failures = 0; }
      catch (e) { S.failures++; S.lastError = e.message; render(); }
    }
    schedulePoll(S.failures ? Math.min(60000, 5000 * Math.pow(2, S.failures)) : 5000);
  };
  const onVisibility = () => { if (document.visibilityState === 'visible') schedulePoll(200); else clearTimeout(S.timer); };
  document.addEventListener('visibilitychange', onVisibility);
  disposers.push(() => { document.removeEventListener('visibilitychange', onVisibility); clearTimeout(S.timer); });

  // ------------------------------------------------------------------ proxy groups (main group switch)
  const loadGroups = async () => {
    const r = await svc('api GET /proxies', 25000);
    if (r.code !== 0 || r.kv.code !== '200') throw new MmError('读取代理分组失败');
    const data = JSON.parse(r.text);
    const proxies = data.proxies || {};
    const order = (proxies.GLOBAL && proxies.GLOBAL.all) || Object.keys(proxies);
    const groups = order.filter((name) => proxies[name] && GROUP_TYPES.includes(proxies[name].type)).map((name) => {
      const g = proxies[name];
      return {
        name, type: g.type, now: g.now || '',
        nodes: (g.all || []).map((n) => {
          const p = proxies[n] || {};
          const hist = p.history || [];
          return {name: n, delay: hist.length ? hist[hist.length - 1].delay : -1, type: p.type || ''};
        }),
      };
    });
    S.groups = groups;
    S.groupsAt = Date.now();
    if (!groups.some((g) => g.name === S.mainGroup)) S.mainGroup = (groups.find((g) => g.type === 'Selector') || groups[0] || {}).name || '';
    renderGroups();
  };
  const delayText = (d) => (d > 0 ? d + ' ms' : d === 0 ? '超时' : '未测');
  const renderGroups = () => {
    if (!ui.groups || !card || !card.isConnected) return;
    const box = ui.groups;
    box.replaceChildren();
    if (S.live.state !== 'running' || !S.groups || !S.groups.length) { box.hidden = true; return; }
    box.hidden = false;
    const group = S.groups.find((g) => g.name === S.mainGroup) || S.groups[0];
    const groupSel = h('select', {class: 'mm-select', 'aria-label': '代理分组', disabled: S.busy});
    for (const g of S.groups) groupSel.add(new Option(g.name + ' · ' + g.type, g.name, false, g.name === group.name));
    groupSel.addEventListener('change', () => { S.mainGroup = groupSel.value; store.set('group', S.mainGroup); renderGroups(); });
    const nodeSel = h('select', {class: 'mm-select', 'aria-label': '节点', disabled: S.busy || group.type !== 'Selector'});
    for (const n of group.nodes) nodeSel.add(new Option(n.name + ' · ' + delayText(n.delay), n.name, false, n.name === group.now));
    nodeSel.addEventListener('change', action('切换节点', async () => {
      const r = await svcOk('api PUT ' + q('/proxies/' + enc(group.name)) + ' ' + q(JSON.stringify({name: nodeSel.value})), 25000);
      if (r.kv.code !== '204') throw new MmError('切换失败：HTTP ' + r.kv.code + '\n' + r.text);
      toast(group.name + ' → ' + nodeSel.value, 'green');
      await loadGroups();
    }, {noRefresh: true}));
    const test = h('button', {class: 'btn mm-btn', type: 'button', text: '测速', disabled: S.busy, title: '测试该分组所有节点的延迟'});
    test.addEventListener('click', action('节点测速', async () => {
      const r = await svc('api GET ' + q('/group/' + enc(group.name) + '/delay?url=' + enc(TEST_URL) + '&timeout=5000'), 40000);
      if (r.code !== 0 || r.kv.code !== '200') throw new MmError('测速失败：' + (r.text || errorLines(r.out)));
      const result = JSON.parse(r.text || '{}');
      const ok = Object.values(result).filter((v) => v > 0);
      toast('测速完成：' + ok.length + '/' + group.nodes.length + ' 个节点可用' + (ok.length ? '，最快 ' + Math.min(...ok) + ' ms' : ''), ok.length ? 'green' : 'red', 5000);
      await loadGroups();
    }, {noRefresh: true}));
    const now = group.type === 'Selector' ? '' : '当前：' + (group.now || '—');
    box.append(h('div', {class: 'mm-row'}, h('span', {class: 'mm-label', text: '分组'}), groupSel, nodeSel, test, now && h('span', {class: 'mm-muted', text: now})));
  };

  // ------------------------------------------------------------------ settings model
  const SETTINGS = [
    {k: 'MM_MODE', label: '代理模式', type: 'select', options: [['rule', '规则分流'], ['global', '全局代理'], ['direct', '全部直连']]},
    {k: 'MM_IPV6', label: 'IPv6 透明代理', type: 'bool'},
    {k: 'MM_UDP', label: 'UDP 透明代理', type: 'bool', help: '关闭后只代理 TCP，UDP（游戏、语音等）直连'},
    {k: 'MM_QUIC_BLOCK', label: '屏蔽走代理的 QUIC（UDP 443）', type: 'bool', help: '浏览器会自动回退到 TCP；部分节点上更稳定、更省流量'},
    {k: 'MM_SNIFF', label: '域名嗅探（TLS/HTTP/QUIC）', type: 'bool', help: '透明代理按域名分流必需，建议保持开启'},
    {k: 'MM_DEV_MODE', label: '设备范围', type: 'select', options: [['all', '所有局域网设备走代理'], ['bypass', '列表中的设备不走代理'], ['only', '仅列表中的设备走代理']]},
    {k: 'MM_DEV_LIST', label: '设备列表（MAC 或 IPv4，逗号分隔；IP 仅作用于 IPv4，建议用 MAC）', type: 'devices'},
    {k: 'MM_BYPASS_PORTS', label: '直连目标端口（逗号分隔，最多 16 个）', type: 'text', help: '默认 123（NTP）、853（DoT，保持 AdGuard Home 的 DoT 拦截）'},
    {k: 'MM_GUARD_TS', label: '允许 Tailscale 设备访问代理端口和面板', type: 'bool', help: '代理端口 7890/7893 和面板 7788 始终只对局域网开放（蜂窝公网 IPv6 无法访问）'},
    {k: 'MM_AUTO_RESTART', label: '内核异常退出后自动重启', type: 'bool', help: '10 分钟内最多 3 次；重启前网络自动恢复直连'},
    {k: 'MM_LOG_LEVEL', label: '日志级别', type: 'select', options: [['warning', 'warning（推荐）'], ['error', 'error'], ['info', 'info（记录每个连接）'], ['debug', 'debug'], ['silent', 'silent']]},
    {k: 'MM_LOG_MAX_KB', label: '日志文件上限（KB，128–16384）', type: 'number', min: 128, max: 16384},
    {k: 'MM_SUB_INTERVAL', label: '订阅自动更新', type: 'select', options: [['0', '关闭'], ['6', '每 6 小时'], ['12', '每 12 小时'], ['24', '每天'], ['48', '每 2 天'], ['72', '每 3 天']]},
    {k: 'MM_SUB_UA', label: '订阅 User-Agent', type: 'ua'},
    {k: 'MM_DL_VIA', label: '下载方式（订阅、内核、规则数据）', type: 'select', options: [['auto', '自动：先直连，失败再经代理'], ['direct', '仅直连'], ['proxy', '优先经代理']]},
    {k: 'MM_GH_MIRROR', label: 'GitHub 下载镜像前缀（可选）', type: 'text', help: '例如 https://ghfast.top/ ；下载内容仍按官方 SHA-256 校验'},
    {k: 'MM_DNS', label: '内核 DNS 上游（逗号分隔，最多 4 个）', type: 'text', help: '仅供内核自身解析；局域网 DNS 仍由 F50 / AdGuard Home 处理'},
    {k: 'MM_MEMLIMIT', label: '内核内存软上限（MB；0 为不限制，修改后需重启生效）', type: 'number', min: 0, max: 512},
  ];
  const UA_PRESETS = ['clash.meta', 'mihomo/1.19.32', 'clash-verge/v2.2.3', 'ClashforWindows/0.20.39', 'Stash/2.4.6 Clash/1.9.0'];

  const lanDevices = async () => {
    const list = new Map();
    try {
      if (typeof getData === 'function') {
        const d = await getData(new URLSearchParams({cmd: 'station_list,lan_station_list,hostNameList'}));
        const names = new Map((d.devices || []).map((x) => [String(x.mac || '').toLowerCase(), x.hostname]));
        for (const x of [...(d.station_list || []), ...(d.lan_station_list || [])]) {
          const mac = String(x.mac_addr || '').toLowerCase();
          if (/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac)) list.set(mac, {mac, ip: x.ip_addr || '', name: names.get(mac) || x.hostname || ''});
        }
      }
    } catch (e) { /* fall back to ARP */ }
    try {
      const r = await root('cat /proc/net/arp', 10000);
      for (const line of r.out.split('\n').slice(1)) {
        const [ip, , flags, mac, , dev] = line.trim().split(/\s+/);
        if (dev === 'br0' && flags !== '0x0' && /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac || '') && !list.has(mac)) list.set(mac, {mac, ip, name: ''});
      }
    } catch (e) { /* optional */ }
    return [...list.values()];
  };

  const settingsDialog = async () => {
    const r = await svcOk('settings-get', 20000);
    const cur = r.kv;
    const d = dialog('settings', '猫猫设置', 760);
    const inputs = {};
    const form = h('div', {class: 'mm-form'});
    for (const f of SETTINGS) {
      let input;
      const value = cur[f.k] !== undefined ? cur[f.k] : '';
      if (f.type === 'bool') {
        input = h('input', {type: 'checkbox', checked: value === '1', id: 'mm_set_' + f.k});
        form.append(h('label', {class: 'mm-check', for: 'mm_set_' + f.k}, input, h('span', {text: f.label})));
      } else {
        if (f.type === 'select') {
          input = h('select', {class: 'mm-select', id: 'mm_set_' + f.k});
          for (const [v, t] of f.options) input.add(new Option(t, v, false, v === value));
        } else if (f.type === 'ua') {
          input = h('input', {type: 'text', class: 'mm-input', id: 'mm_set_' + f.k, list: 'mm_ua_list', value, autocomplete: 'off', spellcheck: 'false'});
          form.append(h('datalist', {id: 'mm_ua_list'}, UA_PRESETS.map((u) => h('option', {value: u}))));
        } else if (f.type === 'number') {
          input = h('input', {type: 'number', class: 'mm-input', id: 'mm_set_' + f.k, value, min: f.min, max: f.max});
        } else {
          input = h('input', {type: 'text', class: 'mm-input', id: 'mm_set_' + f.k, value, autocomplete: 'off', spellcheck: 'false'});
        }
        form.append(h('label', {class: 'mm-field', for: 'mm_set_' + f.k}, h('span', {text: f.label}), input));
        if (f.type === 'devices') {
          const picker = h('div', {class: 'mm-chips'}, h('span', {class: 'mm-muted', text: '正在读取局域网设备…'}));
          form.append(picker);
          lanDevices().then((devices) => {
            picker.replaceChildren();
            if (!devices.length) { picker.append(h('span', {class: 'mm-muted', text: '未发现在线设备，可手动填写 MAC'})); return; }
            const sync = () => {
              const set = new Set(input.value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
              for (const chip of picker.children) chip.classList.toggle('mm-on', set.has(chip.dataset.mac));
            };
            for (const dv of devices) {
              const chip = h('button', {type: 'button', class: 'btn mm-chip', text: (dv.name ? dv.name + ' · ' : '') + (dv.ip ? dv.ip + ' · ' : '') + dv.mac});
              chip.dataset.mac = dv.mac;
              chip.addEventListener('click', () => {
                const set = new Set(input.value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
                if (set.has(dv.mac)) set.delete(dv.mac); else set.add(dv.mac);
                input.value = [...set].join(',');
                sync();
              });
              picker.append(chip);
            }
            input.addEventListener('input', sync);
            sync();
          }).catch(() => picker.replaceChildren(h('span', {class: 'mm-muted', text: '读取设备列表失败'})));
        }
      }
      if (f.help) form.append(h('div', {class: 'mm-help', text: f.help}));
      inputs[f.k] = input;
    }
    d.body.append(form);
    d.button('保存并应用', action('保存设置', async () => {
      const lines = SETTINGS.map((f) => {
        const el = inputs[f.k];
        let v = f.type === 'bool' ? (el.checked ? '1' : '0') : String(el.value).trim();
        if (f.type === 'devices') v = v.toLowerCase().replace(/\s+/g, '');
        if (f.k === 'MM_BYPASS_PORTS' || f.k === 'MM_DNS') v = v.replace(/\s+/g, '');
        if (/[\r\n]/.test(v)) throw new MmError(f.label + ' 不能包含换行');
        return f.k + '=' + v;
      });
      const path = await uploadText(lines.join('\n') + '\n', 'settings.env');
      const res = await jobOk('settings ' + q(path), '保存设置', {minutes: 8});
      d.close();
      toast('设置已保存' + (res.kv.config_changed === '1' ? '，配置已重新生成' : '') + (res.kv.network_changed === '1' ? '，网络规则已更新' : ''), 'green', 5000);
      if (res.kv.restart_needed === '1' && S.live.state === 'running' &&
        await confirmBox('需要重启', '内存上限修改需要重启猫猫才能生效，现在重启吗？', '重启')) {
        await svcOk('restart', 95000);
      }
    }), true);
    d.button('关闭', d.close);
  };

  // ------------------------------------------------------------------ subscriptions
  const usageLine = (info, now) => {
    const u = userinfo(info);
    const parts = [];
    if (u.total) parts.push('已用 ' + fmtBytes((u.upload || 0) + (u.download || 0)) + ' / ' + fmtBytes(u.total));
    if (u.expire) parts.push((u.expire < now ? '已过期 ' : '到期 ') + fmtDate(u.expire));
    return parts.join(' · ');
  };
  const subsDialog = async () => {
    const d = dialog('subs', '订阅管理', 860);
    const list = h('div', {class: 'mm-subs'});
    const name = h('input', {class: 'mm-input', type: 'text', placeholder: '名称（可选）', maxlength: 32, autocomplete: 'off'});
    const url = h('input', {class: 'mm-input', type: 'url', placeholder: 'Clash / Mihomo 订阅链接（http/https）', autocomplete: 'off', spellcheck: 'false'});
    let editing = '';
    const formTitle = h('div', {class: 'mm-label', text: '添加订阅'});
    const save = h('button', {class: 'btn mm-btn mm-primary', type: 'button', text: '添加并使用'});
    const saveOnly = h('button', {class: 'btn mm-btn', type: 'button', text: '仅保存'});
    const cancelEdit = h('button', {class: 'btn mm-btn', type: 'button', text: '取消编辑', hidden: true});
    let subs = [];
    const resetForm = () => { editing = ''; name.value = ''; url.value = ''; formTitle.textContent = '添加订阅'; save.textContent = '添加并使用'; cancelEdit.hidden = true; };
    cancelEdit.addEventListener('click', resetForm);

    const load = async () => {
      const r = await svcOk('sub-list', 30000);
      subs = (r.rec.sub || []).map(fields);
      list.replaceChildren();
      if (!subs.length) list.append(h('div', {class: 'mm-muted', text: '还没有订阅。可在下方添加，或使用“编辑配置/上传配置”手动导入。'}));
      const now = Number(r.kv.now) || Date.now() / 1000;
      for (const s of subs) {
        const label = b64dec(s.name_b64) || s.id;
        const status = s.status === 'ok' ? '正常' : s.status === 'error' ? '失败' : '未下载';
        const err = b64dec(s.error_b64);
        const row = h('div', {class: 'mm-sub' + (s.active === '1' ? ' mm-active' : '')},
          h('div', {class: 'mm-sub-head'},
            h('strong', {text: label}),
            s.active === '1' && h('span', {class: 'mm-badge', text: '使用中'}),
            h('span', {class: 'mm-muted', text: b64dec(s.url_b64)})),
          h('div', {class: 'mm-muted', text: '状态：' + status + ' · 更新于 ' + fmtAgo(s.updated, now) + (Number(s.bytes) ? ' · ' + fmtBytes(s.bytes) : '') +
            (Number(s.interval) ? ' · 机场建议每 ' + s.interval + ' 小时更新' : '')}),
          usageLine(s.userinfo, now) && h('div', {class: 'mm-usage', text: usageLine(s.userinfo, now)}),
          err && h('div', {class: 'mm-err', text: err}));
        const btns = h('div', {class: 'mm-row'});
        const add = (text, fn, primary) => { const b = h('button', {class: 'btn mm-btn' + (primary ? ' mm-primary' : ''), type: 'button', text}); b.addEventListener('click', fn); btns.append(b); };
        if (s.active !== '1') add('使用', action('切换订阅', async () => { await jobOk('sub-use ' + s.id, '切换订阅', {minutes: 6}); toast('已切换到 ' + label, 'green'); await load(); }), true);
        add('更新', action('更新订阅', async () => {
          const res = await jobOk('sub-update ' + s.id, '更新订阅', {minutes: 6});
          toast('订阅已更新' + (s.active === '1' ? '并应用' : '') + (res.kv.bytes ? '（' + fmtBytes(res.kv.bytes) + '）' : ''), 'green');
          await load();
        }));
        add('编辑', async () => {
          editing = s.id;
          formTitle.textContent = '编辑订阅：' + label;
          save.textContent = '保存并更新';
          cancelEdit.hidden = false;
          name.value = label;
          url.value = '';
          try { const u = await svcOk('sub-url ' + s.id, 15000); url.value = b64dec(u.kv.url_b64); } catch (e) { toast('读取链接失败', 'red'); }
          url.focus();
        });
        add('删除', action('删除订阅', async () => {
          if (!(await confirmBox('删除订阅', '删除“' + label + '”？' + (s.active === '1' ? '\n当前配置会保留，但不再自动更新。' : ''), '删除'))) return;
          await svcOk('sub-delete ' + s.id, 15000);
          await load();
        }));
        row.append(btns);
        list.append(row);
      }
    };
    const submit = (andUse) => action(editing ? '保存订阅' : '添加订阅', async () => {
      const link = url.value.trim();
      let parsed;
      try { parsed = new URL(link); } catch (e) { throw new MmError('请输入完整的订阅链接（以 http:// 或 https:// 开头）'); }
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new MmError('订阅链接必须使用 http 或 https');
      if (/[\s"'`]/.test(link)) throw new MmError('订阅链接不能包含空格或引号');
      if (parsed.protocol === 'http:' && !(await confirmBox('使用不加密的订阅链接？', '这是 http:// 链接：订阅内容（含节点密码）以明文传输，可能被运营商或网络中间人读取和篡改。建议改用 https://。仍要继续吗？', '继续'))) return;
      const id = editing || (() => { let n = 1; while (subs.some((s) => s.id === 's' + n)) n++; return 's' + n; })();
      const urlPath = await uploadText(link + '\n', 'sub.url');
      const label = name.value.trim().replace(/[\r\n]/g, ' ').slice(0, 32);
      const namePath = label ? await uploadText(label + '\n', 'sub.name') : '';
      await svcOk('sub-save ' + id + ' ' + q(urlPath) + (namePath ? ' ' + q(namePath) : ''), 20000);
      const wasEditing = !!editing;
      const isActive = subs.some((s) => s.id === id && s.active === '1');
      resetForm();
      if (andUse) {
        if (wasEditing && !isActive) await jobOk('sub-update ' + id, '下载订阅', {minutes: 6});
        else await jobOk((wasEditing ? 'sub-update ' : 'sub-use ') + id, wasEditing ? '更新订阅' : '下载并应用订阅', {minutes: 6});
        toast('订阅已下载、校验并应用', 'green', 4000);
      } else toast('订阅已保存', 'green');
      await load();
    });
    save.addEventListener('click', () => submit(true)());
    saveOnly.addEventListener('click', () => submit(false)());
    d.body.append(list, h('div', {class: 'mm-box'},
      formTitle, name, url, h('div', {class: 'mm-row'}, save, saveOnly, cancelEdit),
      h('div', {class: 'mm-help', text: '订阅在 F50 上下载（先直连，失败再经代理），自动校验并在保存前备份。自动更新间隔和 User-Agent 在“设置”中修改。若机场返回 403 或节点链接列表，请在设置中把 User-Agent 改为 clash.meta / mihomo。'})));
    d.button('全部更新', action('更新全部订阅', async () => { await jobOk('sub-update all', '更新全部订阅', {minutes: 12}); toast('全部订阅已更新', 'green'); await load(); }));
    d.button('关闭', d.close, true);
    await load();
  };

  // ------------------------------------------------------------------ config editing
  const editDialog = async () => {
    const r = await svcOk('source-get', 30000);
    const d = dialog('edit', '编辑配置（源配置）', 960);
    const ta = h('textarea', {class: 'mm-textarea', spellcheck: 'false', autocomplete: 'off', 'aria-label': '源配置'});
    ta.value = r.out;
    d.body.append(h('div', {class: 'mm-help', text: '这里是订阅/上传的原始配置。端口、DNS、TUN、嗅探、控制器等由插件按“设置”自动生成，写在这里会被忽略。保存后会切换为手动配置（订阅自动更新不再覆盖它）。'}), ta);
    d.button('保存并应用', action('保存配置', async () => {
      if (!ta.value.trim()) throw new MmError('配置不能为空');
      if (byteLength(ta.value) > 4 * 1024 * 1024) throw new MmError('配置不能超过 4 MB');
      const path = await uploadText(ta.value, 'config.yaml');
      const res = await jobOk('apply-upload ' + q(path), '应用配置', {minutes: 8});
      d.close();
      toast('配置已校验并应用：' + res.kv.proxies + ' 节点 · ' + res.kv.groups + ' 分组 · ' + res.kv.rules + ' 规则', 'green', 5000);
    }), true);
    d.button('下载', () => download(ta.value, '猫猫_source_' + new Date().toISOString().slice(0, 10) + '.yaml'));
    d.button('关闭', d.close);
  };
  const uploadConfig = (file) => action('上传配置', async () => {
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) throw new MmError('配置文件不能超过 4 MB');
    const text = await file.text();
    if (!text.trim()) throw new MmError('文件为空');
    const path = await uploadText(text, 'config.yaml');
    const res = await jobOk('apply-upload ' + q(path), '应用配置', {minutes: 8});
    toast('配置已校验并应用：' + res.kv.proxies + ' 节点 · ' + res.kv.groups + ' 分组 · ' + res.kv.rules + ' 规则', 'green', 5000);
  })();

  // ------------------------------------------------------------------ logs / diagnostics / tests
  const logsDialog = () => {
    const d = dialog('logs', '猫猫日志', 980);
    const box = pre('加载中…', 'max-height:62vh;min-height:30vh');
    let auto = true, follow = true, timer = 0, loading = false;
    const load = async () => {
      if (loading) return;
      loading = true;
      try {
        const r = await root(q(SERVICE) + ' log 400', 15000);
        const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
        box.textContent = r.out || '（日志为空）';
        if (follow && atBottom) box.scrollTop = box.scrollHeight;
      } catch (e) { box.textContent = '读取失败：' + e.message; }
      finally { loading = false; }
    };
    const loop = async () => {
      if (!box.isConnected) return;
      if (auto && document.visibilityState === 'visible') await load();
      timer = setTimeout(loop, 3000);
    };
    const autoBtn = d.button('自动刷新：开', () => { auto = !auto; autoBtn.textContent = '自动刷新：' + (auto ? '开' : '关'); });
    const followBtn = d.button('自动滚动：开', () => { follow = !follow; followBtn.textContent = '自动滚动：' + (follow ? '开' : '关'); if (follow) box.scrollTop = box.scrollHeight; });
    d.button('清空', async () => { try { await svcOk('log-clear', 15000); await load(); toast('日志已清空', 'green'); } catch (e) { showError('清空日志失败', e); } });
    d.button('下载', () => download(box.textContent, '猫猫日志_' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.txt'));
    d.button('关闭', d.close, true);
    d.body.append(h('div', {class: 'mm-help', text: '文件日志级别：' + (S.info.MM_LOG_LEVEL || 'warning') + '（在“设置”中修改）。每个连接的实时日志请打开面板的“日志”页查看。'}), box);
    d.onClose(() => clearTimeout(timer));
    load().then(() => { box.scrollTop = box.scrollHeight; timer = setTimeout(loop, 3000); });
  };
  const diagnostics = async () => {
    const r = await svc('diag', 60000);
    textDialog('诊断信息（已隐藏密钥和订阅地址）', r.out, '猫猫诊断_' + new Date().toISOString().slice(0, 10) + '.txt');
  };
  const connectivity = async () => {
    const r = await svcOk('connectivity', 95000);
    const d = dialog('conn', '连通性测试', 720);
    const table = h('table', {class: 'mm-table'}, h('tr', {}, h('th', {text: '方式'}), h('th', {text: '地址'}), h('th', {text: '结果'}), h('th', {text: '耗时'})));
    for (const line of r.rec.test || []) {
      const t = fields(line);
      const ok = /^(2|3)\d\d$/.test(t.code);
      table.append(h('tr', {},
        h('td', {text: t.via === 'proxy' ? '经代理' : '直连'}),
        h('td', {text: t.url}),
        h('td', {class: ok ? 'mm-ok' : 'mm-err', text: t.code === 'skip' ? '跳过（未运行）' : ok ? '成功 ' + t.code : '失败 ' + (t.code || '')}),
        h('td', {text: Number(t.time) ? Math.round(Number(t.time) * 1000) + ' ms' : '—'})));
    }
    d.body.append(table, h('div', {class: 'mm-help', text: '“经代理”通过本机 7890 端口按当前规则访问；“直连”不经过代理。'}));
    d.button('关闭', d.close, true);
  };
  const cleanupDialog = async () => {
    const r = await svcOk('cleanup --dry-run', 30000);
    const items = [...(r.rec.junk || []).map((l) => ['临时/遗留', l]), ...(r.rec.backup || []).map((l) => ['旧备份', l])].map(([kind, l]) => {
      const i = l.indexOf(' ');
      return {kind, kb: Number(l.slice(0, i)) || 0, path: l.slice(i + 1)};
    });
    const total = items.reduce((a, b) => a + b.kb, 0);
    const d = dialog('cleanup', '存储清理', 820);
    d.body.append(h('div', {text: '/data/clash 当前占用 ' + fmtBytes(Number(r.kv.total_kb) * 1024) + '；可清理 ' + items.length + ' 项，约 ' + fmtBytes(total * 1024) + '。'}));
    if (items.length) d.body.append(pre(items.map((x) => x.kind + '  ' + fmtBytes(x.kb * 1024).padStart(9) + '  ' + x.path).join('\n'), 'max-height:46vh'));
    d.body.append(h('div', {class: 'mm-help', text: '保留最近 3 次组件备份、10 份配置备份、5 份开机脚本备份；不会删除当前内核、配置、订阅和设置。'}));
    if (items.length) {
      d.button('清理', action('存储清理', async () => {
        const res = await svcOk('cleanup', 60000);
        d.close();
        toast('已释放 ' + fmtBytes(Number(res.kv.freed_kb) * 1024), 'green', 5000);
      }), true);
    }
    d.button('关闭', d.close);
  };

  // ------------------------------------------------------------------ core / components
  const coreFileFormat = async (file) => {
    if (!file || file.size <= 20) throw new MmError('请选择有效的内核文件。');
    if (file.size > 128 * 1024 * 1024) throw new MmError('内核文件不能超过 128 MB。');
    const bytes = new Uint8Array(await file.slice(0, 20).arrayBuffer());
    if (bytes[0] === 0x1f && bytes[1] === 0x8b && bytes[2] === 8) return 'gzip';
    if (bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46) {
      throw new MmError('文件格式错误：请选择官方 .gz 压缩包或解压后的 ELF 内核文件，不能使用 ZIP、网页或安装包。');
    }
    const machine = new DataView(bytes.buffer).getUint16(18, true);
    if (bytes[4] !== 2 || bytes[5] !== 1 || machine !== 183) throw new MmError('内核架构错误：F50 需要 Android arm64-v8（AArch64），不能使用 x86、armv7 或 32 位内核。');
    return 'elf';
  };
  const shaInput = (v, label) => {
    const s = String(v || '').trim().toLowerCase();
    if (s && !/^[0-9a-f]{64}$/.test(s)) throw new MmError(label + '必须是 64 位十六进制 SHA-256。');
    return s;
  };
  const manualCoreDialog = () => {
    const d = dialog('manual', '手动上传内核 · 离线安装/更新', 860);
    const coreFile = h('input', {type: 'file', id: 'mm_core_file'});
    const coreSha = h('input', {type: 'text', class: 'mm-input', id: 'mm_core_sha', autocomplete: 'off', spellcheck: 'false', placeholder: PINNED.tag + ' 可留空；其他版本必填该文件的官方 SHA-256'});
    const geoFile = h('input', {type: 'file', id: 'mm_geo_file', accept: '.metadb,.mmdb'});
    const geoSha = h('input', {type: 'text', class: 'mm-input', id: 'mm_geo_sha', autocomplete: 'off', spellcheck: 'false', placeholder: '配套 GeoIP 可留空；其他版本填写对应 SHA-256'});
    d.body.append(
      h('p', {text: '先用能访问 GitHub 的电脑或手机下载，再在此上传。请选择 Android arm64-v8 版本，不要选 linux-arm64、amd64、386 或 armv7。'}),
      h('p', {}, h('a', {href: PINNED.coreUrl, target: '_blank', rel: 'noopener', text: '下载官方 ' + PINNED.tag + ' Android arm64-v8 (.gz)'}), ' · ',
        h('a', {href: PINNED.releasesUrl, target: '_blank', rel: 'noopener', text: '官方发布页（其他版本与 SHA-256）'})),
      h('label', {class: 'mm-field', for: 'mm_core_file'}, h('span', {text: '内核文件（必选，.gz 或解压后的 ELF，最大 128 MB）'}), coreFile),
      h('label', {class: 'mm-field', for: 'mm_core_sha'}, h('span', {text: '内核 SHA-256（所选文件本身的校验值）'}), coreSha),
      h('details', {}, h('summary', {text: PINNED.tag + ' 参考 SHA-256'}), pre('.gz：' + PINNED.coreSha + '\n解压后：' + PINNED.coreRawSha)),
      h('details', {style: 'margin-top:8px'}, h('summary', {text: '首次离线安装：同时上传 GeoIP 数据'}),
        h('p', {text: '已有 GeoIP 数据时可留空；首次离线安装需要 geoip.metadb。'}),
        h('p', {}, h('a', {href: PINNED.geoUrl, target: '_blank', rel: 'noopener', text: '下载配套 geoip.metadb'})),
        h('label', {class: 'mm-field', for: 'mm_geo_file'}, h('span', {text: 'GeoIP 文件'}), geoFile),
        h('label', {class: 'mm-field', for: 'mm_geo_sha'}, h('span', {text: 'GeoIP SHA-256'}), geoSha)),
      h('p', {class: 'mm-help', text: '安装前依次校验 SHA-256、gzip 完整性、ELF 架构、内核版本、GeoIP 和现有配置，全部通过才替换；失败自动回滚。自行填写的 SHA-256 只能证明文件与该值一致，请只使用官方发布的文件和校验值。'}));
    d.button('校验并安装', action('离线安装内核', async () => {
      const core = coreFile.files[0];
      await coreFileFormat(core);
      const sha = shaInput(coreSha.value, '内核 SHA-256 ');
      const geo = geoFile.files[0] || null;
      const gsha = shaInput(geoSha.value, 'GeoIP SHA-256 ');
      if (geo && (!geo.size || geo.size > 32 * 1024 * 1024)) throw new MmError('GeoIP 文件大小必须在 1 字节到 32 MB 之间。');
      progress('离线安装：上传内核（' + fmtBytes(core.size) + '）…');
      const corePath = await uploadBlob(core, 'core.bin');
      const geoPath = geo ? await uploadBlob(geo, 'geoip.metadb') : '';
      await installComponents('--core file --core-file ' + q(corePath) + (sha ? ' --core-sha ' + sha : '') +
        (geoPath ? ' --geo file --geo-file ' + q(geoPath) + (gsha ? ' --geo-sha ' + gsha : '') : ' --geo auto'), '离线安装');
      d.close();
      toast('离线安装完成，校验通过', 'green', 5000);
    }), true);
    d.button('关闭', d.close);
  };
  const componentsDialog = async () => {
    const i = S.info;
    const d = dialog('core', '内核与组件', 780);
    const latest = h('div', {class: 'mm-muted', text: '点击“检查更新”从 GitHub 获取最新正式版（经 GitHub 官方 SHA-256 校验）。'});
    d.body.append(
      h('table', {class: 'mm-table'},
        h('tr', {}, h('th', {text: '插件'}), h('td', {text: RELEASE_VERSION})),
        h('tr', {}, h('th', {text: '设备服务'}), h('td', {text: i.service_version || '—'})),
        h('tr', {}, h('th', {text: 'Mihomo 内核'}), h('td', {text: i.core_version || '—'})),
        h('tr', {}, h('th', {text: 'GeoIP 数据'}), h('td', {text: i.geoip === 'present' ? '已安装' : '未安装'})),
        h('tr', {}, h('th', {text: 'MetaCubeXD 面板'}), h('td', {text: i.dashboard_xd ? i.dashboard_xd : '未安装（可选）'}))),
      latest);
    const check = d.button('检查更新', action('检查内核更新', async () => {
      const res = await jobOk('core-latest', '检查内核更新', {minutes: 4});
      const {tag, url, sha, published} = res.kv;
      latest.replaceChildren();
      const installed = String(i.core_version || '').includes(' ' + tag + ' ');
      latest.append(h('div', {text: '最新正式版：' + tag + (published ? '（' + published.slice(0, 10) + ' 发布）' : '') + (installed ? ' —— 已是最新' : '')}));
      if (!installed) {
        const b = h('button', {class: 'btn mm-btn mm-primary', type: 'button', text: '更新到 ' + tag});
        b.addEventListener('click', action('更新内核', async () => {
          await installComponents('--core url --core-url ' + q(url) + ' --core-sha ' + sha + ' --tag ' + q(tag) + ' --geo auto', '更新内核');
          d.close();
          toast('内核已更新到 ' + tag, 'green', 5000);
        }));
        latest.append(b);
      }
    }, {noRefresh: true}));
    check.title = '使用 GitHub API；直连失败时经代理';
    d.button('更新 GeoIP/GeoSite', action('更新规则数据', async () => {
      const res = await jobOk('geo-update', '更新规则数据', {minutes: 10});
      toast(res.kv.geo_updated === '1' ? '规则数据已更新' : '规则数据已是最新', 'green');
    }));
    d.button(i.dashboard_xd ? '更新 MetaCubeXD' : '安装 MetaCubeXD 面板', action('安装面板', async () => {
      await jobOk('dashboard-install latest', '安装 MetaCubeXD', {minutes: 8});
      toast('MetaCubeXD 已安装', 'green');
    }));
    d.button('重新安装组件', action('重新安装组件', async () => {
      await installComponents('--core auto --geo auto', '重新安装组件');
      toast('组件已重新安装', 'green');
    }));
    d.button('手动上传内核', () => { d.close(); manualCoreDialog(); });
    d.button('关闭', d.close, true);
  };

  const uninstallDialog = () => {
    const d = dialog('uninstall', '卸载猫猫', 600);
    const purge = h('input', {type: 'checkbox', id: 'mm_purge'});
    d.body.append(
      h('p', {text: '卸载会停止代理、移除透明代理规则和开机自启，然后删除内核与服务。'}),
      h('label', {class: 'mm-check', for: 'mm_purge'}, purge, h('span', {text: '同时删除配置、订阅、设置和全部备份（/data/clash 整个目录）'})));
    d.button('卸载', action('卸载', async () => {
      if (!(await confirmBox('确认卸载', purge.checked ? '将删除 /data/clash 全部内容，且无法恢复。' : '内核和服务将被删除，配置、订阅和备份保留。', '卸载'))) return;
      const r = await svcOk('uninstall' + (purge.checked ? ' --purge' : ''), 60000);
      d.close();
      toast(r.text || '已卸载', 'green', 5000);
    }), true);
    d.button('取消', d.close);
  };

  // ------------------------------------------------------------------ dashboard
  const getSecret = async () => {
    if (!S.secret) S.secret = (await svcOk('secret', 15000)).kv.secret || '';
    if (!/^[a-f0-9]{48}$/.test(S.secret)) { S.secret = ''; throw new MmError('读取控制器密钥失败'); }
    return S.secret;
  };
  const openPanel = (path) => async () => {
    if (S.live.state !== 'running') { toast('猫猫未运行，请先启动', 'red'); return; }
    // Open synchronously within the click so pop-up blockers allow it, then navigate.
    const w = window.open('', '_blank');
    if (w) { try { w.opener = null; w.document.title = '猫猫面板'; } catch (e) { /* ignore */ } }
    try {
      const url = panelUrl(path, await getSecret(), path === '/ui/' ? '' : '');
      if (w) w.location.replace(url); else window.open(url, '_blank', 'noopener');
      if (location.protocol === 'https:') toast('面板使用 http://' + panelHost() + ':' + CTRL_PORT + '，仅在局域网或 Tailscale 内可访问', '', 6000);
    } catch (e) {
      if (w) w.close();
      showError('打开面板失败', e);
    }
  };
  const embedToggle = async () => {
    const on = ui.embed.hidden;
    store.set('embed', on ? '1' : '0');
    await renderEmbed();
  };
  let embedGeneration = 0;
  const renderEmbed = async () => {
    const generation = ++embedGeneration;
    if (!ui.embed) return;
    const want = store.get('embed', '0') === '1' && S.open && S.live.state === 'running';
    if (!want) {
      ui.embed.hidden = true;
      if (ui.embedFrame.getAttribute('src') !== 'about:blank') ui.embedFrame.src = 'about:blank';
      return;
    }
    ui.embed.hidden = false;
    if (location.protocol === 'https:') { ui.embedNote.textContent = '当前页面是 HTTPS，浏览器禁止内嵌 HTTP 面板；请使用“打开面板”。'; ui.embedFrame.hidden = true; return; }
    ui.embedFrame.hidden = false;
    ui.embedNote.textContent = '';
    try {
      await getSecret();
      if (generation !== embedGeneration || !card?.isConnected) return;
      const url = panelBase() + '/ui/#embed=1&parentOrigin=' + enc(location.origin);
      if (ui.embedFrame.getAttribute('src') !== url) ui.embedFrame.setAttribute('src', url);
    } catch (e) { ui.embedNote.textContent = e.message; }
  };

  // ------------------------------------------------------------------ rendering
  const STYLE = `
#${ID} .mm-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:6px 0}
#${ID} .mm-group-title{font-size:12px;opacity:.75;margin:10px 0 2px}
#${ID} .mm-status{display:flex;gap:6px 14px;flex-wrap:wrap;font-size:13px;margin:4px 0 8px}
#${ID} .mm-status b{font-weight:600}
#${ID} .mm-banner{padding:10px;border-radius:8px;background:rgba(250,204,21,.12);border:1px solid rgba(250,204,21,.35);margin:6px 0;font-size:13px;line-height:1.6}
#${ID} .mm-banner.mm-danger{background:rgba(248,113,113,.12);border-color:rgba(248,113,113,.4)}
#${ID} .mm-progress{font-size:12px;margin-top:8px;white-space:pre-wrap;opacity:.9}
#${ID} .mm-select,.mm-dlg .mm-select{max-width:100%;padding:5px 6px;border-radius:6px;background:var(--dark-btn-color);color:var(--dark-text-color);border:1px solid rgba(127,127,127,.4)}
#${ID} .mm-muted,.mm-dlg .mm-muted{opacity:.7;font-size:12px}
#${ID} .mm-label{font-size:12px;opacity:.8}
#${ID} .mm-embed iframe{width:100%;height:560px;border:none;border-radius:10px;background:#111827}
.mm-dlg .mm-pre,#${ID} .mm-pre{white-space:pre-wrap;word-break:break-all;overflow:auto;font:12px/1.45 ui-monospace,Menlo,Consolas,monospace;background:rgba(0,0,0,.72);color:#bbf7d0;padding:8px;border-radius:6px;margin:6px 0}
.mm-dlg .mm-input{display:block;width:100%;box-sizing:border-box;padding:7px 8px;margin:4px 0}
.mm-dlg .mm-field{display:block;margin:10px 0 2px}
.mm-dlg .mm-field>span{display:block;margin-bottom:2px}
.mm-dlg .mm-check{display:flex;gap:8px;align-items:center;margin:10px 0 2px;cursor:pointer}
.mm-dlg .mm-help{font-size:12px;opacity:.72;margin:2px 0 6px}
.mm-dlg .mm-textarea{width:100%;box-sizing:border-box;height:56vh;font:12px/1.45 ui-monospace,Menlo,Consolas,monospace;background:rgba(0,0,0,.72);color:#bbf7d0;border-radius:6px;padding:8px}
.mm-dlg .mm-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:6px 0}
.mm-dlg .mm-sub{padding:8px;border-radius:8px;border:1px solid rgba(127,127,127,.35);margin:6px 0}
.mm-dlg .mm-sub.mm-active{border-color:rgba(74,222,128,.7)}
.mm-dlg .mm-sub-head{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.mm-dlg .mm-badge{font-size:11px;padding:1px 6px;border-radius:9px;background:rgba(74,222,128,.25)}
.mm-dlg .mm-usage{font-size:12px;margin-top:2px}
.mm-dlg .mm-err,#${ID} .mm-err{color:#f87171}
.mm-dlg .mm-ok{color:#4ade80}
.mm-dlg .mm-box{margin-top:10px;padding:8px;border-radius:8px;border:1px dashed rgba(127,127,127,.45)}
.mm-dlg .mm-table{border-collapse:collapse;width:100%;font-size:12px;margin:6px 0}
.mm-dlg .mm-table td,.mm-dlg .mm-table th{border-bottom:1px solid rgba(127,127,127,.25);padding:5px 6px;text-align:left;word-break:break-all}
.mm-dlg .mm-chips{display:flex;gap:6px;flex-wrap:wrap;margin:4px 0}
.mm-dlg .mm-chip.mm-on{background:var(--dark-btn-color-active);}
.mm-btn.mm-primary{background:var(--dark-btn-color-active)}
.mm-btn[disabled]{opacity:.5;cursor:not-allowed}
`;

  const buttonsSpec = () => {
    const running = S.live.state === 'running';
    const boot = S.info.autostart === '1';
    return [
      ['运行', [
        ['启动', action('启动', async () => { const r = await svcOk('start', 95000); toast(r.text || '已启动', 'green'); }), {primary: !running}],
        ['停止', action('停止', async () => { const r = await svcOk('stop', 60000); toast(r.text || '已停止', 'green'); })],
        ['重启', action('重启', async () => { const r = await svcOk('restart', 95000); toast(lastLine(r.out) || '已重启', 'green'); })],
        ['开机自启：' + (boot ? '开' : '关'), action('开机自启', async () => {
          const r = await svcOk('autostart ' + (boot ? 'off' : 'on'), 20000);
          toast(r.kv.autostart === '1' ? '已开启开机自启（开机后等待网络就绪再启动，失败自动重试）' : '已关闭开机自启', 'green', 5000);
        }), {active: boot}],
        ['刷新', action('刷新状态', async () => { if (S.live.state === 'running') await loadGroups().catch(() => {}); })],
      ]],
      ['配置', [
        ['订阅管理', action('订阅管理', subsDialog, {noRefresh: true}), {primary: S.info.config !== 'present'}],
        ['编辑配置', action('打开配置', editDialog, {noRefresh: true})],
        ['上传配置', 'upload'],
        ['备份配置', action('备份配置', async () => {
          const r = await svcOk('source-get', 30000);
          download(r.out, '猫猫_source_' + new Date().toISOString().slice(0, 10) + '.yaml');
        }, {noRefresh: true})],
        ['设置', action('打开设置', settingsDialog, {noRefresh: true})],
      ]],
      ['面板', [
        ['打开面板', openPanel('/ui/'), {disabled: !running}],
        [ui.embed && !ui.embed.hidden ? '收起内嵌面板' : '内嵌面板', embedToggle, {disabled: !running}],
        S.info.dashboard_xd && ['MetaCubeXD', openPanel('/ui/xd/'), {disabled: !running}],
      ].filter(Boolean)],
      ['维护', [
        ['内核与组件', action('内核与组件', componentsDialog, {noRefresh: true})],
        ['查看日志', logsDialog],
        ['诊断', action('诊断', diagnostics, {noRefresh: true})],
        ['连通性测试', action('连通性测试', connectivity, {noRefresh: true})],
        ['存储清理', action('存储清理', cleanupDialog, {noRefresh: true})],
        ['文档', () => window.open(DOCS_URL, '_blank', 'noopener')],
        ['卸载', uninstallDialog],
      ]],
    ];
  };

  const renderButtons = () => {
    const box = ui.actions;
    box.replaceChildren();
    if (S.phase !== 'ready' && S.phase !== 'newer') return;
    for (const [title, buttons] of buttonsSpec()) {
      box.append(h('div', {class: 'mm-group-title', text: title}));
      const row = h('div', {class: 'mm-row'});
      for (const [text, fn, opt] of buttons) {
        const o = opt || {};
        const b = h('button', {class: 'btn mm-btn' + (o.primary ? ' mm-primary' : ''), type: 'button', text, disabled: S.busy || !!o.disabled});
        if (o.active) b.style.background = 'var(--dark-btn-color-active)';
        // The file picker must open inside the click itself (browser user-activation rules).
        if (fn === 'upload') b.addEventListener('click', () => { if (!S.busy) ui.file.click(); });
        else b.addEventListener('click', fn);
        row.append(b);
      }
      box.append(row);
    }
  };

  const renderBanner = () => {
    const box = ui.banner;
    box.replaceChildren();
    box.hidden = true;
    const mk = (cls, text, buttons) => {
      box.hidden = false;
      box.className = 'mm-banner' + (cls ? ' ' + cls : '');
      box.append(h('div', {text}));
      if (buttons && buttons.length) {
        const row = h('div', {class: 'mm-row'});
        for (const [t, fn, primary] of buttons) {
          const b = h('button', {class: 'btn mm-btn' + (primary ? ' mm-primary' : ''), type: 'button', text: t, disabled: S.busy});
          b.addEventListener('click', fn);
          row.append(b);
        }
        box.append(row);
      }
    };
    const install = (opts, label, okText) => action(label, async () => { await installComponents(opts, label); toast(okText, 'green', 6000); });
    switch (S.phase) {
      case 'init': mk('', '正在检测安装状态…'); break;
      case 'noroot': mk('mm-danger', '无法执行 root 命令：请在 UFI-TOOLS 中开启“高级功能”后点击重试。', [['重试', action('检测', async () => {})]]); break;
      case 'error': mk('mm-danger', '状态检测失败：' + S.lastError, [['重试', action('检测', async () => {})]]); break;
      case 'absent': mk('', '尚未安装。在线安装会从 GitHub 下载官方 Mihomo ' + PINNED.tag + '（Android arm64，SHA-256 校验）和 GeoIP 数据；无法访问 GitHub 时可手动上传内核。', [
        ['在线安装', install('--core pinned --geo auto', '在线安装', '安装完成：请在“订阅管理”中添加订阅'), true],
        ['手动上传内核', manualCoreDialog]]); break;
      case 'broken': mk('mm-danger', '检测到内核，但设备服务缺失或损坏。修复安装会保留内核、配置和订阅。', [
        ['修复安装', install('--core auto --geo auto', '修复安装', '修复完成'), true], ['手动上传内核', manualCoreDialog]]); break;
      case 'nocore': mk('mm-danger', '设备服务已安装，但内核缺失或没有执行权限。', [
        ['在线安装内核', install('--core pinned --geo auto', '安装内核', '内核安装完成'), true], ['手动上传内核', manualCoreDialog]]); break;
      case 'legacy': mk('mm-danger', '检测到旧版组件（1.x）。升级到 ' + PLUGIN_VERSION + ' 会保留内核、订阅和配置，并修复旧版把 7890 代理端口暴露到蜂窝公网 IPv6 的问题；' +
        (S.info.legacy_running === '1' ? '代理会自动重启（约 5 秒）。' : '代理保持停止。'), [
        ['立即升级', install('--core auto --geo auto', '升级组件', '已升级到 ' + PLUGIN_VERSION), true]]); break;
      case 'outdated': mk('', '设备组件版本 ' + S.info.service_version + '，插件版本 ' + PLUGIN_VERSION + '。升级会保留内核、订阅、配置和设置；仅脚本变化时代理不中断。', [
        ['升级组件', install('--core auto --geo auto', '升级组件', '组件已升级'), true]]); break;
      case 'newer': mk('', '设备组件（' + S.info.service_version + '）比当前插件（' + PLUGIN_VERSION + '）新，请更新插件；以下功能仍可使用。'); break;
      default: break;
    }
    if (S.phase === 'ready' && S.info.config !== 'present') mk('', '尚未导入配置：请在“订阅管理”中添加订阅，或“上传配置”。', [['订阅管理', action('订阅管理', subsDialog, {noRefresh: true}), true]]);
    if (S.phase === 'ready' && S.live.net_stale === '1') {
      mk('mm-danger', '内核已不在运行，但透明代理规则仍在：局域网设备此刻可能无法上网。通常会在几秒内自动恢复；如未恢复请点击“恢复直连”。', [
        ['恢复直连', action('恢复直连', async () => { const r = await svcOk('stop', 60000); toast(r.text || '已恢复直连', 'green'); }), true]]);
    } else if (S.phase === 'ready' && S.live.last_error_b64 && S.live.state !== 'running') {
      mk('mm-danger', '上次运行问题：' + b64dec(S.live.last_error_b64).replace(/^\d+\s*/, '').slice(0, 300));
    }
  };

  const renderStatus = () => {
    const l = S.live, i = S.info;
    const running = l.state === 'running';
    const ready = S.phase === 'ready' || S.phase === 'newer';
    const badge = !ready ? ({init: '检测中', noroot: '需要高级功能', error: '检测失败', absent: '未安装', broken: '需要修复', nocore: '缺少内核', legacy: '需要升级', outdated: '可升级'}[S.phase] || '')
      : l.busy === '1' ? '🟡 操作中' : running ? '🟢 运行中' : '🔴 已停止';
    ui.badge.textContent = badge;
    ui.title.title = S.lastError || '';
    const st = ui.status;
    st.replaceChildren();
    if (!ready) { st.hidden = true; return; }
    st.hidden = false;
    const item = (k, v) => v && st.append(h('span', {}, h('span', {class: 'mm-muted', text: k + ' '}), h('b', {text: v})));
    item('内核', (i.core_version || '').replace(/^Mihomo Meta /, '').split(' ')[0]);
    if (running) {
      item('运行', fmtDuration(l.uptime));
      item('内存', l.rss_kb ? fmtBytes(Number(l.rss_kb) * 1024) : '');
      item('↑', fmtRate(S.rate.up));
      item('↓', fmtRate(S.rate.down));
      item('连接', l.conns !== undefined ? l.conns : '');
    }
    const mode = l.mode || i.MM_MODE || l.MM_MODE;
    if (S.info.config === 'present' || l.config === 'present') {
      const modeSel = h('select', {class: 'mm-select', 'aria-label': '代理模式', disabled: S.busy});
      for (const [v, t] of [['rule', '规则'], ['global', '全局'], ['direct', '直连']]) modeSel.add(new Option(t, v, false, v === mode));
      modeSel.addEventListener('change', action('切换模式', async () => {
        await svcOk('mode ' + modeSel.value, 60000);
        toast('已切换为' + ({rule: '规则分流', global: '全局代理', direct: '全部直连'}[modeSel.value]) + '（已保存）', 'green');
      }));
      st.append(h('span', {}, h('span', {class: 'mm-muted', text: '模式 '}), modeSel));
    }
    const usage = usageLine(l.sub_userinfo || i.sub_userinfo, Number(l.now) || Date.now() / 1000);
    const subName = b64dec(i.sub_name_b64);
    if (subName || usage) item('订阅', [subName, usage, (l.sub_updated || i.sub_updated) && ('更新于 ' + fmtAgo(l.sub_updated || i.sub_updated, l.now))].filter(Boolean).join(' · '));
    if (S.failures) st.append(h('span', {class: 'mm-err', text: '状态更新失败，稍后重试'}));
  };

  const render = () => {
    // A disposed instance (plugin re-injected) may still have requests in flight.
    if (!card || !card.isConnected) return;
    renderStatus();
    renderEmbed();
    renderBanner();
    renderButtons();
    renderGroups();
    progress(S.progress);
  };

  // ------------------------------------------------------------------ mount
  const mount = (container) => {
    document.getElementById(ID)?.remove();
    if (!document.getElementById('mm-tproxy-style')) document.head.append(h('style', {id: 'mm-tproxy-style', text: STYLE}));
    ui.badge = h('span', {class: 'mm-badge-state', style: 'margin-left:8px;font-size:13px;font-weight:normal', text: '检测中'});
    ui.title = h('strong', {text: '猫猫 TProxy Plus'});
    ui.collapseBtn = h('div', {id: 'mm_tproxy_collapse_btn', style: 'display:inline-block'});
    ui.status = h('div', {class: 'mm-status', hidden: true});
    ui.groups = h('div', {class: 'mm-groups', hidden: true});
    ui.banner = h('div', {class: 'mm-banner', hidden: true});
    ui.actions = h('div', {class: 'mm-actions'});
    ui.progress = h('div', {class: 'mm-progress', hidden: true, role: 'status', 'aria-live': 'polite'});
    ui.file = h('input', {type: 'file', accept: '.yaml,.yml,.txt,text/yaml', hidden: true});
    ui.file.addEventListener('change', () => { const f = ui.file.files[0]; ui.file.value = ''; uploadConfig(f); });
    ui.embedNote = h('div', {class: 'mm-muted'});
    ui.embedFrame = h('iframe', {title: '猫猫面板', src: 'about:blank', loading: 'lazy', referrerpolicy: 'no-referrer'});
    // Hand the controller secret to the embedded panel by message: it never appears in the page DOM.
    ui.embedFrame.addEventListener('load', () => {
      if (!S.secret || ui.embedFrame.getAttribute('src') === 'about:blank') return;
      try { ui.embedFrame.contentWindow.postMessage({type: 'mm-secret', secret: S.secret}, panelBase()); } catch (e) { /* ignore */ }
    });
    ui.embed = h('ul', {class: 'deviceList mm-embed', hidden: true}, h('li', {style: 'padding:10px'}, ui.embedNote, ui.embedFrame));
    const body = h('div', {class: 'collapse_box', style: 'padding:2px 0 10px'}, ui.banner, ui.status, ui.groups, ui.actions, ui.progress, ui.file, ui.embed);
    ui.collapse = h('div', {class: 'collapse', id: 'mm_tproxy_collapse', 'data-name': 'close', style: 'height:0px;overflow:hidden'}, body);
    card = h('div', {id: ID, style: 'width:100%;margin-top:10px'},
      h('div', {class: 'title', style: 'margin:6px 0'}, ui.title, ui.badge, ui.collapseBtn), ui.collapse);
    container.insertAdjacentElement('afterend', card);
    disposers.push(() => card.remove());
    const onToggle = (state) => {
      S.open = state === 'open';
      if (S.open) { refresh().catch(() => {}); schedulePoll(300); } else { clearTimeout(S.timer); }
      renderEmbed();
    };
    try { collapseGen('#mm_tproxy_collapse_btn', '#mm_tproxy_collapse', STORE + 'collapse', onToggle); }
    catch (e) { ui.collapse.dataset.name = 'open'; ui.collapse.style.height = 'auto'; }
    S.open = (localStorage.getItem(STORE + 'collapse') || 'open') === 'open';
    render();
  };

  const init = async () => {
    let container = null;
    for (let i = 0; i < 600 && !(container = document.querySelector('.functions-container')); i++) await sleep(100);
    if (!container) { console.warn('[猫猫 TProxy Plus] 未找到功能列表容器'); return; }
    mount(container);
    try { await refresh(); } catch (e) { /* banner shows it */ }
    if (S.open) { schedulePoll(1000); renderEmbed(); }
  };
  init().catch((e) => console.error('[猫猫 TProxy Plus]', e));
})();
//</script>
