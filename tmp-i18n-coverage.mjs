// One-shot tool: report i18n key gaps + scan source for unwrapped hardcoded strings.

import fs from "node:fs";

const i18nSrc = fs.readFileSync("web/i18n.ts", "utf8");

function extractKeys(dictName) {
  // Match `const NAME: Dict = { ... };` block.
  const re = new RegExp(`const\\s+${dictName}:\\s*Dict\\s*=\\s*\\{([\\s\\S]*?)\\n\\};`, "m");
  const m = i18nSrc.match(re);
  if (!m) return new Set();
  const keys = new Set();
  for (const line of m[1].split("\n")) {
    const km = line.match(/"([^"]+)"\s*:\s*"/);
    if (km) keys.add(km[1]);
  }
  return keys;
}

const tw = extractKeys("zhTW");
const cn = extractKeys("zhCN");
const en = extractKeys("en");
console.log("Sizes  zh-TW:", tw.size, "zh-CN:", cn.size, "en:", en.size);

function diff(a, b, an, bn) {
  const m = [...a].filter((k) => !b.has(k));
  console.log(`\n${an} \\ ${bn}: ${m.length}`);
  m.forEach((k) => console.log("  " + k));
}
diff(tw, cn, "zh-TW", "zh-CN");
diff(tw, en, "zh-TW", "en");
diff(cn, tw, "zh-CN", "zh-TW");
diff(en, tw, "en", "zh-TW");

// ── Scan source for likely-unwrapped strings ──────────────────────────────
function scanForChinese(file) {
  const src = fs.readFileSync(file, "utf8");
  const hits = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip comments, console.* calls, and lines already inside t(...).
    // Heuristic: find ANY CJK chunk inside JSX text or a "..." literal that's
    // NOT inside a t("...", ...) call and NOT a key path.
    if (/^\s*\/\//.test(line)) continue;
    const cjkRe = /[一-鿿]+/g;
    let m;
    while ((m = cjkRe.exec(line)) !== null) {
      // Lazy filter: skip if line looks like a t-key (e.g. "session.foo": "...")
      // or it's inside a console.log/cwarn/cerr/clog/addLog call we can't easily prove.
      // Better: report all and let me eyeball.
      hits.push({ file, line: i + 1, col: m.index + 1, text: m[0], context: line.trim().slice(0, 160) });
    }
  }
  return hits;
}

console.log("\n── Hardcoded CJK strings in web/app.tsx ──");
const appHits = scanForChinese("web/app.tsx");
console.log("  total:", appHits.length);
appHits.slice(0, 200).forEach((h) => {
  console.log(`  ${h.file}:${h.line} → ${h.text}   |  ${h.context}`);
});
if (appHits.length > 200) console.log("  ... +" + (appHits.length - 200) + " more");

console.log("\n── Hardcoded CJK strings in web-phone/app.tsx ──");
const phoneHits = scanForChinese("web-phone/app.tsx");
console.log("  total:", phoneHits.length);
phoneHits.slice(0, 200).forEach((h) => {
  console.log(`  ${h.file}:${h.line} → ${h.text}   |  ${h.context}`);
});
if (phoneHits.length > 200) console.log("  ... +" + (phoneHits.length - 200) + " more");
