# 2026-09-15 验收记录

## 0.5.3 目录分离修复

本次源码基线 `083a528`。完整 `node tools/verify-all.mjs` 退出 0：原桥接 68/68、Channel 16/16、42 个语法检查及其余行为验证通过，零模型调用。Claude manifest、OpenSpec strict 与 git diff --check 通过。

真实路径只读验证：会话 `4a69baa0-7a34-4e18-a898-640adecf306b` 保持 cwd `D:\AI\Website\LDL_UGC`，显式 worktreeRoot/repoRoot 为其下 `backend`。在当时基线 `31cfbbd2e78e5aa0420a14aaee2de67e0bdc0951` 上，契约验证、Git 漂移检查和 tasks.md 上下文哈希均通过。未建立真实开发请求、未发送消息，实际接收仍需目标加载新版本后单独确认。

源码工作区：`D:\AI\Skill\Workflow-Exprience`，基线 HEAD `083a528`，本次为未提交的目录分离增量；保留入场时既有 dirty 文件。Claude 插件版本 0.5.3。

## 自动验收

- `npm run build:channel-sdk`：退出 0；打包 MCP SDK 1.30.0，生成 8 个包的第三方许可说明。
- `node tools/verify-all.mjs`：退出 0。42 个语法检查、6 组行为验证；原 session bridge 68/68、Channel/回传新增 16/16、Workflow repair 120 项全部通过。checkpoint、fallback、effort 路由检查通过。SKILL 6991/7000 字符。
- `claude plugin validate .claude-plugin/plugin.json`：退出 0。
- `openspec validate add-claude-channel-receipts --strict`：退出 0。
- `git diff --check`：退出 0。

测试使用真实临时 Git 仓库和 SDK stdio MCP 子进程；部署副本不包含 node_modules，仍能收到通知并 ACK。Codex 回传通过独立 Node 假 CLI 验证队列回执和去重，未发送真实业务消息、未调用模型。候选结果缺失、写入后的自动验证/发送、预检失败只补通知、主控 receive/acknowledge 均有覆盖。

## 本机只读验证

- 修正 npm shim 解析后 `doctor` 选择 `C:\nvm4w\nodejs\node.exe` + `node_modules\@openai\codex\bin\codex.js`，版本 0.153.0，queue 能力帮助通过；Claude 2.1.260。
- 原 Codex ID `01a08593-36f9-77f1-a3e6-6fef75d6b333` 的只读 thread/read 身份与 `D:\AI\Website\LDL_UGC` 匹配。独立 reader 的 notLoaded 不代表桌面任务空闲。
- 旧失败证据：Claude session `4a69baa0-7a34-4e18-a898-640adecf306b` 的 `wf_bb635a6e-1c0` Report 子代理先遇到 `python: command not found`，再直接 spawnSync codex 且把 null status 变为 1，没有记录 p.error。未把该“1”当成确定的 Codex 拒收。
- 移除原生 exe、保留 npm shim 的测试子进程 PATH 下，直接 spawn 返回 ENOENT；修复解析器后同环境版本探测退出 0。原失败环境未完整保留，根因复现与原始日志证据分开报告。

## 仍待真实会话验收

目标需在原终端启用本插件开发 Channel 并调用 bridge_connect。空闲/忙碌接收、实际模型 ACK、真实 Workflow 结果到 Codex 的端到端验收尚未执行。已有 Markdown 结果不属于本次新 Channel 账本，不自动重建合格 Result v1 或再次发送；其业务验收由原任务处理。
