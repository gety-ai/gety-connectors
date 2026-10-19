# Gety 飞书连接器

[English](./README.en.md)

一个 [Gety](https://gety.ai/) 自定义连接器,通过本机已登录的
[lark-cli](https://github.com/larksuite/cli) 索引你的飞书内容:

- **云文档** —— 你有权限访问的 docx 文档与知识库(wiki)页面,导出为
  Markdown。确认已在源端删除或失去访问权限的文档会在同步时从索引中移除。
- **聊天记录**(可选,默认开启)—— 群聊与单聊,按周(默认)、按天,或
  不分组(回溯窗口内的整段会话一篇)聚合为可搜索文档。

连接器自身不保存任何飞书凭据,所有 API 调用都经由 `lark-cli`,OAuth token
由它自己管理。

## 前置条件

1. 安装 [lark-cli](https://github.com/larksuite/cli)(1.0.58 及以上),并确保
   `lark-cli` 在 **Gety 启动时继承的 `PATH`** 中。连接器的 manifest 只授权运行
   名为 `lark-cli` 的程序(`permissions.run`),不再支持自定义路径。
   - macOS 上 Gety 会把 `/opt/homebrew/bin` 和 `/usr/local/bin` 加入
     `PATH`,Homebrew 安装即可直接使用。
   - 通过 nvm、fnm、volta 等版本管理器 `npm install -g` 安装时,`lark-cli`
     只存在于这些工具的 shell 环境里,而且 npm 生成的启动脚本依赖 `env node`,在
     Gety 中会失败。请把 npm 包内的原生可执行文件链接到 `PATH` 上的目录,例如:

     ```bash
     sudo ln -sf "$(npm root -g)/@larksuite/cli/bin/lark-cli" /usr/local/bin/lark-cli
     ```
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

1. 在 Gety 中打开 **Custom Connectors**。
2. 从 npm 安装(`@gety-connectors/lark`);或者先运行 `deno task build`(需要
   [Deno](https://deno.com/)),再从本地安装本文件夹(构建产物不入库)。
3. 填写设置:

   | 设置项           | 默认值 | 含义                                                                                |
   | ---------------- | ------ | ----------------------------------------------------------------------------------- |
   | 索引聊天记录     | 勾选   | 索引群聊与单聊。取消勾选则只索引云文档,已索引的聊天记录会被移除。                   |
   | 聊天记录聚合粒度 | 按周   | 按周、按天,或不分组(回溯窗口内的整段会话一篇)。修改后会删除并重新索引全部聊天记录。 |
   | 聊天记录回溯天数 | 30     | 首次同步回填多少天的聊天记录;不分组时也是每篇会话文档覆盖的时间范围。               |

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
是一篇文档,覆盖回溯窗口内的消息,内容按日期分节。

同步行为:

- 文档通过 Search v2 的两遍完整枚举发现(两种排序的召回互补,取并集)。仅对
  上次同步后正文或来源信息有变化、或尚未入库的文档重新抓取正文,因此偶发的抓取失败会在下次
  轮询时重试。
- 搜索枚举的召回在两次轮询之间并不稳定,因此从完整枚举中消失的文档,只有在
  直接抓取时 lark-cli 明确报告"不存在"(`not_found`)或"无权限"
  (`permission_denied`)才会从索引中删除;网络错误、超时等其它失败一律保留。
  枚举不完整(如缺少搜索权限)或结果为空时跳过删除。
- 同步状态只在一次轮询成功结束时提交;中途被取消的轮询下次会从上次提交的
  状态重新开始。文档的来源位置缓存在连接器的数据目录中,不占用同步状态。
- 每个会话维护游标;未关闭的当前周期(当天或当周)会整体重取,内容未变时
  不会重复上传。不分组模式下,先用一次轻量探测判断会话是否有新消息,有才重取
  回溯窗口并重建该会话的文档;超长会话会优先丢弃最早的日期以满足大小上限。
- 拉取会话列表失败时跳过本轮的聊天记录,云文档照常提交;单个会话失败只跳过
  该会话。
- 切换聚合粒度后,按新粒度从回溯窗口重建聊天文档;旧的聊天文档在重建完整成功
  (会话列表和每个会话的消息都拉取成功)后才删除,在此之前仍可搜索。
- 单篇内容上限 8 MB,低于 Gety 的单文档限制。
- 单次 `lark-cli` 调用最长 5 分钟;限流和 lark-cli 标记为可重试的错误会退避
  重试。

## Markdown 文档来源说明

云文档的 Markdown
正文开头会显示可取得的来源信息：知识库、父节点、目录路径和原链接。每项只有存在有效值才显示；全部缺失时直接保留原正文，不生成空白来源说明。目录路径从根目录到父节点，不重复文档标题；只能读取部分祖先时以
`… /` 标记不完整路径。

知识库名称链接到该知识库，父节点名称链接到父页面，目录路径中的各级名称分别链接到对应节点。Wiki
链接保留原文档的飞书或 Lark 租户域名；Drive
文件夹仅使用接口返回的链接。无法取得可靠地址时保留纯文本。

来源信息直接属于 Markdown 内容，无需修改 Gety 主仓，也不新增 `metadata.location`
或 `metadata.feishu` 字段。原有 metadata 字段保持兼容。节点等资源 ID
仅在连接器内部用于查询与同步缓存，不显示在正文，也不需要额外的认证
token；查询使用已登录的 `lark-cli` 用户身份。

节点移动、父节点或知识库改名会更新正文来源说明，即使文档编辑时间没有变化。权限不足或临时查询失败不会阻止正文索引，会保留上次成功取得的来源信息。普通云文档的路径来自可访问的
Drive 文件夹树，共享文档可能无法取得完整路径。

## 本地开发

```bash
deno task verify                    # fmt/lint 检查 + generate + 类型检查 + 测试 + 构建
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
- lark-cli 1.0.98 对已删除的 docx 文档返回的错误尚未归类为 `not_found`,这类
  文档可能会继续留在索引中,直到 lark-cli 提供明确的错误类型。
- Windows 上 npm 安装的 `lark-cli.cmd` 启动脚本尚未验证。
