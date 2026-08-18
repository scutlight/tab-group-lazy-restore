# GitHub 托管与 Pages 开启步骤

## 发布前填写

先在以下两个文件中替换 `[发布者名称]` 和 `[联系邮箱]`：

- `PRIVACY.md`
- `docs/index.html`

## 推荐：使用 GitHub Desktop

本目录已经初始化为 `main` 分支的本地 Git 仓库，但尚未提交或连接远程仓库。

1. 安装并登录 GitHub Desktop。
2. 选择 `File > Add Local Repository`。
3. 选择本地的 `tab-group-lazy-restore` 目录。
4. 在左下角 Summary 填写 `Release 4.3.0`，点击 `Commit to main`。
5. 点击上方 `Publish repository`。
6. Name 保持 `tab-group-lazy-restore`。
7. Description 可填写：`Chrome 恢复窗口时，只加载每个窗口的当前标签页，并自动收起其他标签页组。`
8. 取消勾选 `Keep this code private`，然后发布。

## 命令行替代方案：创建 GitHub 空仓库

1. 登录 GitHub，点击右上角 `+`，选择 `New repository`。
2. Repository name 填写 `tab-group-lazy-restore`。
3. Description 可填写：`Chrome 恢复窗口时，只加载每个窗口的当前标签页，并自动收起其他标签页组。`
4. 选择 `Public`，以便免费使用 GitHub Pages 并公开源码。
5. 不要勾选自动添加 README、`.gitignore` 或许可证，本地目录已经准备好这些文件。
6. 点击 `Create repository`，复制仓库的 HTTPS 地址。

## 命令行替代方案：推送本地源码

在本目录打开终端，将下面的 `YOUR_NAME` 替换为 GitHub 用户名：

```bash
git add .
git commit -m "Release 4.3.0"
git remote add origin https://github.com/YOUR_NAME/tab-group-lazy-restore.git
git push -u origin main
```

如果 GitHub 要求登录，推荐使用浏览器授权、Git Credential Manager 或 Personal Access Token；GitHub 不再接受账号密码进行 Git HTTPS 推送。

## 开启 GitHub Pages

1. 打开仓库的 `Settings`。
2. 左侧选择 `Pages`。
3. 在 `Build and deployment` 下，将 Source 选择为 `Deploy from a branch`。
4. Branch 选择 `main`，目录选择 `/docs`。
5. 点击 `Save`。

发布完成后，隐私政策地址通常是：

```text
https://YOUR_NAME.github.io/tab-group-lazy-restore/
```

使用 Chrome 无痕窗口验证该地址无需登录、没有证书警告、发布者信息正确，再把它填入 Chrome Web Store 的隐私政策网址字段。

## 创建 GitHub Release

1. 打开仓库右侧 `Releases`，点击 `Create a new release`。
2. 新建标签 `v4.3.0`。
3. Release title 填写 `标签组懒恢复 4.3.0`。
4. 摘要可复制 `CHANGELOG.md` 中的 4.3.0 内容。
5. 如需提供手动安装包，可上传经过验证的 Chrome Web Store ZIP；不要上传任何 `.pem`、`.key`、恢复快照或浏览数据。

## 推荐仓库设置

- `Settings > Security`：开启 Private vulnerability reporting。
- `Actions`：首次推送后确认自动测试显示绿色通过。
- `About`：添加 `chrome-extension`、`tab-groups`、`productivity` 等主题。
