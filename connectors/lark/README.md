# Gety 飞书连接器

[English](./README.en.md)

一个 [Gety](https://gety.ai/) 自定义连接器,通过本机已登录的
[lark-cli](https://github.com/larksuite/cli) 索引你的飞书内容:

- **云文档** —— 你有权限访问的 docx 文档与知识库(wiki)页面,导出为
  Markdown。源端消失的文档(被删除或失去访问权限)会在同步时从索引中移除。
- **聊天记录**(可选,默认开启)—— 群聊与单聊,按周(默认)、按天,或
  不分组(每个会话一篇)聚合为可搜索文档。

连接器自身不保存任何飞书凭据,所有 API 调用都经由 `lark-cli`,OAuth token
由它自己管理。

## 前置条件

1. 安装 [lark-cli](https://github.com/larksuite/cli)(1.0.58 及以上),并确保 它在
   `PATH` 中,或在连接器设置里填写其路径。
2. 登录并一步授权。注意:`lark-cli auth login` **必须**显式指定权限,裸跑会
   直接报"请指定要授权的权限"。请使用:

   ```bash
   lark-cli auth login --recommend --scope "search:docs:read contact:user.basic_profile:readonly"
   ```

   - `--recommend` 会授予连接器依赖的标准自动审批读权限,包括
     `docx:document:readonly`、`im:chat:read`、`im:message:readonly`、
     `im:message.*_msg:get_as_user`、`wiki:node:read` 等。
   - `search:docs:read`(枚举云文档)和
     `contact:user.basic_profile:readonly`(在聊天记录里解析发送者姓名)
     **不在**推荐集内,必须显式列出。`search:docs:read` 可能还需要先在飞书
     开放平台后台为应用开通该权限。

   用 `lark-cli auth status` 可查看当前已授权的权限。

## 安装到 Gety

1. 构建连接器(需要 [Deno](https://deno.com/)):

   ```bash
   deno task verify
   ```

2. 在 Gety 中打开 **Custom Connectors**,安装本文件夹。
3. 填写设置:

   | 设置项           | 默认值     | 含义                                                                              |
   | ---------------- | ---------- | --------------------------------------------------------------------------------- |
   | 索引聊天记录     | 勾选       | 索引群聊与单聊。取消勾选则只索引云文档,已索引的聊天记录会被移除。                 |
   | 聊天记录聚合粒度 | 按周       | 按周、按天,或不分组(整个会话一篇)聚合为文档。修改后会删除并重新索引全部聊天记录。 |
   | 聊天记录回溯天数 | 30         | 首次同步回填多少天的聊天记录。                                                    |
   | lark-cli 路径    | `lark-cli` | Gety 继承的 `PATH` 中找不到 lark-cli 时填其路径。                                 |

修改源码后需重新构建(`deno task build`)并在 Gety 中点击该连接器的
**Restart**;修改 manifest 后需重新安装。

## 索引内容

| 来源             | Gety 文档 id                     | 链接目标                      |
| ---------------- | -------------------------------- | ----------------------------- |
| 云文档           | `feishu:doc:<token>`             | 浏览器中打开源文档            |
| 聊天记录(周/天)  | `feishu:chat:<chat_id>:<周或日>` | 飞书客户端中打开会话(applink) |
| 聊天记录(不分组) | `feishu:chat:<chat_id>`          | 飞书客户端中打开会话(applink) |

聊天文档按周聚合时以周一日期为键,标题显示为日期区间(如
`2026-07-06 ~ 2026-07-12`);按天聚合时为 `2026-07-10`;不分组时整个会话
是一篇文档,内容按日期分节。

同步行为:

- 文档通过 Search v2 的两遍完整枚举发现(两种排序的召回互补,取并集)。仅对
  上次同步后有编辑、或尚未入库的文档重新抓取正文,因此偶发的抓取失败会在下次
  轮询时重试,不会被水位线跳过。
- 搜索枚举的召回在两次轮询之间并不稳定,因此从完整枚举中消失的文档,只有在
  直接抓取确认已无法访问后才会从索引中删除;枚举结果为空时视为源端召回异常,
  跳过删除。
- 每个会话维护游标;未关闭的当前周期(当天或当周)会整体重取,保证文档
  完整。不分组模式下,先用一次轻量探测判断会话是否有新消息,有才重取整个
  回溯窗口并重建该会话的文档;超长会话会优先丢弃最早的日期以满足大小上限。
- 切换聚合粒度后,旧的聊天文档会被全部删除,并按新粒度从回溯窗口重建。
- 单篇内容上限 8 MB,低于 Gety 的单文档限制。

## 本地开发

```bash
deno task verify                    # fmt + lint + generate + 类型检查 + 测试 + 构建
deno task runner -- --reset-state   # 全量同步,输出到 dev/runs/<timestamp>/
deno task runner -- --polls 2       # 验证增量行为
```

本地运行的配置覆盖写在 `.env`(参考 `.env.example`),例如
`GETY_CONFIG_INDEX_CHAT_HISTORY=false`、`GETY_CONFIG_CHAT_GROUPING=day`。

## 已知限制

- 表格、多维表格、幻灯片、思维笔记、文件附件,以及旧版 "doc" 文档(v2 抓取 API
  不支持)不被索引。
- 已撤回消息只有在其所在周期被重取时才会从聊天文档中消失;历史聊天文档不会
  被逐条清理。
- 图片不显示,以 `[图片]` / `[图片: 描述]` 占位(描述文本可搜索)。飞书的
  图片签名链接实测约 30 分钟内过期,而轮询间隔是 1 小时且只重抓有编辑的
  文档,保留链接只会得到必然加载失败的图。
- 连接器通过子进程调用 `lark-cli`,因此 Gety 必须运行在已安装并登录 lark-cli
  的机器上。
