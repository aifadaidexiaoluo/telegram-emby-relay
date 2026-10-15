# Telegram / Emby 媒体工作台

一个自托管的中文媒体管理工作台：从已授权的 Telegram 频道扫描视频，按作品规则整理季集、下载到本地媒体库，并通知 Emby 刷新。

项目采用 **TanStack Start、React、TypeScript、Node.js 24 和 SQLite**。网页、Telegram 多账号管理、扫描调度和下载队列运行在同一个 Node.js 服务中，无需独立 API 服务或外部数据库。

## 功能

- **七个管理页面**：概览、下载任务、作品规则、Telegram 账号、频道、扫描记录、全局设置。
- **多账号授权**：验证码登录、两步验证、会话恢复；每个频道指定负责账号。
- **作品匹配**：作品名与别名、排除词、自定义季集正则、固定季号、标题季号映射、中文季集号。
- **跨频道选集**：按季号和集号选择最新 N 集，同一集选择一个来源，优先保留已完成或在途版本。
- **持续扫描**：周期补漏、编辑回看、带时区的时间范围补扫和相册标题继承，保存频道检查点。
- **可靠下载**：SQLite 持久化队列、全局并发、限流等待、失败重试、文件大小校验、原子发布和重启恢复；冲突文件不会被覆盖。
- **Emby 刷新**：在网页配置 API 地址与 Key，合并刷新请求，刷新失败单独重试。
- **配置保护**：草稿预览、影响确认、版本冲突检测、配置原子保存和上一版本备份。

## 环境要求

| 方式 | 要求 |
| --- | --- |
| 本地运行 | Node.js 24 或更高版本、npm、可写的本地存储 |
| 容器部署 | Docker Engine、Docker Compose v2；镜像使用 Node.js 24 Alpine |
| Telegram | 自己的 Telegram 应用 `api_id` / `api_hash`，以及有权访问目标频道的账号 |
| Emby（可选） | 服务可访问的 Emby API 地址、API Key、可读取下载目录的媒体库 |

Telegram 应用凭据可在 [my.telegram.org](https://my.telegram.org/apps) 创建。没有这些凭据时也能启动网页和保存全局设置，添加 Telegram 账号前需要先填写凭据。

**网页没有独立的网站登录系统。** 默认仅监听或发布到回环地址；远程访问应通过有身份验证的反向代理或受控内网提供。`WEB_ORIGIN` 是写操作的来源校验配置，不能代替访问认证。

## 本地快速开始

```sh
git clone https://github.com/aifadaidexiaoluo/telegram-emby-relay.git
cd telegram-emby-relay/web
npm ci --include=dev
cp .env.example .env
chmod 600 .env
```

编辑 `web/.env`，至少填写 Telegram 应用凭据：

```dotenv
TG_API_ID=123456
TG_API_HASH=replace-with-your-own-api-hash
WEB_ORIGIN=http://localhost:3000
```

启动开发服务：

```sh
npm run dev
```

访问 <http://localhost:3000>。本地数据默认写入项目根目录的 `local-data/`，不会加入 Git。路径相对于启动进程的工作目录解析，以上命令应在 `web/` 下执行。

### 首次使用

1. 在「账号」添加 Telegram 账号，完成验证码和可能的两步验证。
2. 在「作品」添加作品名、别名、排除词及季集识别规则。
3. 在「频道」添加账号已加入且有权访问的频道，选择负责账号和需要下载的作品。
4. 检查草稿影响后确认应用；后台开始扫描，任务进度可在「扫描」和「下载」查看。
5. 在「设置」填写 Emby API 基地址，例如 `http://emby:8096/emby`，以及 API Key。服务会请求该基地址下的 `/Library/Refresh`。

Emby Key 保存后不回显；留空会保留已有 Key。页面配置的 Emby 地址和 Key 优先于环境变量。请先在 Emby 中将下载目录添加为媒体库，并确保 Emby 对该目录有读取权限。

### 本地运行构建产物

在 `web/` 下执行：

```sh
npm run typecheck
npm run build
node --env-file=.env .output/server/index.mjs
```

`npm start` 也会运行构建产物，但不会自动加载 `.env`，使用它时需由进程管理器或启动环境提供变量。后台随服务启动，即使没有打开网页，也会恢复账号并执行扫描下载。

## Docker 部署

在仓库根目录执行：

```sh
cp management.env.example management.env
chmod 600 management.env
```

编辑 `management.env`，填写 Telegram 凭据、实际访问入口的 `WEB_ORIGIN`、媒体目录和 Emby 网络名称。Compose 默认加入名为 `emby_media_internal` 的已有外部网络。若尚未创建且准备让 Emby 使用此网络，可执行：

```sh
docker network create emby_media_internal
```

Emby 容器需要加入相同网络，`EMBY_BASE_URL` 中的主机名必须能从工作台容器解析。如果不使用 Emby，这个网络也需存在才能启动当前 Compose。

创建媒体与临时目录；容器默认以 UID/GID `1000:1000` 运行。自定义 `MEDIA_PATH` / `TEMP_PATH` 时相应替换以下路径：

```sh
install -d -o 1000 -g 1000 -m 750 ./local-data/media/TV
install -d -o 1000 -g 1000 -m 700 ./local-data/media/.incoming ./local-data/temp
docker compose --env-file management.env -f compose.web.yaml build
docker compose --env-file management.env -f compose.web.yaml up -d
docker compose --env-file management.env -f compose.web.yaml logs -f web
```

默认入口是 <http://localhost:3000>，端口只发布到 `127.0.0.1`。需要反向代理时，代理上游使用该本地端口，并将 `WEB_ORIGIN` 改成浏览器实际访问的完整来源（协议、主机、端口）。

| 容器路径 | 内容 | 默认持久化位置 |
| --- | --- | --- |
| `/state` | SQLite、账号信息、Telegram 会话与运行锁 | `relay_state` 命名卷 |
| `/configuration` | 当前配置和上一版本备份，可能含 Emby Key | `relay_configuration` 命名卷 |
| `/media/TV` | 最终季集媒体 | `./local-data/media/TV` |
| `/media/.incoming` | 发布过程中的中间文件 | `./local-data/media/.incoming` |
| `/tmp/telegram` | 未完成的下载文件 | `./local-data/temp` |

最终媒体目录和 `.incoming` 必须在同一文件系统。一个状态目录只允许一个工作台实例使用，不要对同一组卷启动多个副本。

## 环境变量

本地示例见 [web/.env.example](web/.env.example)，Compose 示例见 [management.env.example](management.env.example)。所有凭据仅由服务端读取，不应使用 `VITE_` 前缀。

| 变量 | 说明 | 本地默认值 |
| --- | --- | --- |
| `TG_API_ID` / `TG_API_HASH` | Telegram 应用凭据 | `0` / 空；登录前必须配置 |
| `WEB_ORIGIN` | 浏览器入口的完整来源，写操作必须匹配 | 示例中为 `http://localhost:3000` |
| `HOST` / `PORT` | HTTP 监听地址和端口 | 示例中为 `127.0.0.1` / `3000` |
| `STATE_ROOT` | 未单独设置数据库、会话路径时的默认状态根目录 | `../local-data/state` |
| `DATABASE_PATH` | SQLite 数据库路径 | `../local-data/state/downloads.sqlite3` |
| `TG_SESSION_PATH` | Telegram 会话基路径 | `../local-data/state/telegram.session` |
| `CONFIG_PATH` | 可写业务配置路径 | `../local-data/configuration/config.json` |
| `MEDIA_ROOT` | 最终媒体目录 | `../local-data/media/TV` |
| `TEMP_ROOT` | 临时下载目录 | `../local-data/temp` |
| `EMBY_BASE_URL` | 未在网页配置时的 Emby API 基地址 | `http://emby:8096/emby` |
| `EMBY_API_KEY` | 未在网页配置时的 Emby Key | 空 |

Compose 还支持 `WEB_PORT`、`MEDIA_PATH`、`TEMP_PATH`、`TELEGRAM_STATE_VOLUME`、`CONFIG_VOLUME`、`EMBY_NETWORK`，用于设置宿主端口、挂载路径和命名卷／网络。具体默认值见环境示例和 [compose.web.yaml](compose.web.yaml)。

## 配置与下载规则

推荐通过网页管理配置。[config.example.json](config.example.json) 是结构示例，其中频道 ID 是占位值；它不会自动导入。新安装从空的频道和作品列表开始，避免在未经确认时访问频道。

| 字段 | 行为 |
| --- | --- |
| `channels` | 频道 ID 或地址、负责账号 `account_id`、关联作品名 |
| `series` | 作品匹配、排除词、季集规则与最新集数限制 |
| `download_concurrency` | 全局下载并发，默认 `2`，范围 `1–16` |
| `scan_interval_seconds` | 周期扫描间隔，默认 `1800` 秒 |
| `initial_history_days` | 首次历史扫描范围，默认 `7` 天 |
| `edit_lookback_hours` | 编辑回看窗口，默认 `24` 小时 |
| `emby_base_url` / `emby_api_key` | Emby 连接配置，Key 为只写字段 |

季集正则支持 JavaScript 命名组 `(?<episode>...)`，也兼容常见 Python 命名组 `(?P<episode>...)`，必须包含 `episode`。其他 Python 专用语法可能需要调整；无效正则会在保存时拒绝。

最新 N 集按所有已配置频道合并选择。负责频道全部检查完成后才放行限量任务；账号离线时暂停限量选择，可用账号的普通作品仍可下载。Telegram 限流按服务端要求等待，不消耗普通失败次数；普通失败最多重试 8 次，页面提供失败任务重试。存储错误会暂停领取任务 60 秒。

删除频道或缩小作品范围会取消不再允许的未完成任务，**不会自动删除已完成媒体**。Emby 刷新失败也不会触发视频重新下载。

## 备份、升级与迁移

备份前先停止服务，以保证 SQLite、会话、配置和媒体状态一致：

```sh
docker compose --env-file management.env -f compose.web.yaml stop web
```

备份两个命名卷、媒体目录、临时目录及私密环境文件；本地运行时备份整个 `local-data/` 和 `web/.env`。会话等同于账号访问凭据，配置及备份可能包含 Emby Key，应限制访问权限。

升级时先备份，再更新代码并重新构建启动：

```sh
git pull --ff-only
docker compose --env-file management.env -f compose.web.yaml build
docker compose --env-file management.env -f compose.web.yaml up -d
```

不要用 `docker compose down -v` 清理已有部署，它会删除持久卷。恢复备份时也先停止服务，成套恢复状态和配置，保持原有路径及 UID/GID 权限。

项目支持读取既有下载队列与 Telethon SQLite 会话，迁移前必须停止旧进程并保留完整备份，流程见 [迁移说明](docs/migration.md)。

## 开发与验证

```sh
cd web
npm ci --include=dev
npm test
npm run typecheck
npm run build
npx playwright install chromium
npm run test:e2e
npm run test:integration
```

Linux 环境如果缺少 Chromium 系统依赖，可使用 `npx playwright install --with-deps chromium`。

| 检查 | 范围 |
| --- | --- |
| `npm test` | 匹配、选集、SQLite、配置校验、会话迁移、文件发布与 Emby 重试 |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm run build` | 网页和服务端构建 |
| `npm run test:e2e` | `127.0.0.1:13000/18765` 的页面回归，模拟管理数据 |
| `npm run test:integration` | `127.0.0.1:13001/18766` 的真实后台／SQLite／文件集成、构建后离线加密检查及直接启动冒烟测试 |

浏览器测试依赖已有构建产物，先执行 `npm run build`。测试使用独立令牌、临时数据库、会话和媒体目录；Telegram 传输使用模拟实现。所有后续测试、审查与截图都应使用隔离环境，不能连接线上服务或复用真实会话、凭据及媒体卷。模拟测试不代表真实 Telegram 登录、频道权限或 Emby 索引已经验收。

项目使用 npm 和 `package-lock.json` 固定依赖；`.npmrc` 中的 `legacy-peer-deps=true` 是现有依赖树的安装要求，Docker 安装也使用此配置。

## 目录结构

```text
.
├── README.md                 # 安装、使用和运维入口
├── Dockerfile                # 从根目录构建单服务镜像
├── compose.web.yaml          # 单服务与持久化卷
├── management.env.example    # Compose 环境示例
├── config.example.json       # 业务配置结构示例
├── docs/
│   ├── development.md        # 模块与开发约定
│   ├── management-api.md     # Server Functions 接口契约
│   └── migration.md          # 旧状态迁移
└── web/
    ├── src/routes/           # 七个管理页面
    ├── src/components/       # 工作台组件和 UI
    ├── src/lib/              # 类型、校验与服务端函数
    ├── src/server/           # 账号、SQLite、扫描、下载和 Emby
    ├── tests/                # 单元、浏览器及后台集成测试
    ├── public/               # 静态资源
    ├── .env.example          # 本地环境示例
    └── package-lock.json     # npm 依赖锁文件
```

开发模块说明见 [docs/development.md](docs/development.md)，接口契约见 [docs/management-api.md](docs/management-api.md)。本机真实配置、运行数据、历史部署材料和测试产物不属于发布源码。

## 常见问题与已知限制

- **页面能打开但无法登录 Telegram**：检查服务端 `TG_API_ID` / `TG_API_HASH`，修改环境变量后重启服务；账号必须拥有目标频道的访问权限。
- **保存时报来源不匹配**：确认 `WEB_ORIGIN` 与浏览器地址栏的协议、主机和端口完全一致，`localhost` 和 `127.0.0.1` 是不同来源。
- **配置无法应用**：在途下载或补扫期间会拒绝应用；配置版本冲突时需刷新并重新检查草稿。
- **提示状态被占用**：检查是否有旧服务、开发服务或另一个容器正在使用同一 SQLite 目录，不要绕过单实例保护。
- **文件无法发布**：检查磁盘空间、UID/GID 权限以及媒体目录与 `.incoming` 是否在同一文件系统。冲突目标文件需要人工确认，服务不会覆盖它。
- **Emby 没有出现新剧集**：检查媒体库路径映射、读取权限、容器网络、API 基地址和 Key，并查看设置页的刷新错误。
- 相册上下文窗口为前后 20 个消息 ID；短暂断线由周期扫描补齐。媒体大小校验不等于视频解码或内容完整性校验。

请仅处理自己有权访问、下载和保存的内容，并遵守 Telegram 使用条款及适用法律。
