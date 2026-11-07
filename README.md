# Review Sys · 单用户版本

面向单个场馆或活动的社交媒体素材分发系统。观众扫码打开网页，领取一条分享文案，点击复制，并长按保存活动图片；管理员通过密码登录后台管理文案和图片。

使命：降低用户分享真实到访体验的门槛，让活动内容更容易被表达和传播。

本仓库保存旧版单用户站点的独立源码，界面以深圳科学技术馆为原型。它与 [多用户版本 review-sys](https://github.com/tangspoon66/review-sys) 分开维护，不含多企业账号、活动点位、AI 生成等新版功能。

## 功能

- 文案库：手工录入、文件导入、修改、删除、批量管理和重复内容拦截。
- 文案文件支持 UTF-8 TXT、MD 和 DOCX；不支持 PDF、PPTX 或旧格式 DOC。
- 图片库：上传多图或文件夹、删除和批量管理。
- 图片策略：关闭图片、随机领取未使用图片、固定一张图片。
- 管理员密码登录；公开页支持手机浏览器及微信内置浏览器。

## 本地启动

安装 Node.js 20.19+（建议使用 Node.js 22 LTS），然后运行：

```bash
git clone https://github.com/tangspoon66/review-sys-single-user.git
cd review-sys-single-user
npm ci
cp .env.example .env
openssl rand -base64 48
```

编辑 `.env`，设置自己的管理员账号、密码和随机会话密钥。不要直接使用示例占位值：

```dotenv
HOST=127.0.0.1
PORT=5177
ADMIN_USER=your_private_username
ADMIN_PASSWORD=your_long_unique_password
SESSION_SECRET=replace_with_the_random_value_generated_above
COOKIE_SECURE=false
```

启动服务：

```bash
npm start
```

- 观众页面：`http://127.0.0.1:5177/`
- 登录页面：`http://127.0.0.1:5177/login.html`
- 管理后台：`http://127.0.0.1:5177/admin.html`

首次启动自动创建空数据库 `data/app.db` 和上传目录。使用 `.env` 中配置的账号登录后台，导入文案、上传图片并选择图片策略后，再访问首页。

## 使用方式与领取规则

1. 在后台导入文案，检查自动拆分结果。纯文本建议每行一条完整文案，正文和标签写在同一行；文件的换行结构会影响拆分结果。
2. 上传图片，选择关闭、随机或固定策略。固定模式可从图片库指定一张图片。
3. 用站点首页的 HTTPS 地址生成二维码，供观众扫码访问。
4. 观众点击“一键复制文案”复制文本；微信中通过长按图片选择保存。网页不能保证自动复制或直接写入系统相册。

每次请求 `/api/next` 都会领取文案并立即标记已用，不以是否点击复制作为使用条件。刷新、预览或重复打开首页也可能消耗文案。文案耗尽时提示“次数已用完”，不会自动循环；手动重置已用状态后才可再次分发。随机图片领取后也会标记已用，固定图片可重复展示。

后台列表默认返回最多 80 条，可请求到最多 200 条；它不是新版的完整分页素材库。

## Docker 与 HTTPS 部署

本仓库的 Compose 只将应用端口绑定到服务器本机 `127.0.0.1:5177`，由宿主机 Caddy 负责 HTTPS：

```bash
cp .env.example .env
# 编辑 .env，填写真实管理员信息，并设置 COOKIE_SECURE=true
docker compose up -d --build
docker compose logs -f single-user
```

如果本机 5177 已有服务，请改 Compose 中宿主机端口，例如 `127.0.0.1:5178:5177`，并同步调整反向代理，避免影响其他项目。

**这是历史版本，服务端使用项目根目录静态服务。公网部署必须在反向代理上限制可访问路径，防止下载数据库和源码。** 宿主机 Caddy 配置示例：

```caddyfile
share.example.com {
    encode zstd gzip

    @public path / /index.html /login.html /admin.html /styles.css /script.js /favicon.ico /api/* /assets/* /uploads/images/*
    handle @public {
        reverse_proxy 127.0.0.1:5177
    }
    handle {
        respond 404
    }
}
```

域名解析到服务器后，仅开放公网 80/443，保持 5177 不对外开放。若 Caddy 在另一个 Docker 容器中，应使用独立内部网络连接应用，并将代理目标改为服务名，不要在代理容器里使用 `127.0.0.1` 指向应用。

上线前验证 `/server.js`、`/package.json`、`/data/app.db` 和 `/.env` 返回 404。旧版未包含新版完整的安全加固；长期对外提供多企业服务请使用新版。本仓库的使用说明不代表历史版本已经完成安全审计。

## 数据备份与迁移

运行数据未包含在仓库中；克隆后不会带入线上文案、管理员密码或观众领取记录。

需保留 `.env`、`data/` 和 `uploads/`。停止服务后整体复制数据目录，或使用 SQLite 在线备份命令；不要只复制运行中的 `app.db` 而遗漏 WAL 日志。

```bash
sqlite3 data/app.db ".backup '/your/backup/path/app.db'"
```

还需单独备份 `uploads/`。恢复时使用同版本代码与配套数据库，不能直接与多用户版本共用数据库或上传目录。

## 修改品牌素材

- `index.html`：左上名称、右上 Logo、IP 动图。
- `styles.css`：布局、颜色与背景引用。
- `assets/`：本地品牌图片。

仓库中的场馆 Logo、IP 动图及图片仅供原项目还原参考，其权利归原权利人；其他场馆使用时应替换为有权使用的素材。

## 验证范围

旧版没有自动化测试套件，`npm test` 是原始占位命令。启动后至少检查登录、未登录访问后台、文案导入、图片上传、三种图片策略、复制操作和素材耗尽状态。公开二维码测试会实际消耗文案，请使用测试素材。
