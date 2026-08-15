# opencode-plugin-deepseek-v4-anchor

OpenCode port of [`xiaobright/dsh-anchored-standard`](https://github.com/xiaobright/dsh-anchored-standard). This is **not** an official DeepSeek preset.

The plugin only activates for model ids that start with `deepseek-v4-`. Every other model is left untouched.

## Install

Clone this repository, then add it to `opencode.jsonc`:

```jsonc
{
  "plugin": ["file:///ABS/PATH/TO/opencode-plugin-deepseek-v4-anchor"]
}
```

OpenCode loads the TypeScript source directly. There is no build step.

## Debug

Set `DSH_ANCHOR_DEBUG=1`. Logs go to `$TMPDIR/dsh-anchor-debug.log`, not the TUI.

## Disable

Set `DSH_ANCHOR_DISABLE=1`.
