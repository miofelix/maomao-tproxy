'use strict';
// Offline UI tests: the built plugin runs in jsdom next to the host's real utils.js
// (createToast, createFixedToast, collapseGen ...) with a scripted fake device.
// Run: npm ci && node tests/ui_harness.cjs
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const {JSDOM} = require('jsdom');

const PLUGIN = fs.readFileSync(path.join(__dirname, '../dist/maomao-tproxy-plus.js'), 'utf8');
const UTILS = fs.readFileSync(path.join(__dirname, 'fixtures/ufi-utils.js'), 'utf8');

const INFO_READY = (over = {}) => Object.entries(Object.assign({
  service_version: '2.0.0', busy: '0', state: 'running', pid: '1234', uptime: '3700', rss_kb: '45000', network: '1', watchdog: '1',
  core: 'present', core_version: 'Mihomo Meta v1.19.32 android arm64 with go1.26.8', config: 'present', source: 'present',
  source_origin: 'sub:s1', geoip: 'present', autostart: '0', MM_GUARD: '1', MM_GUARD_TS: '1', MM_IPV6: '1', MM_UDP: '1',
  MM_QUIC_BLOCK: '0', MM_SNIFF: '1', MM_AUTO_RESTART: '1', MM_DEV_MODE: 'all', MM_DEV_LIST: '', MM_BYPASS_PORTS: '123,853',
  MM_MODE: 'rule', MM_LOG_LEVEL: 'warning', MM_LOG_MAX_KB: '1024', MM_SUB_ACTIVE: 's1', MM_SUB_INTERVAL: '24', MM_SUB_UA: 'clash.meta',
  MM_DL_VIA: 'auto', MM_GH_MIRROR: '', MM_DNS: '223.5.5.5,119.29.29.29', MM_MEMLIMIT: '128', log_kb: '12', backups_kb: '1024', junk: '3',
  sub_name_b64: Buffer.from('示例订阅<img src=x onerror=alert(1)>').toString('base64'), sub_updated: '1792470000', sub_status: 'ok',
  sub_userinfo: 'upload=1073741824;download=10737418240;total=1099511627776;expire=1795000000', sub_next: '0', lan: '192.168.0.1', now: '1792480000',
}, over)).map(([k, v]) => '@' + k + '=' + v).join('\n');

const PROXIES = JSON.stringify({proxies: {
  GLOBAL: {type: 'Selector', now: 'G1', all: ['G1', 'Auto', 'n1', 'n2']},
  G1: {type: 'Selector', now: 'n1', all: ['Auto', 'n1', 'n2', '<b>xss</b>']},
  Auto: {type: 'URLTest', now: 'n2', all: ['n1', 'n2']},
  n1: {type: 'Vless', history: [{delay: 120}]}, n2: {type: 'Trojan', history: [{delay: 0}]}, '<b>xss</b>': {type: 'Ss', history: []},
}});

function makeDevice(scenario) {
  const calls = [];
  const state = {scenario, jobs: {}};
  const respond = (cmd) => {
    calls.push(cmd);
    const svc = "'/data/clash/Scripts/Clash.Service' ";
    if (cmd.startsWith(svc + 'info')) {
      if (state.scenario === 'absent') return {out: '/system/bin/sh: /data/clash/Scripts/Clash.Service: inaccessible or not found', code: 127};
      if (state.scenario === 'legacy') return {out: 'Usage: Clash.Service {start|stop|restart|status}', code: 2};
      if (state.scenario === 'outdated') return {out: INFO_READY({service_version: '1.9.0'}), code: 0};
      return {out: INFO_READY(state.scenario === 'stopped' ? {state: 'stopped', pid: ''} : {}), code: 0};
    }
    if (cmd.includes('echo "@service=legacy"')) {
      if (state.scenario === 'legacy') return {out: '@service=legacy\n@core=present\n@config=present\n@legacy_running=1', code: 0};
      return {out: '@service=none\n@core=missing', code: 0};
    }
    if (cmd.startsWith(svc + 'live')) return {out: INFO_READY({conns: '9', up_total: String(1e6 + calls.length * 5e4), down_total: String(5e6 + calls.length * 4e5), mode: 'rule'}), code: 0};
    if (cmd.startsWith(svc + 'api GET /proxies')) return {out: '@code=200\n' + PROXIES, code: 0};
    if (cmd.startsWith(svc + "api PUT '/proxies/")) return {out: '@code=204', code: 0};
    if (cmd.startsWith(svc + "api GET '/group/")) return {out: '@code=200\n{"n1":130,"n2":0}', code: 0};
    if (cmd.startsWith(svc + 'settings-get')) return {out: INFO_READY().split('\n').filter((l) => l.startsWith('@MM_')).join('\n'), code: 0};
    if (cmd.startsWith(svc + 'settings ')) return {out: '@config_changed=1\n@network_changed=0', code: 0};
    if (cmd.startsWith(svc + 'sub-list')) return {out: '@sub id=s1 active=1 updated=1792470000 status=ok bytes=45517 interval=24 userinfo=upload=1;download=2;total=1099511627776;expire=1795000000 name_b64=' +
      Buffer.from('示例订阅<script>').toString('base64') + ' url_b64=' + Buffer.from('https://b.example.org/…').toString('base64') + ' error_b64=\n@sub id=s2 active=0 updated=0 status=error bytes=0 interval=0 userinfo= name_b64=' +
      Buffer.from('备用').toString('base64') + ' url_b64=' + Buffer.from('https://c.example.org/…').toString('base64') + ' error_b64=' + Buffer.from('下载失败').toString('base64') + '\n@sub_active=s1\n@sub_interval=24\n@now=1792480000', code: 0};
    if (cmd.startsWith(svc + 'source-get')) return {out: 'proxies:\n  - {name: a, type: direct}\nrules:\n  - MATCH,DIRECT', code: 0};
    if (cmd.startsWith(svc + 'secret')) return {out: '@secret=' + 'ab'.repeat(24), code: 0};
    if (cmd.startsWith(svc + 'cleanup --dry-run')) return {out: '@junk 4 /data/clash/.install-1.sh\n@backup 70876 /data/clash/backups/update.1\n@total_kb=497010', code: 0};
    if (cmd.startsWith(svc + 'connectivity')) return {out: '@test via=direct url=https://www.baidu.com code=200 time=0.2\n@test via=proxy url=https://www.google.com/generate_204 code=204 time=0.9', code: 0};
    if (cmd.startsWith(svc + 'diag')) return {out: '== diag\nok', code: 0};
    if (cmd.startsWith(svc + 'log ')) return {out: 'line1\nline2', code: 0};
    if (cmd.startsWith(svc + 'mode ')) return {out: '@mode=global', code: 0};
    if (cmd.startsWith(svc + 'start') || cmd.startsWith(svc + 'stop') || cmd.startsWith(svc + 'restart')) return {out: '猫猫已启动（PID 1)', code: 0};
    if (cmd.includes('mktemp -d /data/clash/.stage.XXXXXX')) return {out: '/data/clash/.stage.AbC123', code: 0};
    if (cmd.startsWith('mv -f ')) {
      const sizes = [...cmd.matchAll(/mv -f '([^']+)' '([^']+)'/g)].map((m) => '  ' + (state.uploads[m[1]] || 0) + ' ' + m[2]);
      return {out: sizes.join('\n'), code: 0};
    }
    const job = /' job (j[a-z0-9]+) (.*)$/.exec(cmd);
    if (job) { state.jobs[job[1]] = {args: job[2], n: 0}; return {out: '@job=' + job[1], code: 0}; }
    const poll = /\/data\/clash\/jobs\/(j[a-z0-9]+);/.exec(cmd);
    if (poll) {
      const j = state.jobs[poll[1]];
      j.n++;
      const log = '任务开始：' + j.args + '\n进行中…\n' + (j.n > 1 ? '完成\n@installed=1\n@tag=v1.20.0\n@url=https://github.com/MetaCubeX/mihomo/releases/download/v1.20.0/x.gz\n@sha=' + 'c'.repeat(64) + '\n@published=2026-10-30T00:00:00Z' : '');
      return {out: (j.n > 1 ? '@job_state=done\n@job_rc=0' : '@job_state=running') + '\n@job_log_b64=' + Buffer.from(log).toString('base64'), code: 0};
    }
    if (cmd.startsWith('cat /proc/net/arp')) return {out: 'IP address HW type Flags HW address Mask Device\n192.168.0.21 0x1 0x2 02:00:00:00:00:21 * br0', code: 0};
    return {out: 'UNHANDLED ' + cmd.slice(0, 80), code: 99};
  };
  state.uploads = {};
  return {state, calls, respond};
}

async function run(scenario, steps) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="toastContainer"></div><div class="kano_function_main"><div class="functions-container"></div></div></body></html>',
    {runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://192.168.0.1:2333/'});
  const w = dom.window;
  const errors = [];
  w.addEventListener('error', (e) => errors.push(e.error || e.message));
  w.console.error = (...a) => errors.push(a.join(' '));
  w.ResizeObserver = class { observe() {} disconnect() {} };
  const dev = makeDevice(scenario);
  w.KANO_baseURL = '/api';
  w.common_headers = {};
  w.UFI_DATA = {lan_ipaddr: '192.168.0.1'};
  w.runShellWithRoot = async (command) => {
    const m = /^\/system\/bin\/sh -c '((?:[^']|'\\'')*)' 2>&1\nprintf "\\n(__MM2_RC_[a-z0-9]+__)%s\\n" \$\?$/.exec(command);
    if (!m) return {success: false, content: 'bad wrapper: ' + command.slice(0, 120)};
    const inner = m[1].replaceAll("'\\''", "'");
    const r = dev.respond(inner);
    return {success: true, content: r.out + '\n' + m[2] + r.code};
  };
  w.fetch = async (url, init) => {
    if (String(url).endsWith('/upload_img')) {
      const file = init.body.get('file');
      const name = 'u' + Object.keys(dev.state.uploads).length + '-uuid.' + (String(file.name).split('.').pop() || 'bin').toLowerCase();
      dev.state.uploads['/data/data/com.minikano.f50_sms/files/uploads/' + name] = file.size;
      return {ok: true, status: 200, json: async () => ({url: '/uploads/' + name})};
    }
    throw new Error('unexpected fetch ' + url);
  };
  w.open = () => ({opener: 1, document: {}, location: {replace() {}}, close() {}});
  w.getData = async () => ({station_list: [{hostname: 'mac', ip_addr: '192.168.0.21', mac_addr: '02:00:00:00:00:21'}], devices: []});
  w.Chart = function () {}; w.Chart.register = () => {};
  w.TextDecoder = TextDecoder; w.TextEncoder = TextEncoder;
  w.eval(UTILS);
  w.eval(PLUGIN.replace(/^\/\/<script>\n/, '').replace(/\/\/<\/script>\s*$/, ''));
  const $ = (s) => w.document.querySelector(s);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await wait(20); }
    const v = fn(); if (!v) throw new Error('timed out waiting for: ' + fn.toString().slice(0, 160)); return v; };
  await until(() => $('#kano-mm-tproxy'));
  await wait(150);
  const ctx = {w, $, dev, wait, until, errors,
    text: () => $('#kano-mm-tproxy').textContent,
    button: (label) => [...w.document.querySelectorAll('#kano-mm-tproxy button, .mm-dlg button')].find((b) => b.textContent === label || b.textContent.startsWith(label)),
    click: async (label) => { const b = ctx.button(label); assert.ok(b, 'button ' + label + ' not found in: ' + [...w.document.querySelectorAll('button')].map((x) => x.textContent).join('|')); b.click(); await wait(250); },
    dialogText: () => [...w.document.querySelectorAll('.mm-dlg')].map((d) => d.textContent).join('\n'),
  };
  await steps(ctx);
  assert.deepEqual(errors.filter((e) => !/Not implemented: (navigation|window\.scrollTo|HTMLCanvas)/.test(String(e))), [], scenario + ': page errors');
  assert.ok(!w.document.querySelector('img'), scenario + ': XSS produced an <img>');
  assert.ok(!w.document.querySelector('.mm-dlg script, #kano-mm-tproxy script'), scenario + ': injected <script> rendered');
  assert.ok(![...w.document.querySelectorAll('#kano-mm-tproxy b, .mm-dlg b')].some((b) => b.textContent === 'xss'), scenario + ': injected <b> rendered');
  const unhandled = dev.calls.filter((c) => dev.respond.length && false);
  w.__kanoMmTproxy.dispose();
  await wait(400);
  dom.window.close();
  return unhandled;
}

(async () => {
  const results = [];
  const t = async (name, scenario, steps) => {
    try { await run(scenario, steps); results.push('PASS ' + name); }
    catch (e) { results.push('FAIL ' + name + ' :: ' + (e.stack || e).toString().split('\n').slice(0, 4).join(' | ')); }
  };
  await t('ready card renders status and groups', 'ready', async (c) => {
    await c.until(() => c.text().includes('运行中'));
    assert.match(c.text(), /v1\.19\.32/);
    assert.match(c.text(), /订阅管理/);
    await c.until(() => c.$('#kano-mm-tproxy select[aria-label="节点"]'));
    const nodes = c.$('#kano-mm-tproxy select[aria-label="节点"]');
    assert.equal(nodes.options.length, 4);
    assert.match([...nodes.options].map((o) => o.textContent).join(','), /n1 · 120 ms/);
  });
  await t('absent shows install', 'absent', async (c) => {
    await c.until(() => c.text().includes('尚未安装'));
    assert.ok(c.button('在线安装'));
    await c.click('在线安装');
    await c.until(() => c.dev.calls.some((x) => x.includes("' job ") && x.includes('install --stage')), 4000);
    assert.ok(c.dev.calls.some((x) => x.startsWith("/system/bin/sh '/data/clash/.stage.AbC123/Clash.Service' job ")), 'install must run from the staged script');
  });
  await t('legacy shows upgrade', 'legacy', async (c) => {
    await c.until(() => c.text().includes('旧版组件'));
    assert.ok(c.button('立即升级'));
    assert.match(c.text(), /自动重启/);
  });
  await t('outdated shows upgrade', 'outdated', async (c) => {
    await c.until(() => c.text().includes('升级组件'));
  });
  await t('stopped card', 'stopped', async (c) => {
    await c.until(() => c.text().includes('已停止'));
    assert.ok(c.button('打开面板').disabled);
  });
  await t('subscription dialog', 'ready', async (c) => {
    await c.until(() => c.button('订阅管理'));
    await c.click('订阅管理');
    await c.until(() => c.dialogText().includes('使用中'));
    assert.match(c.dialogText(), /示例订阅<script>/);
    assert.match(c.dialogText(), /下载失败/);
    assert.match(c.dialogText(), /已用 /);
  });
  await t('settings dialog saves', 'ready', async (c) => {
    await c.until(() => c.button('设置'));
    await c.click('设置');
    await c.until(() => c.w.document.querySelector('#mm_set_MM_GUARD_TS'));
    await c.until(() => c.w.document.querySelector('.mm-chip'));
    c.w.document.querySelector('.mm-chip').click();
    assert.equal(c.w.document.querySelector('#mm_set_MM_DEV_LIST').value, '02:00:00:00:00:21');
    await c.click('保存并应用');
    await c.until(() => c.dev.calls.some((x) => /^'\/data\/clash\/Scripts\/Clash\.Service' job j[a-z0-9]+ settings '\/data\/data\/com\.minikano\.f50_sms\/files\/uploads\//.test(x)), 4000);
    assert.ok(!c.w.document.querySelector('#mm_set_MM_GUARD'), 'guard toggle must be gone');
  });
  await t('components dialog checks update', 'ready', async (c) => {
    await c.until(() => c.button('内核与组件'));
    await c.click('内核与组件');
    await c.click('检查更新');
    await c.until(() => c.dialogText().includes('v1.20.0'), 5000);
    assert.ok(c.button('更新到 v1.20.0'));
  });
  await t('node switch and delay test', 'ready', async (c) => {
    await c.until(() => c.$('#kano-mm-tproxy select[aria-label="节点"]'));
    const sel = c.$('#kano-mm-tproxy select[aria-label="节点"]');
    sel.value = 'n2';
    sel.dispatchEvent(new c.w.Event('change'));
    await c.until(() => c.dev.calls.some((x) => x.includes("api PUT '/proxies/G1'")), 3000);
    await c.until(() => { const b = c.button('测速'); return b && !b.disabled; }, 4000);
    await c.click('测速');
    await c.until(() => c.dev.calls.some((x) => x.includes("api GET '/group/G1/delay")), 3000);
  });
  await t('mode switch', 'ready', async (c) => {
    await c.until(() => c.$('#kano-mm-tproxy select[aria-label="代理模式"]'));
    const sel = c.$('#kano-mm-tproxy select[aria-label="代理模式"]');
    sel.value = 'global';
    sel.dispatchEvent(new c.w.Event('change'));
    await c.until(() => c.dev.calls.some((x) => x.includes('Clash.Service\' mode global')), 3000);
  });
  await t('cleanup, diag, connectivity, logs, edit', 'ready', async (c) => {
    await c.until(() => c.button('存储清理'));
    await c.click('存储清理'); await c.until(() => c.dialogText().includes('可清理 2 项'));
    await c.click('诊断'); await c.until(() => c.dialogText().includes('== diag'));
    await c.click('连通性测试'); await c.until(() => c.dialogText().includes('成功 204'));
    await c.click('查看日志'); await c.until(() => c.dialogText().includes('line2'));
    await c.click('编辑配置'); await c.until(() => c.w.document.querySelector('.mm-textarea'));
  });
  console.log(results.join('\n'));
  process.exitCode = results.some((r) => r.startsWith('FAIL')) ? 1 : 0;
})();
