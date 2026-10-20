use base64::{engine::general_purpose::STANDARD, Engine};

const SERVICE: &str = "AgentDesk";
const ACCOUNT: &str = "master-key";

/// 从 Windows 凭据管理器读取主密钥，不存在则生成并保存。
/// sidecar 用它加密数据库中的所有密钥，数据库文件本身不含明文。
pub fn master_key() -> Result<String, String> {
    let entry = keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(key) => Ok(key),
        Err(keyring::Error::NoEntry) => {
            let key = STANDARD.encode(random_bytes::<32>()?);
            entry.set_password(&key).map_err(|e| e.to_string())?;
            Ok(key)
        }
        Err(e) => Err(e.to_string()),
    }
}

pub fn random_bytes<const N: usize>() -> Result<[u8; N], String> {
    let mut buf = [0u8; N];
    getrandom::getrandom(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf)
}

pub fn random_token() -> Result<String, String> {
    Ok(random_bytes::<24>()?.iter().map(|b| format!("{b:02x}")).collect())
}
