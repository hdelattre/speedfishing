"""Collect, review, and schedule Speedfishing articles using the Python standard library."""

import argparse
import json
import os
import random
import re
import sqlite3
import sys
import tempfile
import time
import unicodedata
from datetime import date, datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
DAY = timedelta(days=1)
BATCH_SIZE = 25
SET_SIZE = 20
MEDIUM_SLOTS = (3, 8, 13, 18)
FILLER = set("a an the of in on at to by for from and or with as de du la le van von".split())
IRREGULAR = {"mice": "mouse", "men": "man", "women": "woman", "children": "child",
             "geese": "goose", "feet": "foot", "teeth": "tooth", "people": "person"}


def words(text):
    text = unicodedata.normalize("NFKD", text.casefold())
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = re.sub(r"['’]s\b", "", text)
    return re.findall(r"[^\W_]+", text)


def word_forms(word):
    forms = {word, IRREGULAR.get(word, word)}
    if len(word) > 3 and word.endswith("s") and not word.endswith(("ss", "us", "is")):
        forms.add(word[:-1])
        if word.endswith(("ches", "shes", "sses", "xes", "zes")):
            forms.add(word[:-2])
        if word.endswith("ies"):
            forms.add(word[:-3] + "y")
    return forms


def gives_away(title, clue, aliases=()):
    # A Wikipedia qualifier like "(1993 film)" is not part of the answer.
    name = re.sub(r"\s*\([^()]*\)$", "", title)
    parts = words(name)
    tokens = words(clue)
    clue_forms = set().union(*(word_forms(w) for w in tokens))
    if any(word_forms(w) & clue_forms for w in parts if w not in FILLER):
        return True
    # A multiword alias gives the answer away only when the phrase occurs together.
    for answer in (name, *aliases):
        phrase = words(answer)
        if phrase and any(all(word_forms(a) & word_forms(b) for a, b in zip(phrase, tokens[i:]))
                          for i in range(len(tokens) - len(phrase) + 1)):
            return True
    return False


def utc_today():
    return datetime.now(timezone.utc).date()


def fetch_json(url):
    agent = os.environ.get("SPEEDFISHING_USER_AGENT", "Speedfishing/1.0 (Wikipedia category trivia curator)")
    for attempt in range(4):
        time.sleep(1)
        try:
            with urlopen(Request(url, headers={"User-Agent": agent}), timeout=30) as response:
                data = json.load(response)
        except HTTPError as error:
            if error.code not in (429, 502, 503, 504) or attempt == 3:
                raise
            retry_after = error.headers.get("Retry-After", "")
            delay = 5 * 2**attempt
            if retry_after.isdigit():
                delay = int(retry_after)
            elif retry_after:
                try:
                    delay = max(0, parsedate_to_datetime(retry_after).timestamp() - time.time())
                except (ValueError, TypeError, OverflowError):
                    pass
            print(f"Wikimedia requested a retry. Waiting {delay}s.", file=sys.stderr)
            time.sleep(delay)
            continue
        if "error" not in data:
            return data
        if data["error"]["code"] != "maxlag" or attempt == 3:
            raise ValueError(data["error"].get("info", str(data["error"])))
        time.sleep(5 * 2**attempt)


def scheduled():
    used = {card["title"] for card in json.loads((DATA / "medium.json").read_text(encoding="utf-8"))}
    dates = []
    for path in DATA.glob("????-??-??.json"):
        dates.append(date.fromisoformat(path.stem))
        used.update(card["title"] for card in json.loads(path.read_text(encoding="utf-8")))
    return dates, used


def categories(titles):
    params = dict(action="query", format="json", formatversion=2, redirects=1, maxlag=5,
                  prop="categories|pageprops", ppprop="disambiguation", clshow="!hidden",
                  cllimit=500, titles="|".join(titles))
    found = {}
    while True:
        data = fetch_json("https://en.wikipedia.org/w/api.php?" + urlencode(params))
        for page in data["query"]["pages"]:
            if page["ns"] != 0 or "missing" in page or "disambiguation" in page.get("pageprops", {}):
                continue
            title = page["title"]
            clues = found.setdefault(title, [])
            for category in page.get("categories", []):
                clue = category["title"].removeprefix("Category:")
                if clue not in clues and not gives_away(title, clue):
                    clues.append(clue)
        if "continue" not in data:
            return found
        params.update(data["continue"])


def collect(db, args):
    month = datetime.strptime(args.month, "%Y-%m")
    endpoint = "https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access/"
    rows = fetch_json(endpoint + month.strftime("%Y/%m/all-days"))["items"][0]["articles"]
    _, known = scheduled()
    known.update(row[0] for row in db.execute("SELECT title FROM articles"))
    titles = []
    for row in rows:
        title = row["article"].replace("_", " ")
        if (title not in known and title != "Main Page" and ":" not in title and
                not title.startswith(("List of ", "Lists of ", "Deaths in "))):
            titles.append(title)
    added = 0
    for start in range(0, len(titles), BATCH_SIZE):
        for title, clues in categories(titles[start:start + BATCH_SIZE]).items():
            if title in known or len(clues) < 3:
                continue
            result = db.execute("INSERT OR IGNORE INTO articles(title, clues) VALUES (?, ?)",
                                (title, json.dumps(clues, ensure_ascii=False)))
            known.add(title)
            added += result.rowcount
            if added == args.limit:
                break
        db.commit()
        if added >= args.limit:
            break
    print(f"Added {added} candidates from {args.month}.")


def review(db):
    _, used = scheduled()
    for title, raw, status, chosen, aliases_json in db.execute(
            "SELECT title, clues, status, chosen, aliases FROM articles WHERE status!='skipped' ORDER BY rowid"):
        if title in used:
            continue
        if status == "ready" and not any(gives_away(title, c, json.loads(aliases_json)) for c in json.loads(chosen)):
            continue
        clues = [c for c in json.loads(raw) if not gives_away(title, c)]
        if len(clues) < 3:
            continue
        print(f"\n{title}")
        for i, clue in enumerate(clues, 1):
            print(f"  {i:2}. {clue}")
        while True:
            choice = input("Three clue numbers (prefix m for Medium), s to skip, q to quit: ").strip()
            if choice == "q":
                return
            if choice == "s":
                db.execute("UPDATE articles SET status='skipped' WHERE title=?", (title,))
                break
            parts = choice.replace(",", " ").split()
            difficulty = "easy"
            if parts and parts[0].lower() == "m":
                difficulty = "medium"
                parts = parts[1:]
            try:
                numbers = [int(part) for part in parts]
            except ValueError:
                numbers = []
            if len(numbers) == len(set(numbers)) == 3 and all(1 <= n <= len(clues) for n in numbers):
                aliases = [a.strip() for a in input("Accepted short names (comma-separated, optional): ").split(",") if a.strip()]
                selected = [clues[n - 1] for n in numbers]
                if any(gives_away(title, c, aliases) for c in selected):
                    print("A selected category contains an accepted answer. Choose different clues or adjust the aliases.")
                    continue
                db.execute("UPDATE articles SET status='ready', chosen=?, aliases=?, difficulty=? WHERE title=?",
                           (json.dumps(selected), json.dumps(aliases), difficulty, title))
                break
            print("Choose three different numbers from the list.")
        db.commit()
    print("Review queue empty.")


def publish(db, days):
    dates, used = scheduled()
    first = max([utc_today(), *dates]) + DAY
    easy, medium = [], []
    for title, chosen, aliases, difficulty in db.execute(
            "SELECT title, chosen, aliases, difficulty FROM articles WHERE status='ready'"):
        if title not in used:
            clues = json.loads(chosen)
            names = json.loads(aliases)
            if any(gives_away(title, clue, names) for clue in clues):
                continue
            url = "https://en.wikipedia.org/wiki/" + quote(title.replace(" ", "_"), safe="")
            pool = medium if difficulty == "medium" else easy
            pool.append(dict(title=title, categories=clues, aliases=names, url=url))
    medium_count = min(len(medium), days * len(MEDIUM_SLOTS))
    easy_needed = days * SET_SIZE - medium_count
    if len(easy) < easy_needed:
        raise ValueError(f"With {medium_count} medium picks, {days} day(s) need {easy_needed} easy articles. "
                         f"You have {len(easy)} approved.")
    random.shuffle(easy)
    random.shuffle(medium)
    for i in range(days):
        path = DATA / f"{first + DAY * i}.json"
        count = medium_count // days + (i < medium_count % days)
        slots = MEDIUM_SLOTS[:count]
        deck = [medium.pop() if slot in slots else easy.pop() for slot in range(SET_SIZE)]
        # Link a fully written file into place without replacing an existing game.
        with tempfile.NamedTemporaryFile(mode="w", dir=DATA, encoding="utf-8") as draft:
            json.dump(deck, draft, ensure_ascii=False, indent=2)
            draft.write("\n")
            draft.flush()
            os.link(draft.name, path)
        print(f"Scheduled {path.name}")


def positive(value):
    n = int(value)
    if n < 1:
        raise argparse.ArgumentTypeError("enter a positive number")
    return n


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    grab = commands.add_parser("collect", help="collect candidates from a month's most-read articles")
    previous = utc_today().replace(day=1) - DAY
    grab.add_argument("month", nargs="?", default=previous.strftime("%Y-%m"), help="YYYY-MM (default: last month)")
    grab.add_argument("--limit", type=positive, default=100, help="maximum new candidates (default: 100)")
    commands.add_parser("review", help="pick three categories and aliases for each article")
    deal = commands.add_parser("publish", help="write local game files starting after the last scheduled day")
    deal.add_argument("--days", type=positive, default=1)
    args = parser.parse_args()
    db = sqlite3.connect(ROOT / "articles.sqlite3")
    try:
        db.execute("""CREATE TABLE IF NOT EXISTS articles (
            title TEXT PRIMARY KEY, clues TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new',
            chosen TEXT, aliases TEXT)""")
        if "difficulty" not in {row[1] for row in db.execute("PRAGMA table_info(articles)")}:
            db.execute("ALTER TABLE articles ADD COLUMN difficulty TEXT NOT NULL DEFAULT 'easy'")
        if args.command == "collect":
            collect(db, args)
        elif args.command == "review":
            review(db)
        else:
            db.execute("BEGIN IMMEDIATE")
            publish(db, args.days)
            db.commit()
    finally:
        db.close()


if __name__ == "__main__":
    try:
        main()
    except (EOFError, KeyboardInterrupt):
        print("\nStopped.")
    except (URLError, OSError, ValueError, sqlite3.Error) as error:
        sys.exit(str(error))
