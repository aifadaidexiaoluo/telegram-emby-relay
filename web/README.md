# TanStack Start 全栈工作台

本目录是完整应用，使用 React / TypeScript、TanStack Start、shadcn/ui 和 Node.js 24。七个页面：`/`、`/downloads`、`/series`、`/accounts`、`/channels`、`/scans`、`/settings`。服务端也在本目录，不需要 Python 或独立后端。

```sh
npm ci --include=dev
cp .env.example .env
chmod 600 .env
npm run dev
```

`TG_API_ID` / `TG_API_HASH` 由服务端环境提供。Emby 接口地址与 API Key 可以直接在设置页填写，留空 Key 保留已有值；环境值为未在页面配置时的默认值。填写地址为 API 基地址，例如 `http://emby:8096/emby`。

```sh
npm test
npm run typecheck
npm run build
node --env-file=.env .output/server/index.mjs
```

Nitro 启动插件恢复 Telegram 账号和后台调度，关闭时等待文件发布与记账并释放会话。`.output` 是生产产物，部署需挂载独立状态、配置、媒体和临时目录；`Dockerfile` 已准备 UID 1000 可写目录。完整 Docker 和旧状态迁移流程见 [根 README](../README.md)。

浏览器只调用 Start Server Functions；所有写操作使用 POST，并验证 `WEB_ORIGIN` 和 JSON 内容类型。服务端函数直接调用 `src/server/runtime.ts`，不依赖网络转发或管理令牌。`RELAY_TEST_MODE` / `RELAY_TEST_PROXY_URL` 只供隔离回归，代理限制为 `127.0.0.1:18765/18766`，生产环境不设置这些变量。

`src/server/` 分别负责配置和匹配、SQLite、Telegram MTProto 传输／账号、扫描、文件下载发布、Emby 刷新和调度。数据库保留原复合主键，媒体 ID 用十进制字符串跨接口传递，避免 JavaScript 数字精度损失。配置原子保存且有上一版本备份；Emby Key 持久化在私密配置中，状态响应与客户端查询缓存不回显保存的 Key。

页面维持草稿、影响检查、版本冲突确认、在途下载／补扫保护。状态每 10 秒更新，任务每 3 秒更新；配置草稿只留在页面内存，主题偏好可写入 localStorage。Telegram 登录凭据通过 POST 传递，不写日志或浏览器存储。

```sh
npx playwright install chromium
npm run test:e2e
npm run test:integration
```

只使用独立临时数据和内部隔离环境，不访问线上入口，不复用真实凭据、会话或媒体卷。普通回归是 `13000/18765`；集成测试是 `13001/18766`，后台使用真实 TypeScript 代码、临时 SQLite 和媒体，只模拟 Telegram 传输。`tests/runtime-fixture.ts` 不进入生产容器。验收不能替代真实 Telegram 或 Emby 索引验证。
