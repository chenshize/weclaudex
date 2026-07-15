# wechat-agent-bridge

English | [简体中文](README.md)

An experimental local bridge that lets you use Codex or Claude Code from WeChat and switch between them with `/codex` and `/claude-code`.

> [!WARNING]
> The default configuration bypasses interactive permission checks for both Codex and Claude Code. Messages accepted by the bridge may execute commands and access files as your local user. Keep the sender allowlist enabled, use a dedicated workspace, and only run this on a machine and WeChat account you trust.

This project does not use OpenClaw as its agent runtime. It reimplements the small HTTP API surface documented by `@tencent-weixin/openclaw-weixin`:

- QR login: `get_bot_qrcode` / `get_qrcode_status`
- Receive messages: `ilink/bot/getupdates`
- Send text: `ilink/bot/sendmessage`

Text direct messages and outbound images are currently supported. Understanding inbound images, files, and voice messages is not implemented yet.

## Requirements

- Node.js 22+
- An installed and authenticated `codex` and/or `claude` CLI

## Install

```bash
npm install
```

## Log in to WeChat

```bash
npm run login
```

Scan the terminal QR code with WeChat. Credentials are stored in:

```text
~/.wechat-agent-bridge
```

Set `WECHAT_BRIDGE_STATE_DIR` to use another directory. Existing installations continue using `~/.weixin-codex-bridge`, preserving saved login credentials.

## Run

```bash
npm run run
```

By default, the bridge only processes messages from the WeChat `userId` returned during QR login.

Useful environment variables:

```bash
WECHAT_BRIDGE_CWD=/path/to/workspace
WECHAT_BRIDGE_ALLOW_FROM=user1@im.wechat,user2@im.wechat
WECHAT_BRIDGE_ALLOW_ALL=1
WECHAT_BRIDGE_TIMEOUT_MS=600000
WECHAT_BRIDGE_PROGRESS_DELAY_MS=2500
WECHAT_BRIDGE_PROGRESS_TEXT='Received, working on it...'
WECHAT_BRIDGE_DEFAULT_AGENT=codex
WECHAT_BRIDGE_CODEX_DEFAULT_MODEL=gpt-5.6-sol
WECHAT_BRIDGE_CLAUDE_CODE_MODEL=sonnet
WECHAT_BRIDGE_CLAUDE_CODE_EFFORT=high
```

`WECHAT_BRIDGE_PROGRESS_TEXT` is empty by default. Set it only when you want a visible progress message in addition to WeChat typing state.

## WeChat commands

```text
/codex                    Switch to Codex
/claude-code              Switch to Claude Code
/status                   Show the active backend, model, effort, and permissions
/model                    List models for the active backend
/model <name>             Switch the active backend's model
/think                    List effort levels for the active backend
/think <level>            Switch the active backend's effort level
/new                      Start a new topic and clear local context
/reset                    Alias for /new
/stop                     Stop the current task
/help                     Show command help
```

`/status`, `/model`, and `/think` automatically operate on the active backend. Claude Code supports aliases such as `sonnet`, `opus`, and `haiku`, as well as full model IDs. Its effort levels are `low`, `medium`, `high`, `xhigh`, and `max`.

## Permissions and custom arguments

Codex runs with full local permissions by default:

```bash
codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -C "$PWD" --output-last-message <tmp> -
```

Use `WECHAT_BRIDGE_CODEX_ARGS` to completely override the Codex arguments, or `WECHAT_BRIDGE_CLAUDE_CODE_ARGS` to completely override the Claude Code arguments.

## Doctor

```bash
npm run doctor
```

## Send a test image

```bash
node src/cli.js send-image /absolute/path/to/image.png
```

The default recipient is the `userId` captured during QR login. Override it with:

```bash
WECHAT_BRIDGE_TO='user@im.wechat' node src/cli.js send-image /absolute/path/to/image.png
```

## Notes

- The project intentionally avoids importing `@tencent-weixin/openclaw-weixin` directly because its modules depend on `openclaw/plugin-sdk`.
- Outbound image sending uses a WeChat CDN upload.
- Keep the bridge process running while you want messages delivered to the active agent.
- This is an independent community project and is not affiliated with or endorsed by Tencent, WeChat, Anthropic, or OpenAI.

## License

[MIT](LICENSE)
