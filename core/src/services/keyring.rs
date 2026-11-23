//! The OS keyring (the macOS Keychain, the Secret Service on Linux): one secret per
//! (service, account) item. Which item the app uses is the caller's choice.

fn entry(service: &str, account: &str) -> Result<::keyring::Entry, String> {
    ::keyring::Entry::new(service, account).map_err(|e| e.to_string())
}

pub fn store(service: &str, account: &str, secret: &str) -> Result<(), String> {
    entry(service, account)?
        .set_password(secret)
        .map_err(|e| e.to_string())
}

pub fn get(service: &str, account: &str) -> Result<Option<String>, String> {
    match entry(service, account)?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(::keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

pub fn clear(service: &str, account: &str) -> Result<(), String> {
    match entry(service, account)?.delete_credential() {
        // Deleting a credential that was never stored leaves the desired state.
        Ok(()) | Err(::keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
