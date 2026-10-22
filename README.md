# 猫猫 TProxy Plus

基于原版 **`猫猫_TProxy_1.2.js`** 独立改进的增强版，面向 **UFI-TOOLS 完整版**。首个正式版本 **v1.0.0**。

**[下载插件（Releases）](https://github.com/miofelix/maomao-tproxy-plus/releases/latest)** · [SHA-256 校验值](https://github.com/miofelix/maomao-tproxy-plus/releases/latest/download/SHA256SUMS)

## 功能

- IPv4 / IPv6、TCP / UDP 透明代理，支持按设备和端口分流。
- 多订阅管理、定时更新、配置上传与热重载。
- 内置面板、节点切换、延迟测试、日志和连通性诊断。
- 开机自启、崩溃恢复、SHA-256 安装校验和失败回滚。
- 保留设备 / AdGuard Home 的局域网 DNS，支持与 Tailscale 共存。

## 安装使用

1. 在 Releases 页面下载 `maomao-tproxy-plus.js` 文件。
2. 进入 **UFI-TOOLS 后台的「插件」功能**，导入下载的 `.js` 文件，启用并保存，然后刷新后台页面。
3. 展开「猫猫 TProxy Plus」卡片，选择「手动上传内核」。按窗口提供的链接，在电脑或手机上下载 Android arm64-v8 内核；首次安装同时下载 GeoIP 数据。
4. 上传内核和所需 GeoIP，点击「校验并安装」。随后在「订阅管理」中添加并选用 Clash / Mihomo YAML 订阅，或上传 YAML 配置。
5. 点击「启动」，按需开启「开机自启」，通过「连通性测试」检查网络。

## 注意

- 已在 **ZTE F50** 实机验证；其他满足 Android arm64、`br0` 接口、root 和 TPROXY 等运行条件的设备理论适用，尚未测试。
- 插件不含内核和数据库。推荐手动上传，避免设备直接下载 GitHub 文件时的网络问题。
- 订阅需返回 Clash / Mihomo YAML，不能直接使用 Base64 节点列表。端口、DNS 等运行设置由插件统一管理。
- 避免同时启用多个猫猫版本。

## 开发与文档

构建插件：`python3 build-plugin.py`。运行离线检查：`npm ci`，然后 `npm test`。

[详细设计与命令](docs/SPEC.md) · [验证记录](docs/VERIFICATION.md) · [第三方说明](THIRD_PARTY_NOTICES.md)

基于 [UFI-TOOLS](https://github.com/kanoqwq/UFI-TOOLS) 生态，感谢 Minikano 及相关开源项目。源码遵循 [MIT License](LICENSE)。
