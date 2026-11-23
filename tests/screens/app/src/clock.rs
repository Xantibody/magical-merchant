//! The pinned clock: the instant read from the environment, and the script that makes the page
//! answer it.

/// Reads the pinned instant from the variable's value.
pub(crate) fn pinned_now(value: Option<&str>) -> Result<Option<u64>, String> {
    value
        .map(|text| {
            text.parse()
                .map_err(|_| format!("not milliseconds since the epoch: {text}"))
        })
        .transpose()
}

/// Runs before the page's own scripts. `new Date()` and `Date.now()` answer the pinned instant;
/// a `Date` built from a value is untouched, and so is `performance.now()`, which nothing shows.
/// The frontend reads the time in many places, so it changes none of them.
pub(crate) fn clock_script(ms: u64) -> String {
    format!(
        "(() => {{
  const pinned = {ms};
  const Real = Date;
  class Pinned extends Real {{
    constructor(...args) {{
      if (args.length === 0) {{ super(pinned); }} else {{ super(...args); }}
    }}
    static now() {{ return pinned; }}
  }}
  globalThis.Date = Pinned;
}})();"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unset_variable_pins_nothing() {
        assert_eq!(pinned_now(None), Ok(None));
    }

    #[test]
    fn milliseconds_pin_that_instant() {
        assert_eq!(
            pinned_now(Some("1786071600000")),
            Ok(Some(1_786_071_600_000))
        );
    }

    #[test]
    fn anything_but_milliseconds_is_refused_with_what_was_read() {
        assert_eq!(
            pinned_now(Some("2026-08-07")),
            Err("not milliseconds since the epoch: 2026-08-07".to_owned())
        );
    }

    #[test]
    fn the_clock_script_answers_the_pinned_instant() {
        let script = clock_script(1_786_071_600_000);
        assert!(script.contains("const pinned = 1786071600000;"), "{script}");
        assert!(script.contains("globalThis.Date = "), "{script}");
    }
}
