use magical_merchant_core::DeviceContext;
use magical_merchant_core::utils::device::{Location, NetworkType};

pub fn get_context(location: Option<Location>) -> DeviceContext {
    let (battery, is_charging) = get_battery();
    let (network_type, wifi_ssid) = get_network();

    DeviceContext {
        battery,
        is_charging,
        network_type,
        wifi_ssid,
        location,
    }
}

#[cfg(not(target_os = "android"))]
fn get_battery() -> (Option<u8>, Option<bool>) {
    use battery::State;

    let manager = match battery::Manager::new() {
        Ok(m) => m,
        Err(_) => return (None, None),
    };

    let mut batteries = match manager.batteries() {
        Ok(b) => b,
        Err(_) => return (None, None),
    };

    match batteries.next() {
        Some(Ok(bat)) => {
            let percentage = (bat.state_of_charge().value * 100.0) as u8;
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
    let output = match std::process::Command::new("networksetup")
        .args(["-getairportnetwork", "en0"])
        .output()
    {
        Ok(o) => o,
        Err(_) => return (None, None),
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let trimmed = stdout.trim();

    if let Some(ssid) = trimmed.strip_prefix("Current Wi-Fi Network: ") {
        (Some(NetworkType::WiFi), Some(ssid.to_string()))
    } else {
        (Some(NetworkType::Offline), None)
    }
}

#[cfg(not(any(target_os = "macos", target_os = "android")))]
fn get_network() -> (Option<NetworkType>, Option<String>) {
    (None, None)
}

#[cfg(target_os = "android")]
fn get_network() -> (Option<NetworkType>, Option<String>) {
    (None, None)
}
