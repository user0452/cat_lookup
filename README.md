# 喵解

[![CI](https://github.com/user0452/cat_lookup/actions/workflows/ci.yml/badge.svg)](https://github.com/user0452/cat_lookup/actions/workflows/ci.yml)

喵解是一款 Windows 桌面悬浮工具。它以小猫悬浮球的形式常驻桌面，可解释选中的文字，也可以框选图片区域并通过 OCR 识别后解释内容。

## 功能

- 点击小猫，解释其他窗口中当前选中的文字。
- 右键小猫或按 `Alt + Shift + A`，框选图片区域进行 OCR 识别与解释。
- 拖拽小猫移动位置，靠近屏幕左右边缘时自动贴边收起。
- 在面板中设置回答语言和自定义提示词。
- 使用 Windows DPAPI 加密保存 API Key。

## 运行要求

- Windows 10 或 Windows 11 x64
- Microsoft Edge WebView2 Runtime
- DeepSeek API Key
- OCR.Space API Key，仅在使用框选 OCR 时需要

## 使用方法

1. 双击运行 `喵解-v1.0.0-windows-x64.exe`。
2. 点击小猫打开面板，再点击右上角设置按钮。
3. 填写 DeepSeek API Key。
4. 如需框选 OCR，填写 OCR.Space API Key，并勾选允许将框选截图发送到 OCR.Space。
5. 点击“保存设置”。

常用操作：

| 操作 | 效果 |
| --- | --- |
| 点击小猫 | 解释当前选中文字 |
| 右键小猫 | 进入 OCR 框选模式 |
| `Alt + Shift + A` | 切换 OCR 框选模式 |
| 拖拽小猫 | 移动悬浮球 |
| 将小猫拖至屏幕边缘 | 贴边收起 |
| `Esc` | 收起面板或取消框选 |

## 隐私说明

- 发布版 EXE 不包含任何 API Key，每位使用者需要自行配置。
- API Key 使用 Windows DPAPI 加密后保存在当前 Windows 用户的配置目录：

  ```text
  %APPDATA%\ask-fast\settings.json
  ```

- 解释选中文字时，文字内容会发送到 DeepSeek。
- 仅在用户启用并保存 OCR 授权后，框选截图区域才会发送到 OCR.Space。

## 本地开发

依赖：

- Node.js 20+
- Rust stable，目标工具链为 `x86_64-pc-windows-msvc`
- Visual Studio Build Tools，包含 C++ 桌面开发组件

安装依赖并启动开发版：

```powershell
npm ci
npm run tauri dev
```

运行验证：

```powershell
npm test
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml
```

构建单文件 Windows EXE：

```powershell
npm run tauri -- build --no-bundle
```

构建产物位于：

```text
src-tauri\target\release\ask-fast.exe
```

## 项目结构

```text
src/                    前端界面与悬浮球交互
src/public/cat/frames/  小猫动画帧
src-tauri/src/          Tauri Rust 命令与 Windows 系统交互
tests/                  前端逻辑测试
```

## License

[MIT](LICENSE)
