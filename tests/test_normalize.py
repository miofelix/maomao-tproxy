"""normalize.awk tests. Run: python3 -I tests/test_normalize.py [--device]

--device additionally runs every case with the F50's /system/bin/awk via adb (non-root shell)."""
import os, subprocess, sys, tempfile, shlex
from pathlib import Path

HERE = Path(__file__).resolve().parent
AWK = HERE.parent / 'normalize.awk'
ADB = ['adb', '-s', os.environ.get('F50_ADB_SERIAL', '192.168.0.1:5555')]
BASE = 'proxies:\n  - {name: a, type: direct}\nproxy-groups:\n  - {name: G, type: select, proxies: [a]}\nrules:\n  - MATCH,G\n'

# (name, source, expectation) — expectation: ('ok', must_contain, must_not_contain, summary_subset) | ('err', substring)
CASES = [
    ('basic', BASE, ('ok', ['- MATCH,G'], [], {'proxies': '1', 'groups': '1', 'rules': '1', 'dropped': ''})),
    ('bom_crlf', '\ufeff' + BASE.replace('\n', '\r\n'), ('ok', ['proxies:', '- MATCH,G'], ['\r'], {'rules': '1'})),
    ('doc_start', '---\n' + BASE, ('ok', ['proxies:'], ['---'], {})),
    ('two_docs', BASE + '---\nfoo: 1\n', ('err', '单个 YAML 文档')),
    ('doc_end_then_content', BASE + '...\nlisteners: []\n', ('err', '结束符')),
    ('doc_end_trailing', BASE + '...\n', ('ok', ['- MATCH,G'], [], {})),
    ('strip_header_keys', 'mixed-port: 1234\nallow-lan: false\nexternal-controller: 0.0.0.0:9090\nsecret: x\n'
     'dns:\n  enable: true\n  enhanced-mode: fake-ip\ntun:\n  enable: true\n' + BASE,
     ('ok', ['proxies:'], ['mixed-port', 'external-controller', 'fake-ip', 'tun:', 'secret'],
      {'dropped': 'mixed-port,allow-lan,external-controller,secret,dns,tun'})),
    ('strip_dangerous', 'tunnels:\n  - tcp,0.0.0.0:1080,1.2.3.4:22,DIRECT\nlisteners:\n  - {name: l, type: mixed, port: 1081}\n'
     'iptables:\n  enable: true\nntp:\n  enable: true\n  write-to-system: true\ntuic-server:\n  enable: true\n'
     'external-doh-server: /dns-query\nexperimental: {}\ninterface-name: wlan0\nrouting-mark: 6666\n'
     'external-controller-cors: {allow-origins: ["*"]}\nlan-allowed-ips: [0.0.0.0/0]\nauthentication: ["a:b"]\n' + BASE,
     ('ok', ['- MATCH,G'], ['tunnels', '1081', 'iptables', 'write-to-system', 'tuic', 'doh', 'wlan0', '6666', 'cors', 'a:b'], {})),
    ('merge_key_root', BASE + '<<: {listeners: [{name: x, type: mixed, port: 1}]}\n', ('err', '不支持的顶层')),
    ('explicit_key_root', BASE + '? listeners\n: [{name: x, type: mixed, port: 1}]\n', ('err', '不支持的顶层')),
    ('escaped_quoted_key', BASE + '"list\\u0065ners": [{name: x, type: mixed, port: 1}]\n', ('err', '不支持的顶层')),
    ('alias_root', BASE + '*x\n', ('err', '不支持的顶层')),
    ('anchor_root_line', BASE + '&a listeners: []\n', ('err', '不支持的顶层')),
    ('tag_root', BASE + '!!map\n', ('err', '不支持的顶层')),
    ('flow_root', '{proxies: [], rules: []}\n', ('err', '不支持的顶层')),
    ('directive', '%YAML 1.2\n' + BASE, ('err', '不支持的顶层')),
    ('quoted_keys', '"proxies":\n  - {name: a, type: direct}\n\'rules\':\n  - MATCH,a\n"tun": {enable: true}\n',
     ('ok', ['"proxies":', "'rules':"], ['tun'], {'dropped': 'tun'})),
    ('duplicate_key', BASE + 'rules:\n  - MATCH,DIRECT\n', ('err', '重复')),
    ('duplicate_dropped_key', 'tun: {}\ntun: {}\n' + BASE, ('err', '重复')),
    ('html', '<!DOCTYPE html>\n<html></html>\n', ('err', '网页')),
    ('uri_list', 'vmess://abcdef\nss://xyz\n', ('err', '节点链接')),
    ('base64', 'dm1lc3M6Ly9hYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0NTY3ODlBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWg==\n', ('err', 'Base64')),
    ('empty', '\n\n', ('err', '为空')),
    ('no_rules', 'proxies:\n  - {name: a, type: direct}\n', ('err', '缺少 rules')),
    ('no_proxies', 'rules:\n  - MATCH,DIRECT\n', ('err', '缺少 proxies')),
    ('providers_only', 'proxy-providers:\n  p1:\n    type: http\n    url: http://example.com/s\n    path: ./p1.yaml\n'
     'proxy-groups:\n  - {name: G, type: select, use: [p1]}\nrules:\n  - MATCH,G\n', ('ok', ['proxy-providers:'], [], {'providers': '1', 'proxies': '0'})),
    ('compact_seq', 'proxies:\n- name: a\n  type: direct\n  alpn:\n  - h2\n- name: b\n  type: direct\nrules:\n- MATCH,DIRECT\n- GEOIP,CN,DIRECT\n',
     ('ok', ['- name: b'], [], {'proxies': '2', 'rules': '2', 'geoip': '1'})),
    ('nested_lists', 'proxies:\n  - name: a\n    type: vless\n    alpn:\n      - h2\n      - http/1.1\n  - name: b\n    type: direct\n'
     'rules:\n  # - commented,rule\n  - DOMAIN,x,DIRECT\n  - GEOSITE,cn,DIRECT\n  - MATCH,DIRECT\n',
     ('ok', [], [], {'proxies': '2', 'rules': '3', 'geosite': '1'})),
    ('flow_lists', 'proxies: [{name: a, type: direct}]\nrules: [MATCH,DIRECT]\n', ('ok', ['proxies: [{name: a'], [], {'proxies': '?', 'rules': '?'})),
    ('anchor_template_kept', 'p: &p\n  type: http\n  interval: 3600\nproxy-providers:\n  a:\n    <<: *p\n    url: http://x/y\n'
     'rules:\n  - MATCH,DIRECT\n', ('ok', ['p: &p', '<<: *p'], [], {'dropped': ''})),
    ('unknown_without_anchor_dropped', 'x-note: hello\n' + BASE, ('ok', [], ['x-note'], {'dropped': 'x-note'})),
    ('known_with_anchor_dropped', 'tunnels: &t\n  - tcp,0.0.0.0:1080,1.2.3.4:22,DIRECT\n' + BASE, ('ok', [], ['tunnels'], {'dropped': 'tunnels'})),
    ('keep_tuning', 'unified-delay: true\ntcp-concurrent: true\nglobal-client-fingerprint: chrome\nhosts:\n  a.example: 1.2.3.4\n' + BASE,
     ('ok', ['unified-delay: true', 'hosts:'], ['global-client-fingerprint'], {'dropped': 'global-client-fingerprint'})),
    ('block_scalar', 'proxies:\n  - name: a\n    type: direct\n    note: |\n      line1\n      rules: not-a-key\nrules:\n  - MATCH,DIRECT\n',
     ('ok', ['rules: not-a-key'], [], {'proxies': '1', 'rules': '1'})),
    ('root_comments', '# comment at top\nproxies: # trailing\n  - {name: a, type: direct}\n# between\nrules:\n  - MATCH,DIRECT\n',
     ('ok', ['proxies: # trailing'], [], {'proxies': '1'})),
    ('flow_continuation', 'proxies: [\n  {name: a, type: direct}\n]\nrules:\n  - MATCH,DIRECT\n', ('ok', [']'], [], {})),
    ('plain_text_line', BASE + 'just some text\n', ('err', '不支持的顶层')),
    ('key_with_space_before_colon', 'proxies :\n  - {name: a, type: direct}\nrules:\n  - MATCH,DIRECT\n', ('ok', ['proxies :'], [], {'proxies': '1'})),
    ('tab_after_colon', 'proxies:\t\n  - {name: a, type: direct}\nrules:\n  - MATCH,DIRECT\n', ('ok', [], [], {'proxies': '1'})),
    ('cr_smuggle', 'proxies:\n  - {name: a, type: direct}\rlisteners:\n  - {name: x, type: mixed, port: 1}\nrules:\n  - MATCH,a\n', ('err', '换行字符')),
    ('nel_smuggle', 'proxies:\n  - {name: a, type: direct}\u0085listeners: []\nrules:\n  - MATCH,a\n', ('err', '换行字符')),
    ('ls_smuggle', 'proxies:\n  - {name: a, type: direct} listeners: []\nrules:\n  - MATCH,a\n', ('err', '换行字符')),
    ('ps_smuggle', 'proxies:\n  - {name: a, type: direct} listeners: []\nrules:\n  - MATCH,a\n', ('err', '换行字符')),
    ('crlf_still_ok', 'proxies:\r\n  - {name: a, type: direct}\r\nrules:\r\n  - MATCH,a\r\n', ('ok', ['- MATCH,a'], ['\r'], {'proxies': '1'})),
    ('provider_path_block', 'proxy-providers:\n  p1:\n    type: http\n    url: http://example.com/s\n    path: ./Clash.Core\n    interval: 3600\n'
     'rule-providers:\n  r1:\n    type: http\n    behavior: domain\n    url: http://example.com/r\n    path: "../../sdcard/x.yaml"\n'
     'proxy-groups:\n  - {name: G, type: select, use: [p1]}\nrules:\n  - RULE-SET,r1,G\n  - MATCH,G\n',
     ('ok', ['path: "./providers/proxy1-Clash.Core"', 'path: "./providers/rule2-x.yaml"', 'interval: 3600'], ['./Clash.Core\n', '../../sdcard'], {'providers': '1'})),
    ('provider_path_flow', 'proxy-providers:\n  p1: {type: http, url: "http://e.com/s", path: ./ui/index.html, interval: 60}\n  p2: { type: file, path: \'./geoip.metadb\' }\n'
     'proxy-groups:\n  - {name: G, type: select, use: [p1, p2]}\nrules:\n  - MATCH,G\n',
     ('ok', ['path: "./providers/proxy1-index.html", interval: 60}', "path: \"./providers/proxy2-geoip.metadb\" }"], ['./ui/index.html', "'./geoip.metadb'"], {})),
    ('provider_no_path', 'proxy-providers:\n  p1:\n    type: http\n    url: http://example.com/s\n'
     'proxy-groups:\n  - {name: G, type: select, use: [p1]}\nrules:\n  - MATCH,G\n', ('ok', ['url: http://example.com/s'], ['providers/'], {})),
    ('provider_explicit_key', 'proxy-providers:\n  p1:\n    ? path\n    : ./Clash.Core\nrules:\n  - MATCH,DIRECT\n', ('err', '显式键')),
    ('path_word_in_url_untouched', 'proxy-providers:\n  p1:\n    type: http\n    url: http://example.com/path/x\n    path: p.yaml\n'
     'rules:\n  - MATCH,DIRECT\n', ('ok', ['url: http://example.com/path/x', 'path: "./providers/proxy1-p.yaml"'], [], {})),
    ('geosite_in_inline_provider', 'rule-providers:\n  r1:\n    type: inline\n    behavior: classical\n    payload:\n      - GEOSITE,cn\n'
     'proxies:\n  - {name: a, type: direct}\nrules:\n  - RULE-SET,r1,DIRECT\n  - MATCH,a\n', ('ok', [], [], {'geosite': '1'})),
    ('geosite_comment_ignored', 'proxies:\n  - {name: a, type: direct}\nrules:\n  # - GEOSITE,cn,DIRECT\n  - MATCH,a\n', ('ok', [], [], {'geosite': '0'})),
    ('bypass_capital_path', 'proxy-providers:\n  p1:\n    type: http\n    url: http://e.com/s\n    Path: ./geoip.metadb\nrules:\n  - MATCH,DIRECT\n',
     ('ok', ['Path: "./providers/proxy1-geoip.metadb"'], ['./geoip.metadb\n'], {})),
    ('bypass_PATH_upper_quoted', 'proxies:\n  - {name: a, type: direct}\nrule-providers:\n  r1: {type: http, behavior: domain, url: "http://e.com/r", "PATH": ./config.yaml}\nrules:\n  - MATCH,DIRECT\n',
     ('ok', ['"PATH": "./providers/rule1-config.yaml"'], [' ./config.yaml'], {})),
    ('bypass_escaped_key', 'proxy-providers:\n  p1:\n    type: http\n    url: http://e.com/s\n    "pat\\x68": ./geoip.metadb\nrules:\n  - MATCH,DIRECT\n', ('err', '转义')),
    ('bypass_merge_key', 't: &t\n  path: ./geoip.metadb\nproxy-providers:\n  p1:\n    <<: *t\n    type: http\n    url: http://e.com/s\nrules:\n  - MATCH,DIRECT\n',
     ('ok', ['path: "./providers/tpl1-geoip.metadb"', '<<: *t'], [' ./geoip.metadb'], {})),
    ('bypass_provider_alias', 't: &t {type: http, url: "http://e.com/s", path: ./geoip.metadb}\nproxy-providers:\n  p1: *t\nrules:\n  - MATCH,DIRECT\n',
     ('ok', ['path: "./providers/tpl1-geoip.metadb"}', 'p1: *t'], [' ./geoip.metadb'], {})),
    ('bypass_root_alias', 'proxies:\n  - {name: a, type: direct}\nrp: &rp\n  r1: {type: http, behavior: domain, url: "http://e.com/r", path: ./geoip.metadb}\nrule-providers: *rp\nrules:\n  - MATCH,DIRECT\n',
     ('ok', ['path: "./providers/tpl1-geoip.metadb"}', 'rule-providers: *rp'], [' ./geoip.metadb'], {})),
    ('provider_url_with_star_ok', 'proxy-providers:\n  p1:\n    type: http\n    url: "https://e.com/sub?f=*.yaml"\n    filter: "(?i)HK|*"\nrules:\n  - MATCH,DIRECT\n', ('ok', ['filter: "(?i)HK|*"'], [], {})),
    ('profile_and_geox_dropped', 'profile:\n  store-selected: false\ngeox-url:\n  mmdb: http://evil/x\n' + BASE,
     ('ok', [], ['store-selected', 'evil'], {'dropped': 'profile,geox-url'})),
]


def run_local(src):
    with tempfile.TemporaryDirectory() as d:
        sp, sf = Path(d, 'src.yaml'), Path(d, 'sum')
        sp.write_bytes(src.encode('utf-8'))
        r = subprocess.run(['env', 'LC_ALL=C', 'awk', '-v', 'sumfile=' + str(sf), '-f', str(AWK), str(sp)], capture_output=True)
        summ = sf.read_text(encoding='utf-8') if sf.exists() else ''
        return r.returncode, r.stdout.decode('utf-8', 'replace'), summ, r.stderr.decode()


def run_device(src):
    with tempfile.TemporaryDirectory() as d:
        sp = Path(d, 'src.yaml'); sp.write_bytes(src.encode('utf-8'))
        subprocess.run(ADB + ['push', str(sp), '/data/local/tmp/mmn.src'], capture_output=True, check=True)
    cmd = ('LC_ALL=C awk -v sumfile=/data/local/tmp/mmn.sum -f /data/local/tmp/mmn.awk /data/local/tmp/mmn.src > /data/local/tmp/mmn.out; '
           'echo "__RC=$?"; cat /data/local/tmp/mmn.out; echo "__SUM"; cat /data/local/tmp/mmn.sum 2>/dev/null; rm -f /data/local/tmp/mmn.sum /data/local/tmp/mmn.out')
    out = subprocess.run(ADB + ['shell', cmd], capture_output=True).stdout.decode('utf-8', 'replace')
    head, _, rest = out.partition('\n')
    rc = int(head.replace('__RC=', '').strip())
    body, _, summ = rest.partition('__SUM\n')
    return rc, body, summ, ''


def check(name, runner, src, exp):
    rc, out, summ, stderr = runner(src)
    s = dict(l[1:].split('=', 1) for l in summ.splitlines() if l.startswith('@') and '=' in l)
    if exp[0] == 'err':
        ok = rc == 2 and exp[1] in s.get('error', '')
        why = 'rc=%s error=%r' % (rc, s.get('error'))
    else:
        _, must, mustnot, subset = exp
        problems = []
        if rc != 0: problems.append('rc=%s err=%r %s' % (rc, s.get('error'), stderr))
        problems += ['missing %r' % m for m in must if m not in out]
        problems += ['unexpected %r' % m for m in mustnot if m in out]
        problems += ['summary %s=%r want %r' % (k, s.get(k), v) for k, v in subset.items() if s.get(k) != v]
        ok, why = not problems, '; '.join(problems)
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else ' :: ' + why))
    return ok


def main():
    runners = [('local-awk', run_local)]
    if '--device' in sys.argv:
        subprocess.run(ADB + ['push', str(AWK), '/data/local/tmp/mmn.awk'], capture_output=True, check=True)
        runners.append(('f50-awk', run_device))
    failed = 0
    for label, runner in runners:
        print('== ' + label)
        for name, src, exp in CASES:
            failed += not check(name, runner, src, exp)
    if '--device' in sys.argv:
        subprocess.run(ADB + ['shell', 'rm -f /data/local/tmp/mmn.awk /data/local/tmp/mmn.src'], capture_output=True)
    print('FAILED: %d' % failed if failed else 'ALL PASS')
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
