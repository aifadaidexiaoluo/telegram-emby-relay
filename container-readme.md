# 本机容器维护约定

本文件记录当前宿主机的实际部署，后续更新代码、镜像或部署文件时必须保留这些路径约定。通用安装示例仍见 [README.md](README.md)。

## 媒体挂载（2026-11-05 修正）

用户指定的唯一宿主媒体根目录为 `/mnt/wdc/emby`，位于挂载点 `/mnt/wdc` 的磁盘上。

| 服务 | 宿主来源 | 容器目录 |
| --- | --- | --- |
| `telegram-emby-relay-web` | `/mnt/wdc/emby` | `/media` |
| `emby` | `/mnt/wdc/emby` | `/mnt/share` |

relay 的 `MEDIA_ROOT=/media`。默认分类 `TV`、自定义分类和 `.incoming` 均放在此媒体根目录下，发布中间文件与最终文件保持同一文件系统。不能将来源恢复为旧 `/root/github/container/data/emby/data/emby/media`，也不能替换成示例中的 `./local-data/media`。

## 部署配置与更新

- 实际 Compose：[relay 部署定义](../container/projects/telegram-emby-relay/compose.yaml)；Emby 配置见 [Emby 部署定义](../container/projects/emby/compose.yaml)。两者必须共享 `/mnt/wdc/emby`。
- 本仓库的 `compose.web.yaml` 和 `management.env.example` 是通用示例，不是本机运行入口。不要从本仓库执行示例 Compose 来替换生产服务或创建第二个实例。
- 原有 `/state`、`/configuration`、`/tmp/telegram` 继续使用 `/root/github/container/data/telegram-emby-relay/` 下的 `state/`、`configuration/`、`temp/`；不得更换成新的命名卷或空目录。
- 私密环境文件保持在 `/root/github/container/data/telegram-emby-relay/config/runtime.env`，不要复制凭据到仓库或文档。
- docker-server 已用于查询、停止和移除旧 Emby 部署；其当前限制不支持外部共享挂载与外部网络，两项服务均由独立 Compose 维护。不要用 MCP 历史 Emby 配置重新部署。

更新命令从实际部署目录执行：

```sh
cd /root/github/container/projects/telegram-emby-relay
# 确认磁盘已挂载，再检查媒体路径。
mountpoint -q /mnt/wdc && test -d /mnt/wdc/emby
docker compose config --quiet
# 仅调整挂载或运行参数时复用原镜像。
docker compose up -d --no-build --pull never --wait --wait-timeout 120 web
# 更新源码时先备份，再在同一目录构建、启动。
docker compose build --progress plain
docker compose up -d --wait --wait-timeout 120 web
```

检查挂载命令也在上述目录执行：

```sh
docker inspect telegram-emby-relay-web emby --format '{{.Name}} {{range .Mounts}}{{.Source}} -> {{.Destination}}; {{end}}'
```

修改本机部署后同步维护本文、两个实际 Compose，以及 [relay 运行记录](../container/data/telegram-emby-relay/container-readme.md) 和 [Emby 运行记录](../container/data/emby/container-readme.md)。不要仅修改示例文件。启动前的磁盘检查必须成功后才能继续执行启动命令。

## 修正记录与验证

2026-11-05：两个服务停服后备份配置和状态，将旧媒体目录内的 `TV/`、`.incoming/` 复制到新磁盘，原目录保留。新媒体根目录为 relay UID 1000 保留可写 ACL。原有镜像、环境变量、配置和其他挂载保持一致。

备份分别位于两个部署目录的 `backups/20261105-082749-media-path/`，含停服数据归档、校验值、修改前容器信息和 ACL；Emby 备份另含 MCP 状态快照。备份含凭据，仅限本机维护使用。恢复时只恢复所需服务的数据和配置，不要直接用旧 MCP 全局快照覆盖当前其他服务状态。

两个容器均通过健康检查、HTTP 和 Emby API 验证；已验证 relay UID 1000 可创建目录、写入和硬链接发布，重复发布拒绝覆盖，Emby 可读取同一文件；验证文件已清理。Emby 当前未配置媒体库，需在其管理页面按分类添加 `/mnt/share/TV` 或 `/mnt/share/<分类>` 才会索引影视。
