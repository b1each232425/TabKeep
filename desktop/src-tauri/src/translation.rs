use std::{fs, path::PathBuf};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

const CONFIG_FILE: &str = "translate-provider-config.json";
const BAIDU_ENDPOINT: &str = "https://fanyi-api.baidu.com/api/trans/vip/translate";
const VOLCENGINE_HOST: &str = "translate.volcengineapi.com";
const VOLCENGINE_VERSION: &str = "2020-06-01";

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct TranslateProviderConfig {
    pub provider: TranslateProvider,
    #[serde(rename = "baiduAppId")]
    pub baidu_app_id: String,
    #[serde(rename = "baiduSecret")]
    pub baidu_secret: String,
    #[serde(rename = "volcengineAccessKey")]
    pub volcengine_access_key: String,
    #[serde(rename = "volcengineSecretKey")]
    pub volcengine_secret_key: String,
    #[serde(rename = "volcengineRegion")]
    pub volcengine_region: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TranslateProvider {
    OpenaiCompatible,
    Baidu,
    Volcengine,
}

impl Default for TranslateProviderConfig {
    fn default() -> Self {
        Self {
            provider: TranslateProvider::OpenaiCompatible,
            baidu_app_id: String::new(),
            baidu_secret: String::new(),
            volcengine_access_key: String::new(),
            volcengine_secret_key: String::new(),
            volcengine_region: "cn-north-1".to_string(),
        }
    }
}

impl TranslateProvider {
    pub fn display_name(&self) -> &'static str {
        match self {
            Self::OpenaiCompatible => "OpenAI-compatible",
            Self::Baidu => "百度翻译",
            Self::Volcengine => "火山翻译",
        }
    }
}

pub fn load_config(app: &AppHandle) -> TranslateProviderConfig {
    let Ok(path) = config_path(app) else {
        return TranslateProviderConfig::default();
    };
    let Ok(raw) = fs::read_to_string(path) else {
        return TranslateProviderConfig::default();
    };
    sanitize_config(serde_json::from_str(&raw).unwrap_or_default())
}

pub fn save_config(
    app: &AppHandle,
    config: &TranslateProviderConfig,
) -> Result<TranslateProviderConfig, String> {
    let config = sanitize_config(config.clone());
    let path = config_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("创建翻译配置目录失败: {err}"))?;
    }
    let raw = serde_json::to_string_pretty(&config)
        .map_err(|err| format!("序列化翻译配置失败: {err}"))?;
    fs::write(path, raw).map_err(|err| format!("写入翻译配置失败: {err}"))?;
    Ok(config)
}

pub async fn translate_fast_provider(
    client: &reqwest::Client,
    config: &TranslateProviderConfig,
    text: &str,
    source_lang: &str,
    target_lang: &str,
) -> Result<String, String> {
    match config.provider {
        TranslateProvider::Baidu => {
            translate_baidu(client, config, text, source_lang, target_lang).await
        }
        TranslateProvider::Volcengine => {
            translate_volcengine(client, config, text, source_lang, target_lang).await
        }
        TranslateProvider::OpenaiCompatible => Err("OpenAI-compatible 由模型配置处理".to_string()),
    }
}

async fn translate_baidu(
    client: &reqwest::Client,
    config: &TranslateProviderConfig,
    text: &str,
    source_lang: &str,
    target_lang: &str,
) -> Result<String, String> {
    let app_id = config.baidu_app_id.trim();
    let secret = config.baidu_secret.trim();
    if app_id.is_empty() || secret.is_empty() {
        return Err("请先配置百度翻译 App ID 和密钥".to_string());
    }

    let salt = Utc::now().timestamp_millis().to_string();
    let sign = md5_hex(&format!("{app_id}{text}{salt}{secret}"));
    let from = baidu_lang(source_lang, true);
    let to = baidu_lang(target_lang, false);
    let params = [
        ("q", text.to_string()),
        ("from", from),
        ("to", to),
        ("appid", app_id.to_string()),
        ("salt", salt),
        ("sign", sign),
    ];

    let response = client
        .post(BAIDU_ENDPOINT)
        .form(&params)
        .send()
        .await
        .map_err(|err| format!("百度翻译请求失败: {err}"))?;
    let status = response.status();
    let raw = response
        .text()
        .await
        .map_err(|err| format!("读取百度翻译响应失败: {err}"))?;
    if !status.is_success() {
        return Err(format!(
            "百度翻译 HTTP {}: {}",
            status.as_u16(),
            trim_detail(&raw)
        ));
    }

    let payload: BaiduResponse = serde_json::from_str(&raw)
        .map_err(|err| format!("百度翻译响应不是合法 JSON: {err}; {}", trim_detail(&raw)))?;
    if let Some(items) = payload.trans_result {
        let result = items
            .into_iter()
            .map(|item| item.dst)
            .collect::<Vec<_>>()
            .join("\n")
            .trim()
            .to_string();
        if !result.is_empty() {
            return Ok(result);
        }
    }

    Err(format!(
        "百度翻译失败: {} {}",
        payload.error_code.unwrap_or_else(|| "unknown".to_string()),
        payload.error_msg.unwrap_or_else(|| trim_detail(&raw))
    ))
}

async fn translate_volcengine(
    client: &reqwest::Client,
    config: &TranslateProviderConfig,
    text: &str,
    source_lang: &str,
    target_lang: &str,
) -> Result<String, String> {
    let access_key = config.volcengine_access_key.trim();
    let secret_key = config.volcengine_secret_key.trim();
    if access_key.is_empty() || secret_key.is_empty() {
        return Err("请先配置火山翻译 Access Key 和 Secret Key".to_string());
    }

    let region = config.volcengine_region.trim();
    let region = if region.is_empty() {
        "cn-north-1"
    } else {
        region
    };
    let source = volcengine_lang(source_lang, true);
    let target = volcengine_lang(target_lang, false);
    let body = if source == "auto" {
        json!({
            "TargetLanguage": target,
            "TextList": [text],
        })
    } else {
        json!({
            "SourceLanguage": source,
            "TargetLanguage": target,
            "TextList": [text],
        })
    };
    let body_text =
        serde_json::to_string(&body).map_err(|err| format!("序列化火山翻译请求失败: {err}"))?;
    let body_hash = sha256_hex(body_text.as_bytes());
    let x_date = Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
    let date = &x_date[..8];
    let service = "translate";
    let signed_headers = "content-type;host;x-content-sha256;x-date";
    let canonical_query = format!("Action=TranslateText&Version={VOLCENGINE_VERSION}");
    let canonical_headers = format!(
        "content-type:application/json\nhost:{VOLCENGINE_HOST}\nx-content-sha256:{body_hash}\nx-date:{x_date}\n"
    );
    let canonical_request =
        format!("POST\n/\n{canonical_query}\n{canonical_headers}\n{signed_headers}\n{body_hash}");
    let hashed_request = sha256_hex(canonical_request.as_bytes());
    let credential_scope = format!("{date}/{region}/{service}/request");
    let string_to_sign = format!("HMAC-SHA256\n{x_date}\n{credential_scope}\n{hashed_request}");
    let signing_key = volcengine_signing_key(secret_key.as_bytes(), date, region, service);
    let signature = bytes_to_hex(&hmac_sha256(&signing_key, string_to_sign.as_bytes()));
    let authorization = format!(
        "HMAC-SHA256 Credential={access_key}/{credential_scope}, SignedHeaders={signed_headers}, Signature={signature}"
    );
    let url = format!("https://{VOLCENGINE_HOST}/?{canonical_query}");

    let response = client
        .post(url)
        .header("Authorization", authorization)
        .header("Content-Type", "application/json")
        .header("Host", VOLCENGINE_HOST)
        .header("X-Content-Sha256", body_hash)
        .header("X-Date", x_date)
        .body(body_text)
        .send()
        .await
        .map_err(|err| format!("火山翻译请求失败: {err}"))?;
    let status = response.status();
    let raw = response
        .text()
        .await
        .map_err(|err| format!("读取火山翻译响应失败: {err}"))?;
    if !status.is_success() {
        return Err(format!(
            "火山翻译 HTTP {}: {}",
            status.as_u16(),
            trim_detail(&raw)
        ));
    }

    let payload: Value = serde_json::from_str(&raw)
        .map_err(|err| format!("火山翻译响应不是合法 JSON: {err}; {}", trim_detail(&raw)))?;
    if let Some(error) = payload
        .get("ResponseMetadata")
        .and_then(|value| value.get("Error"))
        .filter(|value| !value.is_null())
    {
        return Err(format!("火山翻译失败: {error}"));
    }
    let translations = payload
        .get("TranslationList")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("Translation").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
        .trim()
        .to_string();
    if translations.is_empty() {
        return Err(format!("火山翻译没有返回译文: {}", trim_detail(&raw)));
    }
    Ok(translations)
}

#[derive(Deserialize)]
struct BaiduResponse {
    #[serde(rename = "trans_result")]
    trans_result: Option<Vec<BaiduTranslation>>,
    #[serde(rename = "error_code")]
    error_code: Option<String>,
    #[serde(rename = "error_msg")]
    error_msg: Option<String>,
}

#[derive(Deserialize)]
struct BaiduTranslation {
    dst: String,
}

fn sanitize_config(mut config: TranslateProviderConfig) -> TranslateProviderConfig {
    config.baidu_app_id = config.baidu_app_id.trim().to_string();
    config.baidu_secret = config.baidu_secret.trim().to_string();
    config.volcengine_access_key = config.volcengine_access_key.trim().to_string();
    config.volcengine_secret_key = config.volcengine_secret_key.trim().to_string();
    if config.volcengine_region.trim().is_empty() {
        config.volcengine_region = "cn-north-1".to_string();
    } else {
        config.volcengine_region = config.volcengine_region.trim().to_string();
    }
    config
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|err| format!("获取应用数据目录失败: {err}"))?
        .join(CONFIG_FILE))
}

fn baidu_lang(value: &str, allow_auto: bool) -> String {
    let key = normalize_lang_key(value);
    match key.as_str() {
        "auto" if allow_auto => "auto",
        "zh" | "zh-cn" | "zh-hans" | "chinese" | "简体中文" | "中文" => "zh",
        "zh-tw" | "zh-hant" | "繁体中文" | "繁體中文" => "cht",
        "en" | "en-us" | "english" | "英文" => "en",
        "ja" | "ja-jp" | "jp" | "日本語" | "日语" => "jp",
        "ko" | "ko-kr" | "kor" | "한국어" | "韩语" => "kor",
        "fr" | "français" | "french" | "法语" => "fra",
        "de" | "deutsch" | "german" | "德语" => "de",
        "es" | "spanish" | "西班牙语" => "spa",
        "ru" | "russian" | "俄语" => "ru",
        "it" | "italian" | "意大利语" => "it",
        "pt" | "portuguese" | "葡萄牙语" => "pt",
        "vi" | "vietnamese" | "越南语" => "vie",
        other if other == "auto" => "zh",
        other => other,
    }
    .to_string()
}

fn volcengine_lang(value: &str, allow_auto: bool) -> String {
    let key = normalize_lang_key(value);
    match key.as_str() {
        "auto" if allow_auto => "auto",
        "zh" | "zh-cn" | "zh-hans" | "chinese" | "简体中文" | "中文" => "zh",
        "zh-tw" | "zh-hant" | "繁体中文" | "繁體中文" => "zh-Hant",
        "en" | "en-us" | "english" | "英文" => "en",
        "ja" | "ja-jp" | "jp" | "日本語" | "日语" => "ja",
        "ko" | "ko-kr" | "kor" | "한국어" | "韩语" => "ko",
        "fr" | "français" | "french" | "法语" => "fr",
        "de" | "deutsch" | "german" | "德语" => "de",
        "es" | "spanish" | "西班牙语" => "es",
        "ru" | "russian" | "俄语" => "ru",
        "it" | "italian" | "意大利语" => "it",
        "pt" | "portuguese" | "葡萄牙语" => "pt",
        "vi" | "vietnamese" | "越南语" => "vi",
        other if other == "auto" => "zh",
        other => other,
    }
    .to_string()
}

fn normalize_lang_key(value: &str) -> String {
    value.trim().to_lowercase()
}

fn trim_detail(value: &str) -> String {
    value.chars().take(500).collect()
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    bytes_to_hex(&hasher.finalize())
}

fn volcengine_signing_key(secret: &[u8], date: &str, region: &str, service: &str) -> [u8; 32] {
    let k_date = hmac_sha256(secret, date.as_bytes());
    let k_region = hmac_sha256(&k_date, region.as_bytes());
    let k_service = hmac_sha256(&k_region, service.as_bytes());
    hmac_sha256(&k_service, b"request")
}

fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    const BLOCK_SIZE: usize = 64;
    let mut normalized_key = [0u8; BLOCK_SIZE];
    if key.len() > BLOCK_SIZE {
        let mut hasher = Sha256::new();
        hasher.update(key);
        normalized_key[..32].copy_from_slice(&hasher.finalize());
    } else {
        normalized_key[..key.len()].copy_from_slice(key);
    }

    let mut outer = [0x5cu8; BLOCK_SIZE];
    let mut inner = [0x36u8; BLOCK_SIZE];
    for index in 0..BLOCK_SIZE {
        outer[index] ^= normalized_key[index];
        inner[index] ^= normalized_key[index];
    }

    let mut inner_hasher = Sha256::new();
    inner_hasher.update(inner);
    inner_hasher.update(message);
    let inner_hash = inner_hasher.finalize();

    let mut outer_hasher = Sha256::new();
    outer_hasher.update(outer);
    outer_hasher.update(inner_hash);
    let result = outer_hasher.finalize();
    let mut bytes = [0u8; 32];
    bytes.copy_from_slice(&result);
    bytes
}

fn md5_hex(input: &str) -> String {
    const S: [u32; 64] = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5,
        9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10,
        15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
    ];
    const K: [u32; 64] = [
        0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613,
        0xfd469501, 0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193,
        0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d,
        0x02441453, 0xd8a1e681, 0xe7d3fbc8, 0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed,
        0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8771f681, 0x6d9d6122,
        0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70, 0x289b7ec6, 0xeaa127fa,
        0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665, 0xf4292244,
        0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
        0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb,
        0xeb86d391,
    ];

    let mut message = input.as_bytes().to_vec();
    let bit_len = (message.len() as u64) * 8;
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&bit_len.to_le_bytes());

    let mut a0 = 0x67452301u32;
    let mut b0 = 0xefcdab89u32;
    let mut c0 = 0x98badcfeu32;
    let mut d0 = 0x10325476u32;

    for chunk in message.chunks(64) {
        let mut m = [0u32; 16];
        for (index, item) in m.iter_mut().enumerate() {
            let start = index * 4;
            *item = u32::from_le_bytes([
                chunk[start],
                chunk[start + 1],
                chunk[start + 2],
                chunk[start + 3],
            ]);
        }

        let mut a = a0;
        let mut b = b0;
        let mut c = c0;
        let mut d = d0;

        for index in 0..64 {
            let (f, g) = if index < 16 {
                ((b & c) | ((!b) & d), index)
            } else if index < 32 {
                ((d & b) | ((!d) & c), (5 * index + 1) % 16)
            } else if index < 48 {
                (b ^ c ^ d, (3 * index + 5) % 16)
            } else {
                (c ^ (b | (!d)), (7 * index) % 16)
            };
            let next = a
                .wrapping_add(f)
                .wrapping_add(K[index])
                .wrapping_add(m[g])
                .rotate_left(S[index]);
            a = d;
            d = c;
            c = b;
            b = b.wrapping_add(next);
        }

        a0 = a0.wrapping_add(a);
        b0 = b0.wrapping_add(b);
        c0 = c0.wrapping_add(c);
        d0 = d0.wrapping_add(d);
    }

    let mut output = Vec::with_capacity(16);
    output.extend_from_slice(&a0.to_le_bytes());
    output.extend_from_slice(&b0.to_le_bytes());
    output.extend_from_slice(&c0.to_le_bytes());
    output.extend_from_slice(&d0.to_le_bytes());
    bytes_to_hex(&output)
}

fn bytes_to_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

#[cfg(test)]
mod tests {
    use super::md5_hex;

    #[test]
    fn md5_matches_known_values() {
        assert_eq!(md5_hex(""), "d41d8cd98f00b204e9800998ecf8427e");
        assert_eq!(md5_hex("hello"), "5d41402abc4b2a76b9719d911017c592");
    }
}
