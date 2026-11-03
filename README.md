# EasyHey Firmware Skill

通过后台 API 管理 [EasyHey 固件羊](https://easyhey.com/) 固件的 Agent Skill。支持微信扫码登录、查询、新建上传、编辑信息、发布、暂停、恢复和删除指定固件。

面向支持本地 skills、Node.js/Python 执行和图片展示的 Codex 环境。这是社区工具，与 EasyHey 官方无隶属关系。

## 功能

- **扫码登录**：本地生成二维码，校验图片与有效期，直接展示并附备用图片链接。
- **查询**：读取当前账号的固件列表和详情，自动遍历分页。
- **上传与发布**：校验 `.bin` 文件、SHA-256、烧录地址和容量；上传文件后创建记录、绑定固件码并核验状态。
- **编辑信息**：修改名称、描述、版本，保留其他字段并校验并发修改。
- **更新时间**：新建或编辑时，在描述中自动标注北京时间；替换旧时间行，不重复追加。
- **暂停与恢复**：更新发布状态，目标状态已经满足时不重复写入。
- **删除**：核对 ID、名称、版本与修改时间，删除后重新查询确认。

仅上传文件不会自动发布。写请求需要明确的操作授权，创建、绑定和删除会保留本地操作记录，结果不明时不会盲目重试。

## 安装

在 Codex 中使用 Skill Installer，并发送：

```text
请安装 https://github.com/eyesluo/easyhey-firmware/tree/main/skills/easyhey-firmware 中的 skill。
```

也可以下载 GitHub Release 中的 `easyhey-firmware.zip`，解压后把整个 `easyhey-firmware` 文件夹复制到个人 skills 目录：

- Windows：`%USERPROFILE%\.codex\skills\easyhey-firmware`
- macOS / Linux：`~/.codex/skills/easyhey-firmware`
- 自定义了 `CODEX_HOME` 时：`$CODEX_HOME/skills/easyhey-firmware`

确认目录中直接包含 `SKILL.md`、`agents/`、`references/` 和 `scripts/`，不要多套一层文件夹。新开对话后使用；若未识别，重启客户端。

## 运行依赖

- Node.js **20 或更高版本**（使用内置 fetch，无 npm 依赖）。
- Python **3.10 或更高版本**及 `reportlab`，用于生成二维码。
- 能访问 EasyHey、其 Supabase 项目及七牛上传服务的网络环境。

在克隆的仓库中安装 Python 依赖：

```sh
python -m pip install -r requirements.txt
```

安装 ZIP 的用户也可运行 `python -m pip install "reportlab>=4,<5"`。必须安装到实际用于二维码生成的 Python 中。Codex 桌面若提供包含 reportlab 的内置 Python，可以直接复用。

## 使用示例

```text
使用 $easyhey-firmware，查询我现在有哪些固件。
```

```text
使用 $easyhey-firmware，将指定 build 目录中的固件新建并发布。
名称为“我的设备固件”，每次烧录擦除 Flash，完成后自动重启。
```

```text
使用 $easyhey-firmware，修改固件 ID 123 的描述，并标注本次更新时间。
```

```text
使用 $easyhey-firmware，暂停发布固件 ID 123。
```

第一次使用或会话失效时需要微信扫码。一次有效会话可连续完成多项操作；访问令牌会正常刷新。会话不写入磁盘，执行环境重置后需要重新登录。

## 仓库结构

```text
skills/easyhey-firmware/
├── SKILL.md                  # Skill 入口与执行规则
├── agents/openai.yaml        # 显示名称和默认提示
├── references/
│   ├── api.md                # API 契约及验证范围
│   ├── connection.md         # 扫码、图片展示与会话处理
│   └── mcp.md                # 可选官方 MCP 通道
└── scripts/
    ├── easyhey-api.mjs       # API 客户端
    ├── easyhey-api.test.mjs  # 模拟 API 测试
    ├── login-qr.mjs          # 二维码生成、校验和展示信息
    ├── login-qr.test.mjs     # 二维码测试
    └── render_qr.py          # 本地 PNG 编码
```

## 测试与打包

测试不会登录线上账号或修改线上固件。二维码集成测试需指定包含 reportlab 的 Python；不指定时会明确标记跳过。

Windows PowerShell：

```powershell
$env:EASYHEY_TEST_PYTHON = (Get-Command python).Source
node --test skills/easyhey-firmware/scripts/easyhey-api.test.mjs skills/easyhey-firmware/scripts/login-qr.test.mjs
```

macOS / Linux：

```sh
EASYHEY_TEST_PYTHON="$(command -v python3)" node --test skills/easyhey-firmware/scripts/easyhey-api.test.mjs skills/easyhey-firmware/scripts/login-qr.test.mjs
```

打包为可安装 ZIP（不包含仓库文档、临时文件和运行记录）：

```sh
python scripts/package_skill.py
```

输出：`dist/easyhey-firmware.zip`。上述测试与打包命令可在 Windows 和 Linux 上运行；此版本已完成 Windows 本地验证，尚未配置 GitHub Actions。

## 验证范围与限制

Windows 环境下已实测扫码、文件上传、新建和绑定发布、名称/描述/版本编辑、更新时间、暂停/恢复及删除。2026-11-03 的本地验证包含 21 项测试，无跳过；二维码图片展示也已验证。

当前未封装已有固件的文件替换或芯片/分区修改。不包含固件编译、设备烧录、设备授权、密码与密钥管理。API 来自官网前端所使用的接口，网站更新可能需要调整客户端。`references/api.md` 记录了契约来源与实测范围。

公开的 Supabase publishable key 是前端配置，不是用户登录凭据；用户数据访问仍需正常扫码会话和服务端权限。仓库和安装包不包含用户 token、登录二维码、操作记录或固件二进制。默认直接调用 API，官方 MCP 是可选通道。

## 许可证

[MIT](LICENSE)。
