# Speedfishing game data

Each dated JSON file holds one daily game of 20 articles. Each article has a title, three Wikipedia categories, accepted aliases, and a source link. On dates without a scheduled game, the game draws from the starter sets and `medium.json`.

Run the following commands from the repository root.

## Collect candidates

Use your own contact email or project URL in the user agent so Wikimedia can reach you about API traffic.

```sh
export SPEEDFISHING_USER_AGENT='Speedfishing/1.0 (your-contact@example.org)'
python3 articles.py collect --limit 300
```

Collection starts with English Wikipedia’s most-read articles from the last complete month. To try a different month, run `python3 articles.py collect 2025-06 --limit 500`. Each monthly ranking has up to 1,000 titles. The importer skips known articles and keeps candidates with at least three visible categories after filtering out clues that repeat a title word.

The importer requests categories for up to 25 titles at a time, waits a second between requests, and backs off when Wikimedia is busy. Review and publishing work offline. [Wikimedia pageviews](https://doc.wikimedia.org/generated-data-platform/aqs/analytics-api/reference/page-views.html) · [MediaWiki categories](https://www.mediawiki.org/wiki/API:Categories) · [Wikimedia API etiquette](https://www.mediawiki.org/wiki/API:Etiquette)

## Review clues

```sh
python3 articles.py review
```

Choose three numbered categories in the order players should see them. Aim for clues that point to one familiar answer when read together. Enter `2 4 6` for an easy article or `m 2 4 6` for a medium one. At the next prompt, add any short names players should get credit for.

Enter `s` to skip an article or `q` to quit. Your decisions are saved in `articles.sqlite3` so you can resume later.

## Publish daily sets

```sh
python3 articles.py publish --days 7
```

The publisher shuffles approved, unused articles into `data/YYYY-MM-DD.json` files. Scheduling starts on the day after today (UTC) or the latest scheduled date, whichever is later.

A week at the starter mix takes 112 easy and 28 medium articles. Each day has medium picks at rounds 4, 9, 14, and 19. If fewer medium picks are available, the publisher spreads them across the week and fills the remaining slots with easy articles.
