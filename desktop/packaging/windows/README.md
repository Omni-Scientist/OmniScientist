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
OmniSci-Desktop-Windows-x64.zip
OmniSci-Desktop-Windows-x64.zip.sha256
```

解压后**双击 `install.cmd`** 即可安装并自动启动。安装器是纯 batch（快捷方式
那步用 Windows 自带的 cscript 写，零外部依赖），不含任何 .ps1，普通用户双击
就能跑。只装当前用户的开始菜单快捷方式，不需要管理员权限。旧版还在运行时
会先征求同意再退出它。卸载双击 `uninstall.cmd`，默认保留工作区、会话和依赖，
结束时会把数据目录的路径列出来，确认不要了再手动删。

## 命令后端：需要原生 bash

模型生成的 `bash` 工具在 Windows 上**只接受原生 bash**，也就是 Git for Windows
自带的那个（`$OSTYPE` 以 `msys` 或 `cygwin` 开头）。没装就直接报错，不会退而求其次。

装它：<https://git-scm.com/download/win>。默认安装位置会被自动找到，
装完重开 OmniScientist 即可。想指到别处用 `$env:OMNISCI_SHELL`。

**WSL 的 bash 会被明确拒绝。** 它跑在另一个操作系统里：文件系统是 `/mnt/c/...`
而不是 `C:\...`，宿主进程的环境变量一个都拿不到。命令看起来跑成功了，产物却落在
Linux 那边，工作台一片空白 —— 这种错法比直接报错难查得多，所以宁可不跑。
`cmd.exe` 同理不支持，模型写的是 POSIX 语法。

Python 论文工具优先使用应用数据目录下的托管 `venv\Scripts\python.exe`；
`OMNISCI_PYTHON` 可以覆盖它。注意 `python3` 在 Windows 上通常是微软商店的
应用执行别名（2 字节的占位符，跑起来退出码 49），那个不是 python，程序会跳过它。

tectonic 由依赖引导自动下载（x64 有官方构建；ARM64 上游没出包，需要自己装）。
没有它的话研究能跑完，但只出 `.tex` 不出 PDF。

凭据只从 `%USERPROFILE%\.omnisci\env` 读取，不会传给分析子进程。

## 直接验证

```powershell
.\OmniScientist.exe --no-open --verbose
```

然后在浏览器打开终端输出的地址。健康检查无需 token，其他 API 必须先完成一次性
URL 握手；服务不会监听局域网地址。
