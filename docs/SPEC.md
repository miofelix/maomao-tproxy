# 猫猫 TProxy Plus — implementation spec

Release assets: `maomao-tproxy-plus.js` and `SHA256SUMS` on [GitHub Releases](https://github.com/miofelix/maomao-tproxy-plus/releases/latest)
(service version **2.0.0**). Run `python3 build-plugin.py` from the repository root to build local
copies under `dist/`; this directory is ignored by Git. `python3 build-plugin.py --check` verifies
that the local output matches the sources. `npm test` builds the output first, so a fresh clone
needs no prebuilt artifact.
UFI-TOOLS keys each custom-head block by the imported file name. When upgrading an existing
猫猫 plugin, replace that entry’s content or disable it before importing the standalone artifact.

## 0. Principles
- Device-side logic lives in shell (`Clash.Service`) + awk (`normalize.awk`) so it is testable on the
  device without a browser and can run unattended (scheduled subscription update, crash restart, boot).
- The browser plugin is UI + orchestration: few root round trips (`info` = 1 call), uploads, dialogs.
- Every mutating device operation: validate first, back up, swap atomically, verify, roll back on failure.
- Never break coexisting services: AGH DNS (nat PREROUTING :53 → 8858), Tailscale (table 52, fwmark
  0x80000/0xff0000, rule 5270), cloudflared, sshd, other plugins, UFI-TOOLS boot-time INPUT rules.
- Backward compatible with the v1 runtime files (same pid/identity/session/owner paths, same chain names,
  table 20251, pref 1100, mark 0x20000000/0x20000000, owner tag `ufi-f50-tproxy-v1`), so v2 can stop/clean
  a core started by v1 and an install can upgrade a running v1 in place.

## 1. Device layout (root:root; dirs 700, files 600, executables 700)
```
/data/clash/
  Scripts/Clash.Service        service v2 (SERVICE_VERSION=2.0.0)
  Scripts/normalize.awk        config normalizer (device side, single source of truth)
  Proxy/Clash.Core             Mihomo core
  Proxy/source.yaml            raw source of the active config (subscription body / uploaded / edited)
  Proxy/config.yaml            generated = header(settings) + body(source minus replaced keys)
  home/                        isolated Mihomo -d directory; writable cache.db and providers/
    geoip.metadb               GeoIP (mmdb); immutable outside updates
    GeoSite.dat                optional, when a config uses GEOSITE
    ASN.mmdb                   optional, when a config uses IP-ASN
    ui/index.html              built-in dashboard; protected outside updates
    ui/xd/                     optional MetaCubeXD dashboard
  settings.env                 KEY=VALUE settings (§2), validated on every read, never sourced
  subs/<id>.url|.name|.meta|.yaml   subscriptions (§5)
  controller.secret            48 hex
  mihomo.pid mihomo.identity mihomo.session mihomo-watch.pid mihomo-watch.identity tproxy.owner (v1-compatible)
  state/core.version           cached first line of `Clash.Core -v`
  state/last_error state/restarts state/addr.fp state/sub.next state/source.origin state/want
  mihomo.log (+ mihomo.log.1)  bounded by MM_LOG_MAX_KB
  jobs/<job>.{log,rc}          detached jobs; prune each to newest 12 before launch
  backups/update.<stamp>/      previous core/service/awk/config/source via hard links; immutable geoip/ui via copies; keep 3
  backups/config.<stamp>.yaml  keep 10;  backups/boot.<stamp>.sh keep 5
```

## 2. settings.env
Lines `KEY=VALUE`, no quotes, never sourced. Unknown keys are ignored and invalid stored values fall back
to defaults. The settings command validates new values before changing files; the browser trims inputs
and rejects newlines. Written via `Clash.Service settings <staged-file>`.

| key | allowed | default | effect |
|---|---|---|---|
| MM_GUARD_TS | 0/1 | 1 | allow tailscale0 through the guard |
| MM_IPV6 | 0/1 | 1 | IPv6 TPROXY hook + mihomo `ipv6` |
| MM_UDP | 0/1 | 1 | UDP TPROXY |
| MM_QUIC_BLOCK | 0/1 | 0 | DROP UDP 443 in the diversion chain after bypass/device rules |
| MM_DEV_MODE | all/bypass/only | all | per-device policy for LAN clients |
| MM_DEV_LIST | comma list of `xx:xx:xx:xx:xx:xx` (lowercase) or IPv4 `a.b.c.d[/n]`, max 64 | empty | |
| MM_BYPASS_PORTS | comma list of 1..65535, max 16; excludes 53/7788/7890/7893 | 123,853 | TCP/UDP destination ports kept direct |
| MM_MODE | rule/global/direct | rule | mihomo `mode` written into config |
| MM_LOG_LEVEL | silent/error/warning/info/debug | warning | mihomo `log-level` |
| MM_LOG_MAX_KB | 128..16384 | 1024 | rotation threshold |
| MM_SNIFF | 0/1 | 1 | sniffer |
| MM_AUTO_RESTART | 0/1 | 1 | watchdog restarts a crashed core (max 3 per 10 min, backoff) |
| MM_SUB_ACTIVE | `[a-z0-9]{1,16}` or empty | empty | subscription whose body is the active source |
| MM_SUB_INTERVAL | 0/6/12/24/48/72 | 0 | hours between automatic updates of the active subscription |
| MM_SUB_UA | `[A-Za-z0-9._/()+ -]{1,64}` | clash.meta | User-Agent for subscription downloads |
| MM_DL_VIA | auto/direct/proxy | auto | auto: direct first, then local proxy when running; proxy: proxy first, then direct |
| MM_GH_MIRROR | empty or `https://host[/path]/` | empty | prefix for GitHub downloads (SHA-256 pinned, so safe) |
| MM_DNS | up to 4 comma-separated IPv4/IPv6, TLS, HTTPS or QUIC resolver addresses | 223.5.5.5,119.29.29.29 | core DNS only; LAN DNS stays with F50 / AGH |
| MM_MEMLIMIT | 0 or 64..512 | 128 | Go soft memory limit in MiB; restart needed |

The INPUT guard is always enabled; the old `MM_GUARD` setting is ignored. `MM_SUB_ACTIVE` is changed
by subscription/manual-config commands, not by the settings form.

## 3. Service CLI (`Clash.Service <cmd>`)
Machine lines start with `@key=value`; human lines otherwise; errors print `ERROR: …` and exit non-zero.
Configuration and lifecycle commits hold `service.lock` (fd 9, closed in detached processes). Long downloads
and validation run before that lock; background jobs also serialize with `jobs.lock`. `status`/`info`/`live`/`version`
are lock-free; `info`/`live` may launch a detached repair if stale interception or a missing watchdog is detected.

| cmd | behaviour |
|---|---|
| `version` | `@service_version=2.0.0` |
| `status` | `RUNNING PID=n` exit 0 when core, network hooks and watchdog are healthy; otherwise `STOPPED` exit 1 |
| `info` | full card snapshot: version, busy, core/process/network/watchdog state, config/source/origin, core/GeoIP/XD versions, autostart, validated MM_* settings, redacted error and active subscription metadata |
| `live` | lightweight polling snapshot: process health, controller mode, connection count, cumulative traffic, active subscription usage and current time |
| `start` / `stop` / `restart` | as v1 + guard + atomic chains (§4); `restart` = stop && start |
| `apply <raw> <origin>` | origin `manual` or `sub:<id>`: normalize → `-t` → backup → swap config+source → reload/restart if running → rollback on failure; prints `@proxies @groups @rules` |
| `apply-upload <upload>` / `check <raw>` | consume and apply a manual uploaded config / validate without applying |
| `regen` | re-apply `source.yaml` with current settings |
| `settings <staged>` | validate + install settings; regen if config keys changed; net-refresh if network keys changed and running |
| `net-refresh` | rebuild chains/guard atomically (also used by the watchdog when addresses change) |
| `settings-get` / `mode rule\|global\|direct` | read validated settings / persist mode and PATCH the running controller |
| `sub-save <id> <url-file> [name-file]` / `sub-delete <id>` / `sub-list` / `sub-url <id>` | subscription CRUD (`sub-list` masks URLs) |
| `sub-use <id>` / `sub-update <id\|active\|due\|all>` | activate a validated subscription / download and save raw+metadata; apply when active |
| `autostart on\|off` | manage the boot line (backup boot file, keep 5) |
| `install …` | run from the staged new service: verify inputs, back up under lock, swap, verify and roll back; copy protected assets and hardlink other components; keep core running for compatible updates, restart when core/controller/home changes |
| `core-latest` | GitHub releases API → `@tag @url @sha` for `mihomo-android-arm64-v8-*.gz` (asset digest) |
| `geo-update` / `dashboard-install pinned\|latest` | update required geodata / install the optional MetaCubeXD dashboard |
| `cleanup` | remove leaked jobs/staged files/debug traces/stale ui dir; prune backups; `@freed_kb` |
| `diag` | redacted diagnostics |
| `source-get` / `config-get` / `secret` / `api METHOD PATH [json]` | source / generated config with secret redacted / secret for browser panel / controller request via root curl |
| `log [lines]` / `log-clear` / `connectivity` / `uninstall [--purge]` | log tools / direct and proxy probes / uninstall |
| `job <id> <command…>` / `job-status <id> [wait-seconds]` | detached operation and result polling |
| `boot` | detached: wait for br0 and a sane clock (≤180 s), then up to 3 start attempts with 20 s waits |
| `watch …` | internal watchdog |

## 4. Firewall / routing
- mangle `UFI_MM_TPROXY4/6` built with `iptables-restore -w 5 --noflush` (atomic, one call per family):
  local addresses RETURN, socket fast path (`-p tcp -m socket --transparent -j MARK` + marked RETURN),
  tailscale mark RETURN, reserved CIDRs RETURN, tailscale routes RETURN, dport 53 and configured bypass
  ports RETURN, device policy, then `UFI_MM_DIVERT4/6` (optional UDP 443 DROP, TPROXY tcp [+udp] → 7893
  mark 0x20000000/0x20000000).
- filter `UFI_MM_GUARD4/6` inserted at INPUT 1 (UFI-TOOLS appends its own INPUT rules at boot): RETURN for
  lo/br0/(tailscale0); DROP tcp+udp 7890, 7893; tcp 7788.
- Guard installed before the core starts listening; removed after the core stops; watchdog removes TPROXY
  hooks/routes on crash (direct connectivity restored), then optionally restarts.
- Watchdog re-syncs local addresses / tailscale routes / br0 IPv6 prefixes when their fingerprint changes.

## 5. Subscriptions
`subs/<id>.url` (URL), `.name` (display name ≤32 chars), `.meta` (`updated=<epoch>` `status=ok|error`
`error=<msg>` `userinfo=<subscription-userinfo header>` `bytes=<n>`), `.yaml` (last good raw body).
Download: curl permits HTTP/HTTPS, prevents HTTPS-to-HTTP redirects, limits decoded output to 4 MiB,
uses `--compressed`, `-A "$MM_SUB_UA"` and `-D headers`, direct first then proxy when running (auto).
Base64/URI node lists are rejected with
a clear message (suggest a Clash subscription link / different UA).

## 6. Plugin UI (browser)
Collapsible card (collapseGen, persisted) with: status strip (state, version, uptime, memory, mode switch,
main group node select + delay test, traffic rate, connections, subscription usage/expiry), grouped buttons
(运行 / 配置 / 内核 / 工具), dialogs: 订阅管理, 设置, 编辑配置 (source.yaml), 日志 (auto-refresh, auto-scroll,
level filter, clear, download), 诊断, 连通性测试, 内核更新 (online check + manual upload), 存储清理, confirm.
The plugin uses root service commands and root curl for controller requests. Polling runs every 5 s only
while the card is open and the page is visible, with backoff on errors. The self-contained panel runs
at `http://<host>:7788/ui/`; “打开面板” passes the secret in the hash, which the panel immediately removes.
The embedded panel receives the 48-hex secret through a message from its parent window and validates
the exact HTTP parent origin declared in its fragment (legacy same-hostname URLs remain supported).
It rejects other sources/origins and malformed secrets. Secrets stay
in JS memory/sessionStorage, never query strings. HTTPS host pages show a link instead of embedding HTTP.

## 7. Built-in dashboard
Self-contained HTML (<46 KiB): overview (version, mode, traffic/memory streams, connection count), groups with
per-node latency and group delay tests, searchable rules, connections (close one/all), bounded logs stream,
and proxy/rule-provider updates. Connections show at most 300 rows, rules 500 rows, and logs 500 lines.
Overview connection snapshots adapt from 5 to 30 s by connection count; connection-tab snapshots use 2 s.
Streams/polling stop when their tab/page is hidden or the iframe leaves view. Mode changes in this panel
are temporary; changes in the plugin persist. Controller strings render as text. A CSP pins the inline
script by SHA-256, so any script edit must update the CSP hash before building. The build verifies the
dashboard script syntax and CSP hash and refuses stale hashes; it does not recalculate them.

## 8. Configuration boundaries
`normalize.awk` accepts a single block-style root mapping and keeps routing/proxy/provider data plus
selected connection options. It rejects root merges/aliases/tags/flow syntax, duplicate keys and alternate
line separators; unrecognized root sections are dropped except anchored templates. Provider paths are
rewritten into isolated `home/providers/` paths. The service owns ports/listeners, controller/secret/CORS,
DNS, sniffing, TUN, profile, geodata download URLs and router-sensitive settings, then validates the result
with Mihomo `-t` before applying it. GEOSITE and ASN databases are obtained only when required; the core
cannot auto-download missing geodata or overwrite the protected dashboard/data files.
