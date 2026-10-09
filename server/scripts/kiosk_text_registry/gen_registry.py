#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gen_registry.py — the kiosk text registry: every text a kiosk CUSTOMER sees, in one table
(kiosk_text_registry.json), used by the cloud (validation), the dashboard (the texts editor,
grouped by screen, with language tabs) and the Android + Windows kiosks.

Every run reads, read-only:
  * the Android kiosk strings — values/ (Hebrew) and values-en/ (English) of the files listed in
    registry_meta.json `sources.androidFiles` — and the kiosk code that uses them (`R.string.<name>`
    in `sources.codeGlobs`): only strings referenced in code are taken (plus
    `scope.includeUnreferencedPrefixes`, the new layout strings), minus the staff ones (`scope`);
  * the TEXT_KEYS (the flat config `texts` of before): client/src/lib/kioskConfig.ts and
    server/app/services/kiosk_config.py;
  * the web messages: client/src/messages/he.json (and en.json when it exists) — `kiosks.builtin`
    and `kiosks.preview` — and the Windows kiosk's LIVE table (kiosk-desktop/src/renderer/i18n.ts);
  * registry_meta.json — the hand-made part (group, label, max, web mapping, merges, key names,
    placeholder names, shownWhen, English where none exists);
and writes kiosk_text_registry.json and report.md next to registry_meta.json (UTF-8, LF,
2-space indent, deterministic).

A string referenced in code but missing from the meta still gets a text (an automatic key,
group, label and max) and is printed as "NO META: <res>".

Exits 1 on: a duplicate key, a TEXT_KEY missing, a placeholder count mismatch, an unknown
placeholder name, a default longer than its max, an Android resource name that does not exist
(and on a resource or web key mapped twice, a max above 200, an empty default).

Usage:  python gen_registry.py [--meta registry_meta.json] [--out-dir DIR]
                              [--android-root P:/pos-android] [--server-root P:/pos-server]
"""

from __future__ import annotations

import argparse
import glob
import json
import math
import os
import re
import sys
import xml.etree.ElementTree as ET
from typing import Dict, List, Optional, Tuple

HERE = os.path.dirname(os.path.abspath(__file__))
MAX_CAP = 200

try:
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    sys.stderr.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
except Exception:  # pragma: no cover
    pass


# ───────────────────────────────────────────────────────────────── problems

class Problems:
    def __init__(self) -> None:
        self.errors: List[str] = []
        self.warnings: List[str] = []
        self.no_meta: List[str] = []

    def error(self, msg: str) -> None:
        self.errors.append(msg)

    def warn(self, msg: str) -> None:
        self.warnings.append(msg)


# ───────────────────────────────────────────────────────────────── Android

def android_unescape(raw: str) -> str:
    """An Android <string>'s text as the app shows it (aapt2's rules, enough for these files)."""
    out: List[str] = []
    in_quote = False
    pending_space = False
    i = 0
    n = len(raw)
    while i < n:
        c = raw[i]
        if c == "\\" and i + 1 < n:
            if pending_space and out:
                out.append(" ")
            pending_space = False
            e = raw[i + 1]
            if e == "u" and re.fullmatch(r"[0-9a-fA-F]{4}", raw[i + 2:i + 6]):
                out.append(chr(int(raw[i + 2:i + 6], 16)))
                i += 6
                continue
            out.append({"n": "\n", "t": "\t"}.get(e, e))
            i += 2
            continue
        if c == '"':
            in_quote = not in_quote
            i += 1
            continue
        if c.isspace() and not in_quote:
            pending_space = True
            i += 1
            continue
        if pending_space and out:
            out.append(" ")
        pending_space = False
        out.append(c)
        i += 1
    return "".join(out)


def read_android_strings(path: str) -> List[Tuple[str, str]]:
    """[(name, text)] in file order; plurals / arrays are not used by the kiosk files."""
    tree = ET.parse(path)
    result: List[Tuple[str, str]] = []
    for el in tree.getroot():
        if el.tag != "string":
            continue
        name = el.get("name")
        if not name:
            continue
        result.append((name, android_unescape("".join(el.itertext()))))
    return result


FORMAT_SPEC = re.compile(r"%(?:(\d+)\$)?[-#+ 0,(]*\d*(?:\.\d+)?([a-zA-Z%])")
BRACE_NAME = re.compile(r"\{(\w+)\}")


def positional_args(text: str) -> List[int]:
    """The distinct positional arguments of a java format string (1-based, sorted)."""
    seen = set()
    seq = 0
    for m in FORMAT_SPEC.finditer(text):
        idx, conv = m.group(1), m.group(2)
        if conv in ("%", "n"):
            continue
        if idx:
            seen.add(int(idx))
        else:
            seq += 1
            seen.add(seq)
    return sorted(seen)


def to_named(text: str, names: List[str]) -> str:
    """'לתשלום · %1$s' → 'לתשלום · {total}'; '%%' → '%'. Literal {n} stays as written."""
    seq = [0]

    def repl(m: "re.Match[str]") -> str:
        idx, conv = m.group(1), m.group(2)
        if conv == "%":
            return "%"
        if conv == "n":
            return "\n"
        if idx:
            k = int(idx)
        else:
            seq[0] += 1
            k = seq[0]
        if 1 <= k <= len(names):
            return "{" + names[k - 1] + "}"
        return m.group(0)

    return FORMAT_SPEC.sub(repl, text)


# ───────────────────────────────────────────────────────────────── web

def flatten(d: dict, prefix: str = "") -> Dict[str, str]:
    out: Dict[str, str] = {}
    for k, v in d.items():
        path = f"{prefix}{k}"
        if isinstance(v, dict):
            out.update(flatten(v, path + "."))
        elif isinstance(v, str):
            out[path] = v
    return out


def web_names(text: str) -> List[str]:
    """next-intl placeholders ({n}, and the name of an ICU {n, plural, …})."""
    return re.findall(r"\{(\w+)\s*[,}]", text)


def strip_ts_comments(src: str) -> str:
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    return re.sub(r"(^|[^:])//[^\n]*", r"\1", src)


def read_ts_text_keys(path: str) -> List[str]:
    src = open(path, encoding="utf-8").read()
    m = re.search(r"export const TEXT_KEYS\s*=\s*\[(.*?)\]\s*as const", src, flags=re.S)
    if not m:
        raise SystemExit(f"TEXT_KEYS not found in {path}")
    return re.findall(r"'(\w+)'", strip_ts_comments(m.group(1)))


def read_py_text_keys(path: str) -> List[str]:
    src = open(path, encoding="utf-8").read()
    m = re.search(r"^TEXT_KEYS\s*=\s*\((.*?)^\)", src, flags=re.S | re.M)
    if not m:
        raise SystemExit(f"TEXT_KEYS not found in {path}")
    body = re.sub(r"#[^\n]*", "", m.group(1))
    return re.findall(r"\"(\w+)\"", body)


def read_live(path: str) -> Dict[str, str]:
    src = open(path, encoding="utf-8").read()
    m = re.search(r"export const LIVE[^=]*=\s*\{(.*?)\n\};", src, flags=re.S)
    if not m:
        raise SystemExit(f"LIVE not found in {path}")
    body = strip_ts_comments(m.group(1))
    out: Dict[str, str] = {}
    for mm in re.finditer(r"(\w+)\s*:\s*(?:'((?:[^'\\]|\\.)*)'|\"((?:[^\"\\]|\\.)*)\")", body):
        val = mm.group(2) if mm.group(2) is not None else mm.group(3)
        out[mm.group(1)] = re.sub(r"\\(.)", r"\1", val)
    return out


# ───────────────────────────────────────────────────────────────── helpers

def camel(words: str) -> str:
    parts = [p for p in words.split("_") if p]
    if not parts:
        return ""
    return parts[0] + "".join(p[:1].upper() + p[1:] for p in parts[1:])


def auto_names(text: str, vocabulary: List[str]) -> List[str]:
    """Placeholder names for a string without meta: a number → n / count / max…, else name / total / amount…"""
    convs: Dict[int, str] = {}
    seq = 0
    for m in FORMAT_SPEC.finditer(text):
        idx, conv = m.group(1), m.group(2)
        if conv in ("%", "n"):
            continue
        if idx:
            k = int(idx)
        else:
            seq += 1
            k = seq
        convs.setdefault(k, conv)
    if not convs:
        return sorted(set(BRACE_NAME.findall(text)))
    numbers = [x for x in ("n", "count", "max", "number", "seconds") if x in vocabulary]
    others = [x for x in ("name", "total", "amount", "price", "time", "day") if x in vocabulary]
    used: List[str] = []
    for k in sorted(convs):
        pool = numbers if convs[k] in "dx" else others
        pick = next((x for x in pool + vocabulary if x not in used), f"arg{k}")
        used.append(pick)
    return used


def rule_max(base: int, longest: int) -> int:
    return min(MAX_CAP, max(base, math.ceil(longest * 1.5)))


def md_cell(s: str) -> str:
    return s.replace("|", "\\|").replace("\n", "⏎")


# ───────────────────────────────────────────────────────────────── main

def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--meta", default=os.path.join(HERE, "registry_meta.json"))
    ap.add_argument("--out-dir", default=None)
    ap.add_argument("--android-root", default=None)
    ap.add_argument("--server-root", default=None)
    args = ap.parse_args(argv)

    meta = json.load(open(args.meta, encoding="utf-8"))
    out_dir = args.out_dir or os.path.dirname(os.path.abspath(args.meta))
    src = meta["sources"]
    android_root = args.android_root or src["androidRoot"]
    server_root = args.server_root or src["serverRoot"]
    p = Problems()

    vocabulary: List[str] = meta["placeholders"]
    scope = meta["scope"]

    # ── Android strings, in source order
    res_dir = os.path.join(android_root, src["androidRes"])
    he_res: Dict[str, str] = {}
    en_res: Dict[str, str] = {}
    order: Dict[str, Tuple[int, int]] = {}
    for fi, fname in enumerate(src["androidFiles"]):
        for li, (name, text) in enumerate(read_android_strings(os.path.join(res_dir, "values", fname))):
            he_res[name] = text
            order[name] = (fi, li)
        en_path = os.path.join(res_dir, "values-en", fname)
        if os.path.exists(en_path):
            for name, text in read_android_strings(en_path):
                en_res[name] = text

    # ── referenced in code
    referenced = set()
    for pattern in src["codeGlobs"]:
        for path in sorted(glob.glob(os.path.join(android_root, pattern))):
            referenced.update(re.findall(r"R\.string\.([A-Za-z0-9_]+)", open(path, encoding="utf-8").read()))

    def excluded(name: str) -> bool:
        return name in scope["excludeNames"] or any(name.startswith(x) for x in scope["excludePrefixes"])

    def included_unreferenced(name: str) -> bool:
        return any(name.startswith(x) for x in scope["includeUnreferencedPrefixes"])

    in_scope = [n for n in sorted(he_res, key=lambda n: order[n])
                if not excluded(n) and (n in referenced or included_unreferenced(n))]

    # ── TEXT_KEYS
    ts_keys = read_ts_text_keys(os.path.join(server_root, src["textKeysTs"]))
    py_keys = read_py_text_keys(os.path.join(server_root, src["textKeysPy"]))
    if set(ts_keys) != set(py_keys):
        p.warn("TEXT_KEYS differ between kioskConfig.ts and kiosk_config.py: "
               f"only ts {sorted(set(ts_keys) - set(py_keys))}, only py {sorted(set(py_keys) - set(ts_keys))}")
    text_keys = list(dict.fromkeys(ts_keys + py_keys))
    text_key_rank = {k: i for i, k in enumerate(text_keys)}

    # ── web
    msg_dir = os.path.join(server_root, src["webMessages"])
    he_msgs = json.load(open(os.path.join(msg_dir, "he.json"), encoding="utf-8"))["kiosks"]
    en_path = os.path.join(msg_dir, "en.json")
    en_msgs = json.load(open(en_path, encoding="utf-8"))["kiosks"] if os.path.exists(en_path) else None
    builtin_he: Dict[str, str] = he_msgs.get("builtin", {})
    builtin_en: Dict[str, str] = (en_msgs or {}).get("builtin", {})
    preview_he = flatten(he_msgs.get("preview", {}))
    preview_en = flatten((en_msgs or {}).get("preview", {}))
    live = read_live(os.path.join(server_root, src["windowsLive"]))
    web_order = {k: i for i, k in enumerate(list(preview_he) + [k for k in live if k not in preview_he])}

    # ── groups
    groups = meta["groups"]
    group_ids = [g["id"] for g in groups]
    group_rank = {g: i for i, g in enumerate(group_ids)}

    # ── texts: the meta's, then automatic ones
    entries: List[dict] = []
    keys_seen: Dict[str, int] = {}
    android_owner: Dict[str, str] = {}
    web_owner: Dict[str, str] = {}

    for t in meta["texts"]:
        entries.append(dict(t))

    covered = {r for t in entries for r in t.get("android", [])}
    taken_keys = {t["key"] for t in entries}
    for name in in_scope:
        if name in covered or name in scope.get("leaveOut", {}):
            continue
        prefix, key_prefix = "", ""
        for pre, kp in meta["autoKeyPrefixes"]:
            if name.startswith(pre):
                prefix, key_prefix = pre, kp
                break
        rest = name[len(prefix):]
        key = camel(key_prefix + "_" + rest) if key_prefix else camel(rest)
        base, n = key, 2
        while key in taken_keys:
            key = f"{base}{n}"
            n += 1
        taken_keys.add(key)
        group = "errors"
        for pre, g in meta["autoGroups"]:
            if name.startswith(pre):
                group = g
                break
        he_text = he_res[name]
        names = auto_names(he_text, vocabulary)
        label = "(אוטומטי) " + to_named(he_text, names).replace("\n", " ")
        if len(label) > 40:
            label = label[:39] + "…"
        entries.append({"key": key, "group": group, "label": label, "android": [name], "auto": True,
                        "placeholders": names})
        p.no_meta.append(name)
        print(f"NO META: {name}" + (f" (key {key}, group {group}, placeholders {names})" if names else f" (key {key}, group {group})"))

    # ── TEXT_KEYS all present
    for k in text_keys:
        if not any(t["key"] == k for t in entries):
            p.error(f"TEXT_KEY MISSING: {k}")

    out_texts: List[dict] = []
    he_android_web_diffs: List[Tuple[str, str, str, str]] = []
    en_written: List[Tuple[str, str, str]] = []

    for t in entries:
        key = t["key"]
        keys_seen[key] = keys_seen.get(key, 0) + 1
        if keys_seen[key] == 2:
            p.error(f"DUPLICATE KEY: {key}")
        if t["group"] not in group_rank:
            p.error(f"UNKNOWN GROUP: {key} → {t['group']}")
        legacy = key in text_key_rank
        android: List[str] = list(t.get("android", []))
        web: list = list(t.get("web", []))
        names: List[str] = list(t.get("placeholders", []))

        for nm in names:
            if nm not in vocabulary:
                p.error(f"UNKNOWN PLACEHOLDER NAME: {key} → {nm}")
        if len(set(names)) != len(names):
            p.error(f"DUPLICATE PLACEHOLDER NAME: {key} → {names}")

        # Android resources: exist, mapped once, placeholders agree (he and en)
        for r in android:
            if r not in he_res:
                p.error(f"ANDROID RESOURCE DOES NOT EXIST: {key} → {r}")
                continue
            if r in android_owner:
                p.error(f"ANDROID RESOURCE MAPPED TWICE: {r} → {android_owner[r]}, {key}")
            android_owner[r] = key
            if r not in referenced and not included_unreferenced(r):
                p.warn(f"UNREFERENCED ANDROID RESOURCE: {key} → {r} (not R.string.{r} in the kiosk code)")
            if excluded(r):
                p.warn(f"STAFF RESOURCE MAPPED: {key} → {r}")
            for lang, table in (("he", he_res), ("en", en_res)):
                if r not in table:
                    if lang == "en":
                        p.warn(f"NO values-en FOR {r}")
                    continue
                txt = table[r]
                pos = positional_args(txt)
                lit = set(BRACE_NAME.findall(txt))
                if pos:
                    if len(pos) != len(names) or pos != list(range(1, len(pos) + 1)):
                        p.error(f"PLACEHOLDER COUNT MISMATCH: {key} → {r} ({lang}) has {len(pos)} args {pos}, registry {names}")
                elif lit:
                    if lit != set(names):
                        p.error(f"PLACEHOLDER COUNT MISMATCH: {key} → {r} ({lang}) has literal {sorted(lit)}, registry {names}")
                elif names:
                    p.error(f"PLACEHOLDER COUNT MISMATCH: {key} → {r} ({lang}) has no args, registry {names}")

        # Web keys: exist, mapped once, placeholders agree (after rename)
        web_refs: List[Tuple[str, Dict[str, str]]] = []
        for w in web:
            if isinstance(w, str):
                web_refs.append((w, {}))
            else:
                web_refs.append((w["key"], dict(w.get("rename", {}))))
        for wk, rename in web_refs:
            if wk in web_owner:
                p.error(f"WEB KEY MAPPED TWICE: {wk} → {web_owner[wk]}, {key}")
            web_owner[wk] = key
            found = False
            for where, table in (("kiosks.preview", preview_he), ("LIVE", live), ("en.json kiosks.preview", preview_en)):
                if wk in table:
                    found = True
                    got = [rename.get(x, x) for x in web_names(table[wk])]
                    if set(got) != set(names) or len(set(got)) != len(names):
                        p.error(f"PLACEHOLDER COUNT MISMATCH: {key} → web {where}.{wk} has {got}, registry {names}")
            if not found:
                p.warn(f"WEB KEY NOT FOUND (not in kiosks.preview nor LIVE): {key} → {wk}")

        def web_text(table: Dict[str, str]) -> Optional[str]:
            for wk, rename in web_refs:
                if wk in table:
                    s = table[wk]
                    for a, b in rename.items():
                        s = s.replace("{" + a + "}", "{" + b + "}")
                    return s
            return None

        # defaults
        he_src = ""
        if legacy and key in builtin_he:
            he, he_src = builtin_he[key], "he.json kiosks.builtin"
        elif android and android[0] in he_res:
            he, he_src = to_named(he_res[android[0]], names), f"values/{android[0]}"
        elif web_text(preview_he) is not None:
            he, he_src = web_text(preview_he), "he.json kiosks.preview"
        elif web_text(live) is not None:
            he, he_src = web_text(live), "i18n.ts LIVE"
        else:
            he = t.get("he", "")
            he_src = "meta"

        en_src = ""
        if t.get("enOverride"):
            en, en_src = t["enOverride"], "meta (override)"
            en_written.append((key, en, "override: " + t.get("enOverrideWhy", "")))
        elif legacy and key in builtin_en:
            en, en_src = builtin_en[key], "en.json kiosks.builtin"
        elif android and android[0] in en_res:
            en, en_src = to_named(en_res[android[0]], names), f"values-en/{android[0]}"
        elif web_text(preview_en) is not None:
            en, en_src = web_text(preview_en), "en.json kiosks.preview"
        elif t.get("en"):
            en, en_src = t["en"], "meta"
            en_written.append((key, en, "none existed"))
        else:
            en = ""

        for lang, val in (("he", he), ("en", en)):
            if not val:
                p.error(f"EMPTY DEFAULT: {key} ({lang})")
                continue
            got = set(BRACE_NAME.findall(val))
            unknown = got - set(names)
            if unknown:
                p.error(f"UNKNOWN PLACEHOLDER NAME: {key} ({lang}) default uses {sorted(unknown)}, registry {names}")
            missing = set(names) - got
            if missing:
                p.warn(f"PLACEHOLDER NOT IN DEFAULT: {key} ({lang}) lacks {sorted(missing)}")
        if t.get("en") and en_src != "meta" and not t.get("enOverride"):
            p.warn(f"META en IGNORED (a source text exists): {key}")

        # Hebrew of Android vs web, for the report
        for r in android:
            if r in he_res:
                a = to_named(he_res[r], names)
                if legacy and key in builtin_he and builtin_he[key] != a:
                    he_android_web_diffs.append((key, r, a, "builtin: " + builtin_he[key]))
                for wk, rename in web_refs:
                    for where, table in (("preview", preview_he), ("LIVE", live)):
                        if wk in table:
                            s = table[wk]
                            for x, y in rename.items():
                                s = s.replace("{" + x + "}", "{" + y + "}")
                            if s != a:
                                he_android_web_diffs.append((key, r, a, f"{where}.{wk}: {s}"))

        # max
        longest = max(len(he), len(en))
        if t.get("auto"):
            mx = rule_max(100, longest)
        else:
            mx = int(t["max"])
        if mx > MAX_CAP:
            p.error(f"MAX ABOVE {MAX_CAP}: {key} → {mx}")
        for lang, val in (("he", he), ("en", en)):
            if len(val) > mx:
                p.error(f"DEFAULT LONGER THAN MAX: {key} ({lang}) {len(val)} > {mx}")
        if mx < min(MAX_CAP, math.ceil(longest * 1.5)):
            p.warn(f"MAX BELOW 1.5× THE LONGEST DEFAULT: {key} max {mx}, longest {longest}")

        label = t["label"]
        if len(label) > 40:
            p.error(f"LABEL LONGER THAN 40: {key} ({len(label)})")

        item: Dict[str, object] = {
            "key": key,
            "group": t["group"],
            "label": label,
            "defaults": {"he": he, "en": en},
            "max": mx,
            "placeholders": names,
            "android": android,
            "web": web,
            "legacy": legacy,
        }
        if t.get("shownWhen"):
            item["shownWhen"] = t["shownWhen"]

        # order: group, then source order (Android file/line; else TEXT_KEYS; else the web's order)
        if android and android[0] in order:
            rank: Tuple = (0,) + order[android[0]]
        elif legacy:
            rank = (1, text_key_rank[key], 0)
        elif web_refs:
            rank = (2, web_order.get(web_refs[0][0], 10 ** 6), 0)
        else:
            rank = (3, 0, 0)
        item["_rank"] = (group_rank.get(t["group"], 999),) + rank + (key,)
        item["_src"] = (he_src, en_src)
        out_texts.append(item)

    out_texts.sort(key=lambda x: x["_rank"])  # type: ignore[arg-type, return-value]

    # ── in-scope resources nobody took (would be a bug in this script) and the left-out ones
    for name in in_scope:
        if name not in android_owner and name not in scope.get("leaveOut", {}):
            p.error(f"IN-SCOPE RESOURCE WITHOUT A TEXT: {name}")
    for name in scope.get("leaveOut", {}):
        if name not in he_res:
            p.error(f"ANDROID RESOURCE DOES NOT EXIST: scope.leaveOut → {name}")
    unreferenced_left = [n for n in sorted(he_res, key=lambda n: order[n])
                         if not excluded(n) and n not in referenced and not included_unreferenced(n)]

    # ── the web screens' own lookups (m.t('key') / t('key')) that no registry key replaces
    web_used: Dict[str, set] = {}
    for pattern in src.get("webScreens", []):
        for path in sorted(glob.glob(os.path.join(server_root, pattern))):
            for mm in re.finditer(r"\bt\(\s*['\"]([\w.]+)['\"]", open(path, encoding="utf-8").read()):
                web_used.setdefault(mm.group(1), set()).add(os.path.basename(path))
    web_ignore: Dict[str, str] = meta.get("webIgnore", {})
    web_unmapped = sorted(k for k in web_used if k not in web_owner and k not in web_ignore)
    for k in web_unmapped:
        p.warn(f"WEB KEY NOT MAPPED: {k} ({', '.join(sorted(web_used[k]))}) — add it to a text's web, or to webIgnore")

    # ── write the registry
    registry = {
        "version": 1,
        "languages": meta.get("languages", ["he", "en", "ar", "ru"]),
        "placeholders": vocabulary,
        "groups": [
            {k: v for k, v in (("id", g["id"]), ("kind", g["kind"]), ("label", g["label"]), ("shownWhen", g.get("shownWhen")))
             if v is not None}
            for g in groups
        ],
        "texts": [{k: v for k, v in x.items() if not k.startswith("_")} for x in out_texts],
    }
    with open(os.path.join(out_dir, "kiosk_text_registry.json"), "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(registry, ensure_ascii=False, indent=2) + "\n")

    # ── report
    counts = {g: 0 for g in group_ids}
    for x in out_texts:
        counts[x["group"]] = counts.get(x["group"], 0) + 1  # type: ignore[index]
    legacy_n = sum(1 for x in out_texts if x["legacy"])
    lines: List[str] = []
    w = lines.append
    w("# Kiosk text registry — report")
    w("")
    w("Generated by `gen_registry.py` from the sources and `registry_meta.json` (do not edit by hand).")
    w("")
    w(f"- Texts: **{len(out_texts)}** in {len(groups)} groups")
    w(f"- Legacy (TEXT_KEYS) keys: **{legacy_n}** of {len(text_keys)} TEXT_KEYS")
    w(f"- Android resources mapped: {len(android_owner)}; web keys mapped: {len(web_owner)}")
    w(f"- en.json: {'read' if en_msgs is not None else '**does not exist** — English comes from values-en, else from the meta'}")
    w("")
    w("## Count per group")
    w("")
    w("| # | group | kind | label | texts |")
    w("|---|---|---|---|---|")
    for i, g in enumerate(groups, 1):
        w(f"| {i} | `{g['id']}` | {g['kind']} | {g['label']['he']} / {g['label']['en']} | {counts.get(g['id'], 0)} |")
    w("")

    def keylist(items: List[dict]) -> str:
        return ", ".join(f"`{x['key']}`" for x in items) if items else "—"

    android_only = [x for x in out_texts if x["android"] and not x["web"] and not x["legacy"]]
    web_only = [x for x in out_texts if not x["android"] and not x["legacy"]]
    legacy_no_android = [x for x in out_texts if not x["android"] and x["legacy"]]
    w("## Android-only keys")
    w("")
    w(f"Not legacy and no web key mapped ({len(android_only)}): " + keylist(android_only))
    w("")
    w("## Web-only keys")
    w("")
    w(f"No Android resource, not legacy ({len(web_only)}): " + keylist(web_only))
    w("")
    w(f"Legacy keys with no Android resource (`\"android\": []`) ({len(legacy_no_android)}): " + keylist(legacy_no_android))
    w("")
    w("## Web mapping")
    w("")
    w("The `m.t()` / `t()` keys (kiosks.preview, then the Windows kiosk's LIVE) each registry key replaces:")
    w("")
    w("| web key | where | registry key |")
    w("|---|---|---|")
    for wk in sorted(web_owner, key=lambda k: (web_order.get(k, 10 ** 6), k)):
        where = " + ".join(x for x, tbl in (("preview", preview_he), ("LIVE", live)) if wk in tbl) or "not found"
        w(f"| `{wk}` | {where} | `{web_owner[wk]}` |")
    w("")
    w("## Hebrew defaults that differ between Android and web (for information)")
    w("")
    w("The registry's Hebrew default is the first of: he.json `kiosks.builtin` (legacy key), the Android text, the web text.")
    w("")
    w("| key | Android resource | Android (named) | web |")
    w("|---|---|---|---|")
    for key, r, a, wtxt in he_android_web_diffs:
        w(f"| `{key}` | `{r}` | {md_cell(a)} | {md_cell(wtxt)} |")
    w("")
    w("## English texts written by hand (registry_meta.json)")
    w("")
    w("| key | English | why |")
    w("|---|---|---|")
    for key, en, why in sorted(en_written):
        w(f"| `{key}` | {md_cell(en)} | {md_cell(why)} |")
    w("")
    w("## Android strings left out")
    w("")
    w("Defined in the source files, not staff, but not referenced in the kiosk code (`R.string.<name>`), so not in the registry:")
    w("")
    w(", ".join(f"`{n}`" for n in unreferenced_left) or "—")
    w("")
    if scope.get("leaveOut"):
        w("Referenced but left out by hand (`scope.leaveOut`):")
        w("")
        for n, why in scope["leaveOut"].items():
            w(f"- `{n}` — {why}")
        w("")
    w("## Web lookups left out")
    w("")
    w("Looked up by the web screens (`sources.webScreens`) but not customer texts (`webIgnore`); dynamic keys "
      "(`diet.${tag}`, `day${n}`) are mapped by their expanded names:")
    w("")
    for k, why in web_ignore.items():
        w(f"- `{k}` — {why}")
    if web_unmapped:
        w("")
        w("Not mapped and not ignored: " + ", ".join(f"`{k}`" for k in web_unmapped))
    w("")
    w("## Automatic entries (NO META)")
    w("")
    w(", ".join(f"`{n}`" for n in p.no_meta) or "—")
    w("")
    if meta.get("notes"):
        w("## Decisions and open points")
        w("")
        for note in meta["notes"]:
            w(f"- {note}")
        w("")
    w("## Warnings")
    w("")
    for msg in p.warnings or ["—"]:
        w(f"- {msg}")
    w("")
    w("## Errors")
    w("")
    for msg in p.errors or ["—"]:
        w(f"- {msg}")
    w("")
    with open(os.path.join(out_dir, "report.md"), "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines))

    for msg in p.warnings:
        print(f"WARN: {msg}")
    for msg in p.errors:
        print(f"ERROR: {msg}", file=sys.stderr)
    print(f"{len(out_texts)} texts, {legacy_n}/{len(text_keys)} legacy, {len(p.no_meta)} without meta, "
          f"{len(p.warnings)} warnings, {len(p.errors)} errors")
    return 1 if p.errors else 0


if __name__ == "__main__":
    sys.exit(main())
