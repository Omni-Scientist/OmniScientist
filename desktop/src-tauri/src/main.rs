// Windows 上不带这行会多弹一个空控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    omnisci_tauri_lib::run()
}
