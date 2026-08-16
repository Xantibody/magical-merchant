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

  const PLACES = [
    { lat: 35.6812, lon: 139.7671, name: "千代田区丸の内" },
    { lat: 35.659, lon: 139.7005, name: "渋谷区神南" },
    { lat: 35.6284, lon: 139.7387, name: "品川区大崎" },
  ];

  const TEXTS = [
    "朝の散歩で考えた設計メモ #design",
    "コードレビューの指摘を反映した",
    "mermaid の描画が重い気がするので後で測る #perf",
    "買い物リスト: 牛乳、卵、コーヒー豆",
    "同期の競合をどう見せるか検討 #sync",
    "タイムラインの仮想化はまだ要らない、件数を先に測る",
    "読書メモ: 設計の背景を残すことについて",
    "ウィジェットからの起動導線を確認した",
  ];

  const pad = (n) => String(n).padStart(2, "0");

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
        body: `# 設計の見取り図\n\n## UI\n\n- ヘッダ\n- タイムライン\n  - 入力バー\n  - 日付ジャンプ\n\n## コア\n\n- 保存\n- 同期\n  - 認証\n  - 競合`,
      },
    ],
    [
      "20260813_083000.md",
      {
        time: "2026-08-13T08:30:00+09:00",
        tags: [],
        view: null,
        body: "# 短いメモ\n\n今日やることを 3 つだけ。",
        // 昇格ノートのチップ検証用。3 日前のエントリから育ったことにする
        origin: `${isoDaysAgo(3)}T08:00:00`,
      },
    ],
  ]);

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
      }));

  // ---- コマンド実装 ----

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    update_timeline_entry: ({ date, index, text }) => {
      const lines = timeline.get(date) ?? [];
      const raw = lines[index] ?? "";
      const head = raw.match(/^- \[\d{2}:\d{2}:\d{2}\] /)?.[0] ?? "- [00:00:00] ";
      const tail = raw.includes(" {") ? raw.slice(raw.lastIndexOf(" {")) : "";
      lines[index] = `${head}${text}${tail}`;
    },
    delete_timeline_entry: ({ date, index }) => {
      const lines = timeline.get(date) ?? [];
      lines.splice(index, 1);
    },
    // 実機のジオコーダは即答しない。名前が後から届く画面を再現する
    resolve_places: async ({ coordinates }) => {
      await delay(600);
      const answers = [];
      for (const [lat, lon] of coordinates) {
        const hit = PLACES.find((p) => placeKey(p.lat, p.lon) === placeKey(lat, lon));
        if (hit) {
          answers.push([placeKey(lat, lon), hit.name]);
        }
      }
      return answers;
    },
    search_all: () => [],
    list_notes: () => noteList(),
    read_note: async ({ filename }) => {
      // ディスク読みの往復ぶん。ノート切替の描画順の検証に効く
      await delay(30);
      return notes.get(filename)?.body ?? "";
    },
    read_note_meta: async ({ filename }) => {
      await delay(30);
      const note = notes.get(filename);
      if (!note) {
        throw new Error("note not found");
      }
      return { time: note.time, tags: note.tags, ...(note.view ? { view: note.view } : {}) };
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
        body,
        ...(origin ? { origin } : {}),
      });
      return `/mock/data/${filename}`;
    },
    update_draft: ({ filePath, body }) => {
      const filename = filePath.split("/").at(-1);
      const note = notes.get(filename);
      if (note) {
        note.body = body;
      }
    },
    save_document: () => {},
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
