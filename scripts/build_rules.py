#!/usr/bin/env python3
"""Download the official Magic: The Gathering Comprehensive Rules (TXT) from Wizards of the Coast and write rules.json
for the app: sections > subsections > rules (with their examples), plus the glossary.
Run by .github/workflows/rules.yml (weekly). Uses only the Python standard library."""
import json, re, sys, urllib.request, urllib.parse, datetime

PAGE = "https://magic.wizards.com/en/rules"
UA = {"User-Agent": "mtg-binder-rules-updater (github.com/ShaunMcCabe-78/mtg-binder)"}

def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
        return r.read()

def find_txt_url(html):
    m = re.findall(r'https://media\.wizards\.com/[^"\'<>]*?MagicCompRules[^"\'<>]*?\.txt', html)
    if not m: raise SystemExit("No TXT link found on " + PAGE)
    return m[0].replace(" ", "%20")

def decode(raw):
    for enc in ("utf-8-sig", "cp1252"):
        try: return raw.decode(enc)
        except UnicodeDecodeError: pass
    return raw.decode("utf-8", "replace")

SEC = re.compile(r"^([1-9])\. (.+)$")
SUB = re.compile(r"^(\d{3})\. (.+)$")
RULE = re.compile(r"^(\d{3}\.\d+[a-z]?)\.? (.+)$")

def parse(text):
    lines = [l.strip() for l in text.replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    eff = next((m.group(1) for l in lines for m in [re.search(r"effective as of (.+?)\.?$", l)] if m), "")
    # The body starts at the second "1. Game Concepts" (the first is in the contents list).
    starts = [i for i, l in enumerate(lines) if SEC.match(l) and l.startswith("1. ")]
    if len(starts) < 2: raise SystemExit("Unexpected format: body not found")
    i = starts[1]
    gl = [k for k, l in enumerate(lines) if l == "Glossary"]
    cr = [k for k, l in enumerate(lines) if l == "Credits"]
    body_end = gl[-1] if gl else len(lines)
    sections, sec, sub, rule = [], None, None, None
    for l in lines[i:body_end]:
        if not l: continue
        if (m := SEC.match(l)) and len(l) < 60:
            sec = [m.group(1), m.group(2), []]; sections.append(sec); sub = rule = None; continue
        if (m := SUB.match(l)) and sec is not None and len(l) < 90:
            sub = [m.group(1), m.group(2), []]; sec[2].append(sub); rule = None; continue
        if (m := RULE.match(l)) and sub is not None:
            rule = [m.group(1), m.group(2), []]; sub[2].append(rule); continue
        if l.startswith("Example:") and rule is not None:
            rule[2].append(l[len("Example:"):].strip()); continue
        if rule is not None:   # a continuation line
            if rule[2]: rule[2][-1] += " " + l
            else: rule[1] += " " + l
    glossary = []
    if gl:
        end = cr[-1] if cr and cr[-1] > gl[-1] else len(lines)
        block, cur = lines[gl[-1] + 1:end], []
        for l in block + [""]:
            if l: cur.append(l)
            elif cur: glossary.append([cur[0], " ".join(cur[1:])]); cur = []
    n_rules = sum(len(s2[2]) for s in sections for s2 in s[2])
    if len(sections) < 9 or n_rules < 2000: raise SystemExit(f"Unexpected format: {len(sections)} sections, {n_rules} rules")
    return {"effective": eff, "sections": sections, "glossary": glossary}

def main():
    url = sys.argv[1] if len(sys.argv) > 1 else find_txt_url(decode(get(PAGE)))
    data = parse(decode(get(url)))
    data["source"] = urllib.parse.unquote(url)
    data["checked"] = datetime.date.today().isoformat()
    # Keep the file stable when only the check date changed (so it isn't re-committed every week).
    try:
        old = json.load(open("rules.json", encoding="utf-8"))
        if {k: v for k, v in old.items() if k != "checked"} == {k: v for k, v in data.items() if k != "checked"}:
            print("Rules unchanged:", data["effective"]); return
    except (OSError, ValueError): pass
    json.dump(data, open("rules.json", "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    print("Wrote rules.json:", data["effective"], len(data["sections"]), "sections,", len(data["glossary"]), "glossary terms")

if __name__ == "__main__":
    main()
