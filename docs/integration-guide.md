# Totem 接入指南(给消费项目的 Agent)

> 契约标准见 **`docs/standards/consumption-standard.md`**(对齐 StackOne 开放
> 标准;认证、调用、错误、分页、webhook 契约都在那里)。本指南是操作手册,
> 标准是契约依据——两者冲突时以标准为准。

> 本文档写给**其他内部项目**的开发者/Agent:如何把你的项目(或项目里的 agent)
> 接入 totem,拿到对 Feishu Docs 等系统的受控操作能力。
>
> 读完本文档并跑通「冒烟测试」一节,你的项目就完成了接入。

## 1. Totem 是什么(30 秒版)

Totem 是一个自托管的**多租户动作层**:它把真实系统(目前 v1 是 Feishu Docs)的
能力包装成一组 **schema-first 的动作**(`create_doc`、`search_docs`、`read_sheet_cells`
等),通过两个消费面提供给内部项目:

| 消费面 | 给谁用 | 入口 |
|---|---|---|
| **MCP**(Streamable HTTP) | AI Agent(Claude Code、pi、Cursor 等) | `POST {TOTEM_URL}/mcp` |
| **REST Actions RPC** | 非 Agent 代码(CI、定时任务、后端服务) | `POST {TOTEM_URL}/actions/rpc` |

你的项目以 **tenant(租户)** 身份接入:拥有自己的 API key、自己的 Feishu 连接
(connection)、自己的动作白名单(allowlist)和审计记录。

**治理由平台强制,消费方无法绕过**:每次调用都经过 白名单检查 → 参数校验 →
token 获取 → 执行 → 审计 这条执行边界(Seam A)。

## 2. 接入全景

```
┌─────────────────────────────────────────────────────────────┐
│                     你的项目 (tenant)                        │
│                                                             │
│  Agent (MCP client) ──┐                                     │
│                       │   Bearer <API key>                  │
│  后端/CI 代码 ────────┤   x-connection-id: <conn-id>       │
│                       ▼                                     │
│                 ┌─────────────┐        ┌─────────────────┐  │
│                 │  /mcp (MCP) │        │ /actions/rpc    │  │
│                 └─────────────┘        └─────────────────┘  │
└──────────────────────────────────────┬──────────────────────┘
                                       │
                        ┌──────────────▼───────────────┐
                        │  totem 执行边界 (Seam A)      │
                        │  allowlist → 校验 → token →   │
                        │  执行 → 审计 → defender 扫描   │
                        └──────────────┬───────────────┘
                                       │
                                 ┌─────▼─────┐
                                 │  Feishu   │  (v1 唯一 upstream)
                                 └───────────┘
```

三个关键对象(术语见仓库 `CONTEXT.md`):

- **Tenant** —— 你的项目在平台上的身份隔离单元。一个项目一个 tenant。
- **Connection** —— 你的 tenant 授权过的某个 Feishu 账号实例(OAuth 授权后创建)。
  动作以该账号的身份执行。
- **Allowlist** —— 每个 connection 允许执行的动作名单。**空名单 = 什么都不能做
  (fail-closed)**,不在名单里的动作直接 `403 forbidden`。

## 3. 前置:一次性开通(自助,全信任模型)

平台当前是**项目间互相信任**模型(ADR-0010):admin-scope key 等价于平台管理员凭据,
消费项目可以**完全自助开通**,不需要向平台负责人提交工单。

> ⚠️ **信任边界(必读)**:admin-scope key 目前**不限定自己的 tenant** —— 持有一把
> admin-scope key 就能操作平台上的所有项目(改任何项目的 allowlist/凭据、查看任何
> 审计、创建租户)。这只在「项目间全信任」的前提下成立;不要把 admin-scope key 当
> 租户隔离凭据发给信任圈外的人,也不要用它跑生产流水线(那种场景用 actions-scope
> key,见 §4/§5)。

开通命令(`totemctl`,需要 `TOTEM_ADMIN_URL` + `TOTEM_ADMIN_KEY`;
`TOTEM_ADMIN_KEY` 可以放平台 admin key,或本项目的 admin-scope key):

```sh
export TOTEM_ADMIN_URL=http://localhost:3000
export TOTEM_ADMIN_KEY=tt_admin_xxx        # 平台 admin key 或本项目的 admin-scope key

# 1. 创建 tenant(如果平台负责人已建好可跳过)
npm run totemctl -- create-tenant my-project

# 2. 创建 actions-scope API key(打印一次,妥善保存)——这是 agent/代码真正用的 key
npm run totemctl -- create-key <tenant-id> --scope actions

# 3. 注册 Feishu App Credentials(项目自己的飞书自建应用 app_id/app_secret,
#    不要提交进任何代码库)
npm run totemctl -- set-feishu-creds <tenant-id> <app-id> <app-secret>

# 4. 跑 Authorize Flow:打开输出的 URL,用项目想绑定的飞书账号授权(需要真人点一次)
npm run totemctl -- oauth-start <tenant-id>
#    → 授权完成后用 list-connections 拿到 connection id
npm run totemctl -- list-connections <tenant-id>

# 5. 设置 allowlist(fail-closed;只加项目真正需要的动作)
npm run totemctl -- set-allowlist <connection-id> create_doc search_docs get_doc_content
```

完成后你会拿到 4 项**交付物**:

| 交付物 | 环境变量 | 说明 |
|---|---|---|
| Totem 服务地址 | `TOTEM_URL` | 例如 `http://totem.internal:3000` |
| Tenant API key(actions scope) | `TOTEM_API_KEY` | **只显示一次**,务必保密 |
| Connection ID | `TOTEM_CONNECTION_ID` | 形如 uuid,对应某个已授权的 Feishu 账号 |
| 已开通的动作清单 | — | 例如 `create_doc read_doc ...`,见 §7 |

> **re-auth**:连接 token 失效(`auth_expired`)时,重新执行
> `totemctl oauth-start <tenant-id> --connection <connection-id>` 即可,不用重建连接。

## 4. Agent 接入(MCP)

MCP 面是 **Streamable HTTP** 传输,挂载在 `{TOTEM_URL}/mcp`。任何支持 HTTP
transport 的 MCP 客户端都能直接用。

### 4.1 客户端配置示例

Claude Code / Cursor / 通用 MCP client 的 JSON 配置:

```json
{
  "mcpServers": {
    "totem": {
      "type": "http",
      "url": "http://totem.internal:3000/mcp",
      "headers": {
        "Authorization": "Bearer tt_live_xxxxx",
        "x-connection-id": "3f2a9c1e-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
      }
    }
  }
}
```

认证就是两个 header,每个请求都带:

| Header | 值 |
|---|---|
| `Authorization` | `Bearer <TOTEM_API_KEY>`(actions scope) |
| `x-connection-id` | `<TOTEM_CONNECTION_ID>`(也支持 query 参数兜底) |

### 4.2 协议行为(Agent 必须遵守)

1. **先 `tools/list`,只用列出的工具。** 工具列表 = 注册表 ∩ allowlist ∩ 连接器实现
   (ADR-0002「隐藏而非拒绝」)。没列出来的工具就是没有权限,**不要猜工具名**——
   硬调不在列表里的工具会得到 JSON-RPC `-32602 invalid params`。
2. **成功结果**:`content[0].text` 是动作输出的 JSON 字符串(也可能带
   `structuredContent`)。输出里出现的 `doc_id` 等是 **opaque ID** —— 直接存下来
   用于后续调用,不要尝试解析或访问其中的系统 token。
3. **失败结果**:`isError: true`,`content[0].text` 是统一错误词汇表(ADR-0005)的
   JSON,见 §6。**失败是结果,不是 JSON-RPC 异常**,按 `retryable` 字段决定行为。

### 4.3 最小冒烟测试(接入后第一件事)

在客户端里直接调用:

1. `tools/list` → 确认看到了开通的动作(不是空列表);
2. 调用 `test_connection`(如果开通了)→ 返回 `ok`;
3. 调用一个只读动作,例如 `search_docs {query: "测试"}`。

三步全过,Agent 接入完成。

## 5. 非 Agent 代码接入(REST Actions RPC)

CI、定时任务、后端服务不需要 MCP 客户端,直接用 HTTP。**语义与 MCP 完全一致**:
同一个动作、同一套参数、同一套错误(ADR-0008),注册表是唯一事实源,两条消费面
不可能漂移。

### 5.1 调用格式

```
POST {TOTEM_URL}/actions/rpc
Headers:
  Authorization: Bearer <TOTEM_API_KEY>
  x-connection-id: <TOTEM_CONNECTION_ID>
  Content-Type: application/json

Body: { "action": "create_doc", "args": { "title": "Q3 planning", "content": "..." } }
```

curl 示例:

```bash
curl -sS -X POST "$TOTEM_URL/actions/rpc" \
  -H "Authorization: Bearer $TOTEM_API_KEY" \
  -H "x-connection-id: $TOTEM_CONNECTION_ID" \
  -H "Content-Type: application/json" \
  -d '{"action":"search_docs","args":{"query":"Q3"}}'
```

### 5.2 响应

**成功**(HTTP 200):动作的统一输出 JSON。例如:

```json
{ "doc_id": "doxcnxxxxx", "title": "Q3 planning" }
```

**失败**:HTTP 状态码按错误码映射(见下表),响应体是统一错误 JSON:

```json
{
  "code": "rate_limited",
  "message": "rate limit exceeded",
  "retryable": true,
  "retryAfterSeconds": 30
}
```

| HTTP 状态 | 错误码 | 含义 |
|---|---|---|
| 400 | `validation_error` | 参数不符合动作的 schema |
| 400 | (传输层) | 缺 `x-connection-id` / envelope 格式错(`{action, args}`) |
| 401 | (传输层) | API key 无效 / 被禁用 / 不是 actions scope |
| 401 | `auth_expired` | 连接 token 失效,需要重新授权 |
| 403 | `forbidden` | 不在 allowlist(或 defender 拦截) |
| 404 | `action_not_found` | 动作名不存在(拼写错?) |
| 404 | `not_found` | 上游对象不存在(opaque ID 过期/被删) |
| 429 | `rate_limited` | 限流,带 `Retry-After` header 和 `retryAfterSeconds` |
| 502 | `upstream_error` | 上游(飞书)故障 |

### 5.3 动态发现与机器契约(可选)

不想硬编码动作清单,可以用只读发现面(同样 Bearer key,不需要 connection):

```bash
curl -sS "$TOTEM_URL/openapi.json"                                         # 机器契约:OpenAPI 3.1(无认证)
curl -H "Authorization: Bearer $TOTEM_API_KEY" "$TOTEM_URL/actions"        # 全部动作元数据
curl -sS -X POST "$TOTEM_URL/actions/search" \
  -H "Authorization: Bearer $TOTEM_API_KEY" -H "Content-Type: application/json" \
  -d '{"query":"sheet"}'                                                   # 文本搜索
```

`GET {TOTEM_URL}/openapi.json` 是注册表的**机器可读投影**(无认证;CI 锁定,
与注册表不漂移):每个动作的输入/输出 schema 在
`components.schemas.<action>_input` / `<action>_output`,统一错误契约在
`components.schemas.ActionError`(七码 + `retryable` + 可选
`retryAfterSeconds`/`upstream`/`details`)。**代码接入推荐直接用它生成客户端**
(openapi-generator、openapi-python-client 等),不要手抄 schema 的简化版。

## 6. 错误处理决策表(Agent 和代码统一遵守)

平台只有 7 个错误码,每个都带 `retryable` 标志。处理逻辑一句话:**`retryable`
为 true 就按 `retryAfterSeconds` 重试,否则不要重试,修正参数或上报。**

| code | retryable | Agent / 代码应该做什么 |
|---|---|---|
| `validation_error` | ✗ | 读 `details`(ValidationIssue 数组:path/keyword/message)修正参数,不要重试原参数 |
| `action_not_found` | ✗ | 动作名拼错或平台没有此动作;先 `tools/list` 或 `GET /actions` 确认 |
| `forbidden` | ✗ | 不在 allowlist;需要项目负责人加白,不要反复尝试 |
| `auth_expired` | ✗ | 通知负责人重新跑授权(§3 re-auth),连接恢复前停止调用 |
| `not_found` | ✗ | 对象被删或 ID 错;向上报告,不要重试 |
| `rate_limited` | ✓ | 等 `retryAfterSeconds`(或 HTTP `Retry-After`)后重试,建议指数退避 |
| `upstream_error` | ✗ | 上游故障,先上报/告警;确需重试时退避 1–2 次即止,不要死循环 |

> 任何重复失败都写审计日志,你可以在 admin 面查询(`totemctl query-audit`)。

## 7. 当前可用动作(v1, Feishu Docs 域)

| 动作 | 效果 | 说明 |
|---|---|---|
| `create_doc` | write | 新建文档,返回 `doc_id` + `title` |
| `search_docs` | read | 按标题文本搜索文档 |
| `get_doc_content` | read | 按 `doc_id` 读全文(纯文本) |
| `get_doc_metadata` | read | 按 `doc_id` 读元数据(title/owner/类型…) |
| `append_doc_content` | write | 追加文本到文档末尾 |
| `rename_doc` | write | 重命名 |
| `move_doc` | write | 移动到文件夹 |
| `export_doc` | write | 导出(docx/pdf/xlsx/csv/base/pptx;**无 markdown**) |
| `read_sheet_cells` / `write_sheet_cells` | read / write | 表格单元格读写 |
| `read_bitable_records` / `write_bitable_records` | read / write | Bitable 记录读写 |
| `test_connection` | read | 连通性自检 |

精确的输入/输出 schema 以 `tools/list`(MCP)或 `GET {TOTEM_URL}/openapi.json`
(REST,`components.schemas.<action>_input/_output`)为准,不要在代码里复制粘贴
schema 的简化版本。

## 8. 必须知道的三条治理事实

1. **Allowlist 是 fail-closed 的。** 新连接默认空名单 = 零权限。加动作要找负责人
   (`set-allowlist`)。动作从名单移除后,`tools/list` 里立刻消失。
2. **一切调用都进审计。** tenant、connection、动作、参数 hash、成功/失败、错误码、
   耗时。这不是可选的,别指望"小调用不记录"。
3. **响应会被 defender 扫描。** 平台在返回路径上做 prompt-injection 特征扫描
   (pattern 层,默认只观察;若租户开启 `block-high-risk`,高风险响应会变成
   `forbidden` 错误)。这是防"文档内容操纵 agent"的机制,不是针对你的项目。

另外两条红线:

- **API key / app_secret 永不入代码库。** key 只显示一次;泄漏就
  `disable-key` 后重建。放进 CI secret 或 vault。
- **只存 opaque ID,不存系统 token。** 你在文档/表格里拿到的 `doc_id` 就是
  你的引用句柄;任何形如 `doxcn…` 之外的可疑"token"都别存、别传。

## 9. 环境变量约定(建议)

你的项目统一用这三个变量,文档、示例、CI 都引用它们:

```bash
TOTEM_URL=http://totem.internal:3000
TOTEM_API_KEY=tt_live_xxxxx        # actions scope
TOTEM_CONNECTION_ID=3f2a9c1e-...   # 已授权的连接
```

## 10. 常见问题(FAQ)

| 现象 | 原因 | 处理 |
|---|---|---|
| MCP 握手 401 / RPC 401 | key 无效、被禁用、或用了 admin scope 的 key | 检查 `TOTEM_API_KEY`;`create-key <tenant-id> --scope actions` 重建 |
| 400 `missing x-connection-id` | 请求没带 connection | 确认每个请求都带 `x-connection-id`(header 或 query) |
| 400 `unknown connection` | connection 不存在或不属于该 tenant | `totemctl list-connections <tenant-id>` 核对 |
| `tools/list` 是空的 | allowlist 为空(fail-closed) | 找负责人 `set-allowlist` |
| 调用不在列表里的工具报 `-32602` | 客户端工具列表过期 | 重新 `tools/list`;或该动作确实没开通 |
| 429 `rate_limited` | (tenant, connection) 超每分钟预算(默认 600/min) | 等 `Retry-After`;仍频繁则拆分任务或申请调额 |
| `auth_expired` | 飞书 token 过期/被撤销 | 负责人 `oauth-start --connection <id>` 重新授权 |
| `not_found` | 对象被删或 ID 过期 | 用 `search_docs` 重新定位,不要猜测 ID |

## 11. 接入完成清单

- [ ] 拿到 4 项交付物(URL / API key / connection id / 动作清单),key 已入 secret 管理
- [ ] `TOTEM_URL`、`TOTEM_API_KEY`、`TOTEM_CONNECTION_ID` 三变量就位
- [ ] MCP client 配置完成,`tools/list` 能看到动作
- [ ] 冒烟测试通过:`test_connection` + 一个只读动作
- [ ] (代码接入)RPC 调用格式与错误处理决策表已实现,`rate_limited` 有退避
- [ ] (代码接入)客户端 schema 取自 `openapi.json` / `tools/list`,未硬编码简化版
- [ ] 项目里没有 totem 的 key/secret 明文提交

## 12. 事件驱动项目怎么接(webhook 场景)

平台 v1 是**纯拉取** action 层,没有 webhook 推送面(ADR-0011)。如果你的项目是
「webhook 事件驱动 + 定时轮询兜底」模型(如 Emerald),正确姿势:**订阅留在你侧,
执行走 Totem**。

```
上游事件 ──→ 你项目的 webhook handler(直连上游订阅,保留)
                 │  只当“铃铛”:记录事件、入队,不做飞书读写
                 ▼
             你的任务队列 / Celery ──→ POST /actions/rpc   ← 一切飞书读写走这里
             你的定时兜底 / Celery Beat ──→ POST /actions/rpc(增量扫描,防漏事件)
```

要点:

- **事件通道与执行通道职责分离**:webhook 只告诉你“发生了什么”,不产生飞书写
  操作,所以它不经过 Totem 的 allowlist/审计也无妨——治理管的是你响应事件时的
  飞书读写,那部分全走 Totem action,全量审计。
- **身份/权限域差异**:上游事件订阅通常是**应用级**的,而 Totem connection 绑定
  **某个用户**(OAuth)。事件里的对象可能不在该用户权限域内——把 webhook 当铃铛,
  真正读取用 Totem 按 connection 身份做;读不到(not_found/forbidden)就交给
  兑底/告警。
- **流量 vs 限流**:默认 (tenant, connection) 600 次/分钟。事件峰值频率 × 每次
  读取消耗要估算;429 时按 `retryAfterSeconds` 退避(Celery 原生支持)。事件风暴时
  可降级为“只入队不读,由定时兑底补扫”。
- **凭据边界**:订阅用的上游凭据继续留在你侧,不传进 Totem;Totem 只持 connection
  的 OAuth token。

> **未来迁移(v2)**:平台将实现 webhook 投递面(连接器事件 + 连接生命周期事件,
> HMAC 签名,契约已定,见 `docs/standards/consumption-standard.md` §8,依据
> ADR-0011)。届时你只需把事件消费端从“直连上游订阅”换成“平台投递”,执行面不变。
> **建议现在就把事件处理层按标准 §8 的负载格式设计**,迁移时零改动。

---

*这份指南随 totem 演进;契约类内容(动作 schema、错误码、端点)以
`GET {TOTEM_URL}/actions` 与仓库 `docs/adr/`(0002、0005、0007、0008、0010、0011)为准。*
