# wechat-agent-bridge

[English](README.en.md) | 简体中文

一个实验性的本地微信桥，让你可以直接在微信里使用 Codex 或 Claude Code，并通过 `/codex`、`/claude-code` 随时切换后端。

> [!WARNING]
> 默认配置会跳过 Codex 和 Claude Code 的交互式权限确认。桥接收到的消息可能以你的本地用户身份执行命令并访问文件。请保持发送者白名单开启、使用独立工作目录，并且只在你信任的电脑和微信账号上运行。

本项目不使用 OpenClaw 作为 Agent 运行时，只复现 `@tencent-weixin/openclaw-weixin` 所记录的一小部分 HTTP API：

- 扫码登录：`get_bot_qrcode` / `get_qrcode_status`
- 接收消息：`ilink/bot/getupdates`
- 发送文本：`ilink/bot/sendmessage`

目前支持文本私聊和发送图片；暂不支持理解收到的图片、文件或语音。

## 环境要求

- Node.js 22+
- 已安装并登录 `codex` 和/或 `claude` CLI

## 安装

```bash
npm install
```

## 登录微信

```bash
npm run login
```

使用微信扫描终端二维码。凭据默认保存在：

```text
~/.wechat-agent-bridge
```

可以通过 `WECHAT_BRIDGE_STATE_DIR` 修改状态目录。旧版本用户会继续使用 `~/.weixin-codex-bridge`，已有登录凭据不会丢失。

## 运行

```bash
npm run run
```

默认只处理扫码登录时返回的微信 `userId` 发来的消息。

常用环境变量：

```bash
WECHAT_BRIDGE_CWD=/path/to/workspace
WECHAT_BRIDGE_ALLOW_FROM=user1@im.wechat,user2@im.wechat
WECHAT_BRIDGE_ALLOW_ALL=1
WECHAT_BRIDGE_TIMEOUT_MS=600000
WECHAT_BRIDGE_PROGRESS_DELAY_MS=2500
WECHAT_BRIDGE_PROGRESS_TEXT='收到，正在处理...'
WECHAT_BRIDGE_DEFAULT_AGENT=codex
WECHAT_BRIDGE_CODEX_DEFAULT_MODEL=gpt-5.6-sol
WECHAT_BRIDGE_CLAUDE_CODE_MODEL=sonnet
WECHAT_BRIDGE_CLAUDE_CODE_EFFORT=high
```

`WECHAT_BRIDGE_PROGRESS_TEXT` 默认为空。只有需要在微信输入状态之外额外发送进度消息时才需要配置。

## 微信指令

```text
/codex                    切换到 Codex
/claude-code              切换到 Claude Code
/status                   查看当前后端、模型、思考级别和权限
/model                    查看当前后端可用的模型
/model <name>             切换当前后端的模型
/think                    查看当前后端可用的思考级别
/think <level>            切换当前后端的思考级别
/new                      开启新话题并清空本地上下文
/reset                    等同于 /new
/stop                     停止当前任务
/help                     查看指令帮助
```

`/status`、`/model` 和 `/think` 会根据当前后端自动生效。Claude Code 支持 `sonnet`、`opus`、`haiku` 等别名，也支持完整模型 ID；思考级别支持 `low`、`medium`、`high`、`xhigh`、`max`。

## 权限和自定义参数

Codex 默认使用完全本地权限运行：

```bash
codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -C "$PWD" --output-last-message <tmp> -
```

可以用 `WECHAT_BRIDGE_CODEX_ARGS` 完全覆盖 Codex 参数，用 `WECHAT_BRIDGE_CLAUDE_CODE_ARGS` 完全覆盖 Claude Code 参数。

## 诊断

```bash
npm run doctor
```

## 发送测试图片

```bash
node src/cli.js send-image /absolute/path/to/image.png
```

默认发送给扫码登录时记录的 `userId`。也可以指定接收人：

```bash
WECHAT_BRIDGE_TO='user@im.wechat' node src/cli.js send-image /absolute/path/to/image.png
```

## 说明

- 项目没有直接导入 `@tencent-weixin/openclaw-weixin`，因为其模块依赖 `openclaw/plugin-sdk`。
- 发送图片通过微信 CDN 上传实现。
- 使用期间需要保持桥接进程运行。
- 本项目是独立社区项目，与腾讯、微信、Anthropic 或 OpenAI 无隶属或官方认可关系。

## 许可证

[MIT](LICENSE)
