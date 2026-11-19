//! Where and with what a record was written.

mod context;
#[cfg(feature = "device-probe")]
mod current_context;
mod place;
pub mod place_names;
mod visits;

#[cfg(feature = "device-probe")]
pub use context::{ClientContext, fill_from_client, location, parse_client_context};
pub use context::{Context, DeviceIdentity, Location, NetworkType, Source};
#[cfg(feature = "device-probe")]
pub use current_context::{probe, probe_with_client};
pub use place::{PlaceCache, cache_key, place_key};
pub use visits::{PlaceVisit, visited_places};
