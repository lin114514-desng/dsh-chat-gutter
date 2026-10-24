# dsh-chat-gutter 安装预案（desktop profile）

> 目标：DSH 桌面端 0.2.1-rc.2，profile `C:\Users\27516\.dsh\profiles\desktop`，包版本 0.2.20。
> 依据《装皮肤专用记录.md》的硬性流程。安装前用户需明确同意；界面上的启用、停用、重启由用户亲手操作。
> GUI 端口每次启动会变，从当次运行时上下文取，不写死。

## 零、打包与离线自检

```bash
cd "F:\01AI\dsh default\chuangzaomoshi\dsh-chat-gutter"
node --check lib/client.js && node --check lib/index.js
pnpm test
pnpm pack
tar -tzf dsh-chat-gutter-0.2.20.tgz
```

包内只有六项：`package/lib/client.js`、`package/lib/index.js`、`package/package.json`、`package/README.md`、`package/icon.svg`、`package/cordis.patch.yml`。出现 `lib/.dsh-ops-update-*.lock` 就说明打包前没清锁文件，重打。

## 一、兼容体检（不碰 profile）

1. `dsh.client.inject` 只声明宿主确实提供的两个槽位包：`@deepseek-ai/dsh-client-ui-conversation`、`@deepseek-ai/dsh-client-ui-slots`。每个模块名先 grep 桌面程序包验证命中数不为 0。
2. `dsh.client` 为 `platform: "web"` + `immediately: true`。
3. 浏览器半边只 `require('react')`；宿主半边只动态 `import('@deepseek-ai/schemastery')`，失败时降级。
4. 无 `dependencies`、无安装脚本、无 `peerDependencies`。

## 二、备份三件套

```bash
mkdir -p "C:\Users\27516\AppData\Local\Temp\dsh\backup-gutter-<时间戳>"
cd "C:\Users\27516\.dsh\profiles\desktop"
cp package.json pnpm-lock.yaml cordis.patch.yml "C:\Users\27516\AppData\Local\Temp\dsh\backup-gutter-<时间戳>\"
```

## 三、上船三件套（装包前必跑）

```bash
# ① 语法与全量测试
cd "F:\01AI\dsh default\chuangzaomoshi\dsh-chat-gutter"
node --check lib/client.js && node --check lib/index.js && pnpm test

# ② 打包并核对包内容与包内版本
pnpm pack && tar -tzf dsh-chat-gutter-0.2.20.tgz && tar -xzOf dsh-chat-gutter-0.2.20.tgz package/package.json | grep '"version"'

# ③ 装进 profile，再核三方一致
cd "C:\Users\27516\.dsh\profiles\desktop"
pnpm add "F:/01AI/dsh default/chuangzaomoshi/dsh-chat-gutter/dsh-chat-gutter-0.2.20.tgz" --save-exact -w --registry=https://registry.npmjs.org

P="C:/Users/27516/.dsh/profiles/desktop"; W="F:/01AI/dsh default/chuangzaomoshi/dsh-chat-gutter"
grep -n '"dsh-chat-gutter"' "$P/package.json"
node -e "console.log(require('$P/node_modules/dsh-chat-gutter/package.json').version)"
md5sum "$W/lib/client.js" "$P/node_modules/dsh-chat-gutter/lib/client.js"
cd "$W" && tar -xzOf dsh-chat-gutter-0.2.20.tgz package/lib/client.js | md5sum
```

三项都通过后回报「已核对，可以重启」+ 版本号。同版本 tgz 不会替换已装文件，改代码必须先升版本号。

## 四、热挂载（免重启）

```
POST http://127.0.0.1:<当前端口>/dsh-market/toggle
{"name":"dsh-chat-gutter","enabled":true}
```

成功标志：响应 `state: "live"`。热挂载与冷启动是两条独立通路，重启后以 `web-boot` 日志为准。

## 五、装完核对与验收

1. `node_modules\dsh-chat-gutter\` 存在，`lib/client.js`、`lib/index.js`、`cordis.patch.yml`、`icon.svg` 齐全，`lib/` 里没有 `.lock`。
2. profile `package.json` 的 `dependencies` 有 `"dsh-chat-gutter": "file:...0.2.20.tgz"`，`dsh.profile.bundles` 有 `"dsh-chat-gutter"`。
3. 用户托盘退出再启动（假重启会一直下发改动前的快照），进入页面后 `Ctrl+Shift+R` 强刷。
4. 验收点：
   - 右侧出现 `#1 #2 …` 编号，滚动时跟随，细线连成时间线。
   - 左侧每回合一枚 `⚙️N ⌨️N 🤔N` 徽标，随内容移动；滚动到正文上方时消失。
   - 回答段旁边有花瓣弧线，长度等于段落长度，滚动时长度不变。
   - `▶答` 钉在这段回答的中间。
   - 标题栏里不出现任何标记。
   - 点「快速移动」弹出两列面板：左列四类带条数，右列「1 · 摘要」，点编号能跳到那一处，面板自己收起；再点按钮、点面板外、按 Esc 都能关；右键也开面板。
   - 面板是浮在按钮上方的 340px 宽浮层（左列 118px）：开关面板时输入框与会话框的尺寸一点不动；按钮贴着窗口顶端时面板翻到按钮下面。
   - 已有回合的过程组是收起状态时，左列「AI 提问 / 工具」仍有条数；点这类编号会先展开那一回合，再滚到具体那一行。
   - 窗口拉窄到没有空白带时整条标识带消失，不遮挡聊天内容。
   - 侧栏「插件」→ `dsh-chat-gutter` → 行 → 配置：四项能改、能保存；关总开关后所有标记消失，重新打开后恢复。
5. 控制台应只有 `[dsh-chat-gutter] 已加载` 与若干 `扫描到 N 行`，无报错；`C:\Users\27516\AppData\Roaming\@deepseek-ai\dsh-desktop\logs\` 最新 `web-boot` 日志里没有 `dsh-chat-gutter: import failed`。

## 六、回滚

1. 热挂载关闭：`POST /dsh-market/toggle {"name":"dsh-chat-gutter","enabled":false}`。
2. 装回旧包：`pnpm add "F:/01AI/dsh default/chuangzaomoshi/dsh-chat-gutter/dsh-chat-gutter-0.2.11.tgz" --save-exact -w --registry=https://registry.npmjs.org`。
3. 彻底移除：编辑工具删 profile `package.json` 的 `dependencies` 行与 `dsh.profile.bundles` 里的 `"dsh-chat-gutter"`，再用回收站工具删包目录：
   `powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\27516\.dsh\bin\trash.ps1" "C:\Users\27516\.dsh\profiles\desktop\node_modules\dsh-chat-gutter"`
4. 用户完全退出应用（托盘退出）重开。
5. 三件套备份在 `Temp\dsh\backup-gutter-<时间戳>\`。

## 七、免重启取证（改代码时用）

1. 起回环接收器（后台）：`node "C:\Users\27516\AppData\Local\Temp\dsh\gutter-probe\beacon-server.mjs" <输出文件>`（监听 `127.0.0.1:45191`）。
2. `node make-panel-probe.mjs <已装 client.js> <输出 .mjs>` 把一次性探针注进已装文件（脚本会校验锚点唯一性）。要看「面板是不是浮层、有没有把输入区撑变形」，用 `make-geom-probe.mjs` 生成几何探针：量面板的计算样式（`position`/`width`）、往上 8 层祖先的 `transform`/`filter`/`contain`、`<style>` 里有没有 `.dcg-panel`，以及开合面板前后插槽容器的尺寸差。
3. `cp` 到 `node_modules\dsh-chat-gutter\lib\client.js`，宿主 bundle 监视器约 500ms 内推 `rebuilt`，页面热加载插件（徽标闪一下）。
4. 探针约 3 秒后把 JSON 打到回环端口，数据落到输出文件。
5. **收尾必须把正式包里的 `lib/client.js` 拷回去**，`md5sum` 核对等于包内值。
