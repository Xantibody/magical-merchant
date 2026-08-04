use magical_merchant_core::DeviceContext;
use magical_merchant_core::utils::device::{Location, NetworkType};

pub(crate) fn get_context(location: Option<Location>) -> DeviceContext {
    let (battery, is_charging) = get_battery();
    let (network_type, wifi_ssid) = get_network();

    DeviceContext {
        battery,
        is_charging,
        network_type,
        wifi_ssid,
        location,
        os: std::env::consts::OS.to_string(),
        os_version: get_os_version(),
        arch: std::env::consts::ARCH.to_string(),
        hostname: hostname::get().ok().and_then(|h| h.into_string().ok()),
        locale: get_locale(),
    }
}

#[cfg(target_os = "macos")]
fn get_os_version() -> Option<String> {
    let output = std::process::Command::new("sw_vers")
        .arg("-productVersion")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if version.is_empty() {
        None
    } else {
        Some(version)
    }
}

#[cfg(not(target_os = "macos"))]
fn get_os_version() -> Option<String> {
    None
}

fn get_locale() -> Option<String> {
    std::env::var("LC_ALL")
        .or_else(|_| std::env::var("LANG"))
        .ok()
        .map(|l| l.split('.').next().unwrap_or(&l).to_string())
}

#[cfg(not(target_os = "android"))]
fn get_battery() -> (Option<u8>, Option<bool>) {
    use battery::State;

    let Ok(manager) = battery::Manager::new() else {
        return (None, None);
    };

    let Ok(mut batteries) = manager.batteries() else {
        return (None, None);
    };

    match batteries.next() {
        Some(Ok(bat)) => {
            // clamp() keeps the value inside u8 range, so the cast cannot
            // truncate or lose a sign.
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let percentage = (bat.state_of_charge().value * 100.0)
                .round()
                .clamp(0.0, 100.0) as u8;
            let charging = matches!(bat.state(), State::Charging | State::Full);
            (Some(percentage), Some(charging))
        }
        _ => (None, None),
    }
}

#[cfg(target_os = "android")]
fn get_battery() -> (Option<u8>, Option<bool>) {
    (None, None)
}

#[cfg(target_os = "macos")]
fn get_network() -> (Option<NetworkType>, Option<String>) {
    let Ok(output) = std::process::Command::new("ipconfig")
        .args(["getsummary", "en0"])
        .output()
    else {
        return (None, None);
    };

    let stdout = String::from_utf8_lossy(&output.stdout);

    for line in stdout.lines() {
        let trimmed = line.trim();
        if let Some(ssid) = trimmed.strip_prefix("SSID : ") {
            let ssid = ssid.trim();
            if !ssid.is_empty() {
                return (Some(NetworkType::WiFi), Some(ssid.to_string()));
            }
        }
    }

    // No Wi-Fi SSID found — could be Ethernet, tethering, or truly offline.
    // Return None rather than Offline to avoid false negatives.
    (None, None)
}

#[cfg(not(any(target_os = "macos", target_os = "android")))]
fn get_network() -> (Option<NetworkType>, Option<String>) {
    (None, None)
}

#[cfg(target_os = "android")]
fn get_network() -> (Option<NetworkType>, Option<String>) {
    (None, None)
}
