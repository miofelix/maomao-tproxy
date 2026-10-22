"""Build the standalone UFI-TOOLS plugin, or verify its local build artifact.

UFI-TOOLS parses the wrapper as HTML before running its script, so embedded
payloads must escape '<'.
"""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

BASE = Path(__file__).resolve().parent
FILENAME = 'maomao-tproxy-plus.js'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Verify output without writing files')
    parser.add_argument('--output', type=Path, default=BASE / 'dist' / FILENAME,
                        help='Output plugin path (default: dist/maomao-tproxy-plus.js)')
    args = parser.parse_args()
    service = (BASE / 'Clash.Service').read_text(encoding='utf-8')
    normalizer = (BASE / 'normalize.awk').read_text(encoding='utf-8')
    dashboard = (BASE / 'dashboard.html').read_text(encoding='utf-8')
    template = (BASE / 'plugin-main.template.js').read_text(encoding='utf-8')

    scripts = re.findall(r'<script\b[^>]*>([\s\S]*?)</script\s*>', dashboard, re.I)
    if len(scripts) != 1:
        sys.exit('dashboard must contain exactly one inline script')
    dashboard_hash = base64.b64encode(hashlib.sha256(scripts[0].encode()).digest()).decode()
    if "'sha256-" + dashboard_hash + "'" not in dashboard:
        sys.exit('dashboard CSP hash does not match its script; recompute it before building')

    def syntax_check(source, label):
        try:
            check = subprocess.run(['node', '--check', '-'], input=source, text=True, capture_output=True)
        except FileNotFoundError:
            sys.exit('Node.js is required to validate the plugin and dashboard JavaScript')
        if check.returncode:
            sys.exit(label + ' JavaScript syntax error:\n' + check.stderr)

    syntax_check(scripts[0], 'Dashboard')

    def var(name):
        match = re.search(r'^' + re.escape(name) + r'=(\S+)$', service, re.M)
        if not match:
            sys.exit('Missing service constant: ' + name)
        return match.group(1)

    version = var('SERVICE_VERSION')
    release_version = json.loads((BASE / 'package.json').read_text(encoding='utf-8'))['version']
    pinned = {
        'tag': var('PINNED_TAG'), 'coreUrl': var('PINNED_CORE_URL'), 'coreSha': var('PINNED_CORE_SHA'),
        'coreRawSha': var('PINNED_CORE_RAW_SHA'), 'geoUrl': var('PINNED_GEO_URL'), 'geoSha': var('PINNED_GEO_SHA'),
        'releasesUrl': 'https://github.com/MetaCubeX/mihomo/releases',
    }

    def js(value):
        return (json.dumps(value, ensure_ascii=False).replace('<', '\\u003c')
                .replace('\u2028', '\\u2028').replace('\u2029', '\\u2029'))

    source = template
    for key, value in [('__VERSION_JSON__', version), ('__RELEASE_VERSION_JSON__', release_version),
                       ('__PINNED_JSON__', pinned),
                       ('__SERVICE_JSON__', service), ('__NORMALIZER_JSON__', normalizer),
                       ('__DASHBOARD_JSON__', dashboard)]:
        if source.count(key) != 1:
            sys.exit('placeholder %s must occur exactly once' % key)
        source = source.replace(key, js(value))

    if not source.startswith('//<script>\n') or not source.rstrip().endswith('//</script>'):
        sys.exit('plugin must be wrapped in //<script> ... //</script>')
    body = source[source.index('\n') + 1:source.rindex('//</script>')]
    for bad in ('</script', '<script', '<!--', '[KANO_PLUGIN_'):
        if bad.lower() in body.lower():
            sys.exit('plugin body contains forbidden sequence %r' % bad)
    syntax_check(body, 'Plugin')
    data = source.encode('utf-8')
    digest = hashlib.sha256(data).hexdigest()
    checksum = digest + '  ' + args.output.name + '\n'
    sums = args.output.parent / 'SHA256SUMS'
    if args.check:
        if not args.output.is_file() or args.output.read_bytes() != data:
            sys.exit('Plugin artifact is stale or missing; run python3 build-plugin.py')
        if not sums.is_file() or sums.read_text(encoding='utf-8') != checksum:
            sys.exit('SHA256SUMS is stale or missing; run python3 build-plugin.py')
        print('Verified: %s (%d bytes, service %s)' % (args.output, len(data), version))
    else:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_bytes(data)
        sums.write_text(checksum, encoding='utf-8')
        print('Built: %s (%d bytes, service %s)' % (args.output, len(data), version))
    print('SHA-256: ' + digest)


if __name__ == '__main__':
    main()
