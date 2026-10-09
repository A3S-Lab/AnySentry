# Goal 分支干净提交自查手册

> 目标分支：`goal/canonical-observability-20260903`  
> 仓库：`AnySentry` + `Observer`  
> 用途：两位并行工程师在本地自查后，只提交**自己职责内、可验收**的改动，最终得到**两边都干净**、包含三人全部有效修改的 tip。  
> 脏内容、本地产物、与本目标无关的文件**不要 commit**。

---

## 0. 当前基线（Codex/Claude 全链路侧已落地）

| 仓库 | 期望 tip（截至本手册写入） | 状态 |
| --- | --- | --- |
| Observer | `9dd4fbd`（含 perf `7e8d90b` + CLI admit + early-WS activate） | 工作区应保持 **clean** |
| AnySentry | ≥ `18f3adc`（含 `process_lineage`、5m 工具窗、Observer overlay pin） | tip 已含全链路提交；工作区若仍 dirty，多半是你们的 WIP |

部署核对（人工测前可选）：

```bash
# Observer tip 与 pin
git -C <observer-checkout> rev-parse --short HEAD   # 期望 9dd4fbd
rg -n 'digest:|local-source-revision|FORWARD_RETAIN_NON_AGENT' \
  <anysentry-checkout>/deploy/manual-test/k8s-observer/

# 集群是否跟 tip
kubectl -n anysentry get ds a3s-observer -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'
# 期望含 sha256:26999af83759ee3e2fa02da8844e96b85a89a3c76eab7607903e8e0b02a6204d
```

**禁止**：`git stash pop` Observer 上遗留的 `wip-before-landing-cli-ws-*` / `recovered-foreign-h2-data-*`（会冲掉已落地的 CLI/WS tip）。

---

## 1. 职责边界（只改、只提交自己的区）

摘自设计文档 §6，自查时按角色对号入座。

### A. Observer 性能 / 采集吞吐工程师

**可以改并提交：**

- Observer：ring/inbox/reorder、Critical/Semantic 预算、verifier 预算、attach 重试节流、重组内存上限/淘汰（**不要**改 rustls 探针段、WS early-activate、CLI PID allowlist 路径，除非先对齐）
- AnySentry：`scripts/observer-forward.js`、`observer-pipeline-accounting.js`、`observer-capture-profile-control.js`、`observer-workload-filter.js`、`observer-tls-agent-cgroups.js` 及对应 `verify-*.mjs`
- 压力/容量相关 kustomize：`deploy/manual-test/k8s-local-path/**`、`k8s-core/**`、file canary / full probe patch（若确属本目标验收）

**不要提交：**

- `deploy/manual-test/k8s-observer/kustomization.yaml` / `observer-manual-patch.yaml` 的 digest pin（由全链路侧按已部署镜像更新）
- `scripts/.local-bin/**`（宿主机挂载的 collector / overlay JS，**永不入库**）
- 与吞吐无关的 Dify lab、Web UI、LangGraph product 映射

### B. LangChain / LangGraph / Dify 应用侧工程师

**可以改并提交：**

- Manifest / adapter：`langchain-langgraph`、`dify` 条目与应用语义入口
- `agent-conversation-directory.ts` 的产品名映射（如 `langgraph`）、identity / runtime-state / aggregation / clickhouse / filter-rule / relational-business 等应用面
- Web：`agent-identity.tsx`、`identity-ai-review.tsx`、`security-center.ts` API 客户端
- `deploy/manual-test/agent-llm-observability/dify/scripts/**`
- 相关 `verify-agent-identity*` / `verify-agent-runtime-state*` / Dify validate 脚本

**不要提交：**

- Observer `interaction.rs` WS/CLI 路径、eBPF rustls admit、AnySentry `agent-semantic-kernel-relation.ts` 的 CLI `process_lineage` / `OPEN_TOOL_WINDOW_MS`（改前必须知会全链路侧）
- Observer overlay pin / `FORWARD_RETAIN_*`（保持 `false`，不要为了“看得到流量”重新打开 retain-all）
- `api-dist/`、`web-dist/`、`api-dist-overlay/`、截图、个人报告稿

### C. 共享文件（改前必须知会）

任一方改下列文件前，在交接消息写清**文件 + 行段 + 意图**，且 **禁止 `git commit -a`**：

- Observer：`interaction.rs`、`main.rs`（eBPF）、`tls_attach.rs`
- AnySentry：`agent-semantic-kernel-relation.ts`、`canonical-observability.ts`（Manifest 共享区）

---

## 2. 提交前强制自查清单（每人每次 commit）

在对应仓库根目录执行，**全部勾完再 commit**。

### 2.1 只暂存自己的文件

```bash
git status -sb
git diff --stat
# 逐文件看，不要 git add -A / commit -a
git add <path1> <path2> ...
git diff --cached --stat
```

自问三句：

1. 这个文件是我职责内的吗？  
2. 去掉它是否仍能表达“我这次要交付的验收点”？无关则撤出暂存。  
3. 是否含密钥、真实 prompt、本机路径、二进制、构建产物？有则撤出。

### 2.2 明确禁止入库的路径

| 路径 / 模式 | 原因 |
| --- | --- |
| `scripts/.local-bin/` | 本地 hostPath overlay（collector 二进制 + 热挂 JS） |
| `api-dist/`、`api-dist-overlay/`、`web-dist/` | 构建/镜像 overlay 产物 |
| `.Dockerfile.anysentry-overlay` | 本地 overlay 构建用 |
| `*.png` 实测试截图、`pelican-*.html` | 个人证据，非产品代码 |
| 未达成共识的长文报告 / 多份 architecture 草稿 | 另开文档 PR 或等评审后再入 |

仓库 `.gitignore` 已覆盖上述常见产物；若 `git status` 仍出现，先确认 ignore 再生效，**不要强行 add**。

### 2.3 提交信息

- 一条 commit 一个意图：`fix:` / `feat:` / `chore:` / `docs:`  
- 写清 **why**，不要堆文件列表  
- **本地 commit 即可**；未要求不要 `git push`

### 2.4 最小验证（按角色选跑）

**性能工程师（Observer）：**

```bash
cd Observer
cargo fmt --all -- --check
cargo test -p a3s-observer-common -p a3s-observer-collector --release
# 若动了 eBPF：release build + 既有 verifier 冒烟
```

**性能工程师（AnySentry pipeline 脚本）：**

```bash
cd AnySentry
# 跑你改动对应的 verify-*.mjs，至少：
node scripts/verify-deployment-manifests.mjs   # 若动了 deploy
```

**应用工程师（AnySentry）：**

```bash
cd AnySentry
pnpm build:api   # 或项目惯用等价命令
node scripts/verify-canonical-observability.mjs
# 若动了 relation / conversation：
node scripts/verify-agent-semantic-kernel-relation.mjs
node scripts/verify-agent-conversation-resolution-v2.mjs
# Dify lab：跑你们自己的 validate.sh，勿改全局 RETAIN
```

### 2.5 提交后确认工作区意图

```bash
git status -sb
# 期望：要么 clean，要么只剩「明确属于别人 / 明确不入库」的路径
git log --oneline -5
```

---

## 3. 如何处理「现在这一大坨 dirty」

当前 AnySentry 工作区脏文件大致三类（分类仅供自查，以 `git diff` 为准）：

1. **性能 / pipeline**：`observer-forward*`、`pipeline-accounting`、`k8s-local-path`、pressure patch、部分 `deploy/*.yaml`  
2. **应用 / Dify / UI**：`canonical-observability.service` 的 persist 开关、Dify scripts、identity UI、`langgraph` product 行等  
3. **本地产物**：`.local-bin/`、`api-dist*`、`web-dist/`、截图、报告草稿 → **永不 commit**；可留本地或删掉

推荐操作顺序：

```bash
# 1) 先保证本地产物被 ignore（已由全链路侧写入 .gitignore）
git status -sb

# 2) 只 add 自己桶里的、diff 已审过的文件
git add <your files>
git commit -m "$(cat <<'EOF'
feat: <一句话 why>

EOF
)"

# 3) 别人的文件保持 modified，不要 stash -u 整个树除非你们约定交接
```

若某文件**双方都改过**（例如 `canonical-observability.service.ts`）：先 `git diff` 对齐意图，必要时拆成两次 commit 或当面合并后再提交。

---

## 4. 「最终干净分支」完成定义

两边同时满足才算完成：

1. `Observer` 与 `AnySentry` 均在 `goal/canonical-observability-20260903`  
2. `git status` **无**与目标相关的未提交修改；本地产物已被 ignore 或不存在  
3. tip 包含：性能优化 + CLI/WS 全链路 + LangChain/Dify 应用侧**已达成共识的提交**  
4. Observer pin 仍指向已验证 digest（当前 `26999af8…`）；`FORWARD_RETAIN_NON_AGENT=false`  
5. 无人依赖 stash 里的半成品；半成品要么正式 commit，要么丢弃并写进交接说明

合并顺序建议：

1. 确认 Observer tip 不动（或性能工程师在 tip 上 rebase 自己的 Observer commit）  
2. 两位工程师各自在 AnySentry 只提交职责内 diff  
3. 任一方做一次 `git status` 交叉确认对方路径无残留  
4. 再通知负责人做人工 E2E / 发版

---

## 5. 一页速查（可直接转发给两位同事）

```text
目标：goal/canonical-observability-20260903 两边 clean tip
规则：
  - 禁止 git add -A / commit -a
  - 禁止提交 scripts/.local-bin、api-dist*、web-dist、overlay Dockerfile、截图
  - 禁止 stash pop Observer 上旧的 cli-ws / h2 WIP stash
  - 禁止为了“多看见流量”打开 FORWARD_RETAIN_NON_AGENT
  - 共享文件改前声明行段；冲突先对齐再提交
自查：status → diff → 按文件 add → cached diff → 最小 verify → commit → 再 status
完成：两边 status 干净，且三人有效改动都在 tip 上
```
