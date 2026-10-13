# GitHub 公开发布前检查清单

此清单用于维护者审查，**不代表已经公开仓库或获得 Millennium 商店收录**。

1. **选择许可证与版权信息。** 目前未选择项目许可证。公开源码不自动授予复制、修改和再分发权；在本人决定许可证并核对所有依赖和素材授权前，不发布正式版本。
2. **审查实际提交内容。** 运行 `git status --short --untracked-files=all`、`git ls-files --others --exclude-standard` 与 `git diff --check`。确认 `tools/`、`docs/` 截图、旧版 `release/` 包、`build-local/` 和本机独立注入器均未进入 Git；这些文件只在本机保留，不应因提交准备被删除。
3. **查隐私与凭据。** 搜索真实 Steam ID、昵称、头像/截图、绝对本机路径、token、cookie、`.env`、Webhook 和私有 URL。核对历史提交中也无泄露；若已泄露，改写仓库历史并轮换凭据，不能只补 `.gitignore`。
4. **核对数据流。** 人工对照 [SECURITY.md](SECURITY.md) 与当前代码，尤其检查新增网络请求、持久化写入、Steam 内部对象访问和筛选恢复逻辑；标记 AI 辅助代码并逐段审查。
5. **验证源码与生成物。** 在干净检出的源码上执行 `npm test`、`node millennium/scripts/sync-core.mjs`、`git diff --exit-code -- millennium/frontend/core.ts`，然后在 `millennium/` 运行 `pnpm install --frozen-lockfile`、`pnpm exec tsc --noEmit`、`pnpm build`。本机 Steam 运行时打包可能热重载，优先在 CI 或退出 Steam 后执行。
6. **比对发布包。** 记录构建提交 SHA 与 `.star` 的 SHA-256；发布的包应来自对应提交的干净 CI 构建。发布说明列出兼容的 Millennium/Steam 版本、已知限制、安装与卸载方法。公开仓库前不要把旧包误当成当前构建。
7. **商店申请另行决定。** GitHub 仓库与手动安装包并不自动进入 Millennium 插件库；若申请收录，应按当时的官方提交流程审查许可证、代码质量及 AI 辅助开发披露要求。

当前 `.github/workflows/verify.yml` 只运行验证并保留 CI 构建产物，不会自动创建 GitHub Release、上传商店或部署到用户的 Steam。
