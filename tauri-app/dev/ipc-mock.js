/**
 * ブラウザ単体で UI を検証するための Tauri IPC モック。
 *
 * `BROWSER_MOCK=1 pnpm vite` のときだけ vite.config.ts が index.html の先頭に
 * インライン注入する。モジュールグラフより先に実行される普通の <script> なので、
 * `@tauri-apps/api` が `window.__TAURI_INTERNALS__` を読む頃には必ず居る。
 * プロダクションビルドには一切含まれない。
 */
(() => {
  if (window.__TAURI_INTERNALS__) {
    return;
  }

  // ---- タイムラインのつくりもの ----

  // 地名は OS が言語ごとに違う答えを返す。ハーネスでもそれを真似る
  const PLACES = [
    { lat: 35.6812, lon: 139.7671, ja: "千代田区丸の内", en: "Marunouchi, Chiyoda" },
    { lat: 35.659, lon: 139.7005, ja: "渋谷区神南", en: "Jinnan, Shibuya" },
    { lat: 35.6284, lon: 139.7387, ja: "品川区大崎", en: "Osaki, Shinagawa" },
  ];

  const TEXTS = [
    "朝の散歩で考えた設計メモ #design",
    "対空は :623k: で取る。起き攻めは :236p: 重ね #fgc",
    "コードレビューの指摘を反映した",
    "mermaid の描画が重い気がするので後で測る #perf",
    "買い物リスト: 牛乳、卵、コーヒー豆",
    "同期の競合をどう見せるか検討 #sync",
    "タイムラインの仮想化はまだ要らない、件数を先に測る",
    "読書メモ: 設計の背景を残すことについて",
    "ウィジェットからの起動導線を確認した",
  ];

  const pad = (n) => String(n).padStart(2, "0");

  /** 書いた入り口の固定語彙。`undefined` は名乗る前に書かれた記録。 */
  const SOURCES = ["app", "widget", "cli", "mcp", undefined];

  function contextFor(dayIndex, entryIndex) {
    if ((dayIndex + entryIndex) % 3 === 2) {
      return null;
    }
    const ctx = {
      battery: 20 + ((dayIndex * 13 + entryIndex * 29) % 80),
      is_charging: entryIndex % 4 === 0,
      network_type: ["WiFi", "Mobile", "WiFi", "Ethernet"][entryIndex % 4],
      os: entryIndex % 2 === 0 ? "macos" : "android",
      os_version: entryIndex % 2 === 0 ? "15.5" : "15",
      arch: "aarch64",
    };
    if ((dayIndex + entryIndex) % 2 === 0) {
      const place = PLACES[(dayIndex + entryIndex) % PLACES.length];
      ctx.location = {
        latitude: place.lat + (entryIndex % 5) * 0.0004,
        longitude: place.lon + (entryIndex % 7) * 0.0003,
      };
    }
    // 書いた入り口。実ファイルと同じく行末 JSON の最後に置き、名乗らない
    // エントリも混ぜる — キーが無い記録でも行のメタ表示が崩れないこと
    const source = SOURCES[(dayIndex + entryIndex) % SOURCES.length];
    if (source) {
      ctx.s = source;
    }
    return ctx;
  }

  /** date(ISO) -> raw 行の配列(古い順)。 */
  const timeline = new Map();
  const today = new Date();
  for (let d = 0; d < 20; d += 1) {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - d);
    const iso = `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
    const lines = [];
    const count = 4 + ((d * 7) % 5);
    for (let i = 0; i < count; i += 1) {
      const time = `${pad(8 + i * 2)}:${pad((i * 17) % 60)}:${pad((i * 23) % 60)}`;
      const ctx = contextFor(d, i);
      const suffix = ctx ? ` ${JSON.stringify(ctx)}` : "";
      lines.push(`- [${time}] ${TEXTS[(d + i) % TEXTS.length]}${suffix}`);
    }
    timeline.set(iso, lines);
  }

  // ---- ノートのつくりもの ----

  /** タイムラインは実時刻基準で作られるので、origin も同じ基準で合わせる。 */
  const isoDaysAgo = (days) => {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - days);
    return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
  };

  const codeSample = [
    "```typescript",
    "export function debounce<T extends unknown[]>(fn: (...args: T) => void, ms: number) {",
    "  let timer: ReturnType<typeof setTimeout> | undefined;",
    "  return (...args: T) => {",
    "    if (timer) clearTimeout(timer);",
    "    timer = setTimeout(() => fn(...args), ms);",
    "  };",
    "}",
    "```",
  ].join("\n");

  const mermaidSample = [
    "```mermaid",
    "flowchart TD",
    "  A[編集開始] --> B{保存済み?}",
    "  B -- はい --> C[プレビュー]",
    "  B -- いいえ --> D[1秒待って保存]",
    "  D --> C",
    "```",
  ].join("\n");

  const longSections = [];
  for (let i = 1; i <= 30; i += 1) {
    longSections.push(
      `## セクション ${i}`,
      "",
      `本文の段落です。エディタとプレビューの描画コストを測るための行。行番号 ${i}。`,
      "",
    );
  }

  const notes = new Map([
    [
      "20260810_090000.md",
      {
        time: "2026-08-10T09:00:00+09:00",
        tags: ["perf"],
        view: null,
        body: `# パフォーマンス検証ノート\n\nコードブロックと図の混ざった長文。\n\n${codeSample}\n\n${mermaidSample}\n\n${longSections.join("\n")}`,
      },
    ],
    [
      "20260812_140000.md",
      {
        time: "2026-08-12T14:00:00+09:00",
        tags: ["design"],
        view: "mindmap",
        // エージェントが書いたノート。メタデータパネルの「書いたツール」検証用
        source: "mcp",
        body: `# 設計の見取り図\n\n## UI\n\n- ヘッダ\n- タイムライン\n  - 入力バー\n  - 日付ジャンプ\n\n## コア\n\n- 保存\n- 同期\n  - 認証\n  - 競合`,
      },
    ],
    [
      "20260812_150000.md",
      {
        time: "2026-08-12T15:00:00+09:00",
        tags: ["design"],
        // 読み取り専用ノートの検証用。本文を押しても編集に入らないが、
        // ノートリンクは辿れること
        view: "preview",
        body: "# 読むだけのノート\n\n押しても編集に入らない本文。\n\n参照: [[20260811_100000]]\n\n- 一覧から開いても書き始まらない\n- タイトル欄も動かない",
      },
    ],
    [
      "20260811_100000.md",
      {
        time: "2026-08-11T10:00:00+09:00",
        tags: [],
        view: null,
        // 一度書き直したノート。メタデータパネルの更新日時の検証用
        updated: "2026-08-14T22:10:00+09:00",
        // [[リンク]] の解決とバックリンクの検証用。3 本目は表示文字つき
        body: "# リンク集\n\nまず [[20260813_083000]] を読む。次に [[20260810_090000]]。\n\n詳しくは [[20260810_090000|重い方のノート]] を見る。",
      },
    ],
    [
      "20260813_083000.md",
      {
        time: "2026-08-13T08:30:00+09:00",
        tags: [],
        view: null,
        // ウィジェットで捕まえたエントリから育ったノート
        source: "widget",
        // グリフ `:236p:` の描画検証用。登録の無い `:foo:` と時刻は文字のまま
        body: "# 短いメモ\n\n今日やることを 3 つだけ。\n\n- :236p: の入力を安定させる\n- 12:30:45 に :foo: を確認\n- `:236p:` はコードなので文字のまま",
        // 昇格ノートのチップ検証用。3 日前のエントリから育ったことにする
        origin: `${isoDaysAgo(3)}T08:00:00`,
      },
    ],
    [
      "20260813_083100.md",
      {
        time: "2026-08-13T08:31:00+09:00",
        tags: [],
        view: null,
        body: "# 同じ記録から育った 2 本目\n\n1 つのエントリに複数チップが並ぶ場合の検証用。",
        origin: `${isoDaysAgo(3)}T08:00:00`,
      },
    ],
    [
      "20260809_235900.md",
      {
        time: "2026-08-09T23:59:00+09:00",
        tags: [],
        view: null,
        body: "# 元の記録が消えたノート\n\n日の見出し直下に避難するチップの検証用。",
        // どのエントリの時刻とも一致しない origin = 昇格元が消えた状態
        origin: `${isoDaysAgo(3)}T23:59:00`,
      },
    ],
  ]);

  // バックリンク検証用: 昨日のエントリからも 短いメモ を指しておく
  timeline.get(isoDaysAgo(1))?.push(`- [21:00:00] 昨日の続きは [[20260813_083000]] にまとめた`);

  // 週次ダイジェストの「1年前の今日」検証用
  {
    const yearAgo = new Date(today.getFullYear() - 1, today.getMonth(), today.getDate());
    const iso = `${yearAgo.getFullYear()}-${pad(yearAgo.getMonth() + 1)}-${pad(yearAgo.getDate())}`;
    timeline.set(iso, [`- [12:00:00] 一年前のきょうの記録`]);
  }

  const noteList = () =>
    [...notes.entries()]
      .toSorted(([a], [b]) => b.localeCompare(a))
      .map(([filename, note]) => ({
        path: `/mock/data/${filename}`,
        filename,
        time: note.time,
        tags: note.tags,
        preview: note.body.slice(0, 120),
        ...(note.origin ? { origin: note.origin } : {}),
        ...(note.template ? { template: note.template } : {}),
      }));

  // ---- テンプレートのつくりもの ----

  /** filename -> { tags, body }。変数は本物と同じく未解決のまま持つ。 */
  const templates = new Map([
    [
      "daily.md",
      {
        tags: ["daily", "{{date:YYYY-MM}}"],
        body: "# Daily {{date}} ({{weekday}})\n\n## 今日やること\n\n- [ ] \n\n## メモ\n\n前回: {{prev}}",
      },
    ],
    [
      "meeting.md",
      {
        tags: ["meeting"],
        body: "# {{date}} 打ち合わせ\n\n## 出席者\n\n## 決まったこと\n\n## 宿題\n\n- [ ] ",
      },
    ],
    [
      "weekly.md",
      {
        tags: ["weekly"],
        body: "# 週次ふりかえり {{date:YYYY-MM-DD}}\n\n## よかったこと\n\n## 次に試すこと\n\n前回: {{prev}}",
      },
    ],
  ]);

  const WEEKDAYS = {
    ja: ["日", "月", "火", "水", "木", "金", "土"],
    en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
  };

  /** core の `format_stamp` と同じトークン。strftime には渡さない。 */
  const formatStamp = (date, pattern) =>
    pattern
      .replaceAll("YYYY", String(date.getFullYear()))
      .replaceAll("MM", pad(date.getMonth() + 1))
      .replaceAll("DD", pad(date.getDate()))
      .replaceAll("HH", pad(date.getHours()))
      .replaceAll("mm", pad(date.getMinutes()))
      .replaceAll("ss", pad(date.getSeconds()));

  const PREV_LINE = /\{\{\s*prev\s*(:[^}]*)?\}\}/;

  /**
   * core の `resolve_vars` と同じ規則で解く。ハーネスだけ違う結果を返すと、
   * ブラウザで見た画面が実機の答え合わせにならない。
   */
  const resolveVars = (body, prev, locale) =>
    body
      .split("\n")
      // 前回が無いときは、その行を丸ごと落とす(「前回: 」だけを残さない)
      .filter((line) => prev !== null || !PREV_LINE.test(line))
      .map((line) =>
        line.replaceAll(/\{\{([^}]*)\}\}/g, (raw, inner) => {
          const at = inner.indexOf(":");
          const name = (at === -1 ? inner : inner.slice(0, at)).trim();
          const arg = at === -1 ? undefined : inner.slice(at + 1).trim();
          const now = new Date();
          if (name === "date") return formatStamp(now, arg || "YYYY-MM-DD");
          if (name === "time") return formatStamp(now, arg || "HH:mm");
          if (name === "weekday") return (WEEKDAYS[locale] ?? WEEKDAYS.en)[now.getDay()];
          if (name === "prev") return prev ?? "";
          // 知らない変数は書いたまま残す
          return raw;
        }),
      )
      .join("\n");

  const templateSummary = (filename, template) => ({
    filename,
    name: filename.replace(/\.md$/, ""),
    tags: template.tags,
    preview: (template.body.split("\n").find((line) => line.trim()) ?? "")
      .replace(/^#+\s*/, "")
      .trim(),
  });

  // ---- グリフのつくりもの ----

  /** 本物は data:image/svg+xml;base64 で返す。ここも同じ形にしておく。 */
  const svgDataUrl = (svg) => `data:image/svg+xml;base64,${btoa(svg)}`;

  const glyphSvg = (label, fill) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="${fill}"/><text x="16" y="21" font-size="12" font-family="sans-serif" font-weight="700" text-anchor="middle" fill="#fff">${label}</text></svg>`;

  /** name -> { format, url }。 */
  const glyphs = new Map([
    ["236p", { format: "svg", url: svgDataUrl(glyphSvg("236P", "#d9480f")) }],
    ["623k", { format: "svg", url: svgDataUrl(glyphSvg("623K", "#1c7ed6")) }],
  ]);

  // ---- コマンド実装 ----

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // core の Revision の代わり。本文が同じなら同じ値、違えば違う値になれば足りる
  const revisionOf = (body) => {
    let hash = 5381;
    for (const ch of body) {
      hash = ((hash * 33) ^ ch.codePointAt(0)) >>> 0;
    }
    return hash.toString(16);
  };

  const placeKey = (lat, lon) => `${lat.toFixed(2)},${lon.toFixed(2)}`;

  const commands = {
    list_timeline_dates: () => [...timeline.keys()].toSorted().toReversed(),
    read_timeline_by_date: ({ date }) => timeline.get(date) ?? [],
    save_quick_capture: ({ text }) => {
      const now = new Date();
      const iso = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      const line = `- [${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}] ${text}`;
      timeline.set(iso, [...(timeline.get(iso) ?? []), line]);
    },
    delete_timeline_entry: ({ date, index }) => {
      const lines = timeline.get(date) ?? [];
      lines.splice(index, 1);
    },
    // 実機のジオコーダは即答しない。名前が後から届く画面を再現する
    resolve_places: async ({ coordinates, locale }) => {
      await delay(600);
      const answers = [];
      for (const [lat, lon] of coordinates) {
        const hit = PLACES.find((p) => placeKey(p.lat, p.lon) === placeKey(lat, lon));
        if (hit) {
          answers.push([placeKey(lat, lon), locale === "en" ? hit.en : hit.ja]);
        }
      }
      return answers;
    },
    search_all: ({ query, tags }) => {
      const needle = query.trim().toLowerCase();
      // 本流(core)の utils::tags と同じ規則: `#` の有無と ASCII の大小は見ない
      const lower = (tag) => tag.replaceAll(/[A-Z]/g, (c) => c.toLowerCase());
      const scope = tags
        .map((tag) => lower(tag.trim().replace(/^#/, "")))
        .filter((tag) => tag.length > 0);
      if (!needle && scope.length === 0) {
        return [];
      }
      // lib/tags.ts の TAG と同じ。ここは 1 行しか読まないのでコードは切り分けない
      const TAG = /(?<![\p{L}\p{N}_-])#([\p{L}\p{N}_-]+)/gu;
      const parseTags = (text) => [...new Set([...text.matchAll(TAG)].map((m) => lower(m[1])))];
      const inScope = (own) => scope.every((tag) => own.includes(tag));
      /** 本流(core)と同じ形: 一致の前後を含む抜粋と、文字数の一致位置。 */
      const excerpt = (text) => {
        const flat = text.replaceAll("\n", " ");
        // タグだけで絞った一覧には光らせる場所がない
        const at = needle ? flat.toLowerCase().indexOf(needle) : -1;
        if (at === -1) {
          return { snippet: flat.slice(0, 90), match_start: null, match_len: null };
        }
        const start = Math.max(0, at - 40);
        const lead = start > 0 ? "…" : "";
        const snippet = lead + flat.slice(start, at + needle.length + 40);
        return {
          snippet,
          match_start: [...(lead + flat.slice(start, at))].length,
          match_len: [...flat.slice(at, at + needle.length)].length,
        };
      };
      const hits = [];
      for (const [iso, lines] of timeline) {
        lines.forEach((raw, index) => {
          const text = raw.replace(/^- \[\d\d:\d\d:\d\d\] /, "").replace(/ \{.*\}$/, "");
          const own = parseTags(text);
          if (!text.toLowerCase().includes(needle) || !inScope(own)) {
            return;
          }
          hits.push({
            kind: "timeline",
            title: text.split("\n")[0],
            date: iso,
            filename: null,
            index,
            tags: own,
            ...excerpt(text),
          });
        });
      }
      for (const [filename, note] of notes) {
        if (!note.body.toLowerCase().includes(needle) || !inScope(note.tags)) {
          continue;
        }
        hits.push({
          kind: "note",
          title: note.body.split("\n")[0].replace(/^#+\s*/, ""),
          date: note.time.slice(0, 10),
          filename,
          index: null,
          tags: note.tags,
          ...excerpt(note.body),
        });
      }
      return hits.toSorted((a, b) => b.date.localeCompare(a.date)).slice(0, 100);
    },
    list_notes: () => noteList(),
    find_backlinks: ({ filename }) => {
      const needle = `[[${filename.replace(/\.md$/, "")}]]`;
      const hits = [];
      for (const [iso, lines] of timeline) {
        lines.forEach((raw, index) => {
          const text = raw.replace(/^- \[\d\d:\d\d:\d\d\] /, "").replace(/ \{.*\}$/, "");
          if (text.includes(needle)) {
            hits.push({
              kind: "timeline",
              title: text.split("\n")[0],
              snippet: text.slice(0, 90),
              date: iso,
              filename: null,
              index,
              tags: [],
              match_start: null,
              match_len: null,
            });
          }
        });
      }
      for (const [name, note] of notes) {
        if (name === filename || !note.body.includes(needle)) {
          continue;
        }
        hits.push({
          kind: "note",
          title: note.body.split("\n")[0].replace(/^#+\s*/, ""),
          snippet: note.body.slice(0, 90),
          date: note.time.slice(0, 10),
          filename: name,
          index: null,
          tags: note.tags,
          match_start: null,
          match_len: null,
        });
      }
      return hits.toSorted((a, b) => b.date.localeCompare(a.date));
    },
    read_note: async ({ filename }) => {
      // ディスク読みの往復ぶん。ノート切替の描画順の検証に効く
      await delay(30);
      const body = notes.get(filename)?.body ?? "";
      return { body, revision: revisionOf(body) };
    },
    read_note_meta: async ({ filename }) => {
      await delay(30);
      const note = notes.get(filename);
      if (!note) {
        throw new Error("note not found");
      }
      return {
        time: note.time,
        tags: note.tags,
        ...(note.view ? { view: note.view } : {}),
        ...(note.updated ? { updated: note.updated } : {}),
        // 名乗る前に作られたノートにはキーごと無い。core が
        // `skip_serializing_if` で落とすのと同じ形にしておく
        ...(note.source ? { source: note.source } : {}),
      };
    },
    update_note_meta: ({ filename, time, tags }) => {
      const note = notes.get(filename);
      if (note) {
        Object.assign(note, { time, tags });
      }
    },
    set_note_view: ({ filename, view }) => {
      const note = notes.get(filename);
      if (note) {
        note.view = view;
      }
    },
    set_note_origin: ({ filename, origin }) => {
      const note = notes.get(filename);
      if (note) {
        note.origin = origin ?? undefined;
      }
    },
    delete_note: ({ filename }) => {
      notes.delete(filename);
    },
    create_draft: ({ body, tags, origin }) => {
      const now = new Date();
      const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      const filename = `${stamp}.md`;
      notes.set(filename, {
        time: now.toISOString(),
        tags: tags ?? [],
        view: null,
        // 画面から作ったノートはアプリが名乗る。実装(`create_draft`)と
        // 揃えておかないと、作った直後だけメタデータの行が 1 本足りない
        source: "app",
        body,
        ...(origin ? { origin } : {}),
      });
      return `/mock/data/${filename}`;
    },
    update_draft: ({ filePath, body, revision }) => {
      const filename = filePath.split("/").at(-1);
      const note = notes.get(filename);
      if (!note) {
        throw { kind: "other", message: `note not found: ${filename}` };
      }
      // core と同じ照合。読んでから誰かが書き換えていれば、その上に書かない
      if (revision != null && revision !== revisionOf(note.body)) {
        throw { kind: "stale", message: `Stale: ${filename} changed since it was read` };
      }
      note.body = body;
      // core と同じく、本文の保存だけが更新日時を打つ
      note.updated = new Date().toISOString();
      return revisionOf(body);
    },
    list_templates: () =>
      [...templates.entries()]
        .map(([filename, template]) => templateSummary(filename, template))
        .toSorted((a, b) => a.name.localeCompare(b.name)),
    read_template: async ({ filename }) => {
      await delay(30);
      const template = templates.get(filename);
      if (!template) {
        throw new Error("template not found");
      }
      return { body: template.body, tags: template.tags };
    },
    save_template: ({ filename, body, tags }) => {
      templates.set(filename, { body, tags: tags ?? [] });
    },
    delete_template: ({ filename }) => {
      templates.delete(filename);
    },
    create_from_template: ({ filename, locale }) => {
      const template = templates.get(filename);
      if (!template) {
        throw new Error("template not found");
      }
      const name = filename.replace(/\.md$/, "");
      const now = new Date();
      const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

      // 同じテンプレの今日のぶんが既にあれば作らない。日付はファイル名の
      // 先頭 8 桁で見る — 保存している time は UTC で、日をまたぐと食い違う
      const today = stamp.slice(0, 8);
      const existing = [...notes.entries()].find(
        ([fname, note]) => note.template === name && fname.slice(0, 8) === today,
      );
      if (existing) {
        return { path: `/mock/data/${existing[0]}`, reused: true };
      }

      const previous = [...notes.entries()]
        .filter(([, note]) => note.template === name)
        .toSorted(([a], [b]) => b.localeCompare(a))[0];
      const prev = previous ? `[[${previous[0].replace(/\.md$/, "")}]]` : null;

      const created = `${stamp}.md`;
      notes.set(created, {
        time: now.toISOString(),
        tags: template.tags
          .map((tag) => resolveVars(tag, prev, locale))
          .filter((tag) => tag.trim()),
        view: null,
        source: "app",
        body: resolveVars(template.body, prev, locale),
        template: name,
      });
      return { path: `/mock/data/${created}`, reused: false };
    },
    list_glyphs: () =>
      [...glyphs.entries()]
        .map(([name, glyph]) => ({
          name,
          filename: `${name}.${glyph.format}`,
          format: glyph.format,
          // データ URL の base64 部分のおおよその生バイト数
          bytes: Math.floor((glyph.url.length - glyph.url.indexOf(",") - 1) * 0.75),
        }))
        .toSorted((a, b) => a.name.localeCompare(b.name)),
    read_glyphs: () =>
      [...glyphs.entries()]
        .map(([name, glyph]) => ({ name, url: glyph.url }))
        .toSorted((a, b) => a.name.localeCompare(b.name)),
    save_glyph: ({ name, format, dataBase64 }) => {
      // core と同じ規則。通らない名前は本物でも保存できない
      if (!/^[a-z0-9][a-z0-9_+-]{0,31}$/.test(name)) {
        throw new Error(`Invalid path: ${name}`);
      }
      if (format !== "png" && format !== "svg") {
        throw new Error(`Parse error: unsupported glyph format: ${format}`);
      }
      const mime = format === "png" ? "image/png" : "image/svg+xml";
      glyphs.set(name, { format, url: `data:${mime};base64,${dataBase64}` });
    },
    delete_glyph: ({ name }) => {
      glyphs.delete(name);
    },
    sync_start: () => {},
    sync_status: () => ({}),
    auth_login: () => {},
    auth_status: () => true,
    auth_logout: () => {},
    get_sync_config: () => ({ workers_url: "https://mock.example", auto_sync: false }),
    save_sync_config: () => {},
    is_sync_config_editable: () => true,

    "plugin:event|listen": () => 1,
    "plugin:event|unlisten": () => null,
    "plugin:deep-link|get_current": () => null,
    // ブラウザに全画面にする窓は無い。設定を入れても何も起きないのが正しい
    "plugin:window|set_fullscreen": () => null,
    "plugin:geolocation|check_permissions": () => ({
      location: "denied",
      coarseLocation: "denied",
    }),
  };

  let callbackId = 0;

  window.__TAURI_INTERNALS__ = {
    invoke: async (cmd, args) => {
      const handler = commands[cmd];
      if (!handler) {
        throw new Error(`mock: unknown command ${cmd}`);
      }
      return handler(args ?? {});
    },
    transformCallback: () => {
      callbackId += 1;
      return callbackId;
    },
    unregisterCallback: () => {},
    convertFileSrc: (path) => path,
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  };
})();
