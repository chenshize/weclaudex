# weixin-codex-bridge

An experimental, text-first bridge that lets you use Codex from Weixin.

> [!WARNING]
> The default Codex command uses `--dangerously-bypass-approvals-and-sandbox`,
> so messages accepted by the bridge can execute commands and access files as
> your local user. Keep the sender allowlist enabled, use a dedicated workspace,
> and only run this on a machine and Weixin account you trust.

This does not use OpenClaw as the agent runtime. It reimplements the small HTTP API surface documented by `@tencent-weixin/openclaw-weixin`:

- QR login: `get_bot_qrcode` / `get_qrcode_status`
- Receive: `ilink/bot/getupdates`
- Send text: `ilink/bot/sendmessage`

The first version supports text-only direct messages.

## Install

```bash
npm install
```

Requires Node.js 22+ and an existing `codex` CLI login.

## Login

```bash
npm run login
```

Scan the QR code with Weixin. Credentials are stored in:

```text
~/.weixin-codex-bridge
```

Set `WEIXIN_CODEX_STATE_DIR` to use another directory.

## Run

```bash
npm run run
```

By default the bridge only processes messages from the Weixin `userId` returned during QR login.

Useful environment variables:

```bash
WEIXIN_CODEX_CWD=/path/to/workspace
WEIXIN_CODEX_ALLOW_FROM=user1@im.wechat,user2@im.wechat
WEIXIN_CODEX_ALLOW_ALL=1
WEIXIN_CODEX_TIMEOUT_MS=600000
WEIXIN_CODEX_PROGRESS_DELAY_MS=2500
WEIXIN_CODEX_PROGRESS_TEXT='收到，正在处理...'
WEIXIN_CODEX_DEFAULT_MODEL=gpt-5.6-sol
```

`WEIXIN_CODEX_PROGRESS_TEXT` is empty by default. Set it only if you want visible progress messages in addition to Weixin typing state.

By default the bridge starts Codex with full local permissions, matching the Lark bridge behavior.

Default Codex invocation:

```bash
codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -C "$PWD" --output-last-message <tmp> -
```

Override the Codex invocation completely:

```bash
WEIXIN_CODEX_ARGS='exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -C /path/to/workspace --output-last-message /tmp/out -'
```

## Weixin Commands

```text
/model
/model gpt-5.6-sol
/think
/think high
/help
/new
/reset
/stop
/status
```

`/status` shows the active Codex model. `/model` lists available models from `~/.codex/models_cache.json`; `/model <name>` stores the selected model in `~/.weixin-codex-bridge/settings.json` and passes it to `codex exec --model`.
`/think` lists available reasoning levels for the active model; `/think <level>` stores the selected level and passes it to Codex as `-c model_reasoning_effort="<level>"`.

## Doctor

```bash
npm run doctor
```

## Send A Test Image

```bash
node src/cli.js send-image /absolute/path/to/image.png
```

By default the recipient is the `userId` captured during QR login. Override it with:

```bash
WEIXIN_CODEX_TO='user@im.wechat' node src/cli.js send-image /absolute/path/to/image.png
```

## Notes

- This prototype intentionally avoids importing `@tencent-weixin/openclaw-weixin` directly because its modules import `openclaw/plugin-sdk`.
- Outbound image sending is supported through Weixin CDN upload. Inbound image understanding is not implemented yet.
- Keep the bridge process running while you want Weixin messages delivered to Codex.
- This is an independent community project and is not affiliated with or endorsed by Tencent, Weixin, or OpenAI.

## License

[MIT](LICENSE)
