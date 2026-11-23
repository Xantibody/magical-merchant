//! Where and with what a record was written.

mod context;
#[cfg(feature = "device-probe")]
mod current_context;
mod place;
pub mod place_names;
mod visits;

#[cfg(feature = "device-probe")]
pub use context::location;
pub use context::{Context, DeviceIdentity, Location, NetworkType, Source};
#[cfg(feature = "device-probe")]
pub use current_context::probe;
pub use place::{PlaceCache, cache_key, place_key};
pub use visits::{PlaceVisit, visited_places};
