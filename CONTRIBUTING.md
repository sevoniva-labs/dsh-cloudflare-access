# 贡献指南

## 构建

使用 Node.js 22.19.0 或更高版本：

```sh
npm ci
npm run check
npm pack --dry-run
```

`check` 执行类型检查、单元测试和构建。`dist/` 随源码提交，供 GitHub 直接安装使用；修改源码后须同步构建产物。请保持提交范围集中，并为行为变更补充测试。

## 测试

单元测试覆盖身份校验、访问边界、资源配置与清理、连接器生命周期、会话恢复、模型页适配及静态缓存。Cloudflare API 使用模拟服务，网关测试使用官方 DSH 连接模块，不需要真实账号或模型凭据。

涉及前端连接、认证恢复或资源缓存时，还需运行隔离浏览器测试：

```sh
npm install --no-save --package-lock=false playwright
npx playwright install chromium
npm run test:browser
npm run test:browser:assets
```

已有浏览器测试环境时，可用 `PLAYWRIGHT_MODULE` 指定模块路径、`PLAYWRIGHT_EXECUTABLE` 指定 Chromium 路径。测试使用本机随机端口，不连接实际 Cloudflare 部署；长期驻留仍需实机验证。

涉及 Cloudflare API、DSH 版本或设备检查的变更，应另用独立 `DSH_HOME`、端口和测试子域名验证：

1. 创建部署，检查未登录请求和无权限账号均被拦截。
2. 登录后确认目录浏览、模型配置保存和会话加载正常。
3. 验证刷新、断网恢复、后台唤醒、凭据轮换和重新登录，确认草稿保留、指令不重复提交。
4. 重启 DSH，确认入口和连接器恢复。设备策略变更还需检查合规、不合规及已撤销设备。
5. 删除测试部署，确认 DNS、Tunnel 和 Access 应用已清理，共享登录方式仍保留。

模型端到端测试须使用专用凭据和测试任务，不得中断现有部署。测试记录应列明环境、结果及未验证项。

## 代码结构

| 路径 | 用途 |
| --- | --- |
| `src/client.ts` | 插件设置页面 |
| `src/provision.ts` | Cloudflare 资源创建、恢复和删除 |
| `src/gateway.ts` | 身份校验及 HTTP、SSE、WebSocket 代理 |
| `src/session-recovery.ts` | 浏览器认证恢复与原生重连协调 |
| `src/cloudflared.ts` | 连接器安装与进程管理 |
| `src/models-compat.ts`、`src/web-assets.ts` | 版本限定的前端响应适配与缓存策略 |

## 提交检查

- 示例使用 `example.com` 等保留域名和虚构数据。
- 不提交真实域名、个人邮箱、本机路径、账号或资源 ID、凭据、运行日志、浏览器状态及部署备份。公开截图仅使用示例数据。
- 检查暂存区、构建产物和分发包；`.gitignore` 不能阻止已跟踪文件泄露信息。
- 需要隐藏提交邮箱时，使用 GitHub no-reply 邮箱。
- 安装 Gitleaks 后，可运行 `gitleaks git --log-opts=--all --redact` 检查可达历史。

发现凭据泄露时，先撤销或轮换凭据，再联系维护者清理历史。不要把原始凭据粘贴到 Issue、PR 或日志中。
