---
description: 提交开发需求，走 Ultracode workflow 意图路由（修 bug / 只读调研 / OpenSpec 逐里程碑）
argument-hint: <开发需求，如「修复角色登录后偶尔状态不同步」>
---

调用 Skill 工具（skill: "workflow-experience:workflow-experience"）加载意图路由规则，然后按规则处理以下开发需求。对用户只讲阶段意图，不报内部模板文件名。

若需求明确包含“审阅使用 Codex CLI”或“修改代码使用 Codex CLI”等指令，按 `references/codex-cli.md` 只覆盖对应阶段；否则保持默认 `fable` Review/Audit 与现有动态模型路由。

需求：$ARGUMENTS
