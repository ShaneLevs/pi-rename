# pi-rename

pi coding agent 扩展：**根据对话内容给会话重命名，并把名字同步成终端标题**。

- 新会话第一轮对话结束后，自动起一个名字（已有名字的会话不会被覆盖）。
- `/rename` —— 按最近 5 轮对话重新命名，**有名字就覆盖**。
- `/rename model <provider/id>` —— 指定用来起名字的模型。
- `/rename on` / `/rename off` —— 开启 / 关闭自动重命名。

---

## 安装

```bash
pi install npm:pi-rename
```

或写进 `~/.pi/agent/settings.json`：

```json
{ "packages": ["npm:pi-rename"] }
```

安装后在 pi 里执行 `/reload` 生效（首次安装会自动发现）。单次试用：`pi -e npm:pi-rename`。

本地开发版：`pi install ./pi-rename`，或 `pi -e ./extensions/index.ts`。

## 命令

| 命令 | 作用 |
|---|---|
| `/rename` | 取最近 5 轮对话让模型起名字，覆盖当前名字 |
| `/rename <文本>` | 直接用这段文本当名字（覆盖） |
| `/rename on` / `/rename off` | 开/关「第一轮结束后自动重命名」，写进配置文件 |
| `/rename model <provider/id>` | 设置起名字用的模型（支持 id 子串模糊匹配） |
| `/rename model default` | 取消设置，回到「用当前会话模型」 |
| `/rename model` | 不带参数：打印当前实际生效的模型 |

配置在 `~/.pi/agent/pi-rename/config.json`（用 `PI_RENAME_CONFIG_DIR` 可换目录），只有两个字段：

```json
{ "auto": true, "model": "" }
```

## 命名规则

**两条触发路径各自看到多少轮**（窗口都是 `RECENT_TURNS = 5`）：

| 触发 | 时机 | 实际送入的轮数 |
|---|---|---|
| 自动重命名 | 新会话第一轮 `agent_settled`（非 Esc 打断）| 1 轮 —— 此时转录里**只有**第一轮，拿不到更多 |
| `/rename` | 你主动执行 | 最近 5 轮；不足 5 轮就全拿 |

所以上面那些「只拿到很少上下文」的情况不是窗口配小了，而是超预算时被整轮丢了——现在只有用户消息本身巨大到装不下才会发生，而且提示词头部的轮数会写真实值。

**送给模型的上下文**（`extensions/naming.ts`）：

- 只读当前分支 `ctx.sessionManager.getBranch()`，取最近 **5 轮**；
- **用户消息全文发送**，不截断；
- 每轮 **只带最后一个 assistant 正文块**（工具调用之间的「我先读一下文件」这类过程话不要），`toolResult` / `thinking` / tool call / 图片全部丢弃；
- 一轮 = 一条有文字的 user 消息 + 其后的 assistant 文字；
- 超预算（12000 字符）时的取舍：先按阶段 `3000 → 1200 → 400` 字符**裁 assistant 答案**，尽量把 5 轮都保住；真装不下（用户消息本身就是几万字）才**整轮丢掉最旧的**，且提示词头部的轮数会写实际发送的轮数（不会谎称 5 turns）。

**名字长度**：上限 **15 个单位**，1 个中日韩汉字/假名/谚文 = 1 单位，1 个英文（或其他拼音文字）单词 = 1 单位，空格标点不计。`pi插件` = 3 单位，`rename the session` = 3 单位。截断按单位边界切，不加省略号。

**语言**：从**用户消息**的字符构成判定（汉字/假名/谚文/西里尔/拉丁占比），判出的语言同时写进 system prompt 和 user 消息里，例如中文会话 → `Write the name in: Chinese (Simplified unless the user writes Traditional)`。只看用户侧，不看 assistant 侧，避免被模型输出语言带偏。

**不拿「回答要求」当主题**：实测发生过会话被命名成「一句话回答」，因为用户消息尾部写了「只用一句话回答」而模型把它当成主题。system prompt 因此明写：忽略关于回复格式/长度的指令，命名的是对话内容本身。

**实际发出的请求**：一次隔离的单轮调用，不带 pi 的 system prompt、不带工具、不进转录。

```
system:  "You name AI coding-assistant sessions … - Length limit: at most 15 units … - Write the name in: <判定出的语言> …"
user:    "Name this conversation (5 turns) in <语言>, within 15 units:\n\nUSER: …\nASSISTANT: …\n\nName:"
```

参数固定 `maxTokens: 512`、`temperature: 0.2`、`cacheRetention: "none"`（一次性起名调用不去污染提示词缓存，pi 自己的压缩摘要也是这样做的）；`reasoning` 不传 → pi runtime 按 `?? "off"` 处理，即不开思考。模型默认用**当前会话模型**，`/rename model` 可换便宜的。

`maxTokens` 给到 512 而不是 64 的原因：名字本身只有几个 token，但部分 OpenAI 兼容中转**无论是否要求**都会返回 reasoning 内容，这些同样按这个上限结算。实测 64 会被 reasoning 吃光、正文为空，导致名字静默退化成「首条用户消息」；现在这种情况会 notify 一条带 `stopReason` 的 warning。

**返回后清洗**：剥 ```` ``` ```` 围栏 → 只取第一个非空行 → 去 `-`/`*`/`#`/`>`/引号装饰与 `Title:`/`标题：` 前缀 → 去结尾标点 → 折叠空白 → 按 15 单位截断 → 剥控制字符。清洗后一个实词都不剩（或调用失败）就退化成**窗口里第一条用户消息的第一行**（同样限 15 单位），并 notify 一条 warning。

**`/rename <文本>`** 不走清洗截断——你打的什么就是什么，只折叠空白和控制字符。

## 终端标题

命名之后调 `ctx.ui.setTitle(name)`：TUI 模式发出 OSC 标题序列，RPC 模式转成 `extension_ui_request/setTitle` 交给宿主。pi 原生在 `session_info_changed` 时把标题刷成 `π - <name> - <cwd>`，我们随后覆盖成纯名字；你自己用 pi 的 `/name` 或 `--name` 改名时，标题也会跟着同步（挂了同一个事件）。

### VS Code（pwsh / Git Bash）

两种 shell 在 VS Code 集成终端里都正常响应 OSC 标题序列。如果发现**窗口标题变了但标签栏没跟着变**，把标签标题模板改成读 shell 上报的标题：

```json
{ "terminal.integrated.tabs.title": "${sequence}" }
```

注意：

- 用 VS Code 的 **Terminal: Rename** 手动改过标签名会覆盖 shell 上报的标题，需要先 **Terminal: Clear Rename** 或开新终端。
- pi 退出后 pwsh / Git Bash 会在下一次画提示符时把标题写回去，这是 shell 行为，不是扩展失效。

## 行为细节

- 自动重命名**每个会话只尝试一次**：尝试前 `pi.appendEntry("pi-rename", …)` 记一条不进模型上下文的 custom entry，`/reload`、`--continue`、`--resume` 扫分支恢复状态，不会重复烧 token。
- Esc 打断（`agent_settled.aborted === true`）不重命名。
- 只在 `tui` / `rpc` 模式自动重命名；`pi -p` / `--mode json` 不做额外模型调用。
- 手动 `/rename` 之间有并发锁，不会同时发两个命名请求。

## 开发

```
pi-rename/
├── extensions/index.ts     事件与命令接线
├── extensions/naming.ts    纯函数：轮次提取、单位计数、语言判定、prompt 组装、名字清洗
├── test/naming.test.ts     纯函数用例
├── test/extension.test.ts  mock ExtensionAPI，跑自动重命名 / /rename / model / 标题
├── tsconfig.json           只校验 extensions/
└── tsconfig.test.json      加 bun types，校验 extensions/ + test/
```

```bash
npm run check    # tsc + tsc(test) + bun test（52 个用例）
pi -e ./extensions/index.ts
```

---

## English

pi coding agent extension: **names your sessions from the conversation, and mirrors that name into the terminal tab title**.

- A new session gets named automatically after its first turn (sessions that already have a name are never overwritten).
- `/rename` — re-name from the last 5 turns, **overwriting the current name**.
- `/rename model <provider/id>` — pick the model used for naming.
- `/rename on` / `/rename off` — enable / disable auto-renaming.

### Install

```bash
pi install npm:pi-rename
```

Or add it to `~/.pi/agent/settings.json`:

```json
{ "packages": ["npm:pi-rename"] }
```

Run `/reload` in pi afterwards (auto-discovered on first install). To try it once without installing: `pi -e npm:pi-rename`.

### Commands

| Command | Effect |
|---|---|
| `/rename` | Name the session from the last 5 turns, overwriting the current name |
| `/rename <text>` | Use this text as the name, verbatim (overwrite) |
| `/rename on` / `/rename off` | Turn auto-renaming after the first turn on / off (persisted) |
| `/rename model <provider/id>` | Set the naming model (substring / fuzzy id match) |
| `/rename model default` | Clear the override, fall back to the current session model |
| `/rename model` | No argument: print the model that is actually in effect |

Config lives in `~/.pi/agent/pi-rename/config.json` (override the directory with `PI_RENAME_CONFIG_DIR`), two fields only:

```json
{ "auto": true, "model": "" }
```

### How the name is produced

Both triggers use a 5-turn window (`RECENT_TURNS = 5`):

| Trigger | When | Turns actually available |
|---|---|---|
| Auto-rename | First turn of a new session settles (`agent_settled`, not aborted) | 1 turn — the transcript holds nothing else yet |
| `/rename` | You run it | Last 5 turns, or all of them if there are fewer |

**Context sent to the model** (`extensions/naming.ts`):

- Only the current branch is read, via `ctx.sessionManager.getBranch()`, last **5 turns**;
- **User messages are sent in full**, never truncated;
- Per turn only the **final assistant text block** is kept (filler like "let me read that file" between tool calls is dropped); `toolResult` / `thinking` / tool calls / images are all discarded;
- A turn = one user message with text + the assistant text after it;
- Over the 12000-character budget: assistant answers are clipped first (`3000 → 1200 → 400` chars) so all 5 turns survive; only when a user message alone is unclippable is the **oldest whole turn dropped** — and the prompt header then states the real turn count instead of claiming 5.

**Length limit**: 15 units, where 1 CJK ideograph / kana / hangul = 1 unit and 1 English (or other alphabetic) word = 1 unit; spaces and punctuation don't count. `pi plugin` = 2 units, `rename the session` = 3 units. Truncation cuts on unit boundaries, no ellipsis.

**Language** is detected from the **user messages** only (share of CJK / Cyrillic / Latin characters) and written into both the system prompt and the user message, e.g. a Chinese session → `Write the name in: Chinese (Simplified unless the user writes Traditional)`. Looking only at the user side keeps the name from being dragged into the model's own output language.

**Formatting requests are not a topic.** A session once got named "answer in one sentence" because the user's last line said so; the system prompt now explicitly says to ignore instructions about reply format or length and name the content instead.

**The request itself** is one isolated single-turn call: no pi system prompt, no tools, never enters the transcript. Params are fixed at `maxTokens: 512`, `temperature: 0.2`, `cacheRetention: "none"` (a one-off naming call shouldn't pollute prompt caching, same reasoning pi uses for its own compaction summaries); `reasoning` is omitted → the pi runtime treats it as `"off"`.

`maxTokens` is 512 rather than 64 because some OpenAI-compatible proxies return reasoning content whether asked or not, and it bills against the same cap. At 64 the reasoning ate the whole budget and the body came back empty, so the name silently degraded to "first user message"; that case now raises a warning with the `stopReason`.

**Post-processing**: strip ``` fences → take the first non-empty line → drop `-`/`*`/`#`/`>` decoration and `Title:` / `标题：` prefixes → strip trailing punctuation → collapse whitespace → truncate to 15 units → strip control characters. If nothing word-like survives (or the call fails), the name falls back to the **first line of the first user message in the window** (also capped at 15 units) and a warning is shown.

**`/rename <text>`** skips sanitization and truncation — you get exactly what you typed, apart from whitespace and control-character collapsing.

### Terminal title

After naming, `ctx.ui.setTitle(name)` is called: TUI mode emits the OSC title sequence, RPC mode forwards `extension_ui_request/setTitle` to the host. pi natively refreshes the title to `π - <name> - <cwd>` on `session_info_changed`; we overwrite it with the bare name right after. Renaming through pi's own `/name` or `--name` syncs the title too (same event).

#### VS Code (pwsh / Git Bash)

Both shells honour OSC title sequences in the integrated terminal. If the **window title changes but the tab label doesn't**, point the tab title template at the shell-reported title:

```json
{ "terminal.integrated.tabs.title": "${sequence}" }
```

Caveats:

- A manual **Terminal: Rename** in VS Code overrides the shell-reported title; use **Terminal: Clear Rename** or a fresh terminal.
- After pi exits, pwsh / Git Bash writes their own title back on the next prompt. That's shell behaviour, not a broken extension.

### Behaviour details

- Auto-rename is **attempted once per session**: before the attempt, `pi.appendEntry("pi-rename", …)` records a custom entry that stays out of the model context; `/reload`, `--continue` and `--resume` restore the state from the branch, so tokens are never spent twice.
- An Esc abort (`agent_settled.aborted === true`) does not rename.
- Auto-rename runs only in `tui` / `rpc` modes; `pi -p` and `--mode json` make no extra model call.
- Manual `/rename` calls are serialized by a lock, so two naming requests never overlap.

### Development

```bash
npm run check    # tsc + tsc(test) + bun test (52 cases)
pi -e ./extensions/index.ts
```

### License

MIT
