# Totem 消费面接入标准(Consumption Standard)

> 本文档是 totem 消费面的**契约标准**,对齐 StackOne 开放标准(研究:
> `docs/research/stackone-protocols.md`、`stackone-governance.md`)。接入方
> (agent、工程师、CI)遵循本文档调整自己的代码,无需逐项询问平台。
>
> 状态标记:**✅ 已实现** · **⚠️ 差异(totem 有意简化)** · **🚧 v2 预记录
> (契约现在定死,落地后接入方零改动迁移)**

## 0. 标准总览

| 契约领域 | 标准来源 | totem 状态 |
|---|---|---|
| 认证 | StackOne: API key + `x-account-id` | ✅ Bearer key + `x-connection-id`(⚠️ Bearer 非 Basic) |
| 动作调用 | StackOne `POST /actions/rpc` envelope | ✅ `{action, args}`(⚠️ 无 path/query/body 拆分) |
| 响应 | StackOne 统一响应 envelope | ✅ 动作统一输出 + `structuredContent` |
| 错误 | StackOne `error_category` + `retryable` | ✅ 七码 + `retryable` + HTTP 映射 + `Retry-After` |
| 发现 | StackOne `GET /actions` + `POST /actions/search` | ✅ 元数据 + 文本搜索(⚠️ 语义搜索 v2) |
| MCP | MCP 开放协议(Streamable HTTP) | ✅ 工具列表按 allowlist 过滤(隐藏而非拒绝) |
| 分页 | StackOne cursor(`next`/`next_cursor`) | ✅ list 输出 `{data, next}`(ADR-0012);cursor 已落地(#42/#50) |
| 机器可读契约 | OpenAPI 3.1(生成于注册表,非手写) | ✅ `GET {TOTEM_URL}/openapi.json`(无认证)+ CI 漂移门禁 |
| 事件/Webhook | StackOne webhook 契约(HMAC 签名、双 secret、双重配置) | 🚧 v2 落地(ADR-0011),契约已定,见 §8 |
| 目录演进 | StackOne connector semver + 破坏性变更分级(无动作级 deprecation) | ✅ 分级表 + deprecation + 覆盖缺口信号(ADR-0014),见 §11 |

一条总则(照搬 StackOne 架构结论,ADR-0008):**注册表是唯一事实源,REST 与
MCP 都是它的投影**——接入方在任何消费面上看到的行为(参数、错误、输出)必然一致,
不存在第二套语义。

本标准分**两层**,内容同源:本文档(人类可读)+ 机器可读 OpenAPI(生成于注册表,
发布在 `GET {TOTEM_URL}/openapi.json`,无认证,CI 锁定不漂移)。两层以生成物
为准——它直接出自注册表,永远最新。

## 1. 身份与认证(✅)

每次调用携带两个值:

| Header | 值 | 说明 |
|---|---|---|
| `Authorization` | `Bearer <tenant-api-key>` | actions scope 的 tenant key(⚠️ StackOne 用 HTTP Basic,`<api_key>:`;totem 用 Bearer,语义等价,已定不再改) |
| `x-connection-id` | `<connection-id>` | 选定向哪个已授权连接执行;query 参数兜底(`?x-connection-id=`)。语义 = StackOne `x-account-id`(每请求选账号) |

- key 无效/被禁用/非 actions scope → HTTP 401,任何消费面一致;
- 缺少 `x-connection-id` → HTTP 400;
- 连接不存在或不属于该 tenant → HTTP 400 `unknown connection`。

## 2. 动作调用标准(✅)

**REST:**

```
POST {TOTEM_URL}/actions/rpc
Body: { "action": "<action-name>", "args": { ... } }
```

- `action`:注册表动作名(如 `create_doc`),必填非空;
- `args`:动作输入 schema 的扁平对象,可选(默认 `{}`);
- envelope 形状违规(非 JSON、缺 action、args 非对象)→ HTTP 400,不进入执行。

⚠️ **与 StackOne 的差异(有意为之,ADR-0008)**:StackOne 的 RPC body 是
`{action, path, query, body, headers}` 五段式,因为它支持任意 provider 的任意
REST 动作;totem 的注册表是 schema-first 的,动作的输入就是一张扁平 schema,没有
"位置参数"概念——拆成五段只会制造两套参数形状。**接入方按 `{action, args}` 写
代码;如果未来 totem 出现带位置参数的动作,由平台在 args 内投影,wire 形状不变。**

**MCP**(协议标准同 MCP 规范):`tools/call` 的 `arguments` 就是同一个 `args`;
`tools/list` 返回的 inputSchema 就是注册表 schema 原样。REST 与 MCP 参数形状
不可能漂移。

## 3. 响应标准(✅)

- **成功**:动作的统一输出(如 `{"doc_id": "...", "title": "..."}`)。REST 直接
  是输出 JSON(HTTP 200);MCP 是 `content[0].text` = 输出的 JSON 字符串,当输出
  是对象时附 `structuredContent`。
- **输出里的 ID 是 opaque ID**(`doc_id` 等):接入方只存、只传,不解析含义;
  ID 的语义只由平台连接器掌握(对齐 StackOne "agents reference objects by
  opaque IDs")。
- **失败**:见 §4。MCP 的失败是**结果**(`isError: true`),不是 JSON-RPC 异常
  (对齐 StackOne: tool failures are results)。
- **二进制产物(#43,`get_export_artifact`)**:`export_doc` 返回的 URL 需要
  connection 的授权,agent 拿不到——导出闭环由平台代取。输出
  `{artifact_id, content_type, size_bytes, content_base64}`:base64 编码的字节
  (docx/pdf 是二进制,不存在可读文本形态)、上游报告的 MIME 类型、原始字节数。
  `artifact_id` 是 opaque ID(只存、只传、不解析)。**平台级 10 MiB 原始字节
  上限**:超限返回 `upstream_error`(不可重试——重试产物也不会变小),接入方
  应改用更小的文档/格式或引导用户自行下载。Defender 对二进制产物**不做声明**:
  超过 1 MiB 的响应本就被尺寸守卫跳过(“无 metadata = 无声明”),更小的 base64
  产物虽可扫描但注入指令签名不可能匹配 base64 文本——这是诚实标注的边界能力,
  不是静默豁免;能扫描的文本面(`get_doc_content` 等)防护不变。

## 4. 错误标准(✅)

统一错误体(所有消费面一致):

```json
{
  "code": "rate_limited",
  "message": "...",
  "retryable": true,
  "retryAfterSeconds": 30,
  "upstream": { "code": "...", "message": "..." },
  "details": { ... }
}
```

七码与 HTTP 映射(⚠️ StackOne 的 `error_category` 没有公开枚举,研究明确建议
totem 自定枚举——这就是 totem 的枚举):

| code | HTTP | retryable | 接入方行为 |
|---|---|---|---|
| `validation_error` | 400 | ✗ | 读 `details`(ValidationIssue[])修正参数 |
| `action_not_found` | 404 | ✗ | 动作名不存在;先 discovery 确认 |
| `forbidden` | 403 | ✗ | 不在 allowlist 或 defender 拦截;上报,勿重试 |
| `auth_expired` | 401 | ✗ | 连接 token 失效;触发 re-auth 流程 |
| `not_found` | 404 | ✗ | 上游对象不存在(opaque ID 失效) |
| `rate_limited` | 429 | ✓ | 等 `retryAfterSeconds` / `Retry-After` header,退避重试 |
| `upstream_error` | 502 | ✗ | 上游故障;上报/告警,勿死循环 |

规则只有一条:**`retryable: true` 才重试,其余修正或上报。** 对齐 StackOne
"429/408 带 Retry-After;provider 侧 429 自动重试"的语义——totem 不做平台侧
自动重试,重试是接入方的职责(信号已给全)。

## 5. 发现标准(✅)

| 端点 | 用途 | 认证 |
|---|---|---|
| `GET {TOTEM_URL}/actions` | 全部动作元数据(`name`/`description`/`effects`,✅ +`provider` 见 §11;✅ +`deprecated` 见 §11),hidden 动作不出现 | actions key(Bearer),无需 connection |
| `POST {TOTEM_URL}/actions/search` | 文本搜索,body `{query}`(大小写不敏感子串匹配;⚠️ StackOne 是语义搜索,BM25+embedding,totem v2) | 同上 |
| `GET {TOTEM_URL}/openapi.json` | 机器可读契约(OpenAPI 3.1):每个动作 `components.schemas.<action>_input/_output` + `ActionError` 错误组件 | **无认证**(平台级契约元数据,非租户数据) |

对齐 StackOne 的发现哲学:metadata 是注册表的只读投影,驱动 agent 工具列表、
代码动态适配。**接入方不要在代码里硬编码动作清单,从 `GET /actions` 或
`tools/list` 读取。**

### 5.1 副作用分级(effects,✅ 含破坏类,ADR-0018)

每个动作声明一个副作用分级 `effects`,消费面一致投影(MCP 见 §6.1):

| effects | 含义 | 接入方行为 |
|---|---|---|
| `read` | 不改变任何状态 | 自由调用 |
| `write` | 改变状态,但不摧毁对象本身 | 正常调用 |
| `destructive` | 不可逆删除——从平台/agent 的世界里对象永久消失(上游可能移到回收站,但恢复是**人类**在上游 UI 的操作,agent 无法做到) | **先向用户确认再调用**;MCP 面为 `destructiveHint: true` |

破坏类(`destructive`)的治理契约(平台侧保证,接入方可信):

- **永不隐式进 allowlist**:新连接 allowlist 为空(fail-closed,拒绝一切);
  任何包含破坏类动作的 allowlist 写入都必须带运营方的显式
  `allowDestructive: true` 确认(§6),因此 agent 看不到未经确认的删除工具——
  `tools/list` 没出现就是没有权限(§6);
- **每次执行必留审计**:破坏类动作的成功与失败都写入审计日志
  (`metadata.effects = 'destructive'` 戳记),即使租户开启了 error-only
  审计模式;运营方可用 `?destructive=true` 查询;
- **入参失败关闭扫描**:破坏类动作的参数在派发前经 Defender 扫描,高危注入
  指令无论租户的 `blockHighRisk` 开关如何都拦截为 `forbidden`(Tier-1 签名
  扫描,诚实标注);
- 调用语义与其它动作完全一致(同一 envelope、同一七码错误、`forbidden` =
  未授权,勿重试);`effects` 分级变化按 §11.2 的 major 流程通告。

首个破坏类动作(`#44`):`delete_doc`(canonical:删文档;飞书把文件移入系统
回收站,仅人类可恢复)、`feishu_delete_bitable_records`(provider-native:批量删
多维表格记录,1–500 条/次)。

## 6. MCP 标准(✅)

- 传输:Streamable HTTP,挂载 `{TOTEM_URL}/mcp`(与 StackOne `api.stackone.com/mcp`
  同构;StackOne 是一 account 一端点,totem 是单端点 + 每请求 `x-connection-id`)。
- **工具列表 = 注册表 ∩ allowlist ∩ 连接器实现**(ADR-0002 隐藏而非拒绝;
  对齐 StackOne "tool catalog generated from the account's enabled actions")。
  `tools/list` 没出现的工具 = 没有权限,不要猜。
- 调用未知工具 → JSON-RPC `-32602`(stale 工具列表,对齐 StackOne)。
- 成功/失败语义见 §3/§4。

### 6.1 工具注解(effects 投影,ADR-0018 含破坏类)

`tools/list` 按 `effects` 附带注解:`read` → `readOnlyHint: true`;
`destructive` → `destructiveHint: true`;普通 `write` 不带注解(不得标记为
破坏类)。agent 客户端应把 `destructiveHint: true` 的工具视为需要用户确认的
操作(§5.1)。

## 7. 分页 / List Envelope(✅ 已实现,ADR-0012)

list 动作的输出统一为 `{data, next}`(对齐 StackOne actionType=list;早期
ADR-0006 的“命名列表字段”约定已由 ADR-0012 取代):

- `data`:条目数组(条目字段以 `openapi.json` 的 `<action>_output` schema 或
  `tools/list` 为准,如 `doc_id`/`title`/`doc_type`);
- `next`:游标。**cursor 已落地(#42,tracking #50)**:还有更多结果时为非空翻页
  token,最后一页为 `null`;接入方把 `next` 原样传回同名动作的 `page_token` 输入
  参数即可取下一页(对齐 StackOne `next_cursor`)。无 cursor 能力的 provider 恒返
  `null`(单页即全部);不支持翻页的调用方忽略 `next` 也不破——只是只见一页;
- **身份字段保留在顶层**:调用者需要据以行动的对象标识(如 `doc_id`、`range`、
  `table_name`、`record_id`)与 `data` 平级,不塞进条目;
- cursor 落地是行为变更(Major,ADR-0014):`next` 不再恒 `null`,但输出形状不变
  ——`data` 与顶层身份字段不动,只断言 `next === null` 的代码需要复盘是否应改为
  跟随翻页(迁移窗口见 tracking #50)。

MCP 与 REST 同构:`tools/call` 的 `structuredContent` 就是这个对象。

## 8. 事件 / Webhook 标准(🚧 v2 落地,契约现在定死)

平台 v1 无 webhook 投递面(ADR-0011)。**本契约预记录,接入方现在就可以按它
设计事件处理层**,平台投递落地后只换入口、处理层零改动。

### 8.1 两类事件(对齐 StackOne)

1. **平台事件(连接生命周期)**:`connection.created` / `connection.updated` /
   `connection.deleted`(对齐 StackOne `account.created/updated/deleted`)。订阅在
   webhook 本身上配置。
2. **连接器事件(上游数据变化)**:由连接器/连接定义,平台按 connection 自动
   订阅(programmatic,对齐 StackOne)或手动配置;事件类型以平台发布的
   `GET /actions` 元数据(`event_actions`)为准。

### 8.2 平台事件负载(对齐 StackOne platform-events)

```json
{
  "event": "connection.created",
  "tenant_id": "...",
  "connection_id": "...",
  "record_type": "connection",
  "record_id": "<connection_id>",
  "provider": "feishu",
  "event_date": "<ISO 8601>",
  "sent_at": "<ISO 8601>",
  "origin_owner_id": "<tenant_id>",
  "origin_owner_name": "<tenant name>"
}
```

(字段逐一对应 StackOne:`project_id → tenant_id`、`account_id → connection_id`;
totem 无 `origin_username`——连接由 tenant 的 API key 认证,没有端用户身份。)

### 8.3 投递契约(逐条照搬 StackOne,研究 §4.3)

- **签名**:HMAC-SHA256 over **原始 request body**(不是 re-serialized JSON),
  base64url,放 `x-totem-signature` header(与 StackOne 契约同构,仅 header 名
  不同——算法、比较、轮换逐条照搬);用 `timingSafeEqual` 常量时间比较。
- **双 secret 轮换**:新旧 secret 并行,两端都接受,确认后再激活/删除。
- **端点要求**:快速返回 200,响应体被忽略;5xx 会触发平台重试(对齐 StackOne
  "5xx loops" 语义,投递失败有日志可查)。
- **双重配置(缺一不可)**:webhook 端点必须存在 **且** 事件在
  连接/连接器上启用——对齐 StackOne "enabled on profile AND routed to webhook,
  you need both"。
- **典型用途**:`connection.created` = OAuth 完成的异步信号(对齐 StackOne Auth
  Link 无前端回调的场景);`connection.updated/deleted` 替代轮询连接状态。

### 8.4 v1 过渡期的接入方行为(ADR-0011)

v1 阶段平台不投递:接入方直连上游订阅,但**事件处理层按本标准的负载格式设计**
(把上游事件归一化为 §8.2 形状再入队),平台投递落地后迁移成本 = 换一个入口。

## 9. 与 StackOne 的差异一览(接入方对照)

| 维度 | StackOne | totem | 性质 |
|---|---|---|---|
| 认证 | Basic `api_key:` | Bearer | ⚠️ 语义等价,已定 |
| 账号寻址 | `x-account-id` | `x-connection-id` | ✅ 同构改名 |
| RPC envelope | `{action, path, query, body, headers}` | `{action, args}` | ⚠️ schema-first 简化(ADR-0008) |
| 错误枚举 | `error_category`(未公开枚举) | 七码显式枚举 + `retryable` | ✅ 对齐且更强 |
| 搜索 | 语义搜索(embedding) | 子串匹配 | ⚠️ v2 语义搜索 |
| MCP tool-mode | individual / search_execute | individual 单模式 | ⚠️ 目录小(<50),暂不需要 |
| 自动重试 | 平台侧 provider 429 自动重试 ≤5 次 | 无平台自动重试,信号给全 | ⚠️ 接入方职责 |
| 限流 | 1000 req/min/key | (tenant, connection) 预算,默认 600/min | ⚠️ 粒度不同,语义一致 |
| List envelope | actionType=list → `{data, next}` | `{data, next}` + 顶层身份字段 | ✅ 对齐(ADR-0012;曾偏离于 ADR-0006) |
| Webhooks | 生产可用 | v2 预记录(§8);签名契约同构,header 为 `x-totem-signature` | 🚧 |
| A2A / Agent SDK | 开放协议 + SDK | 不提供(内部平台,研究已排除) | — |
| 连接器版本化 | semver pin per profile | 约定已记录,机制 v2 | 🚧 |
| provider-native 动作 | `custom` actionType,裸上游输出 | `<provider>_` 前缀 + curated 输出(平台惯例不破,ADR-0013) | ⚠️ 有意更强 |
| 动作级 deprecation | 无政策(pin 即安全网) | `deprecated` 字段 + sunset + MCP 描述警告(ADR-0014) | ✅ 超越 |
| 破坏类治理 | 无显式概念(删除即普通动作) | `destructive` 分级 + 显式 allowlist 确认 + 入参失败关闭扫描 + 必留审计(§5.1,ADR-0018) | ✅ 超越 |

## 10. 接入方对照调整指南(怎么用本标准)

1. **agent 接入**:对照 §1(认证)、§6(MCP)、§4(错误)——按标准配置 client,
   `tools/list` 即契约,无需改代码;
2. **代码接入**:对照 §2/§3/§4/§5 写 RPC 客户端(一个函数 + 错误决策表)。
   机器契约在 `GET {TOTEM_URL}/openapi.json`(无认证):每个动作的输入/输出
   schema 在 `components.schemas.<action>_input` / `<action>_output`,错误契约
   在 `components.schemas.ActionError`——**可直接喂客户端生成器**
   (openapi-generator / openapi-python-client 等);动作清单仍可从 `GET /actions`
   动态读取,不硬编码;
3. **事件驱动接入(如 Emerald)**:现在按 §8 设计事件处理层(标准负载 + 标准
   签名校验预留 + `{data, next}` 风格翻页),上游直连只作为 v1 临时入口;
4. **迁移承诺**:平台在 v2 落地 §7/§8 时,已按本标准实现的接入方**零改动**
   或仅改入口;契约变更走 ADR 流程并在此文档同步,不静默修改。

## 11. 目录演进政策(✅ 契约定死,registry 机制已落地;ADR-0013 / ADR-0014)

动作目录会生长(provider-native 动作、晋升、废除),本节是接入方的稳定性契约。

### 11.1 canonical 与 provider-native 动作(ADR-0013)

- **canonical 动作**:裸名(`create_doc`),任何 connector 均可实现;
- **provider-native 动作**:`<provider>_` 前缀名(`feishu_read_bitable_records`),
  只有该 provider 的 connector 能实现;输出仍是 curated schema(opaque ID、统一
  错误词表、全量校验),scope 只限制可用性与词汇,不动治理不变量;
- agent 信号 = 名称前缀;`GET /actions` 暴露结构化 `provider` 字段(✅,T19a),
  canonical 动作省略该键;
- 覆盖缺口 ≠ scope:canonical 动作某 provider 未实现(如 dingtalk 暂无
  `export_doc`),只是该 provider connection 的工具列表里没有它(§6)。

### 11.2 变更分级(ADR-0014)

| 级别 | 变更 | 接入方 |
|---|---|---|
| **minor(安全)** | 新增动作(两种 scope);新增可选 input 参数 / 可选 output 字段;挂 `deprecated` flag;description 修订 | 无需动作 |
| **major(破坏性)** | 移除 / 改名动作;移除 / 改名字段;行为变化(分页 / 过滤 / 错误语义 / 默认值);`effects` 分类变化 | 提前通告 + 迁移窗口 |

major 变更一律走 issue 通告 + 逐案约定迁移窗口(当前消费方为两个互信内部项目,
ADR-0010);目录无版本号,pin 机制 v2。

### 11.3 deprecation(ADR-0014,超越 StackOne——其无动作级政策)

- `deprecated: { replacement?, sunset?, note? }`;有 `replacement` 必有 `sunset`
  (✅ 注册期强制,T19b:replacement ⇒ sunset 必填、`sunset` 须为 `YYYY-MM-DD` 日历日期;
  replacement 无需已注册——废除可先于后继动作落地);
- sunset 前:动作照常广告、照常执行;MCP 工具描述自动加 `[DEPRECATED …]` 前缀
  (✅,T19b),注册表的存储描述保持干净——接入方应在 agent 侧把该前缀视为迁移指令;
- sunset 到点:移除,按 major 流程;
- provider-native 晋升路径:第二 provider 长出可统一的等价能力时,**新增**
  canonical 动作并 deprecate 旧 native 动作;native 名永不复用、永不改名。

### 11.4 覆盖缺口信号(ADR-0014)

- **output**:provider 给不了的可选字段 = `null`,不报错(对齐 StackOne
  null-for-unsupported);
- **input**:provider 兑现不了的可选参数 = `validation` 错误,**不会静默忽略**
  (否则 agent 误以为参数已生效)。

### 11.5 消息域(ADR-0016)

首个非文档 canonical 动作 `send_message` 进入目录:纯文本内容,寻址为
`{ email, chat_id }` 恰好取一(`email` = 自然键,`chat_id` = opaque 群 ID);
以连接所有者身份发送。飞书首批实现;钉钉、企微为路线图后续批次(未实现的
provider = 覆盖缺口,§11.1)。接收消息方向属 v2 事件面(§8),不在动作目录。

---

*标准来源:StackOne 官方文档(webhooks / platform-events / Actions RPC OpenAPI /
MCP / A2A,研究快照见 `docs/research/`);totem 侧契约以代码 + ADR
(0002、0005、0008、0011、0013、0014、0016)为准。*
