// OmniScientist menu-bar host.
//
// The product is a local service plus the system browser, not a native window
// (the desktop service contract (4.4)). This process exists to give that service a lifecycle a Mac user
// recognises: something to click, something to quit, and a visible failure when
// it breaks.
//
// It depends on nothing but the documented service contract (the desktop service contract):
//   --no-open, GET /api/health, ~/.omnisci/desktop.lock, POST /api/quit.
// Any binary honouring those can be dropped in beside it.

import AppKit
import Foundation

let serviceName = "omnisci-desktop"
let healthTimeout: TimeInterval = 30
let quitGrace: TimeInterval = 5

struct Session {
    let port: Int
    let token: String
    var url: URL { URL(string: "http://127.0.0.1:\(port)/?t=\(token)")! }
}

let omniHome = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".omnisci")
let lockFile = omniHome.appendingPathComponent("desktop.lock")
let logDirectory = omniHome.appendingPathComponent("logs")

// MARK: - Service contract

/// The lock file is the documented place the token lives. Parsed leniently: a
/// future launcher may add fields, and must not break this host by doing so.
func readLockFile() -> Session? {
    guard let data = try? Data(contentsOf: lockFile),
          let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let port = object["port"] as? Int,
          let token = object["token"] as? String,
          !token.isEmpty
    else { return nil }
    return Session(port: port, token: token)
}

/// Fallback for a launcher whose lock file we cannot parse: the ready line it
/// prints on stdout carries the same URL.
func parseReadyLine(_ text: String) -> Session? {
    guard let range = text.range(of: "http://127\\.0\\.0\\.1:[0-9]+/\\?t=[A-Za-z0-9._-]+",
                                 options: .regularExpression),
          let components = URLComponents(string: String(text[range])),
          let port = components.port,
          let token = components.queryItems?.first(where: { $0.name == "t" })?.value
    else { return nil }
    return Session(port: port, token: token)
}

func probeHealth(port: Int, timeout: TimeInterval = 1.5) -> Bool {
    guard let url = URL(string: "http://127.0.0.1:\(port)/api/health") else { return false }
    var request = URLRequest(url: url)
    request.timeoutInterval = timeout
    var healthy = false
    let done = DispatchSemaphore(value: 0)
    URLSession.shared.dataTask(with: request) { data, response, _ in
        defer { done.signal() }
        guard let http = response as? HTTPURLResponse, http.statusCode == 200, let data,
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        else { return }
        healthy = object["ok"] as? Bool == true
    }.resume()
    _ = done.wait(timeout: .now() + timeout + 0.5)
    return healthy
}

func healthWorkspace(port: Int, token: String) -> String? {
    guard let url = URL(string: "http://127.0.0.1:\(port)/api/health") else { return nil }
    var request = URLRequest(url: url)
    request.timeoutInterval = 3
    var workspace: String?
    let done = DispatchSemaphore(value: 0)
    URLSession.shared.dataTask(with: request) { data, _, _ in
        defer { done.signal() }
        guard let data, let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
        workspace = object["workspace"] as? String
    }.resume()
    _ = done.wait(timeout: .now() + 3.5)
    return workspace
}

/// Trades the token for whatever session credential the service issues.
///
/// The contract says the token rides on every API request but not how. One
/// launcher accepts it on the query string; another answers `/?t=` with a
/// redirect and an HttpOnly cookie and then accepts only that. Loading the URL
/// once through the shared session, exactly as a browser would, satisfies both:
/// any cookie set here is replayed automatically on later requests.
func handshake(session: Session) {
    var request = URLRequest(url: session.url)
    request.timeoutInterval = 5
    request.httpShouldHandleCookies = true
    let done = DispatchSemaphore(value: 0)
    URLSession.shared.dataTask(with: request) { _, _, _ in done.signal() }.resume()
    _ = done.wait(timeout: .now() + 5.5)
}

@discardableResult
func post(path: String, session: Session, timeout: TimeInterval = 3) -> Bool {
    guard let url = URL(string: "http://127.0.0.1:\(session.port)\(path)?t=\(session.token)") else { return false }
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.timeoutInterval = timeout
    request.httpShouldHandleCookies = true
    // Belt and braces: header for launchers that read it, cookie for the ones
    // that only trust the handshake, and the query string for the rest.
    request.setValue(session.token, forHTTPHeaderField: "x-omnisci-token")
    var ok = false
    let done = DispatchSemaphore(value: 0)
    URLSession.shared.dataTask(with: request) { _, response, _ in
        ok = (response as? HTTPURLResponse)?.statusCode == 200
        done.signal()
    }.resume()
    _ = done.wait(timeout: .now() + timeout + 0.5)
    return ok
}

/// Labels of the dependency checks that are not satisfied, for the menu badge.
func missingDependencies(session: Session) -> [String] {
    guard let url = URL(string: "http://127.0.0.1:\(session.port)/api/doctor?t=\(session.token)") else { return [] }
    var request = URLRequest(url: url)
    request.timeoutInterval = 30
    request.httpShouldHandleCookies = true
    request.setValue(session.token, forHTTPHeaderField: "x-omnisci-token")
    var missing: [String] = []
    let done = DispatchSemaphore(value: 0)
    URLSession.shared.dataTask(with: request) { data, _, _ in
        defer { done.signal() }
        guard let data,
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        else { return }

        // The contract says /api/doctor reports three things; it does not fix the
        // JSON shape, and the two launchers written against it chose different
        // ones. Read both rather than silently badge nothing.
        func isBad(_ check: [String: Any]) -> Bool {
            if let ok = check["ok"] as? Bool { return !ok }
            if let status = check["status"] as? String { return status != "ok" }
            return false
        }
        if let checks = object["checks"] as? [[String: Any]] {           // list of checks
            missing = checks.compactMap { check in
                guard isBad(check) else { return nil }
                return (check["label"] as? String) ?? (check["id"] as? String) ?? "?"
            }
        } else if let checks = object["checks"] as? [String: Any] {      // map keyed by name
            missing = checks.compactMap { name, value in
                guard let check = value as? [String: Any], isBad(check) else { return nil }
                return (check["label"] as? String) ?? name
            }.sorted()
        }
    }.resume()
    _ = done.wait(timeout: .now() + 31)
    return missing
}

func tailOfTodaysLog(lines: Int = 12) -> String {
    let formatter = DateFormatter()
    formatter.dateFormat = "yyyy-MM-dd"
    formatter.timeZone = TimeZone(identifier: "UTC")
    let file = logDirectory.appendingPathComponent("desktop-\(formatter.string(from: Date())).log")
    guard let text = try? String(contentsOf: file, encoding: .utf8) else { return "" }
    return text.split(separator: "\n").suffix(lines).joined(separator: "\n")
}

// MARK: - Status icon

/// Drawn rather than shipped as an asset: the menu bar wants a template image
/// that follows light and dark automatically, and a ring reads at 18 points
/// where a scaled-down app icon turns to mud.
/// 菜单栏图标：产品自己的标记，彩色。
///
/// 以前这里是代码里手画的一个圆环加圆点，跟品牌标记没有关系，用户在菜单栏
/// 看到的是个通用符号。现在读打包时放进 Resources 的 StatusIcon.png，
/// 改 logo 不用改代码。
///
/// isTemplate 必须是 false：模板模式会把整张图涂成单色，彩色旋涡就没了。
/// 这个标记本身在深浅两种菜单栏底色上都清楚，不靠系统着色。
func statusIcon(warning: Bool) -> NSImage {
    let side: CGFloat = 18
    let base = Bundle.main.url(forResource: "StatusIcon", withExtension: "png")
        .flatMap { NSImage(contentsOf: $0) }
        ?? NSApp.applicationIconImage

    let image = NSImage(size: NSSize(width: side, height: side), flipped: false) { rect in
        base?.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1.0)
        if warning {
            // 右上角一个不透明角标，压在彩图上也读得出"有事要处理"
            let pip = NSRect(x: rect.maxX - 6.0, y: rect.maxY - 6.0, width: 6.0, height: 6.0)
            NSColor.white.setFill()
            NSBezierPath(ovalIn: pip.insetBy(dx: -0.8, dy: -0.8)).fill()
            NSColor.systemRed.setFill()
            NSBezierPath(ovalIn: pip).fill()
        }
        return true
    }
    image.isTemplate = false
    return image
}

// MARK: - App

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var child: Process?
    private var session: Session?
    private var workspace = ""
    private var missing: [String] = []
    /// Suppresses the crash alert while we are the ones taking the service down.
    private var stopping = false
    private var childOutput = ""
    private let outputLock = NSLock()

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.image = statusIcon(warning: false)
        statusItem.button?.toolTip = "OmniScientist"
        rebuildMenu(state: "正在启动…")
        DispatchQueue.global(qos: .userInitiated).async { self.startService(workspace: nil) }
    }

    // MARK: service lifecycle

    private var serviceURL: URL {
        Bundle.main.executableURL!.deletingLastPathComponent().appendingPathComponent(serviceName)
    }

    private func startService(workspace: String?) {
        // An instance from an earlier launch (or from a terminal) is a session
        // to adopt, not a reason to start a second service.
        if let existing = readLockFile(), probeHealth(port: existing.port) {
            finishStartup(with: existing)
            return
        }

        let executable = serviceURL
        guard FileManager.default.isExecutableFile(atPath: executable.path) else {
            DispatchQueue.main.async {
                self.fail(title: "OmniScientist 装不全",
                          message: "找不到服务程序：\n\(executable.path)\n\n应用包不完整，请重新安装。")
            }
            return
        }

        let process = Process()
        process.executableURL = executable
        var arguments = ["--no-open", "--verbose"]
        if let workspace { arguments += ["--workspace", workspace] }
        process.arguments = arguments

        // The pipe must be drained or the child blocks once its buffer fills.
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8), let self else { return }
            self.outputLock.lock()
            self.childOutput = String((self.childOutput + text).suffix(8192))
            self.outputLock.unlock()
        }

        process.terminationHandler = { [weak self] finished in
            DispatchQueue.main.async { self?.childDied(status: finished.terminationStatus) }
        }

        do {
            try process.run()
        } catch {
            DispatchQueue.main.async {
                self.fail(title: "OmniScientist 起不来",
                          message: "无法启动服务程序：\n\(error.localizedDescription)")
            }
            return
        }
        child = process

        // Poll until the service says it is ready. Opening the browser before
        // this point is the race the --no-open flag exists to avoid.
        let deadline = Date().addingTimeInterval(healthTimeout)
        while Date() < deadline {
            if let found = readLockFile(), probeHealth(port: found.port) {
                finishStartup(with: found)
                return
            }
            outputLock.lock()
            let seen = childOutput
            outputLock.unlock()
            if let found = parseReadyLine(seen), probeHealth(port: found.port) {
                finishStartup(with: found)
                return
            }
            if !process.isRunning { return }  // terminationHandler reports it
            Thread.sleep(forTimeInterval: 0.25)
        }

        DispatchQueue.main.async {
            let tail = tailOfTodaysLog()
            self.fail(title: "OmniScientist 启动超时",
                      message: "服务在 \(Int(healthTimeout)) 秒内没有就绪。\n\n日志：\(logDirectory.path)\n\n"
                             + (tail.isEmpty ? "日志还是空的。" : "最后几行：\n\(tail)"))
        }
    }

    private func finishStartup(with found: Session) {
        handshake(session: found)
        let root = healthWorkspace(port: found.port, token: found.token) ?? ""
        DispatchQueue.main.async {
            self.session = found
            self.workspace = root
            self.openWorkbench(nil)
            self.rebuildMenu(state: "运行中 · 端口 \(found.port)")
        }
        // The dependency check spawns python, so it must never delay the browser.
        DispatchQueue.global(qos: .utility).async {
            let bad = missingDependencies(session: found)
            DispatchQueue.main.async {
                self.missing = bad
                self.statusItem.button?.image = statusIcon(warning: !bad.isEmpty)
                self.rebuildMenu(state: "运行中 · 端口 \(found.port)")
            }
        }
    }

    private func childDied(status: Int32) {
        guard !stopping else { return }
        // A launcher that finds a live instance exits 0 straight away; that is a
        // handover, not a crash.
        if status == 0, let existing = readLockFile(), probeHealth(port: existing.port) {
            child = nil
            finishStartup(with: existing)
            return
        }
        let tail = tailOfTodaysLog()
        fail(title: "OmniScientist 服务已停止",
             message: "后台服务退出了（退出码 \(status)）。\n\n日志：\(logDirectory.path)\n\n"
                    + (tail.isEmpty ? "日志里没有更多信息。" : "最后几行：\n\(tail)"))
    }

    private func fail(title: String, message: String) {
        stopping = true
        session = nil
        rebuildMenu(state: "已停止")
        statusItem.button?.image = statusIcon(warning: true)
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: "打开日志文件夹")
        alert.addButton(withTitle: "退出")
        if alert.runModal() == .alertFirstButtonReturn { showLogs(nil) }
        NSApp.terminate(nil)
    }

    // MARK: menu

    private func rebuildMenu(state: String) {
        let menu = NSMenu()
        menu.autoenablesItems = false

        let header = NSMenuItem(title: "OmniScientist · \(state)", action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)
        menu.addItem(.separator())

        let open = NSMenuItem(title: "打开工作台", action: #selector(openWorkbench(_:)), keyEquivalent: "o")
        open.target = self
        open.isEnabled = session != nil
        menu.addItem(open)

        if !missing.isEmpty {
            let warn = NSMenuItem(title: "缺少依赖：\(missing.joined(separator: "、"))",
                                  action: #selector(openWorkbench(_:)), keyEquivalent: "")
            warn.target = self
            warn.isEnabled = session != nil
            menu.addItem(warn)
        }

        if !workspace.isEmpty {
            let item = NSMenuItem(title: "工作区：\((workspace as NSString).abbreviatingWithTildeInPath)",
                                  action: #selector(revealWorkspace(_:)), keyEquivalent: "")
            item.target = self
            menu.addItem(item)
        }

        let choose = NSMenuItem(title: "选择工作区…", action: #selector(chooseWorkspace(_:)), keyEquivalent: "")
        choose.target = self
        menu.addItem(choose)

        let logs = NSMenuItem(title: "显示日志", action: #selector(showLogs(_:)), keyEquivalent: "l")
        logs.target = self
        menu.addItem(logs)

        menu.addItem(.separator())
        let quitItem = NSMenuItem(title: "退出 OmniScientist", action: #selector(quit(_:)), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)

        statusItem.menu = menu
    }

    /// 点 Dock 图标就打开工作台。
    ///
    /// 做过"切回已经打开的那个标签页"，但浏览器没有"这个 URL 已经开着了"的接口，
    /// 只能用 AppleScript 去翻标签页，而那要请求控制浏览器的权限，
    /// 会弹一个"OmniScientist 想要控制 Google Chrome"的系统弹窗。
    /// 为这点便利换那个弹窗不划算，所以就是简单地开一页。
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        openWorkbench(nil)
        return false
    }

    @objc private func openWorkbench(_ sender: Any?) {
        guard let session else { return }
        NSWorkspace.shared.open(session.url)
    }

    @objc private func revealWorkspace(_ sender: Any?) {
        guard !workspace.isEmpty else { return }
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: workspace)])
    }

    @objc private func showLogs(_ sender: Any?) {
        try? FileManager.default.createDirectory(at: logDirectory, withIntermediateDirectories: true)
        NSWorkspace.shared.activateFileViewerSelecting([logDirectory])
    }

    @objc private func chooseWorkspace(_ sender: Any?) {
        NSApp.activate(ignoringOtherApps: true)
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.prompt = "选为工作区"
        guard panel.runModal() == .OK, let chosen = panel.url else { return }
        rebuildMenu(state: "正在切换工作区…")
        DispatchQueue.global(qos: .userInitiated).async {
            self.stopService()
            DispatchQueue.main.async {
                self.session = nil
                self.workspace = ""
                self.missing = []
            }
            self.stopping = false
            self.startService(workspace: chosen.path)
        }
    }

    // MARK: shutdown

    /// Asks the service to quit, then escalates. Returns once it is gone.
    private func stopService() {
        stopping = true
        if let session { post(path: "/api/quit", session: session) }
        let deadline = Date().addingTimeInterval(quitGrace)
        while let process = child, process.isRunning, Date() < deadline {
            Thread.sleep(forTimeInterval: 0.1)
        }
        if let process = child, process.isRunning {
            process.terminate()  // SIGTERM
            let hard = Date().addingTimeInterval(2)
            while process.isRunning, Date() < hard { Thread.sleep(forTimeInterval: 0.1) }
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        }
        child?.terminationHandler = nil
        child = nil
    }

    @objc private func quit(_ sender: Any?) {
        stopping = true
        DispatchQueue.global(qos: .userInitiated).async {
            self.stopService()
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        if child != nil { stopService() }
    }
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.setActivationPolicy(.accessory)  // menu bar only; LSUIElement covers the rest
application.run()
