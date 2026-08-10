# Emerald 接入 Totem:按标准调整清单

> 给 Emerald 项目(开发者/agent)的落地指引。契约依据:
> `docs/standards/consumption-standard.md`(下文简称「标准」);操作手册:
> `docs/integration-guide.md`。**调整前先读标准 §0 总览,理解两层契约(人类可读
> 文档 + 机器可读 OpenAPI:`GET {TOTEM_URL}/openapi.json`,无认证)。**

## 0. 背景与边界

- Totem v1 是**纯拉取** action 层,无 webhook 投递面(ADR-0011);事件订阅 v1
  留在 Emerald 侧,执行走 Totem。平台 v2 将提供投递,契约已定(标准 §8)。
- Emerald 现有模型(webhook 事件驱动 + Celery Beat 兜底)保持不变;接入 = 把
  事件触发的飞书读写从「直连飞书 API」换成「调 Totem action」。
- 建议先做**只读试点**:Celery Beat 兜底扫描走 Totem,主路径不动,可随时回滚。

## 1. 前置(一次性)

- [ ] 拿到 4 项交付物:`TOTEM_URL` / `TOTEM_API_KEY`(actions scope)/
  `TOTEM_CONNECTION_ID` / 开通动作清单;key 入 secret 管理,不进代码库
- [ ] Allowlist 开通只读动作:`search_docs get_doc_content get_doc_metadata`
  (试点期不要开写动作)
- [ ] 确认动作 schema:`GET {TOTEM_URL}/openapi.json`(REST,`components.schemas.<action>_input/_output`,无认证)或 `tools/list`(MCP)——**不要**按本文档示例硬编码参数,以实际契约为准

## 2. RPC 客户端(标准 §1–§4)

- [ ] 客户端从 `openapi.json` 生成(openapi-python-client 等)或对照其 schema
  实现——**不手抄 schema 简化版**(机器契约见标准 §0 两层)
- [ ] 一个函数封装 `POST /actions/rpc`:`Authorization: Bearer <key>` +
  `x-connection-id` header,body `{action, args}`
- [ ] 错误决策表落地(标准 §4):`retryable: true` 才重试;
  - 429 → 等 `retryAfterSeconds` / `Retry-After` header,指数退避
  - `validation_error` → 读 `details` 修正参数(不重试)
  - `auth_expired` → 通知平台负责人 re-auth(`oauth-start --connection`),
    Emerald 不自行处理
  - `forbidden` / `not_found` / `upstream_error` → 上报/告警,不重试
- [ ] list 动作按 **List Envelope**(标准 §7,现行契约)写翻页:
  `result.data` 是条目数组,`result.next` 当前恒 `null`;将来 cursor 落地是
  加性字段,现有代码不破
- [ ] 冒烟:手动调一次 `search_docs`,确认返回 `{data: [...], next: null}`,
  并在审计里看到记录(`totemctl query-audit <tenant-id>`)

## 3. 事件处理层(按标准 §8 设计,为 v2 迁移铺路)

- [ ] **事件负载标准化**:webhook handler 收到上游事件后,归一化为标准平台
  事件形状再入队(标准 §8.2):

  ```json
  {
    "event": "connection.created",
    "tenant_id": "...",
    "connection_id": "...",
    "record_type": "connection",
    "record_id": "<connection_id>",
    "provider": "feishu",
    "event_date": "<ISO 8601>",
    "sent_at": "<ISO 8601>"
  }
  ```

  (v1 阶段 Emerald 收到的是上游原始事件,把它映射成这个形状;v2 平台投递
  落地后,入口换成平台 webhook,处理层零改动。)
- [ ] **签名校验预留**:handler 里预留 HMAC-SHA256 校验函数(HMAC-SHA256 over
  raw body、base64url、常量时间比较),secret 从环境变量读;v1 直连期可先
  校验上游签名,v2 换 `x-totem-signature`
- [ ] **双重配置理解**:事件投递需要「webhook 端点存在 AND 事件启用」;
  v1 直连期由 Emerald 自行保证订阅存在,将来平台期按此规则配
- [ ] 事件到达只入队,不直接读写飞书;飞书读写全部在 Celery 任务里走 Totem

## 4. Celery Beat 兜底(试点建议)

- [ ] 定时任务调 Totem RPC 增量扫描(如 `search_docs` + 本地水位记录),
  代替直连飞书扫描
- [ ] 429 退避接入 Celery 重试(`countdown=retry_after`),避免事件风暴打爆
  (tenant, connection) 限流预算(默认 600/min)

## 5. 红线

- [ ] `TOTEM_API_KEY` / 上游订阅凭据不入代码库、不进提交历史
- [ ] 只存 opaque ID(`doc_id` 等),不解析、不传系统 token
- [ ] admin-scope key 不用于日常调用(它等价平台管理员,标准 §0 信任模型)

## 6. 完成标准

- [ ] 只读试点跑通:Beat 扫描 → Totem RPC → 数据回写,审计可见
- [ ] 事件处理层已按 §8 负载格式设计,迁移预留就位
- [ ] 回滚路径明确:关掉试点配置即回到直连飞书
