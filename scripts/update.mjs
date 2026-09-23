// Pulls conference records from ESPN and writes data.json for the leaderboard.
// Run: node scripts/update.mjs   (Node 18+, no dependencies)
import { readFile, writeFile } from "node:fs/promises";

const league = JSON.parse(await readFile(new URL("../league.json", import.meta.url)));
const BASE = "https://site.api.espn.com/apis";
// ESPN conference group ids.
const GROUPS = { B1G: 5, SEC: 8, MAC: 15, ACC: 1 };

async function get(url) {
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 theknute" } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

// Standings: conference membership plus each team's conference record.
// Conferences may nest divisions under `children`, so walk the tree.
function standingsEntries(node, out = []) {
  if (node?.standings?.entries) out.push(...node.standings.entries);
  for (const c of node?.children || []) standingsEntries(c, out);
  return out;
}
function confRecord(entry) {
  const s = (entry.stats || []).find(s =>
    (s.type === "vsconf" || /conf/i.test(`${s.name} ${s.abbreviation} ${s.shortDisplayName}`))
    && /^\d+-\d+/.test(s.summary || s.displayValue || ""));
  if (!s) return null;
  const [w, l] = (s.summary || s.displayValue).split("-").map(Number);
  return { w, l };
}

const members = {};   // conf -> Set(teamId)
const standing = {};  // teamId -> {w,l}
for (const conf of league.conferences) {
  members[conf] = new Set();
  try {
    const data = await get(`${BASE}/v2/sports/football/college-football/standings?season=${league.season}&group=${GROUPS[conf]}`);
    const entries = standingsEntries(data);
    for (const e of entries) {
      const id = String(e.team?.id);
      members[conf].add(id);
      const r = confRecord(e);
      if (r) standing[id] = r;
    }
    console.log(`${conf}: ${entries.length} teams in standings`);
    if (entries[0]) console.log(`  sample stats: ${(entries[0].stats || []).map(s => `${s.name}/${s.type}=${s.summary ?? s.displayValue}`).join(", ")}`);
  } catch (e) {
    console.log(`${conf}: standings failed (${e.message})`);
  }
}

const teams = {};
for (const p of league.players) {
  for (const [j, [name, id]] of p.teams.entries()) {
    const conf = league.conferences[j];
    const t = { name, conf, w: 0, l: 0, games: [], espnName: null, error: null };
    try {
      const data = await get(`${BASE}/site/v2/sports/football/college-football/teams/${id}/schedule?season=${league.season}`);
      t.espnName = data.team?.displayName || null;
      for (const ev of data.events || []) {
        const comp = ev.competitions?.[0];
        if (!comp) continue;
        const us = comp.competitors?.find(c => String(c.team?.id) === String(id));
        const them = comp.competitors?.find(c => c !== us);
        if (!us || !them) continue;
        const inConf = comp.conferenceCompetition === true || members[conf].has(String(them.team?.id));
        if (!inConf) continue;
        const isTitle = (comp.notes || []).some(n => /championship/i.test(n.headline || ""));
        if (isTitle && !league.countChampionshipGames) continue;
        const done = !!comp.status?.type?.completed;
        const score = c => c.score?.displayValue ?? c.score ?? "";
        t.games.push({
          date: ev.date,
          opp: them.team?.shortDisplayName || them.team?.displayName || "?",
          home: us.homeAway === "home",
          done,
          win: done && us.winner === true,
          loss: done && us.winner === false,
          score: done ? `${score(us)}-${score(them)}` : "",
        });
      }
      t.games.sort((a, b) => a.date.localeCompare(b.date));
      t.w = t.games.filter(g => g.win).length;
      t.l = t.games.filter(g => g.loss).length;
    } catch (e) {
      t.error = e.message;
    }
    // Standings' conference record is authoritative when present.
    const s = standing[String(id)];
    if (s && (s.w !== t.w || s.l !== t.l)) {
      console.log(`  ${name}: schedule says ${t.w}-${t.l}, standings say ${s.w}-${s.l} (using standings)`);
      Object.assign(t, s);
    }
    if (league.overrides[id] != null) t.w = league.overrides[id];
    if (!members[conf].has(String(id))) console.log(`  WARNING ${name} (${id}) not found in ${conf} standings`);
    console.log(`${p.name.padEnd(8)} ${conf} ${name.padEnd(18)} id=${id} espn="${t.espnName}" ${t.w}-${t.l}${t.error ? " ERROR " + t.error : ""}`);
    teams[id] = t;
  }
}

await writeFile(new URL("../data.json", import.meta.url),
  JSON.stringify({ updated: new Date().toISOString(), teams }, null, 1) + "\n");
console.log("wrote data.json");
