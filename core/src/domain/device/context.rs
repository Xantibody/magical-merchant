//! What a record keeps of the device that wrote it.

#[cfg(feature = "device-probe")]
use crate::utils::device::Location;

/// Makes a [`Location`] only when both coordinates are passed together.
#[cfg(feature = "device-probe")]
#[must_use]
pub const fn location(latitude: Option<f64>, longitude: Option<f64>) -> Option<Location> {
    match (latitude, longitude) {
        (Some(latitude), Some(longitude)) => Some(Location {
            latitude,
            longitude,
        }),
        _ => None,
    }
}

#[cfg(all(test, feature = "device-probe"))]
mod tests {
    use super::*;

    #[test]
    fn makes_a_location_only_from_a_pair() {
        assert_eq!(
            location(Some(35.68), Some(139.76)),
            Some(Location {
                latitude: 35.68,
                longitude: 139.76
            })
        );
        assert_eq!(location(Some(35.68), None), None);
        assert_eq!(location(None, Some(139.76)), None);
        assert_eq!(location(None, None), None);
    }
}
