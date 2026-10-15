# 开发说明

当前全栈是 TanStack Start + TypeScript + Node 24；运行、Docker 部署、状态迁移和测试命令见 [README](../README.md)，接口见 [management-api.md](management-api.md)。

浏览器调用 `web/src/lib/api.ts` 的服务端函数，再由 `management.server.ts` 访问 `web/src/server/runtime.ts`。Nitro 启动插件初始化后台，退出 hook 关闭后台。无 Python 依赖，无独立生产 API 端口。

后台模块：

- `config.ts`：环境与配置读取、原子私密保存、版本、白名单匹配和目录生成。
- `database.ts`：旧表兼容、下载队列、最新剧集选择、频道检查点和 Emby 刷新代数。
- `telegram.ts`：teleproto MTProto 适配、旧 Telethon 会话只读转换、事件和流式下载。
- `accounts.ts`：登录流程、两步验证、限流、恢复、账号身份校验和注销。
- `source.ts`：相册上下文、事件入队、历史／回看扫描、游标与扫描代数。
- `download.ts`：空间预留、来源与大小校验、原子无覆盖发布、失败重试与恢复。
- `emby.ts`：合并刷新、Retry-After 和失败退避。
- `runtime.ts`：全局调度、账号频道绑定、配置热更新、补扫、查询及单实例状态锁。

配置写入串行化。在途下载或补扫时拒绝应用配置。所有频道扫描完后才放行限量作品；扫描代数防止旧扫描完成结果放行新一轮尚未完成的候选。不同账号可并行扫描，一个账号的频道逐个扫描。Telegram 媒体 ID 永远用十进制字符串传递，数据库用 BigInt 写 INTEGER，查询只选 CAST 文本列，避免 Node 在读原列时先触发范围错误。

Emby Key 是写入专用配置字段。状态和成功响应不含 Key，客户端配置成功缓存也删除 Key。环境值作为默认值；配置／备份文件权限 0600。改动相应行为时需验证秘密不会进入状态、浏览器存储、静态资产或错误。

验证只使用隔离临时目录与 `13000/18765`、`13001/18766`，不访问线上入口或复用真实凭据、会话及媒体卷。`npm test` 覆盖真实 SQLite 与文件发布，`test:integration` 运行完整后台，只替换 Telegram 传输。迁移见 [migration.md](migration.md)。
