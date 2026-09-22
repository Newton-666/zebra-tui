# ⚡ Krystal（原 zebra-tui）

多 agent 团队驾驶舱 —— 一个终端窗口，指挥整支 agent 团队。

前端基于 [`@earendil-works/pi-tui`](https://github.com/earendil-works/pi)（pi coding agent 的 TUI 框架，MIT）：差分渲染、无闪烁、圆角框编辑器（「两条线中间的输入框」）、@ 自动补全、ScrollView、Stack 布局。应用层（团队网格、tmux 引擎、团队历史、拖拽调宽、logo）是 Krystal 自己的。

```
╭────────────────────────────────────────────────────────────────────────────╮
│ ██╗  ██╗  ██████╗  ██╗   ██╗ ███████╗ ████████╗  █████╗  ██╗               │
│ ██║ ██╔╝  ██╔══██╗ ╚██╗ ██╔╝ ██╔════╝ ╚══██╔══╝ ██╔══██╗ ██║               │
│ █████╔╝   ██████╔╝  ╚████╔╝  ███████╗    ██║    ███████║ ██║               │
│ ██╔═██╗   ██╔══██╗   ╚██╔╝   ╚════██║    ██║    ██╔══██║ ██║               │
│ ██║  ██╗  ██║  ██║    ██║    ███████║    ██║    ██║  ██║ ███████╗          │
│ ╚═╝  ╚═╝  ╚═╝  ╚═╝    ╚═╝    ╚══════╝    ╚═╝    ╚═╝  ╚═╝ ╚══════╝          │
╰────────────────────────────────────────────────────────────────────────────╯
```

## 架构

```
┌─ Krystal TUI ────────────────────────────┐
│ logo 框 / 团队网格（可拖拽分隔线）/ 状态行 / 输入框 │
└──────────┬───────────────────┬───────────┘
           │ tmux send-keys    │ tmux capture-pane（350ms 轮询）
           ▼                   ▲
    tmux 会话 zebra-<id>（引擎室：每个成员一个真实交互窗格）
```

- agent 以**真实交互 CLI** 生活在 tmux 引擎室里（会话、审批、TUI 全保留）
- Krystal 是视图 + 遥控器：轮询显示各成员实时画面，输入框分发指令
- 拖拽中间的分隔线可调列宽：**引擎窗格同步缩放**，agent 按新宽度重排，排版不破坏
- `tmux attach -t zebra-<id>` 随时直看任意成员的原始窗格

## 运行

```bash
git clone https://github.com/Newton-666/zebra-tui && cd zebra-tui
sh scripts/vendor-pi-tui.sh     # 从本地已安装的 pi 复制 pi-tui 到 deps/（仓库不提交第三方代码）
./zebra                          # 首次：团队向导（1–6 名成员、命名、类型、命令）
```

可选：装成全局命令

```bash
ln -sf "$PWD/zebra" ~/.local/bin/krystal
```

要求：`tmux`、Node ≥ 22.6（跑 TypeScript 用 `--experimental-strip-types`）。

## 用法

| 输入 | 效果 |
|---|---|
| `消息` | 广播全体（或 `:to` 锁定的目标） |
| 行首 `@` | 弹出成员补全（↑↓ + enter） |
| `@pi @kimi 消息` | 定向多个成员 |
| `:to <name>` | 锁定默认目标（`◈` 标记，`:to all` 解除） |
| `:team` | tmux 引擎丢失时重建 |
| `:quit` / `ctrl+c` | 退出（tmux 引擎保留在后台） |
| 拖拽分隔线 | 调整列宽（同时缩放引擎窗格） |

## 团队历史（Krystal 自己的历史，不是 pi 的）

每个团队一个目录：`sessions/<id>/`

- `team.json` — 成员、类型、启动/恢复命令、列宽比例、tmux 会话名、pane 映射
- `history.jsonl` — 团队事件流：`team_created` / `dispatch` / `screen`（各成员画面快照）/ `note`

```bash
./zebra -c          # 恢复最近团队：回放团队视图 + 重接引擎（缺格会自动重建）
./zebra -r <id前缀> # 指定团队
./zebra --dir <p>   # 新团队的工作目录
```

## 成员类型

| 类型 | 启动 | 恢复（尽力而为） |
|---|---|---|
| pi | `pi` | `pi -c \|\| pi` |
| hermes | `hermes chat` | `hermes chat --continue \|\| hermes chat` |
| codex | `codex` | `codex resume --last \|\| codex` |
| kimi | `kimi` | `kimi -c \|\| kimi` |
| custom | 自定义命令 | 同启动命令 |

## 开发

```bash
npm run smoke    # 引擎 + 存储冒烟测试（无需 TTY）
node --experimental-strip-types src/main.ts
```

代码结构：

```
src/
├── main.ts          入口（-c / -r / --dir）
├── app.ts           TUI 装配：logo 框 / 团队网格 / 状态行 / 输入框 / 拖拽
├── view/grid.ts     团队网格（精确列宽 + 可拖拽分隔线 + 布局链委托）
├── view/cell.ts     成员卡片（圆角边框 + 定宽截断 tail）
├── view/wizard.ts   团队向导 + 会话选择器
├── agents.ts        tmux 引擎（建格 / 分发 / 捕获 / 复活 / 窗格同步）
├── poll.ts          画面轮询 + 死格自动复活
├── team.ts          团队历史存储
└── ui/              ansi / @补全 provider
```

## 变更历史

每一版都提交到 git。当前 v0.1。