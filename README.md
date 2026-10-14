# Friends Game Hub V1

私人多人网页游戏大厅，首款游戏：大话骰。独立于原有德州扑克项目。

## 技术
- Cloudflare Workers + Durable Objects (SQLite) + WebSocket
- Cloudflare D1: 账号、会话、房间索引
- 原生 HTML/CSS/JavaScript 前端（无需额外打包）
- GitHub Actions 自动部署

## 部署步骤
1. 创建独立 GitHub 私人仓库，把项目文件上传到根目录（包括 `.github`）。
2. 本地安装 Node.js 22+，运行 `npm install`，可提交生成的 `package-lock.json`。
3. 运行 `npx wrangler login`，然后 `npx wrangler d1 create friends-game-hub`。
4. 将输出的 `database_id` 填入 `wrangler.jsonc`，替换 `REPLACE_WITH_YOUR_D1_DATABASE_ID`。
5. 运行 `npm run db:remote` 初始化数据库，再运行 `npm run deploy` 部署。
6. 在 GitHub 仓库 Settings → Secrets and variables → Actions 添加 `CLOUDFLARE_API_TOKEN`（具备 Workers/D1/DO 部署权限）及 `CLOUDFLARE_ACCOUNT_ID`。
7. 后续推送 main 分支会自动运行 typecheck、数据库迁移和部署。

## 本地开发
`npm run db:local` 然后 `npm run dev`。

## V1 功能
- 注册/密码登录（PBKDF2），7 天有效的会话令牌（当前浏览器标签页会话存储）
- 私人房间、邀请码、最多8人、房主开始、准备、实时 WebSocket
- 5 颗骰子，叫点、质疑、输家掉骰、最后一人获胜、重新开局
- 服务端判定，其他玩家不会收到你的骰子

## 重要限制 / 待改进
- 这是可部署的第一版开发原型，**尚未在真实 Cloudflare 账号中完成端到端测试**。
- 当前 WebSocket 连接使用 URL 查询参数携带短期会话令牌；正式公开运营前建议改成 HttpOnly Secure Cookie + WebSocket Origin 校验，并对日志隐藏敏感查询参数。
- 当前游戏不允许进行中途加入；断线刷新可以重连。若断线玩家轮到操作，游戏会等待他回来。
- 不支持忘记密码、邮箱验证、账号找回、观战、踢人、房间超时清理、长期战绩写入。
- 骰子使用 crypto.getRandomValues；当前取模映射有极小概率偏差，正式竞技可使用拒绝采样。
- 未加入 API 速率限制、密码尝试限制、强制 HTTPS 自定义域名、用户数据删除入口。
- 仅适合小规模私人测试，公开发布前必须增加上述安全机制并完成多设备测试。
