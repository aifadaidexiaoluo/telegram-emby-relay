# 管理接口契约（TanStack Start）

浏览器调用 `web/src/lib/api.ts` 的 Start Server Functions，服务端直接访问同进程 `ManagementRuntime`。产品不再提供或依赖 Python `/internal` HTTP 服务。网页维持无网站登录的内网管理入口；所有写操作校验精确 Origin 与 `application/json`，非本机入口必须配置 `WEB_ORIGIN`。

| Server Function | 方法 | 行为 |
| --- | --- | --- |
| `readState` | GET | 账号、频道、扫描、计数、业务配置、版本、Emby 状态 |
| `readDownloads` | GET | 状态／作品／频道／搜索筛选，页大小 50 |
| `writeManagement` | POST | 验证并执行下列固定操作 |

返回 `ApiResult<T>`：`{ok:true,data:T}` 或 `{ok:false,error:string,status:number,retry_at?:number}`。来源拒绝是 403，格式错误由 Start 验证器拒绝，版本冲突／在途操作为 409，Telegram 限流为 429 并提供秒级 Unix 重试时间。读取与写响应不缓存，错误不包含凭据或原始 Telegram 请求。

| action | 字段 | 行为 |
| --- | --- | --- |
| login | name, phone, account_id? | 创建 5 分钟有效的登录流程 |
| code | id, code | 校验验证码，可能转入 password |
| password | id, password | 两步验证完成授权 |
| resend / cancel | id | 重发验证码／取消临时会话 |
| logout | id | 检查负责频道和任务后退出账号 |
| config | version, config | 原子备份与保存、重建扫描、取消不允许任务 |
| scan | since, until, channel? | 补扫已配置频道，时间必须含时区，结束不包含 |
| retry | channel, message | 重新入队失败任务，继续遵守最新集数和白名单 |

Config 原字段保持不变，新增 `emby_base_url?: string` 和写入专用 `emby_api_key?: string`。地址允许 HTTP(S)，禁止用户名／密码、查询参数和 fragment，刷新路径为 `/Library/Refresh`。Key 必须非空且不含换行；省略 Key 保留已配置值。环境变量提供默认值，页面保存的值优先。

Config 的频道只需要 `url`（兼容 `id`），`account_id` 可选，未指定时自动尝试可访问的已登录账号。旧频道 `series` 字段仅为读取兼容，所有频道均匹配完整作品列表。允许先添加频道再添加作品；应用作品／AI 识别配置变更后自动从全部频道历史重新搜索。新增频道也会搜索全部历史。

`categories?: string[]` 定义单层媒体分类目录，`series[].category?: string` 必须引用其中一项；未分类使用 `TV`。`MEDIA_ROOT` 为各分类共同的父目录。分类变更仅影响后续下载，保留已有文件。

`ai?: {enabled:boolean,base_url:string,model:string,api_key?:string}` 配置兼容 OpenAI 的识别接口。规则无法识别作品／集数时调用 `<base_url>/chat/completions`，仅发送文字与文件名，限制输出为已配置作品与有效季集；接口错误会保留扫描游标并重试。AI 地址同样限制为无凭据／查询参数／fragment 的 HTTP(S) URL，省略 `api_key` 保留旧值，关闭功能使用 `enabled:false`。

状态响应的 `config` **删除 emby_api_key 和 ai.api_key**，只返回 Emby 密钥状态 `emby.configured`；`version` 覆盖完整私密配置的版本。配置文件和上一版本备份用 `0600` 保存，不能公开。媒体 `document_id` 返回十进制字符串，与旧 64 位 SQLite INTEGER 等值；其他安全范围整数仍为 number。

测试中的 `/internal` 仅为 `tests/runtime-fixture.ts` 和 `tests/mock-management.mjs` 提供的隔离桥接接口，使用独立测试令牌并只监听内部回环端口；它们不部署到产品。
