# Windows desktop build

Windows 版沿用 macOS/Linux 的桌面契约：一个 `OmniScientist.exe` 启动只监听
`127.0.0.1` 的本机 gateway，然后打开默认浏览器。前端仍然是同一套 React 页面，
没有 Electron 或内嵌 WebView。

## 构建

在 Windows PowerShell（或 WSL 中调用 `powershell.exe`）执行：

```powershell
cd desktop\packaging\windows
.\build-windows.ps1 -Version 0.1.0
```

产物在 `desktop/packaging/windows/dist/`：

```text
OmniScientist-0.1.0-windows-x64.zip
OmniScientist-0.1.0-windows-x64.zip.sha256
```

解压后运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

它只安装当前用户的开始菜单快捷方式，不需要管理员权限。卸载默认保留工作区、
会话和依赖；如果确认要删运行数据，再执行 `uninstall.ps1 -PurgeData`。

## WSL 命令后端

Windows 下模型生成的 `bash` 工具会按以下顺序选择执行器：

1. `OMNISCI_SHELL` 显式指定的 `wsl`、`bash` 或 `cmd`；
2. 已安装的 `wsl.exe`；
3. `bash.exe`（例如 Git Bash）；
4. `cmd.exe`。

安装 WSL 后无需把项目复制进 Linux 文件系统；Windows 工作区会转换成 `/mnt/c/...`
传给 WSL。若工作区位于自定义挂载点，可设置：

```powershell
$env:OMNISCI_SHELL = "wsl"
$env:OMNISCI_WSL_CWD = "/mnt/d/research/OmniScientist"
```

Python 论文工具优先使用应用数据目录下的托管 `venv\Scripts\python.exe`；
`OMNISCI_PYTHON` 可以覆盖它。凭据只从 `%USERPROFILE%\.omnisci\env` 读取，
不会传给分析子进程。

## 直接验证

```powershell
.\OmniScientist.exe --no-open --verbose
```

然后在浏览器打开终端输出的地址。健康检查无需 token，其他 API 必须先完成一次性
URL 握手；服务不会监听局域网地址。
