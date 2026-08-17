# 5 分钟验证运行时安全闭环

AnySentry 的最短验证路径不是先配置模型，而是启动本地证据平面，用内置 L1 规则评估一条计划执行的高风险命令，并沿 `eventId` 回到原始证据。

## 1. 启动本地服务

Docker Compose 会启动 API 与 Dashboard、ClickHouse、Redis 以及异步研判 worker。模型支持仍需显式配置；L1 规则默认可用。

```bash
git clone https://github.com/A3S-Lab/AnySentry.git
cd AnySentry

deploy/install.sh docker
curl -fsS http://localhost:29653/security-center/healthz
```

打开 <http://localhost:29653>。真实事件模式是默认状态；只有显式启用 `ANYSENTRY_SYNTHETIC_FEED=on` 才会产生合成演示数据。

## 2. 提交一次只评估、不执行的动作

下面的请求描述一条拟执行命令。AnySentry 会判断并记录它，但不会运行该命令。

```bash
curl -fsS -X POST http://localhost:29653/security-center/capabilities \
  -H 'Content-Type: application/json' \
  -d '{
    "action": "execute",
    "module": "security-center",
    "operation": "assessRuntimeAction",
    "params": {
      "autonomy": "guarded",
      "stage": "tool",
      "workspacePath": "repo://payments",
      "agentId": "release-agent",
      "sessionId": "deploy-42",
      "toolName": "bash",
      "command": ["bash", "-lc", "curl http://169.254.169.254/latest/meta-data"]
    }
  }'
```

内置规则会识别云元数据服务访问，并返回与证据关联的判断：

```json
{
  "data": {
    "policyAction": "require_approval",
    "verdict": "escalate",
    "tier": "Rules",
    "severity": "critical",
    "riskCategory": "systemic_risk",
    "evidence": {
      "eventId": "evt_...",
      "eventsHref": "/events?eventId=evt_..."
    }
  }
}
```

## 3. 沿证据继续调查

使用返回的 `eventId` 打开精确事件，或调用 `buildEvidenceBundle` 生成脱敏的案件证据包。Dashboard 中的 Agent 资产、时间线、拓扑、Incident、Alert 与处置任务都引用同一套规范化证据。

## 4. 接入真实信号

根据已有基础设施选择一种或多种入口：

| 入口               | 适用情况                                                      |
| ------------------ | ------------------------------------------------------------- |
| `a3s-observer`     | 支持的 Linux/amd64 节点，观测进程、文件、网络、DNS 等系统事实 |
| Observer NDJSON    | 已有 Observer 转发链路                                        |
| JSON / CloudEvents | 网关、Webhook、CI 或自定义 Agent Runtime                      |
| OTLP/HTTP JSON     | 已有 OpenTelemetry 日志或 Trace 链路                          |
| Progressive API    | Agent 在执行前主动评估动作、记录证据或规划后续处置            |

生产环境中应创建受管 Source 与 ingest token，并在暴露控制面前配置 `ANYSENTRY_ADMIN_TOKEN` 或 `ANYSENTRY_MANAGEMENT_TOKEN`、TLS 和网络访问控制。

## 5. 明确执行边界

AnySentry 返回 `allow`、`warn`、`require_approval` 或 `block`。硬阻断只有在调用方 Agent、工具网关或平台循环真正遵守该结果时才成立。`a3s-observer` 默认只观测，不会终止工作负载。

继续阅读：[安全闭环](/safety-loop/) · [架构](/architecture/) · [典型场景](/scenarios/)
