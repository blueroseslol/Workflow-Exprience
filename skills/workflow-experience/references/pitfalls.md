# 踩坑记忆

每条都来自真实事故。标 `[通用]` / `[LDL_UGC]` / `[Windows]` 区分适用范围。

---

## 1. hook / 历史手动工具游标会掩盖失败 `[通用]`

**症状**：hook 第一次跑"成功"了（游标记为已处理），但产物写到了错误的位置。之后每次跑都被游标跳过，看起来像"什么都没发生"。

**根因**：游标在文件搬运**之后**更新，但搬运的目标路径是错的 —— 操作本身没抛异常，所以被记为成功。

**教训**：调试 hook 时**先清游标**再重跑，否则你在调试一个不会执行的分支。
```bash
ls "$TMPDIR"/wfharvest-*.json "$TMPDIR"/wfpeer-*.json  # wfpeer 仅在手动运行历史 peer-progress 工具时存在
rm -f "$TMPDIR"/wfharvest-<hash>.json
```

---

## 2. Git Bash 路径 ≠ Node 路径 `[Windows]`

**症状**：`node script.js` 里 `fs.mkdirSync('/tmp/x')` 不报错，但 `ls /tmp/x` 什么都没有。

**根因**：Git Bash 的 `/tmp` 映射到 `C:\Users\<user>\AppData\Local\Temp`（或 MSYS 的挂载点），而 Node 的 `/tmp` 解析为当前盘符根下的 `\tmp`。两者是不同目录。

**教训**：传给 Node 的路径一律用 Windows 形式（`D:/tmp/x`），或用 `os.tmpdir()` 让 Node 自己决定。

---

## 3. heredoc 遇到内容里的引号会截断 `[通用]`

**症状**：`cat > f.js <<'EOF' ... EOF` 报 `unexpected EOF while looking for matching '`，文件没写成但前面的命令已执行。

**根因**：内容里含未配对的引号或反引号时，shell 的解析会出意外。

**教训**：写含代码的文件用 **Write 工具**，不要用 heredoc。heredoc 只适合短小、无引号的纯文本。

---

## 4. `agent()` 失败返回 null，不抛异常 `[通用]`

**症状**：`parallel()` 的结果数组里混入 `null`，下游 `.map(r => r.field)` 崩溃。

**触发**：用户 skip 了该 agent、subagent 遇终端 API 错误、pipeline stage 抛异常。

**教训**：
```js
const results = (await parallel(...)).filter(Boolean)   // 必须过滤
if (!results.length) return { status: 'failed', at: 'Recon' }
```

**计数器必须放调用前自增**，否则失败不计数 → 死循环：
```js
calls++; const r = await agent(...)     // ✅
const r = await agent(...); if (r) calls++   // ❌
```

---

## 5. 大文件必须流式，不能 cat `[通用]`

**症状**：读一个 195MB / 37829 行的 jsonl，context 直接爆掉。

**教训**：
- 单行可能有数百 KB —— `head -c` 也不安全
- 用 `node` + `readline` 流式，或 `grep -c` / `grep -o | head` 限量
- 大头字段（reasoning、tool_output）**用行首前缀判别丢弃，永不 JSON.parse**
- 实测：195MB → 29KB 摘要，428ms，靠的就是"90% 字节从不解析"

参考实现：`legacy/codex-handoff.mjs`

---

## 6. Glob 返空不等于文件不存在 `[通用]`

**症状**：`Glob('**/*.test.ts')` 返回空，但文件明明在。

**常见原因**：`.gitignore` 排除、路径含非 ASCII 字符、搜索根目录写错。

**教训**：Glob 返空时，用 `ls` 或 `find` 交叉验证一次再下结论。

---

## 7. GitNexus 的 repo 名不是目录名 `[LDL_UGC]`

**症状**：`impact(target, {repo: 'LDL_UGC'})` 报 repo 未索引。

**教训**：先跑 `list_repos` 拿准确的 repo 名。本项目是 `ldl-ugc-backend` 而非 `LDL_UGC` 或 `backend`。

**另一条**：索引可能落后于工作区。`impact` 返回 LOW 不等于真的低风险 —— 要看索引时间戳，落后就在结论里标注，不要当成"无影响"的证据。

---

## 8. `git -C` 与 `pnpm --dir` 的差异 `[通用]`

`git -C <path>` 改变 git 的工作目录；`pnpm --dir <path>` 改变 pnpm 的。两者不能互换，也不要指望 `cd` 在 Bash 工具的多次调用间保持 —— 工作目录会被重置。

**教训**：跨目录操作一律用绝对路径 + 工具自带的 `-C` / `--dir`，不依赖 `cd`。

---

## 9. workflow 脚本里禁用的 API `[通用]`

会直接 throw：
- `import` / `require`（AST 层面拒绝）
- `Date.now()` / `new Date()`（无参） / `Math.random()`

前者意味着**没有公共库，只有可粘贴模板**；后者意味着**时间戳走 args 注入**。

详见 `resume-and-args.md`。

---

## 10. 不要相信 agent 的自述 `[通用]`

**实例**：一条 codex 线程的 68 轮自述都在说"验证通过"，但从 3799 条命令里数出来 —— `git commit` 调用次数是 **0**。361 个文件的改动全裸露在工作区。

**教训**：验证层要**自己跑一遍**，不要基于上一层的报告下结论。schema 里要退出码和原始输出，就是为了让"跑过"这件事可被复核。
