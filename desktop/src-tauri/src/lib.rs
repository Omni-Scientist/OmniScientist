use std::sync::Mutex;

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// 正在跑的本机服务进程。退出时要拿它出来杀，不留后台孤儿。
struct Service(Mutex<Option<CommandChild>>);

/// 从服务进程的一行输出里揪出带一次性令牌的入口 URL。
///
/// 服务启动时会把 `http://127.0.0.1:<port>/?t=<token>` 打到 stdout，这跟 macOS
/// 菜单栏宿主解析的是同一条约定。token 只在这条 URL 上出现一次，服务端换成
/// HttpOnly cookie 后就作废。
fn find_entry_url(line: &str) -> Option<String> {
    let start = line.find("http://127.0.0.1:")?;
    let rest = &line[start..];
    let end = rest
        .find(|c: char| c.is_whitespace() || c == '"' || c == '\'')
        .unwrap_or(rest.len());
    let url = &rest[..end];
    if url.contains("/?t=") {
        Some(url.to_string())
    } else {
        None
    }
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // 窗口立刻开，先显示打包在壳里的开屏页；等服务就绪后原窗口跳转。
            // 不这样的话，用户要对着白屏等"服务启动 + WebView 初始化"整个过程。
            WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::App("splash.html".into()),
            )
            .title("OmniScientist")
            .inner_size(1360.0, 860.0)
            .min_inner_size(760.0, 560.0)
            .build()
            .expect("开主窗口失败");

            let sidecar = app.shell().sidecar("omnisci-desktop")?.args(["--no-open"]);
            let (mut rx, child) = sidecar.spawn()?;
            app.manage(Service(Mutex::new(Some(child))));

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut opened = false;
                while let Some(event) = rx.recv().await {
                    let bytes = match event {
                        CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => bytes,
                        _ => continue,
                    };
                    // 跳转过之后也要继续收，不然子进程的输出管道写满会卡死它
                    if opened {
                        continue;
                    }
                    let line = String::from_utf8_lossy(&bytes);
                    if let Some(url) = find_entry_url(&line) {
                        opened = true;
                        let handle2 = handle.clone();
                        let _ = handle.run_on_main_thread(move || {
                            if let Some(mut window) = handle2.get_webview_window("main") {
                                // 用壳的原生导航而不是页面里的 location.replace：
                                // 后者的发起源是 tauri:// 开屏页，属于跨站导航，
                                // SameSite cookie 会被扣下；原生导航没有发起源，
                                // 跟第一方加载同等对待。
                                let parsed: tauri::Url =
                                    url.parse().expect("服务打出的 URL 一定合法");
                                let _ = window.navigate(parsed);
                            }
                        });
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Tauri 启动失败");

    app.run(|app, event| {
        // 最后一个窗口关掉，Tauri 就走到 Exit；把本机服务一起带走
        if let RunEvent::Exit = event {
            if let Some(service) = app.try_state::<Service>() {
                if let Some(child) = service.0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        }
    });
}
