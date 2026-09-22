# Cloudflare 零信任接入

DeepSeek Harness 插件，通过 Cloudflare Access、Tunnel 和 DNS 提供远程访问。

- 包名：`@sevoniva/dsh-cloudflare-access`
- 版本：`0.1.0-alpha.3`
- 已验证兼容：官方 DSH `0.1.6-alpha.2`、Node.js 22
- 平台：macOS、Linux；Windows 暂不支持自动安装连接器

## 安装

```sh
dsh plugin --profile web add github:sevoniva-labs/dsh-cloudflare-access
dsh --profile web --host 127.0.0.1
```

离线安装包也可通过 `dsh plugin --profile web add /absolute/path/package.tgz` 安装。

在本机打开 Harness 启动链接，进入 **设置 → Cloudflare 零信任接入**：

1. 安装或指定官方 cloudflared。
2. 填写 API Token，选择域名、访问地址、允许邮箱和认证方式。
3. 如需设备验证，填写已有设备检查 ID。
4. 检查配置，输入访问地址确认发布。
5. 隧道连接后，从其他设备登录并验证。

Cloudflare 账号需已完成 Zero Trust 初始化，域名需由该账号托管。插件不会覆盖已有 DNS 或接管已有部署。

## API Token 权限

将 Token 限定到目标账号和 Zone，不使用 Global API Key。

| 范围 | 权限 |
| --- | --- |
| Account | Cloudflare Tunnel: Edit |
| Account | Access: Apps and Policies: Edit |
| Account | Access: Organizations, Identity Providers, and Groups: Read |
| Zone | Zone: Read；DNS: Edit |
| 可选 | 自动创建邮件验证码登录方式时，Identity Providers 需要 Edit |
| 可选 | 使用设备检查时，需要 Access: Device Posture: Read |

名称以 [Cloudflare 权限表](https://developers.cloudflare.com/fundamentals/api/reference/permissions/) 为准。

管理 Token 不保存，预览有效期为 10 分钟。Tunnel 运行凭据由 DSH 凭据服务保存；cloudflared 使用权限为 `0600` 的临时 Token 文件，不通过命令行参数传递凭据。

## 配置

默认 Harness 与插件入口均只监听本机。插件入口端口为 `3082`。可在 profile 的 `cordis.patch.yml` 中覆盖：

```yaml
- id: dsh-cloudflare-access
  name: '@sevoniva/dsh-cloudflare-access'
  config:
    instance: web
    gatewayPort: 3082
    # cloudflaredPath: /absolute/path/to/cloudflared
    # dataDir: /absolute/path/to/private/state
```

状态目录为 `$DSH_HOME/dsh-cloudflare-access/<instance>`。多个 profile 必须使用不同实例名和端口。

当前版本更换域名、端口或策略时，需先删除原部署再配置。插件随 DSH 启停，不自动注册系统服务。无人值守运行请使用 launchd 或 systemd 管理 DSH。

目录选择使用 DSH 官方网页目录浏览器，选择的是 **Harness 主机上的目录**。

## 访问边界

```text
浏览器 → Cloudflare Access → Tunnel → 本机插件网关 → 官方 Harness
```

网关校验 Access JWT、邮箱、Host 和 Origin，同时保留官方 DSH 认证，不修改官方源码或替换连接模块。HTTP、SSE 和 WebSocket 使用同一认证入口。

**获准用户共享 Harness 的数据与工具权限。此插件不是多租户隔离系统，只适用于可信管理员。** 配置页面仅在本机开放，但这不是对远程管理员的权限隔离。

设备验证为可选项；仅配置邮箱认证不等于设备已获信任。设备检查需在 Cloudflare Zero Trust 中预先配置。

长连接受 JWT 有效期及 90 秒浏览器租约限制。撤权仍受 Cloudflare 会话和策略传播影响，不保证即时断开。详情见 [安全说明](docs/security.md)。

## 停用、删除与更新

- **停用**：关闭本机入口和连接器，保留云端配置。
- **删除配置**：先停用，重新填写 API Token 并确认域名。仅删除本实例管理的 DNS、Tunnel 和 Access 应用，保留共享登录方式。
- **卸载**：完成云端清理后运行下方命令。直接卸载不会自动删除 Cloudflare 资源。

```sh
dsh plugin --profile web remove @sevoniva/dsh-cloudflare-access
```

不要提前删除状态目录，其中保存资源归属与恢复记录。配置操作中断后，可使用原配置重新检查并恢复。

更新插件可重新执行安装命令，然后重启 DSH。建议固定发布 tag/commit 并保留旧版本包。更新 DSH 前需检查兼容范围，不保证兼容未验证的新版本。

## 开发

```sh
npm ci
npm run check
npm pack
```

| 文件 | 职责 |
| --- | --- |
| `src/client.ts` | 设置页面 |
| `src/gateway.ts` | 身份校验与 HTTP/SSE/WS 代理 |
| `src/provision.ts` | Cloudflare 资源创建、恢复与清理 |
| `src/controller.ts` | 操作串行化与运行状态 |
| `src/cloudflared.ts` | 连接器安装与进程管理 |

`dist/` 随源码提交，GitHub 安装不需要本机编译。提交前执行 `npm run check` 并同步构建产物。测试范围与集成检查见 [测试与验收](docs/verification.md)。

MIT License。非 DeepSeek 或 Cloudflare 官方产品。
