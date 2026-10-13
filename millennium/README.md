# Millennium 插件源码

本目录是 [Steam 家庭库透视](../README.md) 的 Millennium 插件工程。公开分发以 `.star` 包为单位；用户需要另外安装 Millennium。本仓库不提供独立注入器。

| 文件 | 用途 |
| --- | --- |
| `millennium.toml` | 插件元数据和入口 |
| `frontend/index.tsx` | 读取 Steam 内部数据、挂载界面与设置 |
| `frontend/core.ts` | 从 `../src/ui/core.js` 自动生成的界面核心 |
| `frontend/millennium.d.ts` | Millennium 前端类型声明 |
| `scripts/sync-core.mjs` | 同步界面核心 |

在仓库根目录先运行 `npm test` 和 `node millennium/scripts/sync-core.mjs`，然后在此目录执行：

```powershell
pnpm install --frozen-lockfile
pnpm exec tsc --noEmit
pnpm build
```

构建结果在 `../build-local/com.familylens.steamlibrary.star`。Starlight 的本地打包在 Steam 正在运行时可能触发插件热重载；请在退出 Steam 后构建或使用 CI。`pnpm deploy` 会写入本机插件目录，不属于纯验证步骤。

完整安装步骤、数据流和发布检查分别见根目录的 [README](../README.md)、[SECURITY](../SECURITY.md) 与 [PUBLISHING](../PUBLISHING.md)。
