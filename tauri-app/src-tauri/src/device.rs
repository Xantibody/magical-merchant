use magical_merchant_core::DeviceContext;

pub fn get_context() -> DeviceContext {
    let (battery, is_charging) = get_battery();

    DeviceContext {
        battery,
        is_charging,
        network_type: None,
        wifi_ssid: None,
        location: None,
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
