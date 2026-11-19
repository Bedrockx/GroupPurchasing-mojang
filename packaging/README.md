# 发布打包

在 Windows 上安装 Node.js 和 Git。首次使用时在仓库根目录执行 `npm ci --prefix client`，安装桌面项目锁定的构建依赖。

在仓库根目录运行：

```powershell
node .\packaging\pack.cjs
```

也可以在其他目录向 Node 传入脚本路径。脚本从自身所在目录查找项目，重新构建当前工作区的桌面端，并用 UTF-8 文件名打包。团购的新增路线和模板需要先加入 Git，已有发布文件会取工作区当前内容。

完成后，在管理员发布页面选择 `packaging/out/upload/` 中的文件。

| 上传入口 | 文件 |
| --- | --- |
| 用户端安装包 | `mojang.zip` |
| 团购安装包 | `ArtifactsGroupPurchasing.zip` |
| 客户端代码校验 | `app.asar`，与桌面包中的 `resources/app.asar` 相同 |

上传完成后，在管理页填写脚本输出的桌面版本和团购版本。重新打包会替换该目录中的上一批三个文件。Git 忽略整个 `packaging/out/`。
