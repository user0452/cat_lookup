use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

// ========== 设置 ==========
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Settings {
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub ocr_api_key: String,
    #[serde(default)]
    pub answer_language: String,
    #[serde(default)]
    pub system_prompt: String,
    #[serde(default)]
    pub ocr_consent: bool,
}

#[derive(Serialize, Deserialize, Default)]
struct StoredSettings {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    api_key_protected: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    ocr_api_key_protected: String,
    #[serde(default, skip_serializing)]
    api_key: String,
    #[serde(default, skip_serializing)]
    ocr_api_key: String,
    #[serde(default)]
    answer_language: String,
    #[serde(default)]
    system_prompt: String,
    #[serde(default)]
    ocr_consent: bool,
}

fn settings_path() -> PathBuf {
    let mut path = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    path.push("ask-fast");
    fs::create_dir_all(&path).ok();
    path.push("settings.json");
    path
}

fn remove_legacy_clipboard_backup() {
    let mut path = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    path.push("ask-fast");
    path.push("clipboard_backup.txt");
    let _ = fs::remove_file(path);
}

#[cfg(target_os = "windows")]
fn protect_secret(secret: &str) -> Result<String, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    if secret.is_empty() {
        return Ok(String::new());
    }

    let bytes = secret.as_bytes();
    let input_len = u32::try_from(bytes.len()).map_err(|_| "密钥长度无效".to_string())?;
    let input = CRYPT_INTEGER_BLOB {
        cbData: input_len,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    let protected = unsafe {
        CryptProtectData(
            &input,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };

    if protected == 0 {
        return Err(format!("加密密钥失败: {}", std::io::Error::last_os_error()));
    }

    let encrypted = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) };
    let encoded = general_purpose::STANDARD.encode(encrypted);
    unsafe {
        LocalFree(output.pbData as _);
    }
    Ok(encoded)
}

#[cfg(not(target_os = "windows"))]
fn protect_secret(_secret: &str) -> Result<String, String> {
    Err("当前系统不支持安全保存密钥".to_string())
}

#[cfg(target_os = "windows")]
fn unprotect_secret(protected: &str) -> Result<String, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    if protected.is_empty() {
        return Ok(String::new());
    }

    let encrypted = general_purpose::STANDARD
        .decode(protected)
        .map_err(|e| format!("解码密钥失败: {}", e))?;
    let input_len = u32::try_from(encrypted.len()).map_err(|_| "密钥长度无效".to_string())?;
    let input = CRYPT_INTEGER_BLOB {
        cbData: input_len,
        pbData: encrypted.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    let unprotected = unsafe {
        CryptUnprotectData(
            &input,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };

    if unprotected == 0 {
        return Err(format!("解密密钥失败: {}", std::io::Error::last_os_error()));
    }

    let decrypted = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) };
    let secret = String::from_utf8(decrypted.to_vec()).map_err(|e| format!("密钥格式无效: {}", e));
    unsafe {
        LocalFree(output.pbData as _);
    }
    secret
}

#[cfg(not(target_os = "windows"))]
fn unprotect_secret(_protected: &str) -> Result<String, String> {
    Err("当前系统不支持读取安全密钥".to_string())
}

#[tauri::command]
pub fn load_settings() -> Result<Settings, String> {
    remove_legacy_clipboard_backup();
    let path = settings_path();
    if !path.exists() {
        return Ok(Settings {
            answer_language: "zh-CN".to_string(),
            ..Default::default()
        });
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let stored: StoredSettings = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    let settings = Settings {
        api_key: if stored.api_key_protected.is_empty() {
            stored.api_key.clone()
        } else {
            unprotect_secret(&stored.api_key_protected)?
        },
        ocr_api_key: if stored.ocr_api_key_protected.is_empty() {
            stored.ocr_api_key.clone()
        } else {
            unprotect_secret(&stored.ocr_api_key_protected)?
        },
        answer_language: if stored.answer_language.is_empty() {
            "zh-CN".to_string()
        } else {
            stored.answer_language
        },
        system_prompt: stored.system_prompt,
        ocr_consent: stored.ocr_consent,
    };

    if !stored.api_key.is_empty() || !stored.ocr_api_key.is_empty() {
        save_settings(settings.clone())?;
    }

    Ok(settings)
}

#[tauri::command]
pub fn save_settings(settings: Settings) -> Result<(), String> {
    let path = settings_path();
    let stored = StoredSettings {
        api_key_protected: protect_secret(&settings.api_key)?,
        ocr_api_key_protected: protect_secret(&settings.ocr_api_key)?,
        answer_language: settings.answer_language,
        system_prompt: settings.system_prompt,
        ocr_consent: settings.ocr_consent,
        ..Default::default()
    };
    let json = serde_json::to_string_pretty(&stored).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
}

// ========== 截图 ==========
use xcap::Monitor;

#[tauri::command]
pub fn capture_screen_region(x: i32, y: i32, w: u32, h: u32) -> Result<String, String> {
    if w == 0 || h == 0 {
        return Err("选区大小无效".to_string());
    }

    let center_x = x.saturating_add((w / 2) as i32);
    let center_y = y.saturating_add((h / 2) as i32);
    let monitor = Monitor::from_point(center_x, center_y)
        .or_else(|_| Monitor::from_point(x, y))
        .map_err(|_| "未找到选区所在显示器".to_string())?;
    let image = monitor.capture_image().map_err(|e| e.to_string())?;

    let monitor_left = i64::from(monitor.x());
    let monitor_top = i64::from(monitor.y());
    let monitor_right = monitor_left + i64::from(monitor.width());
    let monitor_bottom = monitor_top + i64::from(monitor.height());

    let crop_left = i64::from(x).max(monitor_left);
    let crop_top = i64::from(y).max(monitor_top);
    let crop_right = (i64::from(x) + i64::from(w)).min(monitor_right);
    let crop_bottom = (i64::from(y) + i64::from(h)).min(monitor_bottom);

    if crop_right <= crop_left || crop_bottom <= crop_top {
        return Err("选区超出屏幕范围".to_string());
    }

    let img_w = image.width();
    let img_h = image.height();
    let crop_x = (crop_left - monitor_left) as u32;
    let crop_y = (crop_top - monitor_top) as u32;
    let crop_w = (crop_right - crop_left) as u32;
    let crop_h = (crop_bottom - crop_top) as u32;
    let safe_w = crop_w.min(img_w.saturating_sub(crop_x));
    let safe_h = crop_h.min(img_h.saturating_sub(crop_y));

    if safe_w == 0 || safe_h == 0 {
        return Err("选区超出屏幕范围".to_string());
    }

    let cropped = image::imageops::crop_imm(&image, crop_x, crop_y, safe_w, safe_h).to_image();
    let mut buf = std::io::Cursor::new(Vec::new());
    cropped
        .write_to(&mut buf, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;

    let b64 = general_purpose::STANDARD.encode(buf.into_inner());
    Ok(format!("data:image/png;base64,{}", b64))
}

// ========== OCR ==========
use reqwest::Client;

#[derive(Deserialize)]
struct OcrResponse {
    #[serde(rename = "ParsedResults")]
    parsed_results: Option<Vec<ParsedResult>>,
    #[serde(rename = "IsErroredOnProcessing")]
    is_errored: Option<bool>,
    #[serde(rename = "ErrorMessage")]
    error_message: Option<Vec<String>>,
}

#[derive(Deserialize, Clone)]
struct ParsedResult {
    #[serde(rename = "ParsedText")]
    parsed_text: Option<String>,
}

#[tauri::command]
pub async fn ocr_image(image_data_url: String, api_key: Option<String>) -> Result<String, String> {
    ensure_ocr_consent(&load_settings()?)?;
    let key = api_key
        .filter(|k| !k.is_empty())
        .ok_or("请先在设置中配置 OCR.Space API Key")?;
    let base64_data = if image_data_url.contains(",") {
        image_data_url.split(",").nth(1).unwrap_or(&image_data_url)
    } else {
        &image_data_url
    };

    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let params = [
        (
            "base64Image",
            format!("data:image/png;base64,{}", base64_data),
        ),
        ("language", "auto".to_string()),
        ("isOverlayRequired", "false".to_string()),
        ("OCREngine", "2".to_string()),
    ];

    let response = client
        .post("https://api.ocr.space/parse/image")
        .header("apikey", key)
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("OCR 请求失败: {}", e))?;

    let result: OcrResponse = response
        .json()
        .await
        .map_err(|e| format!("OCR 响应解析失败: {}", e))?;

    if result.is_errored.unwrap_or(false) {
        let msg = result
            .error_message
            .and_then(|m| m.first().cloned())
            .unwrap_or_else(|| "OCR 处理失败".to_string());
        return Err(msg);
    }

    let text = result
        .parsed_results
        .and_then(|r| r.first().cloned())
        .and_then(|r| r.parsed_text)
        .unwrap_or_default()
        .trim()
        .to_string();

    if text.is_empty() {
        return Err("未识别到任何文字".to_string());
    }

    Ok(text)
}

fn ensure_ocr_consent(settings: &Settings) -> Result<(), String> {
    if settings.ocr_consent {
        Ok(())
    } else {
        Err("使用框选 OCR 前，请在设置中勾选授权并保存".to_string())
    }
}

// ========== DeepSeek 解释 ==========
#[derive(Serialize)]
struct ChatRequest {
    model: String,
    messages: Vec<Message>,
    stream: bool,
    max_tokens: u32,
}

#[derive(Serialize)]
struct Message {
    role: String,
    content: String,
}

#[derive(Deserialize)]
struct ChatResponse {
    choices: Option<Vec<Choice>>,
}

#[derive(Deserialize, Clone)]
struct Choice {
    message: Option<Content>,
}

#[derive(Deserialize, Clone)]
struct Content {
    content: Option<String>,
}

fn validate_text_length(text: &str) -> Result<(), String> {
    if text.chars().count() > 8000 {
        return Err("文字过长，最多支持 8000 字符".to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn explain_text(
    text: String,
    system_prompt: String,
    api_key: Option<String>,
) -> Result<String, String> {
    let key = api_key
        .filter(|k| !k.is_empty())
        .ok_or("请先在设置中配置 DeepSeek API Key")?;

    validate_text_length(&text)?;

    let client = Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;

    let request = ChatRequest {
        model: "deepseek-chat".to_string(),
        messages: vec![
            Message {
                role: "system".to_string(),
                content: system_prompt,
            },
            Message {
                role: "user".to_string(),
                content: format!("请解释以下内容：\n\n{}", text),
            },
        ],
        stream: false,
        max_tokens: 1500,
    };

    let response = client
        .post("https://api.deepseek.com/chat/completions")
        .header("Authorization", format!("Bearer {}", key))
        .header("Content-Type", "application/json")
        .json(&request)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let msg = match status {
            401 | 403 => "API Key 无效，请检查设置",
            429 => "请求过于频繁，请稍后重试",
            500..=599 => "DeepSeek 服务暂时不可用",
            _ => "请求失败",
        };
        return Err(format!("{} (HTTP {})", msg, status));
    }

    let result: ChatResponse = response
        .json()
        .await
        .map_err(|e| format!("响应解析失败: {}", e))?;

    let answer = result
        .choices
        .and_then(|c| c.first().cloned())
        .and_then(|c| c.message)
        .and_then(|m| m.content)
        .ok_or("未获取到回答")?;

    Ok(answer)
}

// ========== 剪贴板 ==========

#[cfg(target_os = "windows")]
const CF_UNICODETEXT: u32 = 13;

#[cfg(target_os = "windows")]
const CF_BITMAP: u32 = 2;

#[cfg(target_os = "windows")]
const CF_DIB: u32 = 8;

#[cfg(target_os = "windows")]
const CF_DIBV5: u32 = 17;

#[cfg(target_os = "windows")]
const CF_METAFILEPICT: u32 = 3;

#[cfg(target_os = "windows")]
const CF_PALETTE: u32 = 9;

#[cfg(target_os = "windows")]
const CF_ENHMETAFILE: u32 = 14;

#[cfg(target_os = "windows")]
const CF_OWNERDISPLAY: u32 = 128;

#[cfg(target_os = "windows")]
const CF_DSPBITMAP: u32 = 130;

#[cfg(target_os = "windows")]
const CF_DSPMETAFILEPICT: u32 = 131;

#[cfg(target_os = "windows")]
const CF_DSPENHMETAFILE: u32 = 142;

#[cfg(target_os = "windows")]
static LAST_TARGET_WINDOW: OnceLock<Mutex<isize>> = OnceLock::new();

#[cfg(target_os = "windows")]
static CLIPBOARD_BACKUP: OnceLock<Mutex<Option<ClipboardBackup>>> = OnceLock::new();

#[cfg(target_os = "windows")]
fn last_target_window() -> &'static Mutex<isize> {
    LAST_TARGET_WINDOW.get_or_init(|| Mutex::new(0))
}

#[cfg(target_os = "windows")]
fn clipboard_backup() -> &'static Mutex<Option<ClipboardBackup>> {
    CLIPBOARD_BACKUP.get_or_init(|| Mutex::new(None))
}

#[cfg(target_os = "windows")]
enum ClipboardFormatBackup {
    Global {
        format: u32,
        data: Vec<u8>,
    },
    Bitmap {
        format: u32,
        handle: isize,
    },
    EnhancedMetaFile {
        format: u32,
        handle: isize,
    },
    MetaFilePicture {
        format: u32,
        mm: i32,
        x_ext: i32,
        y_ext: i32,
        handle: isize,
    },
    Palette {
        format: u32,
        entries: Vec<windows_sys::Win32::Graphics::Gdi::PALETTEENTRY>,
    },
}

#[cfg(target_os = "windows")]
impl Drop for ClipboardFormatBackup {
    fn drop(&mut self) {
        use windows_sys::Win32::Graphics::Gdi::{DeleteEnhMetaFile, DeleteMetaFile, DeleteObject};

        unsafe {
            match self {
                Self::Bitmap { handle, .. } if *handle != 0 => {
                    DeleteObject(*handle as _);
                }
                Self::EnhancedMetaFile { handle, .. } if *handle != 0 => {
                    DeleteEnhMetaFile(*handle as _);
                }
                Self::MetaFilePicture { handle, .. } if *handle != 0 => {
                    DeleteMetaFile(*handle as _);
                }
                _ => {}
            }
        }
    }
}

#[cfg(target_os = "windows")]
struct ClipboardBackup {
    formats: Vec<ClipboardFormatBackup>,
}

#[cfg(target_os = "windows")]
struct ClipboardGuard;

#[cfg(target_os = "windows")]
impl Drop for ClipboardGuard {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::System::DataExchange::CloseClipboard();
        }
    }
}

#[cfg(target_os = "windows")]
fn open_clipboard() -> Result<ClipboardGuard, String> {
    use windows_sys::Win32::System::DataExchange::OpenClipboard;

    for _ in 0..10 {
        let opened = unsafe { OpenClipboard(std::ptr::null_mut()) };
        if opened != 0 {
            return Ok(ClipboardGuard);
        }
        std::thread::sleep(Duration::from_millis(20));
    }

    Err("无法打开剪贴板".to_string())
}

#[cfg(target_os = "windows")]
fn snapshot_clipboard() -> Result<ClipboardBackup, String> {
    use windows_sys::Win32::System::DataExchange::{EnumClipboardFormats, GetClipboardData};

    let _guard = open_clipboard()?;
    let mut formats = Vec::new();
    let mut available_formats = Vec::new();
    let mut format = 0;

    loop {
        format = unsafe { EnumClipboardFormats(format) };
        if format == 0 {
            break;
        }
        available_formats.push(format);
    }

    let has_serialized_bitmap =
        available_formats.contains(&CF_DIB) || available_formats.contains(&CF_DIBV5);

    for format in available_formats {
        let handle = unsafe { GetClipboardData(format) };
        if handle.is_null() {
            return Err(format!("无法备份剪贴板格式 {}", format));
        }
        match snapshot_clipboard_format(format, handle) {
            Ok(backup) => formats.push(backup),
            Err(_) if has_serialized_bitmap && matches!(format, CF_BITMAP | CF_DSPBITMAP) => {}
            Err(error) => return Err(error),
        }
    }

    Ok(ClipboardBackup { formats })
}

#[cfg(target_os = "windows")]
fn snapshot_clipboard_format(
    format: u32,
    handle: windows_sys::Win32::Foundation::HANDLE,
) -> Result<ClipboardFormatBackup, String> {
    use windows_sys::Win32::Graphics::Gdi::{
        CopyEnhMetaFileW, CopyMetaFileW, GetPaletteEntries, PALETTEENTRY,
    };
    use windows_sys::Win32::System::DataExchange::METAFILEPICT;
    use windows_sys::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CopyImage, IMAGE_BITMAP, LR_CREATEDIBSECTION,
    };

    match format {
        CF_BITMAP | CF_DSPBITMAP => {
            let mut copy = unsafe { CopyImage(handle, IMAGE_BITMAP, 0, 0, LR_CREATEDIBSECTION) };
            if copy.is_null() {
                copy = unsafe { CopyImage(handle, IMAGE_BITMAP, 0, 0, 0) };
            }
            if copy.is_null() {
                return Err(format!(
                    "无法备份剪贴板位图格式 {}: {}",
                    format,
                    std::io::Error::last_os_error()
                ));
            }
            Ok(ClipboardFormatBackup::Bitmap {
                format,
                handle: copy as isize,
            })
        }
        CF_ENHMETAFILE | CF_DSPENHMETAFILE => {
            let copy = unsafe { CopyEnhMetaFileW(handle as _, std::ptr::null()) };
            if copy.is_null() {
                return Err(format!("无法备份剪贴板增强图元文件格式 {}", format));
            }
            Ok(ClipboardFormatBackup::EnhancedMetaFile {
                format,
                handle: copy as isize,
            })
        }
        CF_METAFILEPICT | CF_DSPMETAFILEPICT => {
            let ptr = unsafe { GlobalLock(handle as _) } as *const METAFILEPICT;
            if ptr.is_null() {
                return Err(format!("无法读取剪贴板图元文件格式 {}", format));
            }
            let picture = unsafe { *ptr };
            let copy = unsafe { CopyMetaFileW(picture.hMF, std::ptr::null()) };
            unsafe {
                GlobalUnlock(handle as _);
            }
            if copy.is_null() {
                return Err(format!("无法备份剪贴板图元文件格式 {}", format));
            }
            Ok(ClipboardFormatBackup::MetaFilePicture {
                format,
                mm: picture.mm,
                x_ext: picture.xExt,
                y_ext: picture.yExt,
                handle: copy as isize,
            })
        }
        CF_PALETTE => {
            let count = unsafe { GetPaletteEntries(handle as _, 0, 0, std::ptr::null_mut()) };
            if count == 0 || count > u16::MAX as u32 {
                return Err("无法备份剪贴板调色板".to_string());
            }
            let mut entries = vec![PALETTEENTRY::default(); count as usize];
            let copied = unsafe { GetPaletteEntries(handle as _, 0, count, entries.as_mut_ptr()) };
            if copied != count {
                return Err("无法备份剪贴板调色板".to_string());
            }
            Ok(ClipboardFormatBackup::Palette { format, entries })
        }
        CF_OWNERDISPLAY => Err("当前剪贴板包含无法安全备份的显示格式".to_string()),
        _ => {
            let size = unsafe { GlobalSize(handle as _) };
            if size == 0 {
                return Err(format!(
                    "当前剪贴板包含无法安全备份的格式 {}，操作已取消",
                    format
                ));
            }
            let ptr = unsafe { GlobalLock(handle as _) } as *const u8;
            if ptr.is_null() {
                return Err(format!(
                    "当前剪贴板包含无法安全备份的格式 {}，操作已取消",
                    format
                ));
            }
            let data = unsafe { std::slice::from_raw_parts(ptr, size) }.to_vec();
            unsafe {
                GlobalUnlock(handle as _);
            }
            Ok(ClipboardFormatBackup::Global { format, data })
        }
    }
}

#[cfg(target_os = "windows")]
fn restore_clipboard_snapshot(backup: &mut ClipboardBackup) -> Result<(), String> {
    use windows_sys::Win32::Foundation::GlobalFree;
    use windows_sys::Win32::Graphics::Gdi::{
        CreatePalette, DeleteObject, LOGPALETTE, PALETTEENTRY,
    };
    use windows_sys::Win32::System::DataExchange::{
        EmptyClipboard, SetClipboardData, METAFILEPICT,
    };
    use windows_sys::Win32::System::Memory::{
        GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE,
    };

    let _guard = open_clipboard()?;
    if unsafe { EmptyClipboard() } == 0 {
        return Err("清空剪贴板失败".to_string());
    }

    for item in &mut backup.formats {
        match item {
            ClipboardFormatBackup::Global { format, data } => {
                let global = alloc_global_bytes(data)?;
                if unsafe { SetClipboardData(*format, global as _) }.is_null() {
                    unsafe {
                        GlobalFree(global);
                    }
                    return Err(format!("恢复剪贴板格式 {} 失败", format));
                }
            }
            ClipboardFormatBackup::Bitmap { format, handle }
            | ClipboardFormatBackup::EnhancedMetaFile { format, handle } => {
                if unsafe { SetClipboardData(*format, *handle as _) }.is_null() {
                    return Err(format!("恢复剪贴板格式 {} 失败", format));
                }
                *handle = 0;
            }
            ClipboardFormatBackup::MetaFilePicture {
                format,
                mm,
                x_ext,
                y_ext,
                handle,
            } => {
                let global =
                    unsafe { GlobalAlloc(GMEM_MOVEABLE, std::mem::size_of::<METAFILEPICT>()) };
                if global.is_null() {
                    return Err("分配剪贴板图元文件内存失败".to_string());
                }
                let ptr = unsafe { GlobalLock(global) } as *mut METAFILEPICT;
                if ptr.is_null() {
                    unsafe {
                        GlobalFree(global);
                    }
                    return Err("锁定剪贴板图元文件内存失败".to_string());
                }
                unsafe {
                    ptr.write(METAFILEPICT {
                        mm: *mm,
                        xExt: *x_ext,
                        yExt: *y_ext,
                        hMF: *handle as _,
                    });
                    GlobalUnlock(global);
                }
                if unsafe { SetClipboardData(*format, global as _) }.is_null() {
                    unsafe {
                        GlobalFree(global);
                    }
                    return Err(format!("恢复剪贴板格式 {} 失败", format));
                }
                *handle = 0;
            }
            ClipboardFormatBackup::Palette { format, entries } => {
                let header_size = std::mem::size_of::<u16>() * 2;
                let entries_size = std::mem::size_of_val(entries.as_slice());
                let byte_len = header_size + entries_size;
                let word_len = byte_len.div_ceil(std::mem::size_of::<usize>());
                let mut storage = vec![0usize; word_len];
                let bytes = storage.as_mut_ptr() as *mut u8;
                unsafe {
                    (bytes as *mut u16).write(0x0300);
                    (bytes.add(2) as *mut u16).write(entries.len() as u16);
                    std::ptr::copy_nonoverlapping(
                        entries.as_ptr(),
                        bytes.add(header_size) as *mut PALETTEENTRY,
                        entries.len(),
                    );
                }
                let palette = unsafe { CreatePalette(bytes as *const LOGPALETTE) };
                if palette.is_null() {
                    return Err("重建剪贴板调色板失败".to_string());
                }
                if unsafe { SetClipboardData(*format, palette as _) }.is_null() {
                    unsafe {
                        DeleteObject(palette as _);
                    }
                    return Err("恢复剪贴板调色板失败".to_string());
                }
            }
        }
    }

    Ok(())
}

#[cfg(target_os = "windows")]
fn alloc_global_bytes(data: &[u8]) -> Result<windows_sys::Win32::Foundation::HGLOBAL, String> {
    use windows_sys::Win32::Foundation::GlobalFree;
    use windows_sys::Win32::System::Memory::{
        GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE,
    };

    let global = unsafe { GlobalAlloc(GMEM_MOVEABLE, data.len()) };
    if global.is_null() {
        return Err("分配剪贴板内存失败".to_string());
    }
    let ptr = unsafe { GlobalLock(global) } as *mut u8;
    if ptr.is_null() {
        unsafe {
            GlobalFree(global);
        }
        return Err("锁定剪贴板内存失败".to_string());
    }
    unsafe {
        std::ptr::copy_nonoverlapping(data.as_ptr(), ptr, data.len());
        GlobalUnlock(global);
    }
    Ok(global)
}

#[cfg(target_os = "windows")]
fn read_clipboard_unicode_text() -> Result<String, String> {
    use windows_sys::Win32::System::DataExchange::{GetClipboardData, IsClipboardFormatAvailable};
    use windows_sys::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};

    let _guard = open_clipboard()?;
    let available = unsafe { IsClipboardFormatAvailable(CF_UNICODETEXT) };
    if available == 0 {
        return Err("剪贴板没有文本内容".to_string());
    }

    let handle = unsafe { GetClipboardData(CF_UNICODETEXT) };
    if handle.is_null() {
        return Err("读取剪贴板失败".to_string());
    }

    let ptr = unsafe { GlobalLock(handle) } as *const u16;
    if ptr.is_null() {
        return Err("锁定剪贴板数据失败".to_string());
    }

    let byte_len = unsafe { GlobalSize(handle) };
    let max_units = byte_len / std::mem::size_of::<u16>();
    let mut len = 0usize;
    while len < max_units {
        let value = unsafe { *ptr.add(len) };
        if value == 0 {
            break;
        }
        len += 1;
    }

    let units = unsafe { std::slice::from_raw_parts(ptr, len) };
    let text = String::from_utf16_lossy(units);
    unsafe {
        GlobalUnlock(handle);
    }

    if text.trim().is_empty() {
        return Err("剪贴板为空".to_string());
    }

    Ok(text)
}

#[cfg(target_os = "windows")]
fn write_clipboard_unicode_text(text: &str) -> Result<(), String> {
    use windows_sys::Win32::Foundation::GlobalFree;
    use windows_sys::Win32::System::DataExchange::{EmptyClipboard, SetClipboardData};
    use windows_sys::Win32::System::Memory::{
        GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE,
    };

    let _guard = open_clipboard()?;

    let mut wide: Vec<u16> = text.encode_utf16().collect();
    wide.push(0);
    let byte_len = wide.len() * std::mem::size_of::<u16>();

    let handle = unsafe { GlobalAlloc(GMEM_MOVEABLE, byte_len) };
    if handle.is_null() {
        return Err("分配剪贴板内存失败".to_string());
    }

    let ptr = unsafe { GlobalLock(handle) } as *mut u16;
    if ptr.is_null() {
        unsafe {
            GlobalFree(handle);
        }
        return Err("锁定剪贴板内存失败".to_string());
    }

    unsafe {
        std::ptr::copy_nonoverlapping(wide.as_ptr(), ptr, wide.len());
        GlobalUnlock(handle);
    }

    let emptied = unsafe { EmptyClipboard() };
    if emptied == 0 {
        unsafe {
            GlobalFree(handle);
        }
        return Err("清空剪贴板失败".to_string());
    }

    let result = unsafe { SetClipboardData(CF_UNICODETEXT, handle) };
    if result.is_null() {
        unsafe {
            GlobalFree(handle);
        }
        return Err("写入剪贴板失败".to_string());
    }

    Ok(())
}

/// 模拟 Ctrl+C 复制选中文字
#[tauri::command]
pub fn simulate_copy() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        use std::process::Command;

        const CREATE_NO_WINDOW: u32 = 0x08000000;

        let script = r#"
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('^c')
"#;
        let _ = Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-WindowStyle",
                "Hidden",
                "-Command",
                script,
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output();

        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("当前系统不支持此功能".to_string())
    }
}

/// 读取剪贴板文字（不模拟复制）
#[tauri::command]
pub fn get_clipboard_text() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        read_clipboard_unicode_text()
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("当前系统不支持此功能".to_string())
    }
}

#[tauri::command]
pub fn set_clipboard_text(text: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        write_clipboard_unicode_text(&text)
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("当前系统不支持此功能".to_string())
    }
}

/// 保存当前剪贴板内容到内存，覆盖前确保所有格式都能可靠恢复。
#[tauri::command]
pub fn save_clipboard() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let backup = snapshot_clipboard()?;
        let mut slot = clipboard_backup()
            .lock()
            .map_err(|_| "剪贴板备份状态不可用".to_string())?;
        *slot = Some(backup);
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("当前系统不支持此功能".to_string())
    }
}

#[tauri::command]
pub fn remember_target_window() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            GetForegroundWindow, GetWindowThreadProcessId,
        };

        let hwnd = unsafe { GetForegroundWindow() };
        if hwnd.is_null() {
            return Ok(());
        }

        let mut process_id = 0u32;
        unsafe {
            GetWindowThreadProcessId(hwnd, &mut process_id);
        }

        if process_id == std::process::id() {
            return Ok(());
        }

        let mut slot = last_target_window()
            .lock()
            .map_err(|_| "目标窗口状态不可用".to_string())?;
        *slot = hwnd as isize;
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("当前系统不支持此功能".to_string())
    }
}

/// 恢复保存在内存中的剪贴板内容。
#[tauri::command]
pub fn restore_clipboard() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let mut slot = clipboard_backup()
            .lock()
            .map_err(|_| "剪贴板备份状态不可用".to_string())?;
        let Some(backup) = slot.as_mut() else {
            return Ok(());
        };

        restore_clipboard_snapshot(backup)?;
        *slot = None;
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("当前系统不支持此功能".to_string())
    }
}

/// 复制选中文字：切换到上一个窗口，发送 Ctrl+C，再切回来
#[tauri::command]
pub fn copy_selected_text() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
            keybd_event, KEYEVENTF_KEYUP, VK_CONTROL,
        };
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            BringWindowToTop, IsWindow, SetForegroundWindow,
        };

        let hwnd = {
            let slot = last_target_window()
                .lock()
                .map_err(|_| "目标窗口状态不可用".to_string())?;
            *slot
        };

        if hwnd == 0 {
            return Err("未记录到目标窗口，请先返回原窗口选中文字".to_string());
        }

        let hwnd = hwnd as *mut core::ffi::c_void;
        if unsafe { IsWindow(hwnd) } == 0 {
            return Err("目标窗口已失效，请重新选中文字后再试".to_string());
        }

        unsafe {
            BringWindowToTop(hwnd);
            SetForegroundWindow(hwnd);
        }
        std::thread::sleep(Duration::from_millis(120));

        unsafe {
            keybd_event(VK_CONTROL as u8, 0, 0, 0);
            keybd_event(b'C', 0, 0, 0);
            keybd_event(b'C', 0, KEYEVENTF_KEYUP, 0);
            keybd_event(VK_CONTROL as u8, 0, KEYEVENTF_KEYUP, 0);
        }
        std::thread::sleep(Duration::from_millis(220));

        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("当前系统不支持此功能".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_unicode_length_by_character_count() {
        assert!(validate_text_length(&"中".repeat(8000)).is_ok());
        assert!(validate_text_length(&"中".repeat(8001)).is_err());
    }

    #[test]
    fn stored_settings_never_serialize_plaintext_keys() {
        let stored = StoredSettings {
            api_key: "deepseek-secret".to_string(),
            ocr_api_key: "ocr-secret".to_string(),
            api_key_protected: "encrypted-a".to_string(),
            ocr_api_key_protected: "encrypted-b".to_string(),
            ..Default::default()
        };
        let json = serde_json::to_string(&stored).unwrap();

        assert!(!json.contains("deepseek-secret"));
        assert!(!json.contains("ocr-secret"));
        assert!(json.contains("encrypted-a"));
        assert!(json.contains("encrypted-b"));
    }

    #[test]
    fn requires_saved_ocr_consent() {
        let mut settings = Settings::default();
        assert!(ensure_ocr_consent(&settings).is_err());

        settings.ocr_consent = true;
        assert!(ensure_ocr_consent(&settings).is_ok());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn protects_and_unprotects_secrets_with_dpapi() {
        let secret = "sk-test-中文";
        let encrypted = protect_secret(secret).unwrap();

        assert_ne!(encrypted, secret);
        assert_eq!(unprotect_secret(&encrypted).unwrap(), secret);
    }
}
