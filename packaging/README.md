# 发布打包

在 Windows 上安装 Node.js 和 Git。首次使用时在仓库根目录执行 `npm ci --prefix client`，安装桌面项目锁定的构建依赖。

从仓库根目录执行以下命令。

```powershell
node .\packaging\pack.cjs
```

也可以在其他目录向 Node 传入脚本路径。脚本从自身所在目录查找项目，只构建一次当前工作区的 Windows x64 桌面端，再用同一份 `app.asar` 生成完整包、更新包和校验文件。ZIP 内的文件名用 UTF-8 保存，压缩后会检查完整性。团购的新增路线和模板需要先加入 Git，已有发布文件会取工作区当前内容。

## 桌面完整包

`packaging/out/full/mojang-<桌面版本>-full.zip` 用于首次安装。它包含 `mojang.exe`、Electron 运行库、语言文件、`resources/app.asar`、更新器、两套配置模板和空的 `namePng/`。解压到单独目录后运行 `mojang.exe`。文件名中的版本取自 `client/package.json`。重新打包会替换同版本的完整包，并保留其他版本。

## 管理端上传

在管理员发布页面选择 `packaging/out/upload/` 中的文件。

| 上传入口 | 文件 |
| --- | --- |
| 用户端安装包 | `mojang.zip`，用于自动更新已有客户端 |
| 团购安装包 | `ArtifactsGroupPurchasing.zip` |
| 客户端代码校验 | `app.asar`，与桌面包中的 `resources/app.asar` 相同 |

`mojang.zip` 的根目录直接包含 `resources/app.asar`、`updater.ps1`、`modelUser/` 和 `modelUserLcb/`。更新器会将这些文件安装到已有客户端目录，复用原来的 `mojang.exe` 和运行库。首次安装请使用上方的完整包。

上传完成后，在管理页填写脚本输出的桌面版本和团购版本。重新打包会替换上传目录中的上一批三个文件。Git 忽略整个 `packaging/out/`。

## 打包中断后恢复

如果再次打包提示 `.publish-lock` 已存在，先确认没有其他进程正在为同一仓库打包，再检查 `packaging/out/upload/` 和 `packaging/out/.work-*/previous/`。若 `upload/` 缺失，将确认完整的上一批 `previous/` 目录恢复为 `upload/`。有多份备份时，核对两个 ZIP 和 `app.asar` 属于同一批次后再选择。确认上传目录状态后，移除残留的 `packaging/out/.publish-lock`，重新运行打包命令。
