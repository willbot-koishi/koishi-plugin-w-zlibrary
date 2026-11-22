# koishi-plugin-w-zlibrary

[![npm](https://img.shields.io/npm/v/koishi-plugin-w-zlibrary?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-w-zlibrary)

Z-Library 搜索、详情及书籍转存。使用桌面客户端的 eAPI，不再解析网页 HTML；不自动处理网页验证码。

## 配置与指令

需要 `http`、`database` 和 `assetsPro` 服务；合并转发展示使用 `w-as-forward`。

- `domain`：提供 eAPI 的站点域名，默认 `z-lib.by`，可按实际可访问的域名修改。
- `cookie`：账号 Cookie，需包含 `remix_userid` 和 `remix_userkey`，属于私密凭据。API 请求只携带这两个账号字段，不转发浏览器防护 Cookie。
- `pageSize`：每页条目数，1–100，默认 30。
- `reactionInteraction`：是否使用 reaction 交互，默认开启。关闭后不添加、删除或响应 reaction；各阶段改用文字提示，下载超时通过 `y` / `yes`、`n` / `no` / `取消` 回应。序号选书仍直接下载，无需确认。
- `selectionTimeout`：搜索结果序号选书的有效期，默认 2 分钟。
- `downloadTimeout`：默认下载 60 秒后询问是否继续等待；查询者跟贴 ✅ 继续、❌ 取消，超过 Koishi 的 `delay.prompt` 时间未回应则取消。
- `maxFileSize`：单本大小上限，默认 100 MiB；已知超限的书籍在请求下载链接前拒绝，下载流也受此上限约束。

```text
zlib.state
zlib.search Alice in Wonderland -p 2
zlib.search 关键词 -s
zlib.detail <详情链接>
zlib.store.fetch <详情链接> -s
zlib.store.list -p 2
zlib.store.send <转存编号>
zlib.store.delete <转存编号>
```

支持 `/book/数字ID/hash/...` 旧式详情链接和 `/book/不透明ID/...html` 新式链接，包括短路径。粘贴其它站点别名的书籍链接时只提取书籍路径，认证请求始终发送到配置域名，不跟随链接向其它域名发送账号凭据。

搜索期间，机器人在指令消息上贴 🔍，搜索结束后撤下。搜索结果按当前页编号，选书提示包含在合并转发内。查询者可在同一聊天、同一机器人下回复序号，直接转存并发送所选书籍文件，不再二次确认；选书前回复“取消”或 `n` / `no` 退出。普通聊天和无关指令不被选书会话拦截；新搜索替换旧会话，选书、直接转存或超时会结束会话。

下载期间，机器人在下载指令（或序号消息）上贴 ⏳；文件下载完成、开始上传到 assets 时，替换为 📤。完成、失败或取消后撤下当前阶段的标记。下载超时只发一条普通询问消息，并在该消息上贴 ✅ / ❌；只有发起者在对应消息上的 reaction 会生效，其他用户、机器人自身及过期操作均忽略。选择继续后不重复询问，文件自行下载完成后也会清理等待。无法贴 reaction 时保留对应阶段的文字进度及 `y` / `yes`、`n` / `no` / `取消` 回应兜底，无关消息不会取消下载。

搜索、详情和查看登录状态不请求下载链接。仅 `zlib.store.fetch`（包括输入序号后的调用）请求 `/file`，此步骤可能扣减账号下载额度；额度以 `zlib.state` 返回值为准，不写死网页或桌面客户端的每日次数。已转存的书籍直接发送已有文件，不重新下载；同一本书的并发请求不会重复获取下载链接。只下载你有权获取的书籍。

API 请求固定使用已验证的客户端标识（`User-Agent: undici`）。实测站点会因客户端标识不同而返回不同的链接兼容行为和额度口径，因此不依赖 Node 版本的隐式默认值。

下载文件时不携带账号 Cookie，逐跳校验 HTTPS 下载地址并拒绝本地地址。HTML 错误页不会当作书籍上传，失败不新增转存记录。已下载文件通过 assets 服务转存；资源来源记录书籍详情页，不保存或回显临时签名下载链接。

搜索、详情和转存列表中的封面通过 `assetsPro.uploadFromUrl()` 转存，资源分类为 `zlibrary-cover`，发送时只使用 assets URL。封面转存失败时记录脱敏日志并省略该封面，不影响文字结果，也不回退到原站图片地址。封面转存不请求书籍下载链接，不消耗书籍下载额度。

请求失败时，日志记录失败阶段（上游查询、结果发送、文件下载等）、错误堆栈及底层原因；HTTP 错误还记录状态码及响应类型。Cookie、认证头和临时下载链接会脱敏，不输出原始请求配置或响应正文；用户侧仍显示简短提示。

沿用原有转存表和编号，新加来源 ID/hash、文件字节数，旧记录的查询、发送和删除继续可用；无需清空数据库。`zlib.store.delete` 仍需权限 3 并确认。

## 开发

在 Koishi 开发工作区中，首次测试前构建合并转发依赖：

```sh
yarn build w-as-forward
yarn workspace koishi-plugin-w-zlibrary check
yarn workspace koishi-plugin-w-zlibrary test
yarn workspace koishi-plugin-w-zlibrary build
```

测试使用隔离内存数据库、模拟 API 和文件响应，不读取真实账号或消耗下载额度。
