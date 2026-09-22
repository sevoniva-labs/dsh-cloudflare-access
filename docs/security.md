# 安全边界与恢复

## 信任模型

这是给本机所有者/可信管理员使用的共享 Harness。Cloudflare 是身份提供与入口策略执行方。插件在源站独立验证 JWT，避免只信任明文邮箱头。设备规则由 Access 执行；插件配置其 AND 条件，不在本地伪造设备证明。

没有用户隔离、目录 ACL、多租户容器或应用 RBAC。所有获准用户可能运行 shell、读写主机文件、调用凭据服务。只隐藏配置页面不能限制这些权力。若需要非管理员成员，必须另建受限执行环境与宿主 API 授权层。

本机同用户的恶意进程、被攻陷的 DSH/浏览器/Cloudflare 账号、官方插件供应链及管理员主动修改策略不在插件能够隔离的边界内。

## 入口约束

- 源站与官方 WebServer 都必须监听 loopback。无公网监听、无路由器端口转发。
- JWT 使用固定账号 `*.cloudflareaccess.com` 的 HTTPS JWKS，限制 RS256；校验 app audience、issuer、exp/iat/sub/email/type。
- 所有请求验证 exact Host。修改请求和 WebSocket 必须携带 exact HTTPS Origin。禁止向控制命名空间代理任何远程请求。
- 丢弃客户端 Cookie/Authorization/Cloudflare 身份头和 hop-by-hop headers，再由网关注入服务端取得的官方 DSH Cookie。
- 原生启动 token 不出现在公网地址、响应或日志；不转发上游 Set-Cookie，不接受来自浏览器的原生启动 query token。
- 上游 401 清空本机会话缓存，返回可恢复错误，不自动重放 POST/工具/模型调用。
- SSE/WS 的两端 socket 受 JWT 到期、90 秒浏览器租约和显式退出约束；卸载插件时关闭连接器、入口及活动代理 socket。

Cloudflare 撤权、浏览器后台定时器限速、网络切换可能导致重连。租约是有界重验，不是即时全局撤权承诺。收到租约失败时客户端明确提示重新登录，不进行无限刷新。

## 凭据与状态

API 管理 Token 不写盘、不回显；预览到期或完成即释放引用。Tunnel Token 通过官方 DSH credential reference 存储；明文运行文件仅本机用户可读。DSH 凭据存储是否加密取决于其 provider，插件不虚称 Keychain 加密。

状态原子替换、文件权限 0600，目录创建权限 0700。安装 UUID 用于资源归属，proper-lockfile 防止双实例并发管理同一份状态。锁失效时停止远程入口。请不要同时手工修改其锁或状态文件。

第三方异常与 Cloudflare 原始错误 body 不直接返回用户。API 错误仅展示请求路径、HTTP 状态和数值错误码。

## 云端事务与人工漂移

预览只读。提交时重新检查冲突，写入前保存 journal。Access 应用创建时尚无 allow 策略，默认不发布；policy readback 成功后才建 Tunnel，最后才创建 DNS。任何步骤失败，不自动降低认证要求。

操作超时不代表远程没有写入。再次使用同一配置预览会通过 UUID marker 找回已提交资源，不重复创建。恢复仅限本安装实例；状态丢失时不会猜测接管已有资源。

本版不持续轮询 Cloudflare 的管理员改动。虽然本地 JWT 校验仍会约束 email/audience，但 Cloudflare 管理员若更改设备策略，其效果由 Cloudflare 决定。重新配置会检查策略是否与预期一致；不一致需人工处理，不覆盖现有策略。

清理前停止服务；先检查所有归属，再依序删除 DNS、Tunnel、Access app。不删除别人的资源，不删除账号共享 IdP。清理中途失败可以再次确认后继续。操作一旦成功删除云端资源，恢复需要重新创建；仅停用则可直接再启动。

## 来源

- [Tunnel API 设置](https://developers.cloudflare.com/tunnel/get-started/)
- [Access JWT 验证](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
- [Access 会话](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/)
- [One-time PIN](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/)

报告漏洞时只提供脱敏复现；不要提交 API Token、Access JWT、Cookie、DSH 启动 URL 或真实凭据文件。
