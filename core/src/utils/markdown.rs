use crate::error::CoreError;
use crate::utils::clock::Stamp;
use crate::utils::device::Context;
use crate::utils::frontmatter::{self, NoteFrontmatter, Provenance};

pub fn format_note_markdown(
    body: &str,
    tags: &[String],
    time: Stamp,
    context: &Context,
    provenance: Provenance<'_>,
) -> Result<String, CoreError> {
    let fm = NoteFrontmatter {
        tags: tags.to_vec(),
        context: Some(context.clone()),
        origin: provenance.origin.map(str::to_string),
        template: provenance.template.map(str::to_string),
        source: provenance.source.map(|s| s.as_str().to_string()),
        ..NoteFrontmatter::new(time)
    };
    frontmatter::render(&fm, body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::frontmatter::NoteFrontmatter;

    fn fixed_stamp() -> Stamp {
        Stamp::new(2026, 3, 20, 14, 30, 45, 9 * 3600).unwrap()
    }

    fn test_context() -> Context {
        Context {
            battery: Some(82),
            is_charging: Some(false),
            ..Context::default()
        }
    }

    #[test]
    fn test_format_note_markdown() {
        let tags = vec!["rust".to_string(), "memo".to_string()];
        let result = format_note_markdown(
            "# Hello\nWorld",
            &tags,
            fixed_stamp(),
            &test_context(),
            Provenance::default(),
        )
        .unwrap();

        let (fm, body): (NoteFrontmatter, &str) = frontmatter::parse(&result).unwrap();
        assert_eq!(fm.tags, vec!["rust", "memo"]);
        assert!(fm.context.is_some());
        let ctx = fm.context.unwrap();
        assert_eq!(ctx.battery, Some(82));
        assert_eq!(ctx.is_charging, Some(false));
        assert_eq!(body, "# Hello\nWorld");
    }

    #[test]
    fn test_format_note_markdown_empty_tags() {
        let result = format_note_markdown(
            "body",
            &[],
            fixed_stamp(),
            &test_context(),
            Provenance::default(),
        )
        .unwrap();
        let (fm, _body): (NoteFrontmatter, &str) = frontmatter::parse(&result).unwrap();
        assert!(fm.tags.is_empty());
    }

    #[test]
    fn test_format_note_markdown_charging() {
        let ctx = Context {
            battery: Some(100),
            is_charging: Some(true),
            ..Context::default()
        };
        let result =
            format_note_markdown("body", &[], fixed_stamp(), &ctx, Provenance::default()).unwrap();
        let (fm, _body): (NoteFrontmatter, &str) = frontmatter::parse(&result).unwrap();
        let context = fm.context.unwrap();
        assert_eq!(context.battery, Some(100));
        assert_eq!(context.is_charging, Some(true));
    }
}
