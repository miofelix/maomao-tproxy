# 第三方来源说明

## UFI-TOOLS

- 项目：https://github.com/kanoqwq/UFI-TOOLS
- 来源提交：`925bb63dfa25bf103527d8d8c1951e3746d2a88d`
- 原文件：`app/frontEnd/public/script/utils.js`
- 仓库快照：`tests/fixtures/ufi-utils.js`
- 用途：离线 UI 测试中执行宿主真实的提示、折叠等辅助函数。
- 许可：MIT；以下原版权声明与许可对应 `tests/fixtures/ufi-utils.js`。该测试文件的署名不表示 UFI-TOOLS 作者共同拥有本项目独立代码的版权。独立代码的许可见根目录 `LICENSE`。

```text
MIT License

Copyright (c) [2025] [Minikano]

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE
```

插件沿用 UFI-TOOLS 的插件包装和公开页面接口。`kano` / `kano-mm-tproxy` 等名称用于宿主兼容，保留最终版本的既有标识。

## 开发依赖

`jsdom` 固定为 `26.1.0`，仅用于离线 UI 测试。依赖与精确版本记录在 `package-lock.json` 中，各自许可随 npm 包提供。

## 运行时下载组件

Mihomo、meta-rules-dat 和可选 MetaCubeXD 从各自上游单独下载，源码或二进制未打包进入本仓库的插件。

- Mihomo：https://github.com/MetaCubeX/mihomo
- meta-rules-dat：https://github.com/MetaCubeX/meta-rules-dat
- MetaCubeXD：https://github.com/MetaCubeX/metacubexd

各组件遵循其上游许可；本仓库 MIT 许可适用于本仓库发布的源码。
