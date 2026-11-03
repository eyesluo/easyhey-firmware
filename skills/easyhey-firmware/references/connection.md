# API 微信扫码登录

会话保存在持久客户端内存中。先复用已有有效会话；网页已登录不代表 API 已登录。不读取浏览器 Cookie，不输出访问令牌、刷新令牌、scene 或原始登录响应。

## 生成前检查

从真实安装目录导入 `scripts/login-qr.mjs`，先调用 `checkQrRenderer({pythonExecutable})`。Python 路径由当前环境确定；Codex 桌面可使用 `load_workspace_dependencies` 查找。该脚本需要 reportlab，不依赖外部二维码网站。缺依赖、路径错误或权限问题时，先解决具体错误，再获取登录二维码，避免验证码在排错期间过期。

所有示例变量均替换为当前环境实际值，不固定用户名或 Python 路径。在持久 Node 会话中：

```javascript
let qrTools = await import(pathToFileURL(join(SKILL_DIRECTORY, 'scripts/login-qr.mjs')).href);
await qrTools.checkQrRenderer({pythonExecutable: PYTHON_EXECUTABLE});
let qr = await client.loginStart(); // 保留原 client；不要每次轮询新建客户端
let qrImage = await qrTools.renderLoginQr(qr, {
  pythonExecutable: PYTHON_EXECUTABLE,
  outputDir: TEMP_DIRECTORY // 可读写、宿主可访问的本机临时目录绝对路径
});
```

`loginStart()` 返回 qrCodeContent、expiresIn、expiresAt（毫秒时间戳）；不要打印 qr。`renderLoginQr()` 通过 stdin 传入内容，本地生成 PNG，返回 path、尺寸、字节数、expiresAt、imageMarkdown 和 linkMarkdown，不返回原始登录内容。

每次使用独立临时子目录和全新文件，避免相同文件名被界面缓存，不覆盖旧二维码。渲染最长等待 20 秒，文件完整写入并关闭后才检查、展示；不依赖 Windows 沙箱中可能被拒绝的文件重命名操作。返回前检查图片可读性、PNG 签名/CRC/尺寸/解压长度和有效期。缺内容、无法启动 Python、缺 reportlab、编码失败、写入失败、图片损坏、已过期或剩余不足 15 秒会明确报错；报错时不能声称二维码已显示。

## 必须展示图片和备用链接

生成文件不等于用户已经看到二维码。完成以下两步后再请用户扫码：

1. 调用宿主的本地图片显示工具（如 `view_image`，path 为 qrImage.path），确认工具成功读图。也可在 Node REPL 用 `await nodeRepl.emitImage({bytes: await fs.readFile(qrImage.path), mimeType:'image/png'})` 显示。如果通过 `functions.exec` 调用，必须用 `image(result.image_url)` 转发 view_image 图片，或将工具 content 中的 image 块逐个传给 `image(block)`；仅 `text(result)` 不会可靠展示图片。不要打印 base64。
2. 在面向用户的消息中实际写出 qrImage.imageMarkdown 和 qrImage.linkMarkdown（不要放进代码块），同时说明微信扫码及有效期。用户等待登录而结束当前回合时，最终回复也必须包含图片和备用链接，不能只说“二维码在上方”或仅把路径留在工具输出里。

展示形如：先说明“请用微信扫码并完成登录”；接着放 `![微信登录二维码](<实际图片绝对路径>)`，再放 `[打开二维码图片](<同一实际绝对路径>)`。路径使用正斜杠；含空格时保留尖括号。这是格式示意，必须用实际路径替换。

如果用户说看不到图片，先重新显示**同一个仍有效的 PNG**及链接；可调用 `open_in_codex` 打开该本地图片供侧栏查看。若原文件不见了但内存中的 qr 仍有效，用同一个 qr 再渲染即可，无须重建登录会话。只在过期或即将过期时调用 loginStart 获取新码；每次换码都明确提示以新图为准。不要使用旧路径冒充新二维码，也不要因 pending 不断换码。

确认展示后用问题工具请用户扫码并回复“已登录”。扫码不是上传/发布授权。二维码图片放在临时目录，不打包或提交仓库；扫码完成前不要清理。运行环境无法向用户呈现图片时说明具体限制，不让用户盲目等待。

## 确认登录

每隔至少 5 秒调用一次 `await client.loginPoll()`。pending 返回 retryAfterSeconds；authenticated 返回已核验的 user_id/nick。一次等待不超过 60 秒，保持使用原来的 client。

超过 expiresAt 或 HTTP 410 后重新获取并显示新码。401 重新认证，403 检查权限；不要发送写请求来测试登录。成功后调用 `client.list()` 验证当前账号数据；身份以 me() 与实际扫码账号为准。不要用旧列表代替查询结果。

访问令牌到期前正常刷新，刷新失败清除内存并重新扫码；REPL 重置也需要重新登录。不要把令牌写进文件来跨会话保活。`forgetSession()` 仅清本客户端内存，不影响用户其他设备。

## 可选 MCP

用户要求官方 MCP 时，端点为 `https://easyhey.com/mcp`，通过正常 OAuth 配置，遵循 [MCP 操作](mcp.md)。不把本客户端会话当作 OAuth 凭据。
