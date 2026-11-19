const $ = id => document.getElementById(id);
const DAY = 86_400_000;
const LIMIT = 10_000;
const TYPING_PAUSE = 1_000;
const OVERTIME_LIMIT = 3_000;
const FIRST = Date.parse("2026-11-17T00:00:00Z") / DAY;
const roundCount = 20;
const mediumSlots = [3, 8, 13, 18];
const iso = day => new Date(day * DAY).toISOString().slice(0, 10);
const today = () => Math.floor(Date.now() / DAY);
const firstArchiveDay = current => Math.min(FIRST, current - 2);
const gameNumber = day => day - FIRST + 1;
const gameLabel = day => day >= FIRST ? "#" + gameNumber(day) : "Practice · " + iso(day);
const gameQuery = day => day >= FIRST ? "?g=" + gameNumber(day) : "?d=" + iso(day);
const normalized = value => value.normalize("NFKD").toLowerCase()
  .replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]/gu, "");
const savePrefix = "speedfishing:v1:";
const key = day => savePrefix + iso(day);
const count = outcomes => outcomes.filter(outcome => outcome === "caught").length;
const batchCache = new Map();
let selected = today();
let deck = [];
let state;
let practice = false;
let view = "home";
let loadId = 0;
let timer, transition;
let typingUntil = 0;

function read(day) {
  try {
    const saved = JSON.parse(localStorage.getItem(key(day)));
    if (Array.isArray(saved?.outcomes) && saved.outcomes.length <= roundCount &&
      saved.outcomes.every(value => ["caught", "passed", "expired"].includes(value)) &&
      (saved.deadline === null || Number.isFinite(saved.deadline))) return saved;
  } catch { /* Storage is optional. */ }
  return null;
}

function save() {
  if (!practice) {
    try { localStorage.setItem(key(selected), JSON.stringify(state)); } catch { /* Play in memory. */ }
  }
}

function show(id) {
  clearTimeout(timer);
  clearTimeout(transition);
  view = id;
  for (const name of ["home", "game", "results", "archive", "stats"]) $(name).hidden = name !== id;
  const nav = id === "stats" || id === "archive" ? id : selected === today() ? "daily" : "archive";
  for (const name of ["daily", "archive", "stats"]) {
    if (name === nav) $(name + "-nav").setAttribute("aria-current", "page");
    else $(name + "-nav").removeAttribute("aria-current");
  }
  window.scrollTo(0, 0);
}

async function loadCards(name, optional = false) {
  if (!batchCache.has(name)) {
    const response = await fetch("data/" + name + ".json");
    if (response.status === 404 && optional) return null;
    if (!response.ok) throw Error("Missing set");
    batchCache.set(name, await response.json());
  }
  return batchCache.get(name);
}

function shuffled(pool, seed) {
  const cards = [...pool];
  for (let i = cards.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = Math.floor(seed / 4294967296 * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

async function dailyDeck(day, mixed) {
  const offset = day - FIRST;
  const starter = offset >= 0 && offset < 3;
  const scheduled = await loadCards(iso(day), !starter);
  // The publisher already places the medium articles in its dated sets.
  if (!starter && scheduled) return scheduled;
  const group = (offset % 3 + 3) % 3;
  const seed = Math.floor(offset / 3) ^ 0x91e10da5;
  let cards = scheduled;
  if (!cards) {
    const pools = await Promise.all([0, 1, 2].map(i => loadCards(iso(FIRST + i))));
    cards = shuffled(pools.flat(), seed).slice(group * roundCount, (group + 1) * roundCount);
  }
  if (!mixed) return cards;
  const medium = shuffled(await loadCards("medium"), seed);
  const deck = [...cards];
  mediumSlots.forEach((slot, i) => { deck[slot] = medium[group * mediumSlots.length + i]; });
  return deck;
}

function dayFromUrl() {
  const params = new URLSearchParams(location.search);
  const current = today();
  const number = params.get("g") ?? params.get("game");
  if (/^[1-9]\d*$/.test(number)) {
    const day = FIRST + Number(number) - 1;
    if (day <= current) return day;
  }
  const date = params.get("d") ?? params.get("date");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return current;
  const day = Date.parse(date + "T00:00:00Z") / DAY;
  return day >= firstArchiveDay(current) && day <= current && iso(day) === date ? day : current;
}

async function openDay(day) {
  const url = new URL(location.href);
  for (const param of ["view", "g", "game", "d", "date"]) url.searchParams.delete(param);
  if (day !== today()) {
    for (const [key, value] of new URLSearchParams(gameQuery(day))) url.searchParams.set(key, value);
  }
  if (url.href !== location.href) history.replaceState(null, "", url);
  const request = ++loadId;
  selected = day;
  practice = false;
  // Existing attempts resume against the exact deck they started.
  state = read(day) || { outcomes: [], deadline: null, mixed: true };
  show("home");
  $("error").hidden = true;
  $("issue-label").textContent = gameLabel(day);
  $("start").disabled = true;
  $("start").textContent = "Loading…";
  try {
    const cards = await dailyDeck(day, state.mixed);
    if (request !== loadId) return;
    deck = cards;
    $("start").textContent = state.outcomes.length === roundCount ? "View result" :
      state.deadline || state.outcomes.length ? "Resume game" : "Start fishing";
    $("start").disabled = false;
  } catch {
    if (request !== loadId) return;
    $("error").textContent = "The clues couldn’t load. Refresh the page to try again.";
    $("error").hidden = false;
  }
}

function roundDeadline() {
  return Math.max(state.deadline, typingUntil);
}

function tick(now = Date.now()) {
  clearTimeout(timer);
  if (now >= roundDeadline()) return finish("expired");
  const left = state.deadline - now;
  if (left > 0) {
    $("clock").textContent = Math.ceil(left / 1000) + "s";
    timer = setTimeout(tick, left % 1000 || 1000);
  } else {
    const overtimeLeft = state.deadline + OVERTIME_LIMIT - now;
    $("clock").textContent = "Overtime · " + Math.ceil(overtimeLeft / 1000) + "s";
    const hint = "Keep typing!";
    if ($("feedback").textContent !== hint) $("feedback").textContent = hint;
    timer = setTimeout(tick, Math.min(overtimeLeft % 1000 || 1000, typingUntil - now));
  }
}

function startRound() {
  if (state.outcomes.length === roundCount) return results();
  if (view !== "game") show("game");
  const card = deck[state.outcomes.length];
  $("round").textContent = "Article " + (state.outcomes.length + 1) + " / " + roundCount;
  $("clues").replaceChildren(...card.categories.map(category => {
    const li = document.createElement("li");
    li.textContent = category;
    return li;
  }));
  $("guess").value = "";
  delete $("guess").dataset.result;
  typingUntil = 0;
  $("guess").focus({ preventScroll:true });
  $("pass").disabled = false;
  $("feedback").textContent = "";
  state.deadline ??= Date.now() + LIMIT;
  save();
  tick();
}

function finish(outcome, now = Date.now()) {
  if (view !== "game" || state.deadline === null) return;
  if (now >= roundDeadline()) outcome = "expired";
  clearTimeout(timer);
  const card = deck[state.outcomes.length];
  state.outcomes.push(outcome);
  state.deadline = null;
  save();
  $("feedback").textContent = (outcome === "caught" ? "Caught! " : outcome === "passed" ? "Passed · " : "Time’s up · ") + card.title;
  $("pass").disabled = true;
  if (outcome === "caught") $("guess").dataset.result = "correct";
  if (outcome === "expired") {
    $("guess").dataset.result = "wrong";
    $("clock").textContent = "0s";
  }
  if (!document.hidden) transition = setTimeout(startRound, 1400);
}

function checkGuess(now = Date.now()) {
  if (state.deadline === null) return;
  if (now >= roundDeadline()) return finish("expired", now);
  const card = deck[state.outcomes.length];
  const guess = normalized($("guess").value);
  if ([card.title, ...card.aliases].some(answer => normalized(answer) === guess)) finish("caught", now);
}
// Keep the field editable so a phone can keep its keyboard open during the reveal.
$("guess").addEventListener("beforeinput", event => {
  if (state.deadline === null) event.preventDefault();
});
$("guess").addEventListener("input", event => {
  if (state.deadline === null) return;
  const now = Date.now();
  if (now >= roundDeadline()) return finish("expired", now);
  if ($("guess").dataset.result === "wrong") {
    delete $("guess").dataset.result;
    $("feedback").textContent = "";
  }
  // A guess must already be underway at the buzzer. Allow corrections once in overtime.
  if (now >= state.deadline || normalized($("guess").value)) {
    typingUntil = Math.min(now + TYPING_PAUSE, state.deadline + OVERTIME_LIMIT);
  } else {
    typingUntil = 0;
  }
  if (now >= state.deadline) tick(now);
  if (!event.isComposing) checkGuess(now);
});
$("guess").addEventListener("compositionend", () => checkGuess());
$("guess").addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.isComposing && state.deadline !== null) {
    event.preventDefault();
    checkGuess();
    if (state.deadline !== null) {
      $("feedback").textContent = "Try another guess.";
      if ($("guess").value.trim()) $("guess").dataset.result = "wrong";
      $("guess").select();
    }
  }
});
document.addEventListener("visibilitychange", () => {
  if (view !== "game") return;
  clearTimeout(transition);
  clearTimeout(timer);
  if (!document.hidden) {
    if (state.deadline !== null) tick();
    else transition = setTimeout(startRound, 1400);
  }
});

function results() {
  show("results");
  $("answers").open = false;
  $("result-label").textContent = gameLabel(selected);
  $("final-score").textContent = count(state.outcomes);
  $("share-status").textContent = "";
  $("review").replaceChildren(...deck.map((card, i) => {
    const li = document.createElement("li");
    const mark = document.createElement("span");
    mark.className = "symbol";
    const outcome = state.outcomes[i];
    mark.textContent = outcome === "caught" ? "✓" : outcome === "passed" ? "→" : "×";
    mark.setAttribute("aria-label", outcome);
    const link = document.createElement("a");
    link.href = card.url;
    link.textContent = card.title;
    li.append(mark, link);
    return li;
  }));
}

function archive() {
  ++loadId;
  show("archive");
  $("error").hidden = true;
  $("days").replaceChildren();
  let cursor = today() - 1;
  // On a clock set before the first published issue, still offer practice sets.
  const first = firstArchiveDay(today());
  function more() {
    const until = Math.max(first, cursor - 6);
    for (; cursor >= until; cursor--) {
      const day = cursor;
      const li = document.createElement("li");
      const button = document.createElement("button");
      const label = document.createElement("span");
      const score = read(day)?.outcomes;
      label.className = "meta";
      label.textContent = score?.length === roundCount ? count(score) + "/20" : "Play";
      button.title = iso(day);
      button.append(gameLabel(day), label);
      button.onclick = () => openDay(day);
      li.append(button);
      $("days").append(li);
    }
    if (cursor >= first) {
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.textContent = "Older games";
      button.onclick = () => { li.remove(); more(); };
      li.append(button);
      $("days").append(li);
    }
  }
  more();
}
function completedGames() {
  const games = [];
  for (const savedKey of Object.keys(localStorage)) {
    if (!savedKey.startsWith(savePrefix)) continue;
    const date = savedKey.slice(savePrefix.length);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const day = Date.parse(date + "T00:00:00Z") / DAY;
    if (!Number.isFinite(day) || iso(day) !== date) continue;
    const saved = read(day);
    if (saved?.outcomes.length === roundCount) {
      const score = count(saved.outcomes);
      const passed = saved.outcomes.filter(outcome => outcome === "passed").length;
      games.push({ day, score, passed, expired: roundCount - score - passed });
    }
  }
  return games.sort((a, b) => b.day - a.day);
}

function renderStats() {
  let games;
  try {
    games = completedGames();
  } catch {
    $("stats-content").hidden = true;
    $("stats-play").hidden = false;
    $("stats-note").hidden = false;
    $("stats-note").textContent = "This browser’s saved results are unavailable.";
    return;
  }
  $("stats-content").hidden = games.length === 0;
  $("stats-play").hidden = games.length > 0;
  $("stats-note").hidden = games.length > 0;
  $("stats-note").textContent = "Finish a game to see your stats.";
  if (!games.length) return;

  const frequencies = Array(roundCount + 1).fill(0);
  let total = 0, passes = 0, best = 0;
  for (const { score, passed } of games) {
    total += score;
    passes += passed;
    best = Math.max(best, score);
    frequencies[score]++;
  }
  $("stat-games").textContent = games.length;
  $("stat-average").textContent = (total / games.length).toFixed(1);
  $("stat-best").textContent = best;
  $("total-caught").textContent = total;
  $("total-passed").textContent = passes;
  $("total-expired").textContent = games.length * roundCount - total - passes;

  const peak = Math.max(...frequencies);
  const descriptions = [];
  $("score-chart").replaceChildren(...frequencies.map((frequency, score) => {
    const bin = document.createElement("div");
    const bar = document.createElement("span");
    bar.className = "score-bar";
    bar.style.height = (100 * frequency / peak) + "%";
    if (frequency) {
      bar.dataset.count = frequency;
      bin.title = frequency + (frequency === 1 ? " game" : " games") + " at " + score + "/20";
      descriptions.push(bin.title);
    }
    const tick = document.createElement("span");
    tick.className = "score-tick";
    if (frequency || score % 5 === 0) tick.textContent = score;
    bin.append(bar, tick);
    return bin;
  }));
  $("score-chart").setAttribute("aria-label", descriptions.join(". "));

  function historyRow({ day, score, passed, expired }) {
    const row = document.createElement("tr");
    const label = document.createElement("th");
    label.scope = "row";
    const link = document.createElement("a");
    link.href = gameQuery(day);
    link.textContent = gameLabel(day);
    link.title = iso(day);
    label.append(link);
    row.append(label);
    for (const value of [score, passed, expired]) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    return row;
  }
  $("recent-games").replaceChildren(...games.slice(0, 7).map(historyRow));
  const older = $("older-games");
  const more = $("more-history");
  more.hidden = games.length <= 7;
  function showOlder(expanded) {
    older.hidden = !expanded;
    older.replaceChildren(...(expanded ? games.slice(7).map(historyRow) : []));
    more.setAttribute("aria-expanded", String(expanded));
    more.textContent = expanded ? "Show recent only" : "Show all " + games.length + " games";
  }
  showOlder(!more.hidden && !older.hidden);
  more.onclick = () => showOlder(older.hidden);
}
$("start").onclick = startRound;
$("pass").onclick = () => {
  $("guess").focus({ preventScroll:true });
  finish("passed");
};
$("again").onclick = () => {
  practice = true;
  state = { outcomes: [], deadline:null };
  startRound();
};
$("share").onclick = async () => {
  const squares = state.outcomes.map(outcome => outcome === "caught" ? "🟦" : "⬜");
  const link = selected === today() ? "speedfishing.net" : "speedfishing.net/" + gameQuery(selected);
  const report = link + " · " + gameLabel(selected) + (practice ? " (replay)" : "") + "\n" +
    count(state.outcomes) + "/20 🎣\n" + squares.slice(0,10).join("") + "\n" + squares.slice(10).join("");
  try {
    await navigator.clipboard.writeText(report);
    $("share-status").textContent = "Copied to clipboard.";
  } catch { $("share-status").textContent = report; }
};

const initialView = new URLSearchParams(location.search).get("view");
if (initialView === "stats") {
  document.title = "Stats — Speedfishing";
  show("stats");
  renderStats();
  window.addEventListener("storage", event => {
    if (event.key === null || event.key.startsWith(savePrefix)) renderStats();
  });
  window.addEventListener("pageshow", event => { if (event.persisted) renderStats(); });
} else if (initialView === "archive") {
  archive();
} else {
  openDay(dayFromUrl());
}
