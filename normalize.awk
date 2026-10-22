# 猫猫 TProxy — source config filter (device side; BWK awk compatible).
#
# Reads a Clash/Mihomo YAML source and prints only the root sections that are
# safe to combine with the plugin-owned header (ports, controller, DNS, TUN,
# sniffer ...). This is an allowlist over root keys, not a YAML parser:
#   * only block-style root mappings are accepted; any other column-0 syntax
#     (merge keys "<<", explicit keys "?", anchors/aliases/tags/flow at root,
#     directives, further documents) is rejected, so stripped keys cannot be
#     re-introduced through YAML features;
#   * mihomo root keys outside KEEP are dropped;
#   * unknown root keys are dropped unless they carry anchors (templates);
#   * CR, NEL, LS and PS inside a line are rejected: YAML treats them as line breaks but awk does
#     not, so they could hide a root key from this filter (keep this check);
#   * provider "path:" values are rewritten into ./providers/, so a provider cannot overwrite other
#     files in the core's home directory.
# The plugin header additionally defines every root key that is dropped here, so a key that
# slipped through would be a duplicate key and fail mihomo's own `-t` check.
#
# Usage: LC_ALL=C awk -v sumfile=FILE -f normalize.awk SOURCE > BODY
# Writes "@key=value" summary lines to sumfile; on error writes "@error=..."
# and exits 2.

BEGIN {
    split("proxies proxy-groups proxy-providers rules rule-providers sub-rules hosts " \
          "unified-delay tcp-concurrent global-ua etag-support " \
          "keep-alive-idle keep-alive-interval disable-keep-alive geosite-matcher clash-for-android", t, " ")
    for (i in t) keep[t[i]] = 1
    # mihomo v1.19 RawConfig root keys (config/config.go). Listed keys outside
    # KEEP are owned by the plugin header or are unsafe on a router.
    split("port socks-port redir-port tproxy-port mixed-port ss-config vmess-config inbound-tfo " \
          "inbound-mptcp authentication skip-auth-prefixes lan-allowed-ips lan-disallowed-ips allow-lan " \
          "bind-address mode unified-delay log-level ipv6 external-controller " \
          "external-controller-routing-mark external-controller-pipe external-controller-unix " \
          "external-controller-tls external-controller-cors external-ui external-ui-url external-ui-name " \
          "external-doh-server secret interface-name routing-mark tunnels geo-auto-update " \
          "geo-update-interval geodata-mode geodata-loader geosite-matcher tcp-concurrent " \
          "find-process-mode global-client-fingerprint global-ua etag-support keep-alive-idle " \
          "keep-alive-interval disable-keep-alive proxy-providers rule-providers proxies proxy-groups " \
          "rules sub-rules listeners hosts dns ntp tun tuic-server iptables experimental profile " \
          "geox-url sniffer tls clash-for-android", t, " ")
    for (i in t) known[t[i]] = 1
    n = 0; nsec = 0; err = ""; started = 0; ended = 0; nonblank = 0
}

function fail(msg) { if (err == "") err = msg }

# Last path component reduced to safe characters.
function safe_name(v,    n, parts, b) {
    gsub(/["']/, "", v)
    sub(/[ \t]+$/, "", v)
    n = split(v, parts, "/")
    b = parts[n]
    gsub(/[^A-Za-z0-9._-]/, "", b)
    sub(/^\.+/, "", b)
    if (b == "") b = "data"
    return substr(b, 1, 48)
}

# Rewrite every "path:" value on a provider line to ./providers/<kind><n>-<name>.
function provider_paths(line, kind,    out, rest, c, q, vlen, val) {
    out = ""
    while (match(line, /(^|[{, \t])(["']?[Pp][Aa][Tt][Hh]["']?)[ \t]*:[ \t]*/)) {
        out = out substr(line, 1, RSTART + RLENGTH - 1)
        rest = substr(line, RSTART + RLENGTH)
        c = substr(rest, 1, 1)
        if (c == "\"" || c == "'") {
            q = index(substr(rest, 2), c)
            vlen = (q > 0) ? q + 1 : length(rest)
        } else if (match(rest, /[,}#]/)) {
            vlen = RSTART - 1
        } else {
            vlen = length(rest)
        }
        val = substr(rest, 1, vlen)
        npaths++
        out = out "\"./providers/" kind npaths "-" safe_name(val) "\""
        if (c != "\"" && c != "'" && vlen > 0 && substr(rest, vlen, 1) ~ /[ \t]/) out = out " "
        line = substr(rest, vlen + 1)
    }
    return out line
}

# Root key of a column-0 line, or "" when the line is not a simple "key:" line.
function rootkey(line,    k) {
    if (match(line, /^[A-Za-z_][A-Za-z0-9_.-]*[ \t]*:([ \t]|$)/)) {
        k = substr(line, 1, RLENGTH); sub(/[ \t]*:[ \t]*$/, "", k); return k
    }
    if (match(line, /^"[A-Za-z_][A-Za-z0-9_.-]*"[ \t]*:([ \t]|$)/) ||
        match(line, /^'[A-Za-z_][A-Za-z0-9_.-]*'[ \t]*:([ \t]|$)/)) {
        k = substr(line, 2, RLENGTH - 1); sub(/["'][ \t]*:[ \t]*$/, "", k); return k
    }
    return ""
}

{
    line = $0
    if (NR == 1) sub(/^\357\273\277/, "", line)
    sub(/\r$/, "", line)
    if (err != "") next
    if (line ~ /\r/ || index(line, "\302\205") || index(line, "\342\200\250") || index(line, "\342\200\251")) {
        fail("第 " NR " 行：含有不支持的换行字符（CR/NEL/LS/PS）"); next
    }
    if (line ~ /^[ \t]*$/) { lines[++n] = line; next }
    nonblank++
    if (nonblank == 1) {
        if (line ~ /^[ \t]*</) { fail("订阅返回了网页（HTML），不是 Clash/Mihomo 配置"); next }
        if (line ~ /^[ \t]*(vmess|vless|ss|ssr|trojan|hysteria2?|hy2|tuic|anytls|wireguard|socks5?|https?):\/\//) {
            fail("内容是节点链接列表，不是 Clash/Mihomo YAML；请使用 Clash 订阅链接（可将 UA 设为 clash.meta）"); next
        }
        if (line ~ /^[A-Za-z0-9+\/_-]+=*[ \t]*$/ && length(line) >= 64) {
            fail("内容是 Base64 节点列表，不是 Clash/Mihomo YAML；请使用 Clash 订阅链接（可将 UA 设为 clash.meta）"); next
        }
    }
    if (ended) { fail("第 " NR " 行：YAML 文档结束符 ... 之后仍有内容"); next }
    if (line ~ /^[ \t#]/ || line ~ /^-([ \t]|$)/ || line ~ /^[\]},]/) { lines[++n] = line; next }
    if (line ~ /^---([ \t]|$)/) {
        if (started) { fail("第 " NR " 行：仅支持单个 YAML 文档"); next }
        started = 1; next
    }
    if (line ~ /^\.\.\.([ \t]|$)/) { ended = 1; next }
    k = rootkey(line)
    if (k == "") { fail("第 " NR " 行：不支持的顶层 YAML 语法（如 <<、?、&、*、!、{ 或无冒号文本）"); next }
    if (k in seen) { fail("顶层键重复：" k); next }
    seen[k] = 1; started = 1
    sec_end[nsec] = n
    nsec++; sec_key[nsec] = k; sec_start[nsec] = n + 1
    lines[++n] = line
}

END {
    if (err == "" && nonblank == 0) fail("配置为空")
    if (err == "" && !("proxies" in seen) && !("proxy-providers" in seen))
        fail("配置缺少 proxies 或 proxy-providers")
    if (err == "" && !("rules" in seen)) fail("配置缺少 rules")
    if (err != "") { print "@error=" err > sumfile; exit 2 }
    sec_end[nsec] = n
    dropped = ""
    for (s = 1; s <= nsec; s++) {
        k = sec_key[s]; out = 0
        if (k in keep) out = 1
        else if (!(k in known)) {
            for (i = sec_start[s]; i <= sec_end[s]; i++)
                if (lines[i] ~ /(^|[ \t:,\[{-])&[A-Za-z0-9_-]+/) { out = 1; break }
        }
        if (!out) { dropped = dropped (dropped == "" ? "" : ",") k; continue }
        # Provider sections and anchored templates (which providers may merge or alias) get their
        # "path:" values confined; constructs that would hide a key from that rewrite are refused.
        kind = (k == "proxy-providers") ? "proxy" : (k == "rule-providers") ? "rule" : (!(k in known)) ? "tpl" : ""
        for (i = sec_start[s]; i <= sec_end[s]; i++) {
            if (kind != "") {
                pl = lines[i]
                if (pl ~ /^[ \t]*\?([ \t]|$)/) { print "@error=" k " 中不支持显式键（?）语法" > sumfile; exit 2 }
                if (pl ~ /["'][^"']*\\[^"']*["'][ \t]*:/) { print "@error=" k " 中不支持含转义字符的键" > sumfile; exit 2 }
                lines[i] = provider_paths(lines[i], kind)
            }
            print lines[i]
            if (k == "proxies" || k == "proxy-groups" || k == "rules") {
                if (match(lines[i], /^[ ]*-([ \t]|$)/)) {
                    ind = RLENGTH - 1
                    if (!((k, "min") in cnt) || ind < cnt[k, "min"]) { cnt[k, "min"] = ind; cnt[k] = 0 }
                    if (ind == cnt[k, "min"]) cnt[k]++
                }
            }
            # Geodata needs anywhere in the kept body (rules, sub-rules, inline rule-provider payloads,
            # anchored rule templates); a false positive only means an extra download.
            if (lines[i] !~ /^[ \t]*#/) {
                u = toupper(lines[i])
                if (u ~ /GEOSITE[ \t]*,/) geosite = 1
                if (u ~ /GEOIP[ \t]*,/) geoip = 1
                if (u ~ /IP-ASN[ \t]*,/) asn = 1
            }
        }
    }
    print "@proxies=" (("proxies" in cnt) ? cnt["proxies"] : (("proxies" in seen) ? "?" : 0)) > sumfile
    print "@groups=" (("proxy-groups" in cnt) ? cnt["proxy-groups"] : (("proxy-groups" in seen) ? "?" : 0)) > sumfile
    print "@rules=" (("rules" in cnt) ? cnt["rules"] : "?") > sumfile
    print "@providers=" (("proxy-providers" in seen) ? 1 : 0) > sumfile
    print "@rule_providers=" (("rule-providers" in seen) ? 1 : 0) > sumfile
    print "@geosite=" (geosite ? 1 : 0) > sumfile
    print "@geoip=" (geoip ? 1 : 0) > sumfile
    print "@asn=" (asn ? 1 : 0) > sumfile
    print "@dropped=" dropped > sumfile
}
