# API 调用与接口契约

## 运行方式

在可持久保存变量的 Node REPL 中载入 `scripts/easyhey-api.mjs`（Node 20+，只使用内置 fetch、FormData、文件与加密库）。Codex 中发现 `mcp__node_repl__js` 工具后使用它；不要在浏览器 evaluate 中注入请求，也不要用每次退出的进程保存登录状态。

以安装目录的真实绝对路径构造 file URL；以下 `SKILL_DIRECTORY` 表示已解析的路径，不是要原样传入的值：

```javascript
let api = await import(pathToFileURL(join(SKILL_DIRECTORY, 'scripts/easyhey-api.mjs')).href);
let client = new api.EasyHeyClient();
// 在同一 REPL 中复用 client，勿在每次调用时重新创建。
nodeRepl.write(await client.chips());
```

需要 `pathToFileURL` 时从 `node:url` 导入，需要 `join` 时从 `node:path` 导入。首次登录读取 connection.md。网络访问若受沙箱限制，按宿主正常权限流程处理，不更换端点规避限制。

## 方法

| 方法 | 作用与输入 |
| --- | --- |
| `chips()` | 无用户会话的只读芯片列表；实际返回 chip_id/chip_name |
| `me()` | 校验当前登录身份，仅返回 user_id/nick |
| `list()` | 当前用户固件；自动分页，检测重复页 |
| `detail(id)` | 先核验在本人列表，再查询详情；不读取烧录密码 |
| `updateInfo(id, {name?, description?, version?}, {execute:true})` | 更新指定字段并自动刷新描述末尾的北京时间；时间戳条件校验、写后核验 |
| `setPublished(id, boolean, {execute:true})` | 上架或暂停；目标状态已满足时不重复写 |
| `deleteFirmware(id, {execute:true, expectedName, expectedVersion, operationFile})` | 核对目标名称/版本，带修改时间条件删除并核验不存在；operationFile 必须是新的绝对路径 |
| `inspectFile(path)` | 导出函数；本地检查大小、扩展名和 SHA-256 |
| `inspectManifest(manifest)` | 导出函数；纯本地检查文件、地址、重叠和已知容量 |
| `uploadFile(path, {execute:true})` | 获取凭证、查询七牛上传区域、上传一次，返回非敏感回执 |
| `preparePublish(manifest, receipts)` | 纯本地生成提交体，无上传/发布 |
| `publish(manifest, receipts, {execute:true, operationFile})` | 创建后按需绑定固件码发布，检查重名版本、写日志、防重复提交、读回核验 |
| `bindShareCode(id, code, {execute:true, operationFile})` | 为已有 status=0、无固件码的记录完成首次发布；不可替换已有固件码；可恢复创建成功但尚未绑定的流程 |
| `forgetSession()` | 清除本客户端内存，不注销用户其他会话 |

`inspectManifest` 和 `inspectFile` 是模块导出函数，例如 `await api.inspectManifest(manifest)`，不是 client 方法。

描述更新时间规则见 SKILL.md。`inspectManifest()`、`preparePublish()` 返回含更新时间的描述；`publish()` 提交时重新生成，核验时以实际提交内容为准，不和较早预览的时间逐字比较。`updateInfo()` 即使未传 description，也在同一次带版本条件的 PATCH 中保留原正文并更新时间。导出函数 `withUpdatedTime(description)` 可用于其他已核实的写入通道或本地预览；正文过长时抛错，不截断。仅上传文件不修改现有固件描述。

### 发布计划

```javascript
let manifest = {
  name: '用户指定或依据项目拟定的名称',
  description: '准确说明现成固件及适用硬件',
  version: '从实际固件确认的版本',
  chip_id: '来自 chips() 的 ID',
  share_code: api.generateShareCode(), // 只生成一次，预览和提交复用
  flash_config: {erase_type: 'always', auto_restart: true}, // 使用用户已选设置
  flash_size: 16 * 1024 * 1024, // 仅在已证实容量时填写
  files: [/* {path: 真实绝对路径, offset: 已核实的整数或0x字符串, sha256?: 已知摘要} */]
};
let plan = await api.inspectManifest(manifest);
// 此前必须已获得上传授权。保存每次回执，避免中断后重复上传。
let receipts = [];
for (const f of plan.files) receipts.push(await client.uploadFile(f.path, {execute:true}));
let payload = await client.preparePublish(manifest, receipts);
// 汇报具体内容。只有用户已经授权发布时执行下一句。
let result = await client.publish(manifest, receipts, {
  execute:true, operationFile: '本次独立操作记录的真实绝对路径'
});
nodeRepl.write(result);
```

回执可以写入用户工作目录，但不能把上传凭证或会话写进去。发布会重新检查文件摘要；文件改动后旧回执不可复用。预览没有匹配回执时应先报告本地 plan，不伪造 etag。

`operationFile` 必须为不存在的新文件；失败记录不能自动删掉来重试。若 `outcome_unknown`，按记录里的名称、版本、固件码查询；若已有 firmware_id 则查该 ID。只有确定未创建且用户仍授权时，才明确处理失败记录并再次尝试。share_code 碰撞也不无界重试。

## 已核实的底层请求

API 基址 `https://easyhey.com/web/api/v1`；Supabase 项目基址见脚本 deployment。EasyHey 请求使用 `apikey` 与正常用户 `Authorization: Bearer ...`。Supabase REST 使用相同用户会话与公开 key，服从服务端权限。

| 操作 | HTTP 请求 | 请求/响应要点 |
| --- | --- | --- |
| 生成扫码会话 | POST `/wechat-qr-create` | `{}`；data 中 qrCodeContent/scene/expiresIn |
| 查询扫码结果 | POST `/wechat-login` | `{scene}`；pending 或 ok，ok 返回会话凭据 |
| 当前身份 | GET `/wechat-login/me` | data.user_id/nick |
| 令牌刷新 | POST Supabase `/auth/v1/token?grant_type=refresh_token` | 正常 refresh_token 流程；不输出响应凭据 |
| 芯片 | GET Supabase `/rest/v1/chip_list` | select chip_id,chip_name,description |
| 我的固件 | POST Supabase `/rest/v1/rpc/get_my_firmware_list` | `{}`；分页 limit/offset，并按 firmware_id 排序 |
| 详情 | GET Supabase `/rest/v1/firmware_info` | firmware_id 精确过滤，限定所需列 |
| 更新/上下架 | PATCH Supabase `/rest/v1/firmware_info` | ID 与 last_modified_time 条件；status=1 已发布，2 暂停 |
| 删除指定固件 | DELETE Supabase `/rest/v1/firmware_info` | ID、名称、版本、last_modified_time 精确过滤；Prefer return=representation；删除后重查列表 |
| 上传凭证 | GET `/misc/uploadToken` | code=200，data.token；仅限当前上传用途 |
| 上传区域 | GET `https://api.qiniu.com/v4/query` | 从上传凭证解析 ak/bucket；不携带 EasyHey 会话 |
| 文件上传 | POST 区域返回的 HTTPS 上传主机 | multipart token/key/file；EasyHey 回调结果 data.etag |
| 新建发布 | POST `/firmware` | chip_id/version/name/description/share_code/file_list/flash_config；data.firmware_id |
| 首次绑定发布 | POST `/firmware/share/bind` | `{firmwareId, shareCode}`；data.shareCode；创建后无固件码时需要此步骤 |

新建的 `file_list` 是 **JSON 字符串**，内容为 `[{etag, offset}]`，offset 为整数。`flash_config` 是对象：erase_type 为 none/first_time/always，auto_restart 为布尔值。前端编辑完整记录时会把 flash_config 序列化为字符串；当前 helper 只支持元信息与状态 PATCH，不假装支持未经测试的换文件/换芯片操作。

上传使用区域发现结果的七牛域名白名单；不会把 Supabase token 发给七牛，不跟随重定向。未知上传域名或非标准回调结构时停下，先核实官方前端。文件已上传但回执异常时不立即再传。

## 证据与验证范围

2026-10-28 从官网 `/admin/upload/release-firmware` 指向的公开部署脚本 `/admin/assets/index-o0P35Ad8.js` 核实以上流程，脚本 SHA-256 为 `ED69D043CA76EB07737CBB4B2CF0ED15F16FCABB0D7554FD990EC58F8C106177`。不执行或打包官网整份脚本。

已真实验证公开 `chips()` 返回 11 项，ESP32-S3 的网站 chip_id 为字符串 `2`；执行时仍从列表解析，不写死。2026-11-02 已真实验证扫码登录、本人固件查询、五个分区文件上传、创建及绑定发布；发现 `/firmware` 返回的记录可为 status=0、share_code=null。当前官网脚本中 `i6()` 对应 `/firmware/share/bind`，管理页通过它完成首次发布；调用后实测固件码匹配、status=1。不能把创建成功等同于发布成功。2026-11-02 使用专用临时记录完成线上测试：名称/描述/版本编辑、北京时间自动标注和替换、暂停发布、恢复发布、重复设置状态不更新、删除目标校验、删除后不存在。测试记录已清理，原有记录的管理字段保持不变。删除契约来自同一官方脚本的 c6()：firmware_info.delete().eq("firmware_id", id).select("firmware_id")；本客户端额外加名称、版本和修改时间条件。

测试：`node --test scripts/easyhey-api.test.mjs scripts/login-qr.test.mjs`。二维码真实渲染测试需将环境变量 `EASYHEY_TEST_PYTHON` 设为包含 reportlab 的 Python 绝对路径；未设置时这些集成测试会标记跳过，不能宣称全部通过。测试使用临时文件、测试二维码及模拟 fetch，不访问线上服务。2026-11-03 已运行全部 21 项测试（无跳过），并验证测试 PNG 经 Node 图片输出转发后可显示；扫码展示流程见 connection.md。

来源：[官方后台](https://easyhey.com/admin/upload/release-firmware)、[官方前端脚本](https://easyhey.com/admin/assets/index-o0P35Ad8.js)、[Supabase REST](https://supabase.com/docs/guides/api/quickstart)、[七牛请求头](https://developer.qiniu.com/kodo/api/common-request-headers)。官网重新部署或接口返回变化后，应重新核实契约，不试探猜测的写端点。
