# Steam 家庭库透视 / Steam Family Library Owners

在 Steam 库里查看游戏和软件由哪些家庭成员持有、共有几份，并按成员筛选库内容。

See who owns each game or app in your Steam Family, how many copies there are, and filter your library by member.

本插件通过 **Millennium** 在 Steam 客户端中运行。使用前需要安装 Millennium；不需要开启 Steam 的 CEF 远程调试端口，也不需要让额外的注入器常驻。本项目不是 Valve 或 Millennium 的官方产品。

## 功能

- 在游戏列表及实际游戏卡片显示持有成员头像和份数；收藏夹预览卡不显示游戏角标。
- 在游戏或软件详情页显示家庭持有成员及份数；免费项目和 Steam 标记为不可共享的付费项目使用各自的说明。
- 顶部成员控件显示各成员的游戏/软件数量，支持单成员、多人交集（共同持有）与并集（总共持有）筛选。筛选会作用于收藏夹及库主页“所有游戏”，并由 Steam 重新排列卡片。
- 详情面板的位置、密度、透明度、头像显示及偏移可在插件设置中调整。

## 如何使用

启动 Steam 并打开“库”后，顶部会出现家庭成员筛选按钮。点击成员头像即可筛选，再次点击可取消；选择多名成员时，“共同持有”显示交集，“总共持有”显示并集。点击“全部”清除筛选。打开某个游戏或软件的详情页，可查看持有成员和份数，并通过设置按钮调整详情面板的显示方式。

数量和可共享状态来自当前 Steam 客户端可见的数据，不能替代 Steam 的实际借用或许可判定。对于不可共享项目，家庭共享接口可能无法完整显示其他成员是否也拥有它；未显示某位成员不代表该成员没有购买。

## 安装与更新

1. 从 [Millennium 官方网站](https://steambrew.app/)安装 Millennium。
2. 在本仓库的 **Releases** 页面下载 `com.familylens.steamlibrary.star`。如果尚无 Release，说明目前没有公开的安装包；不要把 GitHub 自动生成的“Source code ZIP”当作插件安装包。
3. 完全退出 Steam，将 `.star` 文件放入 Steam 安装目录下的 `millennium/plugins/` 文件夹，然后重新启动 Steam，在 Millennium 的插件页面确认已启用。

更新时先退出 Steam，再用新版 `.star` 替换同名文件。卸载时可先在 Millennium 中禁用插件；若要移除文件，请退出 Steam 后删除该 `.star`，再重新启动 Steam。通过本仓库下载并手动安装不代表插件已获 Millennium 商店审核。

## 自行构建（可选）

希望从源码核验或构建插件？请参阅 [Millennium 工程说明](millennium/README.md)。构建时需要 Node.js 24 与 pnpm 11，产物为 `build-local/com.familylens.steamlibrary.star`。在 Steam 正在运行的电脑上打包可能触发插件热重载，建议先退出 Steam。

## 隐私与项目状态

插件使用 Steam 客户端可见的家庭成员和库数据来渲染界面，并将显示偏好保存在本机 Steam UI 的存储中。具体读取、写入和安全边界见[数据与权限说明](SECURITY.md)。Steam 或 Millennium 更新后，插件可能需要适配；目前已在 Windows 版 Steam 与 Millennium v3.5.0 环境验收。

开发过程中使用了 AI 辅助；公开源码和自动测试不等于独立安全审计。本仓库目前未提供 `LICENSE` 文件，如需复用、修改或再分发源码，请先取得授权。
