use chrono::{DateTime, FixedOffset};
use serde::{Deserialize, Serialize, de::DeserializeOwned};

use crate::error::CoreError;
use crate::utils::device::{Context, Source};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NoteFrontmatter {
    pub time: DateTime<FixedOffset>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<Context>,
    /// 表示モード(例: `mindmap`)。time/tags/context と違い「作成時の記録」では
    /// なく閲覧の好みだが、ノート単位の設定はノートと一緒に同期されてほしいので
    /// frontmatter に持つ。未指定・未知の値は読む側がエディタ表示に倒す。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub view: Option<String>,
    /// 昇格元タイムラインエントリの日時(`YYYY-MM-DDTHH:MM:SS`)。エントリから
    /// 作ったノートだけが持つ出自の記録で、タイムライン側のチップ表示は
    /// この値から毎回導出する(エントリ側のファイルには何も書かない)。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    /// 本文を最後に書き直した時刻。`time` は作成時刻に固定されている(一覧が
    /// ファイル名順に並ぶ)ので、書き直した事実はここにしか残らない。
    /// 一度も編集していないノートには書かない — 既定値を書くと、触っても
    /// いないノートの frontmatter が全部変わって同期が丸ごと走る。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated: Option<DateTime<FixedOffset>>,
    /// 生まれ元のテンプレ名(`templates/daily.md` なら `daily`)。`origin` と
    /// 同じ作成時の記録で、`{{prev}}` の解決も「同じテンプレの今日のノートは
    /// もう在るか」の判定も、この値を走査する以外に手がない。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
    /// どの入り口で書かれたか(`app` / `cli` / `mcp` / `widget`)。
    /// `origin` / `template` と同じ作成時の記録で、あとから別のツールで
    /// 編集しても変わらない。「最後に編集したツール」が要るなら別のキーを
    /// 足す — 1 つのキーに両方の意味を持たせると、どちらの問いにも答えられない。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

impl NoteFrontmatter {
    /// 作成直後の記録。任意のキーは持たない状態から始め、書くものだけを
    /// `..NoteFrontmatter::new(time)` で足す。
    ///
    /// 構築のたびに全フィールドを並べていると、キーが 1 つ増えるだけで
    /// 関係のない呼び出し側とテストが全部書き換わる。増える先はここだけにする。
    #[must_use]
    pub const fn new(time: DateTime<FixedOffset>) -> Self {
        Self {
            time,
            tags: Vec::new(),
            context: None,
            view: None,
            origin: None,
            updated: None,
            template: None,
            source: None,
        }
    }
}

/// 作成時にだけ書かれる出自の記録。後の編集では書き換わらない。
/// 両方を持つノートは今のところ無い — エントリの昇格はテンプレを通らない。
#[derive(Debug, Default, Clone, Copy)]
pub struct Provenance<'a> {
    /// 昇格元タイムラインエントリの日時(`YYYY-MM-DDTHH:MM:SS`)。
    pub origin: Option<&'a str>,
    /// 生まれ元のテンプレ名。
    pub template: Option<&'a str>,
    /// どの入り口で書かれたか。呼び出し側が自分で名乗る — 共有のヘルパに
    /// 決めさせると、CLI と MCP のように同じ経路を通るものが同じ名前になる。
    pub source: Option<Source>,
}

pub fn render<T: Serialize>(fm: &T, body: &str) -> Result<String, CoreError> {
    let yaml = serde_yaml::to_string(fm).map_err(|e| CoreError::Parse(e.to_string()))?;
    Ok(format!("---\n{yaml}---\n{body}"))
}

/// 本文は `content` を借りて返す。呼び出し側の多くは先頭だけしか使わないので、
/// ここで所有権を持たせると読み捨てるぶんまで丸ごと複製することになる。
///
/// frontmatter が無ければ空の対応表として読む — 全キーが省略可能な型は
/// 既定値で通り、`time` のような必須キーを持つ型はここで失敗する。
/// 区切りだけあって中身が無い(`---\n---`)ものも同じ扱い。
///
/// YAML は `T` に直接読む。いったん `serde_yaml::Value` を組み立ててから
/// 変換すると、ノート 1 本ごとに木を 1 つ余分に作って捨てることになり、
/// 一覧(`list_notes`)で最も広い frame だった。
pub fn parse<T: DeserializeOwned>(content: &str) -> Result<(T, &str), CoreError> {
    let (matter, body) = match split(content) {
        Split::Some { matter, body } => (matter, body),
        Split::None { body } => ("", body),
        Split::Unclosed => {
            return Err(CoreError::Parse(
                "frontmatter is missing its closing delimiter".to_string(),
            ));
        }
    };
    let matter = if matter.trim().is_empty() {
        "{}"
    } else {
        matter
    };
    let fm = serde_yaml::from_str::<T>(matter).map_err(|e| CoreError::Parse(e.to_string()))?;
    Ok((fm, body))
}

/// frontmatter を捨てて本文だけを返す。`parse` と違い YAML の中身は見ないので、
/// メタデータが壊れているファイルでも本文が画面に漏れ出さない。
/// 区切りが閉じていなければ frontmatter とはみなさず全文を返す。
#[must_use]
pub fn strip(content: &str) -> &str {
    match split(content) {
        Split::Some { body, .. } | Split::None { body } => body,
        Split::Unclosed => content.trim_start(),
    }
}

enum Split<'a> {
    /// 区切りの内側と、閉じ区切りの次の行からの本文。
    Some { matter: &'a str, body: &'a str },
    /// 先頭が `---` ではない。本文は先頭の空白を落とした全文。
    None { body: &'a str },
    /// 開き区切りはあるが閉じていない。
    Unclosed,
}

/// 区切りの規則はここ 1 か所: 先頭の空白は落とす、行末は LF / CRLF / CR の
/// どれでもよい、開始直後の `---` も閉じ区切り。`parse` と `strip` が同じ
/// 分割を使うので、一覧と編集経路で本文の始まりがずれることはない。
fn split(content: &str) -> Split<'_> {
    let content = content.trim_start();
    let Some(first) = next_line(content, 0) else {
        return Split::None { body: content };
    };
    if first.text != "---" {
        return Split::None { body: content };
    }
    let mut pos = first.next_start;
    while let Some(line) = next_line(content, pos) {
        if line.text == "---" {
            return Split::Some {
                matter: &content[first.next_start..line.start],
                body: &content[line.next_start..],
            };
        }
        pos = line.next_start;
    }
    Split::Unclosed
}

struct Line<'a> {
    /// 行末の改行を含まない行の中身。
    text: &'a str,
    /// この行の開始位置。
    start: usize,
    /// 次の行の開始位置。行末が無い(末尾の行)なら文字列の長さ。
    next_start: usize,
}

/// `pos` から 1 行を切り出す。行末は LF / CRLF / CR のどれでもよい。
fn next_line(s: &str, pos: usize) -> Option<Line<'_>> {
    let bytes = s.as_bytes();
    if pos >= bytes.len() {
        return None;
    }
    let mut end = pos;
    while end < bytes.len() && bytes[end] != b'\n' && bytes[end] != b'\r' {
        end += 1;
    }
    let mut next_start = end;
    if next_start < bytes.len() && bytes[next_start] == b'\r' {
        next_start += 1;
    }
    if next_start < bytes.len() && bytes[next_start] == b'\n' {
        next_start += 1;
    }
    Some(Line {
        text: &s[pos..end],
        start: pos,
        next_start,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn fixed_offset() -> FixedOffset {
        FixedOffset::east_opt(9 * 3600).unwrap()
    }

    fn sample_datetime() -> DateTime<FixedOffset> {
        fixed_offset()
            .with_ymd_and_hms(2026, 3, 20, 14, 30, 45)
            .unwrap()
    }

    fn sample_fm() -> NoteFrontmatter {
        NoteFrontmatter::new(sample_datetime())
    }

    #[test]
    fn test_note_frontmatter_roundtrip() {
        let fm = NoteFrontmatter {
            tags: vec!["memo".to_string()],
            context: Some(Context {
                battery: Some(82),
                is_charging: Some(false),
                ..Context::default()
            }),
            ..sample_fm()
        };
        let rendered = render(&fm, "# Hello\nWorld").unwrap();
        let (parsed, body): (NoteFrontmatter, _) = parse(&rendered).unwrap();
        assert_eq!(parsed, fm);
        assert_eq!(body, "# Hello\nWorld");
    }

    #[test]
    fn test_note_frontmatter_view_roundtrip() {
        let fm = NoteFrontmatter {
            view: Some("mindmap".to_string()),
            ..sample_fm()
        };
        let rendered = render(&fm, "body").unwrap();
        let (parsed, _body): (NoteFrontmatter, _) = parse(&rendered).unwrap();
        assert_eq!(parsed.view, Some("mindmap".to_string()));
    }

    /// view を持たないノートの frontmatter は今までと 1 バイトも変わらない。
    /// 余計なキーを書くと内容ハッシュが変わり、同期が全ノートを転送し直すことになる。
    #[test]
    fn test_render_omits_absent_view() {
        let rendered = render(&sample_fm(), "body").unwrap();
        assert!(!rendered.contains("view"));
    }

    /// view キーを知らない版のアプリが書いたノートも今まで通り読める。
    #[test]
    fn test_parse_defaults_view_to_none() {
        let yaml = "---\ntime: 2026-03-20T14:30:45+09:00\ntags: []\n---\nbody";
        let (fm, _body): (NoteFrontmatter, &str) = parse(yaml).unwrap();
        assert_eq!(fm.view, None);
    }

    #[test]
    fn test_note_frontmatter_updated_roundtrip() {
        let fm = NoteFrontmatter {
            updated: Some(sample_datetime()),
            ..sample_fm()
        };
        let rendered = render(&fm, "body").unwrap();
        let (parsed, _body): (NoteFrontmatter, _) = parse(&rendered).unwrap();
        assert_eq!(parsed.updated, Some(sample_datetime()));
    }

    /// 一度も編集していないノートに更新日時は無い。空の値でも書けば、
    /// 全ノートの frontmatter が書き換わって同期が丸ごと走る。
    #[test]
    fn test_render_omits_absent_updated() {
        let rendered = render(&sample_fm(), "body").unwrap();
        assert!(!rendered.contains("updated"));
    }

    /// updated キーを知らない版のアプリが書いたノートも今まで通り読める。
    #[test]
    fn test_parse_defaults_updated_to_none() {
        let yaml = "---\ntime: 2026-03-20T14:30:45+09:00\ntags: []\n---\nbody";
        let (fm, _body): (NoteFrontmatter, &str) = parse(yaml).unwrap();
        assert_eq!(fm.updated, None);
    }

    #[test]
    fn test_note_frontmatter_origin_roundtrip() {
        let fm = NoteFrontmatter {
            origin: Some("2026-08-13T08:30:00".to_string()),
            ..sample_fm()
        };
        let rendered = render(&fm, "body").unwrap();
        let (parsed, _body): (NoteFrontmatter, _) = parse(&rendered).unwrap();
        assert_eq!(parsed.origin, Some("2026-08-13T08:30:00".to_string()));
    }

    /// origin を持たないノートの frontmatter は今までと 1 バイトも変わらない。
    /// view と同じ約束: 書いていないキーは書かない。
    #[test]
    fn test_render_omits_absent_origin() {
        let rendered = render(&sample_fm(), "body").unwrap();
        assert!(!rendered.contains("origin"));
    }

    /// origin キーを知らない版のアプリが書いたノートも今まで通り読める。
    #[test]
    fn test_parse_defaults_origin_to_none() {
        let yaml = "---\ntime: 2026-03-20T14:30:45+09:00\ntags: []\n---\nbody";
        let (fm, _body): (NoteFrontmatter, &str) = parse(yaml).unwrap();
        assert_eq!(fm.origin, None);
    }

    #[test]
    fn test_note_frontmatter_source_roundtrip() {
        let fm = NoteFrontmatter {
            source: Some(Source::Cli.as_str().to_string()),
            ..sample_fm()
        };
        let rendered = render(&fm, "body").unwrap();
        let (parsed, _body): (NoteFrontmatter, _) = parse(&rendered).unwrap();
        assert_eq!(parsed.source, Some("cli".to_string()));
    }

    /// source を名乗らないノートの frontmatter は今までと 1 バイトも変わらない。
    /// view / origin と同じ約束: 書いていないキーは書かない。既存のノートに
    /// キーが増えると内容ハッシュが動き、全端末で「変更あり」として同期が走る。
    #[test]
    fn test_render_omits_absent_source() {
        let rendered = render(&sample_fm(), "body").unwrap();
        assert!(!rendered.contains("source"));
    }

    /// source キーを知らない版のアプリが書いたノートも今まで通り読める。
    #[test]
    fn test_parse_defaults_source_to_none() {
        let yaml = "---\ntime: 2026-03-20T14:30:45+09:00\ntags: []\n---\nbody";
        let (fm, _body): (NoteFrontmatter, &str) = parse(yaml).unwrap();
        assert_eq!(fm.source, None);
    }

    #[test]
    fn test_note_frontmatter_no_context() {
        let fm = sample_fm();
        let rendered = render(&fm, "body").unwrap();
        let (parsed, _body): (NoteFrontmatter, _) = parse(&rendered).unwrap();
        assert_eq!(parsed, fm);
    }

    #[test]
    fn test_render_contains_delimiters() {
        let rendered = render(&sample_fm(), "body").unwrap();
        assert!(rendered.starts_with("---\n"));
        assert!(rendered.contains("\n---\n"));
        assert!(rendered.ends_with("body"));
    }

    #[test]
    fn strip_removes_frontmatter() {
        assert_eq!(strip("---\ntime: x\n---\nbody line"), "body line");
    }

    #[test]
    fn strip_returns_whole_content_without_frontmatter() {
        assert_eq!(strip("just body"), "just body");
    }

    /// YAML として壊れていても、区切りの中身を本文に漏らさない。
    #[test]
    fn strip_drops_broken_yaml_frontmatter() {
        assert_eq!(strip("---\n:{ not yaml ::\n---\nbody"), "body");
    }

    #[test]
    fn strip_handles_empty_body() {
        assert_eq!(strip("---\ntime: x\n---"), "");
    }

    /// 閉じ区切りが無いなら frontmatter ではない(本文先頭の水平線かもしれない)。
    #[test]
    fn strip_keeps_unclosed_delimiter() {
        assert_eq!(strip("---\nno closing"), "---\nno closing");
    }

    /// CRLF で書かれたノート。`parse` は受けるので一覧は正常に出るのに、
    /// `strip` が剥がせないと編集経路にだけ frontmatter が本文として流れ込み、
    /// そのまま保存されて固定される。
    #[test]
    fn strip_removes_crlf_frontmatter() {
        assert_eq!(strip("---\r\ntime: x\r\n---\r\nbody line"), "body line");
    }

    /// 空の frontmatter は開始直後の `---` が閉じ区切り。
    #[test]
    fn strip_removes_empty_frontmatter() {
        assert_eq!(strip("---\n---\nbody line"), "body line");
    }

    /// `parse` と `strip` は同じノートから同じ本文を返す。行末や空 frontmatter の
    /// 扱いが片方にしか入っていないのが元のバグで、一覧(`parse`)は正しいのに
    /// 編集経路(`strip`)だけ frontmatter を本文として抱えた。
    #[test]
    fn strip_matches_parse_body() {
        for content in [
            // LF
            "---\ntime: x\n---\nbody line\n",
            // CRLF
            "---\r\ntime: x\r\n---\r\nbody line\r\n",
            // CR だけ
            "---\rtime: x\r---\rbody line\r",
            // 空 frontmatter
            "---\n---\nbody line\n",
            // 本文中に閉じ区切りと同じ行がある
            "---\ntime: x\n---\nbefore\n---\nafter\n",
            // 先頭の空白
            "\n\n  ---\ntime: x\n---\nbody line\n",
            // frontmatter 無し
            "body line\n",
        ] {
            let (_fm, body): (serde_yaml::Value, &str) = parse(content).unwrap();
            assert_eq!(strip(content), body, "content: {content:?}");
        }
    }

    // ──────────── 境界 ────────────

    /// 全キーが省略可能な型は、frontmatter が無くても・空でも既定値で読める。
    /// 日ファイルの端末一覧がこれ。区切りだけの `---\n---` を壊れた
    /// メタデータ扱いにすると、`---` の行が本文(エントリ)として残る。
    #[test]
    fn an_absent_or_empty_frontmatter_reads_as_defaults() {
        #[derive(Debug, Default, PartialEq, serde::Deserialize)]
        struct Optional {
            #[serde(default)]
            items: Vec<String>,
        }

        for content in ["body", "---\n---\nbody", "---\n\n---\nbody"] {
            let (fm, body): (Optional, &str) = parse(content).unwrap();
            assert_eq!(fm, Optional::default(), "content: {content:?}");
            assert_eq!(body, "body", "content: {content:?}");
        }
    }

    /// `time` を必須とするノートは、frontmatter が無ければ読めない。
    /// 一覧はそこで `strip` に倒れ、本文をプレビューに出す。
    #[test]
    fn a_note_without_frontmatter_is_a_parse_error() {
        let result = parse::<NoteFrontmatter>("just body");
        assert!(matches!(result, Err(CoreError::Parse(_))));
    }

    /// 開き区切りだけの本文。`parse` は失敗し、`strip` は全文を返す —
    /// 閉じていないものを frontmatter とみなすと本文が丸ごと消える。
    #[test]
    fn an_unclosed_delimiter_is_not_a_frontmatter() {
        let content = "---\ntime: x\nbody line";
        assert!(matches!(
            parse::<serde_yaml::Value>(content),
            Err(CoreError::Parse(_))
        ));
        assert_eq!(strip(content), content);
    }

    /// 閉じ区切りの直後で終わるファイル。本文は空で、範囲外に触れない。
    #[test]
    fn a_closing_delimiter_at_the_very_end_leaves_an_empty_body() {
        let (_fm, body): (serde_yaml::Value, &str) = parse("---\ntime: x\n---").unwrap();
        assert_eq!(body, "");
    }

    /// `---` に前後の空白や余分な記号が付いた行は区切りではない。
    #[test]
    fn a_delimiter_must_be_exactly_three_dashes() {
        for content in ["--- \ntime: x\n---\nbody", "----\ntime: x\n---\nbody"] {
            assert_eq!(strip(content), content, "content: {content:?}");
        }
        assert_eq!(strip("---\ntime: x\n--- \n---\nbody"), "body");
    }

    #[test]
    fn test_note_frontmatter_old_format_compat() {
        // Old format only had battery and is_charging
        let yaml = "---\ntime: 2026-03-20T14:30:45+09:00\ntags: []\ncontext:\n  battery: 82\n  is_charging: false\n---\nbody";
        let (fm, body): (NoteFrontmatter, &str) = parse(yaml).unwrap();
        let ctx = fm.context.unwrap();
        assert_eq!(ctx.battery, Some(82));
        assert_eq!(ctx.is_charging, Some(false));
        assert_eq!(ctx.network_type, None);
        assert_eq!(body, "body");
    }
}
