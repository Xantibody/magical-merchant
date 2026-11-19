//! Where and with what a record was written.

mod context;
#[cfg(feature = "device-probe")]
mod current_context;

#[cfg(feature = "device-probe")]
pub use context::location;
#[cfg(feature = "device-probe")]
pub use current_context::probe;
