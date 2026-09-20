require('dotenv').config();
const { Telegraf } = require('telegraf');
const axios = require('axios');

const token = process.env.TELEGRAM_TOKEN;
const apiFootballKey = process.env.FOOTBALL_API_KEY;       // API-Football (x-apisports-key)
const footballDataKey = process.env.FOOTBALL_DATA_API_KEY; // football-data.org (X-Auth-Token)
const oddsApiKey = process.env.ODDSPAPI_API_KEY;           // OddsPapi (?apiKey=...)

const bot = new Telegraf(token);

console.log('Bot démarré...');

// ==================== CONFIG API-FOOTBALL (live, compo, blessures, joueur) ====================

const AF_BASE = 'https://v3.football.api-sports.io';
const AF_HEADERS = { 'x-apisports-key': apiFootballKey };

const AF_LEAGUES = {
  39: 'Premier League', 140: 'La Liga', 78: 'Bundesliga', 135: 'Serie A', 61: 'Ligue 1',
  2: 'Champions League', 3: 'Europa League', 848: 'Conference League', 88: 'Eredivisie',
  94: 'Primeira Liga', 40: 'Championship',
};

// Correspondance code football-data.org -> id ligue API-Football (mêmes 9 compétitions)
const FD_TO_AF_LEAGUE = { PL: 39, PD: 140, BL1: 78, SA: 135, FL1: 61, CL: 2, DED: 88, PPL: 94, ELC: 40 };

// ==================== CONFIG FOOTBALL-DATA.ORG (classement, buteurs, matchs, analyse) ====================

const FD_BASE = 'https://api.football-data.org/v4';
const FD_HEADERS = { 'X-Auth-Token': footballDataKey };

const FD_COMPETITIONS = ['PL', 'PD', 'BL1', 'SA', 'FL1', 'CL', 'DED', 'PPL', 'ELC'];
const FD_COMP_NAMES = {
  PL: 'Premier League', PD: 'La Liga', BL1: 'Bundesliga', SA: 'Serie A', FL1: 'Ligue 1',
  CL: 'Champions League', DED: 'Eredivisie', PPL: 'Primeira Liga', ELC: 'Championship',
};

// ==================== CONFIG ODDSPAPI (cotes des bookmakers) ====================

const ODDS_BASE = 'https://api.oddspapi.io/v4';
const ODDS_SOCCER_SPORT_ID = 10;

function normalize(str) {
  return str.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function findCompetition(name) {
  const query = normalize(name);
  const entry = Object.entries(FD_COMP_NAMES).find(([, n]) => normalize(n).includes(query));
  return entry ? { code: entry[0], name: entry[1] } : null;
}

// ==================== CACHE ÉQUIPES FOOTBALL-DATA.ORG (chargé au démarrage) ====================

let fdTeamsCache = [];

async function loadFDTeamsCache() {
  console.log('Chargement du cache des équipes (football-data.org)...');
  for (const comp of FD_COMPETITIONS) {
    try {
      const res = await axios.get(`${FD_BASE}/competitions/${comp}/teams`, { headers: FD_HEADERS });
      fdTeamsCache.push(...res.data.teams);
      await new Promise(r => setTimeout(r, 6500)); // respecte la limite 10 req/min
    } catch (err) {
      console.error(`Erreur chargement ${comp}:`, err.response?.data || err.message);
    }
  }
  console.log(`Cache football-data.org chargé : ${fdTeamsCache.length} équipes.`);
}

function findTeam(name) {
  const query = normalize(name);
  return fdTeamsCache.find(t =>
    normalize(t.name).includes(query) ||
    normalize(t.shortName || '').includes(query) ||
    normalize(t.tla || '').includes(query)
  ) || null;
}

// ==================== CACHE ÉQUIPES API-FOOTBALL (recherche à la demande) ====================

let afTeamsCache = {};

async function findAFTeam(name) {
  const query = normalize(name);
  const cached = Object.values(afTeamsCache).find(t => normalize(t.name).includes(query));
  if (cached) return cached;

  try {
    const cleanName = normalize(name); // API-Football rejette les accents/caractères spéciaux
    const res = await axios.get(`${AF_BASE}/teams`, { headers: AF_HEADERS, params: { search: cleanName } });
    console.log('DEBUG findAFTeam search="' + cleanName + '"', JSON.stringify(res.data.errors), 'results=' + res.data.results);
    const found = res.data.response?.[0]?.team;
    if (found) {
      afTeamsCache[normalize(found.name)] = found;
      return found;
    }
    return null;
  } catch (err) {
    console.error('Erreur recherche équipe AF:', err.response?.data || err.message);
    return null;
  }
}

// ==================== FOOTBALL-DATA.ORG : matchs, classement, buteurs ====================

async function getRecentMatches(teamId, limit = 5) {
  const res = await axios.get(`${FD_BASE}/teams/${teamId}/matches`, {
    headers: FD_HEADERS,
    params: { status: 'FINISHED', limit },
  });
  return res.data.matches || [];
}

async function getNextMatch(teamId) {
  const res = await axios.get(`${FD_BASE}/teams/${teamId}/matches`, {
    headers: FD_HEADERS,
    params: { status: 'SCHEDULED', limit: 1 },
  });
  return res.data.matches?.[0] || null;
}

async function getUpcomingFixtures(teamId, limit = 10) {
  const res = await axios.get(`${FD_BASE}/teams/${teamId}/matches`, {
    headers: FD_HEADERS,
    params: { status: 'SCHEDULED', limit },
  });
  return res.data.matches || [];
}

async function getHeadToHead(teamAId, teamBId) {
  const res = await axios.get(`${FD_BASE}/teams/${teamAId}/matches`, {
    headers: FD_HEADERS,
    params: { status: 'FINISHED', limit: 50 },
  });
  return (res.data.matches || [])
    .filter(m => m.homeTeam.id === teamBId || m.awayTeam.id === teamBId)
    .slice(0, 5);
}

async function getMatchesByDate(dateStr) {
  let allMatches = [];
  for (const comp of FD_COMPETITIONS) {
    try {
      const res = await axios.get(`${FD_BASE}/competitions/${comp}/matches`, {
        headers: FD_HEADERS,
        params: { dateFrom: dateStr, dateTo: dateStr },
      });
      allMatches.push(...(res.data.matches || []));
    } catch (err) {
      console.error(`Erreur récupération matchs ${comp}:`, err.response?.data || err.message);
    }
    await new Promise(r => setTimeout(r, 6500)); // respecte la limite 10 req/min
  }
  return allMatches;
}

async function getStandings(compCode) {
  const res = await axios.get(`${FD_BASE}/competitions/${compCode}/standings`, { headers: FD_HEADERS });
  const table = res.data.standings?.find(s => s.type === 'TOTAL');
  return table?.table || [];
}

async function getTopScorers(compCode) {
  const res = await axios.get(`${FD_BASE}/competitions/${compCode}/scorers`, {
    headers: FD_HEADERS,
    params: { limit: 10 },
  });
  return res.data.scorers || [];
}

function formatMatchesMessage(matches, dateLabel) {
  if (matches.length === 0) {
    return `Aucun match prévu le ${dateLabel} dans les compétitions suivies.`;
  }

  const byCompetition = {};
  matches.forEach(m => {
    const comp = m.competition.name;
    if (!byCompetition[comp]) byCompetition[comp] = [];
    byCompetition[comp].push(m);
  });

  let text = `📅 Matchs du ${dateLabel} :\n\n`;
  for (const comp in byCompetition) {
    text += `🏆 ${comp}\n`;
    byCompetition[comp].forEach(m => {
      const time = new Date(m.utcDate).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
      const status = m.status === 'FINISHED'
        ? `${m.score.fullTime.home}-${m.score.fullTime.away}`
        : m.status === 'IN_PLAY' || m.status === 'PAUSED'
        ? `🔴 ${m.score.fullTime.home ?? 0}-${m.score.fullTime.away ?? 0}`
        : time;
      text += `  ${m.homeTeam.name} vs ${m.awayTeam.name} — ${status}\n`;
    });
    text += '\n';
  }

  if (text.length > 4000) text = text.slice(0, 4000) + '\n...(liste tronquée, trop de matchs)';
  return text;
}

// ==================== CALCULS STATS (football-data.org) ====================

function computeStats(matches, teamId) {
  let wins = 0, draws = 0, losses = 0, goalsFor = 0, goalsAgainst = 0;
  let homeFor = 0, homeAgainst = 0, homeCount = 0;
  let awayFor = 0, awayAgainst = 0, awayCount = 0;
  let form = '';

  matches.forEach(m => {
    const isHome = m.homeTeam.id === teamId;
    const gf = isHome ? m.score.fullTime.home : m.score.fullTime.away;
    const ga = isHome ? m.score.fullTime.away : m.score.fullTime.home;

    goalsFor += gf; goalsAgainst += ga;
    if (isHome) { homeCount++; homeFor += gf; homeAgainst += ga; }
    else { awayCount++; awayFor += gf; awayAgainst += ga; }

    if (gf > ga) { wins++; form += 'V'; }
    else if (gf === ga) { draws++; form += 'N'; }
    else { losses++; form += 'D'; }
  });

  const count = matches.length || 1;

  return {
    wins, draws, losses, form,
    avgFor: (goalsFor / count).toFixed(1),
    avgAgainst: (goalsAgainst / count).toFixed(1),
    homeAvgFor: homeCount ? (homeFor / homeCount).toFixed(1) : 'N/A',
    homeAvgAgainst: homeCount ? (homeAgainst / homeCount).toFixed(1) : 'N/A',
    awayAvgFor: awayCount ? (awayFor / awayCount).toFixed(1) : 'N/A',
    awayAvgAgainst: awayCount ? (awayAgainst / awayCount).toFixed(1) : 'N/A',
  };
}

function factorial(n) { return n <= 1 ? 1 : n * factorial(n - 1); }
function poisson(lambda, k) { return (Math.pow(lambda, k) * Math.exp(-lambda)) / factorial(k); }

function estimateProbabilities(avgA, avgB) {
  const lambdaA = parseFloat(avgA) || 1;
  const lambdaB = parseFloat(avgB) || 1;
  let homeWin = 0, draw = 0, awayWin = 0, over25 = 0, btts = 0;

  for (let i = 0; i <= 6; i++) {
    for (let j = 0; j <= 6; j++) {
      const p = poisson(lambdaA, i) * poisson(lambdaB, j);
      if (i > j) homeWin += p; else if (i === j) draw += p; else awayWin += p;
      if (i + j > 2) over25 += p;
      if (i > 0 && j > 0) btts += p;
    }
  }

  return {
    homeWin: (homeWin * 100).toFixed(0),
    draw: (draw * 100).toFixed(0),
    awayWin: (awayWin * 100).toFixed(0),
    over25: (over25 * 100).toFixed(0),
    btts: (btts * 100).toFixed(0),
  };
}

// ==================== API-FOOTBALL : live, compo, blessures, joueur, résumé ====================

async function getLiveMatches() {
  const res = await axios.get(`${AF_BASE}/fixtures`, { headers: AF_HEADERS, params: { live: 'all' } });
  console.log('DEBUG getLiveMatches', JSON.stringify(res.data.errors), 'results=' + res.data.results);
  const matches = res.data.response || [];
  return matches.filter(m => AF_LEAGUES[m.league.id]);
}

// Le plan gratuit d'API-Football exige désormais une saison pour team+status, et bloque la saison 2026.
// On contourne en cherchant le match précis par DATE (dérivée de football-data.org), ce qui évite le problème de saison.
// On filtre par ligue quand on la connaît : sans ça, une journée complète renvoie des milliers de matchs
// dans le monde entier et la pagination de l'API peut tronquer la réponse avant d'atteindre le bon match.
async function findAFFixtureByDateAndTeams(dateStr, teamNameA, teamNameB, leagueId) {
  const params = { date: dateStr };
  if (leagueId) params.league = leagueId;

  const res = await axios.get(`${AF_BASE}/fixtures`, { headers: AF_HEADERS, params });
  console.log('DEBUG findAFFixtureByDateAndTeams date=' + dateStr + ' league=' + leagueId, JSON.stringify(res.data.errors), 'results=' + res.data.results);
  const fixtures = res.data.response || [];

  const qA = normalize(teamNameA);
  const qB = normalize(teamNameB);
  const teamMatches = (n, q) => {
    const nn = normalize(n || '');
    return nn.includes(q) || q.includes(nn);
  };

  return fixtures.find(f =>
    (teamMatches(f.teams.home.name, qA) && teamMatches(f.teams.away.name, qB)) ||
    (teamMatches(f.teams.home.name, qB) && teamMatches(f.teams.away.name, qA))
  ) || null;
}

async function getLineups(fixtureId) {
  const res = await axios.get(`${AF_BASE}/fixtures/lineups`, { headers: AF_HEADERS, params: { fixture: fixtureId } });
  console.log('DEBUG getLineups fixture=' + fixtureId, JSON.stringify(res.data.errors), 'results=' + res.data.results);
  return res.data.response || [];
}

async function getMatchEvents(fixtureId) {
  const res = await axios.get(`${AF_BASE}/fixtures/events`, { headers: AF_HEADERS, params: { fixture: fixtureId } });
  console.log('DEBUG getMatchEvents fixture=' + fixtureId, JSON.stringify(res.data.errors), 'results=' + res.data.results);
  return res.data.response || [];
}

// ==================== ODDSPAPI : cotes des bookmakers ====================

async function findOddsFixture(nameA, nameB) {
  const today = new Date();
  const in9days = new Date(today.getTime() + 9 * 24 * 60 * 60 * 1000);
  const from = today.toISOString().split('T')[0];
  const to = in9days.toISOString().split('T')[0];

  const res = await axios.get(`${ODDS_BASE}/fixtures`, {
    params: { apiKey: oddsApiKey, sportId: ODDS_SOCCER_SPORT_ID, from, to },
  });
  const fixtures = Array.isArray(res.data) ? res.data : (res.data.fixtures || res.data.data || []);
  console.log('DEBUG findOddsFixture count=' + fixtures.length);

  const queryA = normalize(nameA);
  const queryB = normalize(nameB);
  const teamMatches = (teamName, query) => {
    const n = normalize(teamName || '');
    return n.includes(query) || query.includes(n);
  };

  return fixtures.find(f =>
    (teamMatches(f.participant1Name, queryA) && teamMatches(f.participant2Name, queryB)) ||
    (teamMatches(f.participant1Name, queryB) && teamMatches(f.participant2Name, queryA))
  ) || null;
}

const ODDS_V5_BASE = 'https://v5.oddspapi.io/en';

async function getOddsForFixtureV5(fixtureId) {
  const res = await axios.get(`${ODDS_V5_BASE}/fixtures/odds`, {
    params: { apiKey: oddsApiKey, fixtureId },
  });
  console.log('DEBUG getOddsForFixtureV5 fixture=' + fixtureId, JSON.stringify(res.data).slice(0, 1500));
  return res.data;
}

// ==================== COMMANDES ====================

bot.command('start', (ctx) => {
  return ctx.reply(
    "⚽ Salut ! Je suis ton bot d'analyse foot.\n\n" +
    "Commandes disponibles :\n" +
    "/match <équipe> - prochain match d'une équipe\n" +
    "/calendrier <équipe> - tous les prochains matchs\n" +
    "/classement <championnat> - classement actuel\n" +
    "/buteurs <championnat> - top buteurs\n" +
    "/compo <équipe> - composition du prochain match\n" +
    "/resume <équipe> - résumé du dernier match\n" +
    "/cotes <équipe1> vs <équipe2> - cotes des bookmakers\n" +
    "/live - scores en direct\n" +
    "/today - tous les matchs du jour\n" +
    "/suivre <équipe> - alertes buts en direct\n" +
    "/arreter <équipe> - stopper les alertes\n\n" +
    "Envoie une date (JJ/MM/AAAA) pour voir les matchs de ce jour-là.\n" +
    "Ou envoie : Équipe1 vs Équipe2\n" +
    "pour une analyse complète du duel.\n\n" +
    "⚠️ NB : vérifie bien l'orthographe exacte des noms d'équipes avant de les envoyer (ex: 'Manchester United' plutôt que 'Man U'), sinon le bot risque de ne pas les trouver."
  );
});

bot.command('live', async (ctx) => {
  try {
    const matches = await getLiveMatches();
    if (matches.length === 0) return ctx.reply("Aucun match en direct actuellement.");

    let text = "🔴 Matchs en direct :\n\n";
    matches.forEach(m => {
      text += `${m.teams.home.name} ${m.goals.home ?? 0} - ${m.goals.away ?? 0} ${m.teams.away.name}\n`;
    });
    return ctx.reply(text);
  } catch (error) {
    console.error(error.response?.data || error.message);
    return ctx.reply("Erreur lors de la récupération des matchs.");
  }
});

bot.command('today', async (ctx) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const matches = await getMatchesByDate(today);
    return ctx.reply(formatMatchesMessage(matches, "aujourd'hui"));
  } catch (error) {
    console.error(error.response?.data || error.message);
    return ctx.reply("Erreur lors de la récupération des matchs du jour.");
  }
});

bot.command('classement', async (ctx) => {
  const leagueName = ctx.message.text.replace('/classement', '').trim();
  const comp = findCompetition(leagueName);
  if (!comp) return ctx.reply("Championnat non reconnu. Essaie par exemple : /classement Ligue 1");

  try {
    const standings = await getStandings(comp.code);
    if (standings.length === 0) return ctx.reply(`Aucun classement disponible pour ${comp.name} actuellement.`);

    let text = `🏆 Classement — ${comp.name}\n\n`;
    standings.forEach(s => {
      text += `${s.position}. ${s.team.name} — ${s.points} pts (${s.playedGames}J, ${s.won}V ${s.draw}N ${s.lost}D, diff ${s.goalDifference})\n`;
    });

    if (text.length > 4000) text = text.slice(0, 4000) + '\n...(tronqué)';
    return ctx.reply(text);
  } catch (error) {
    console.error(error.response?.data || error.message);
    return ctx.reply("Erreur lors de la récupération du classement.");
  }
});

bot.command('buteurs', async (ctx) => {
  const leagueName = ctx.message.text.replace('/buteurs', '').trim();
  const comp = findCompetition(leagueName);
  if (!comp) return ctx.reply("Championnat non reconnu. Essaie par exemple : /buteurs Premier League");

  try {
    const scorers = await getTopScorers(comp.code);
    if (scorers.length === 0) return ctx.reply(`Aucune donnée de buteurs disponible pour ${comp.name}.`);

    let text = `⚽ Top buteurs — ${comp.name}\n\n`;
    scorers.forEach((s, i) => {
      text += `${i + 1}. ${s.player.name} (${s.team.name}) — ${s.goals} buts\n`;
    });

    return ctx.reply(text);
  } catch (error) {
    console.error(error.response?.data || error.message);
    return ctx.reply("Erreur lors de la récupération des buteurs.");
  }
});

bot.command('match', async (ctx) => {
  const teamName = ctx.message.text.replace('/match', '').trim();
  if (!teamName) return ctx.reply("Utilise la commande comme ça : /match Real Madrid");

  try {
    const team = findTeam(teamName);
    if (!team) return ctx.reply(`Équipe "${teamName}" introuvable (vérifie qu'elle joue dans une compétition couverte : PL, Liga, Bundesliga, Ligue 1, Serie A, C1...).`);

    const nextMatch = await getNextMatch(team.id);
    if (!nextMatch) return ctx.reply(`Aucun match à venir trouvé pour ${team.name}.`);

    const date = new Date(nextMatch.utcDate).toLocaleString('fr-FR', { dateStyle: 'full', timeStyle: 'short' });
    return ctx.reply(`⚽ ${team.name}\n\nProchain match :\n${nextMatch.homeTeam.name} vs ${nextMatch.awayTeam.name}\n📅 ${date}\n🏆 ${nextMatch.competition.name}`);
  } catch (error) {
    console.error(error.response?.data || error.message);
    return ctx.reply("Erreur lors de la récupération des infos.");
  }
});

bot.command('calendrier', async (ctx) => {
  const teamName = ctx.message.text.replace('/calendrier', '').trim();
  if (!teamName) return ctx.reply("Utilise : /calendrier Real Madrid");

  try {
    const team = findTeam(teamName);
    if (!team) return ctx.reply(`Équipe "${teamName}" introuvable.`);

    const fixtures = await getUpcomingFixtures(team.id, 10);
    if (fixtures.length === 0) return ctx.reply(`Aucun match à venir trouvé pour ${team.name}.`);

    let text = `📅 Calendrier — ${team.name}\n\n`;
    fixtures.forEach(f => {
      const date = new Date(f.utcDate).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
      const opponent = f.homeTeam.id === team.id ? f.awayTeam.name : f.homeTeam.name;
      const venue = f.homeTeam.id === team.id ? '🏠' : '🚗';
      text += `${date} ${venue} vs ${opponent} (${f.competition.name})\n`;
    });

    return ctx.reply(text);
  } catch (error) {
    console.error(error.response?.data || error.message);
    return ctx.reply("Erreur lors de la récupération du calendrier.");
  }
});

bot.command('compo', async (ctx) => {
  const teamName = ctx.message.text.replace('/compo', '').trim();
  if (!teamName) return ctx.reply("Utilise : /compo Real Madrid");

  try {
    const team = findTeam(teamName);
    if (!team) return ctx.reply(`Équipe "${teamName}" introuvable.`);

    const nextMatch = await getNextMatch(team.id);
    if (!nextMatch) return ctx.reply(`Aucun match à venir trouvé pour ${team.name}.`);

    const dateStr = nextMatch.utcDate.split('T')[0];
    const afFixture = await findAFFixtureByDateAndTeams(dateStr, nextMatch.homeTeam.name, nextMatch.awayTeam.name, FD_TO_AF_LEAGUE[nextMatch.competition.code]);
    if (!afFixture) return ctx.reply("Match trouvé mais introuvable côté API-Football pour récupérer la composition.");

    const lineups = await getLineups(afFixture.fixture.id);
    if (lineups.length === 0) {
      return ctx.reply("Composition pas encore disponible (généralement publiée ~1h avant le coup d'envoi).");
    }

    let text = `📋 Compositions — ${nextMatch.homeTeam.name} vs ${nextMatch.awayTeam.name}\n\n`;
    lineups.forEach(l => {
      text += `${l.team.name} (${l.formation}) — Coach : ${l.coach.name}\n`;
      l.startXI.forEach(p => { text += `  ${p.player.number}. ${p.player.name} (${p.player.pos})\n`; });
      text += '\n';
    });

    if (text.length > 4000) text = text.slice(0, 4000) + '\n...(tronqué)';
    return ctx.reply(text);
  } catch (error) {
    console.error(error.response?.data || error.message);
    return ctx.reply("Erreur lors de la récupération de la composition.");
  }
});

bot.command('resume', async (ctx) => {
  const teamName = ctx.message.text.replace('/resume', '').trim();
  if (!teamName) return ctx.reply("Utilise : /resume Real Madrid");

  try {
    const team = findTeam(teamName);
    if (!team) return ctx.reply(`Équipe "${teamName}" introuvable.`);

    const lastMatches = await getRecentMatches(team.id, 1);
    const lastMatch = lastMatches[0];
    if (!lastMatch) return ctx.reply(`Aucun match terminé trouvé pour ${team.name}.`);

    const dateStr = lastMatch.utcDate.split('T')[0];
    const afFixture = await findAFFixtureByDateAndTeams(dateStr, lastMatch.homeTeam.name, lastMatch.awayTeam.name, FD_TO_AF_LEAGUE[lastMatch.competition.code]);

    const date = new Date(lastMatch.utcDate).toLocaleDateString('fr-FR');
    let text = `📝 Résumé — ${lastMatch.homeTeam.name} ${lastMatch.score.fullTime.home}-${lastMatch.score.fullTime.away} ${lastMatch.awayTeam.name} (${date})\n\n`;

    if (!afFixture) {
      text += "Détails (buteurs, cartons) indisponibles pour ce match.";
      return ctx.reply(text);
    }

    const events = await getMatchEvents(afFixture.fixture.id);
    const relevant = events.filter(e => ['Goal', 'Card'].includes(e.type));
    if (relevant.length === 0) {
      text += "Aucun événement détaillé disponible.";
    } else {
      relevant.forEach(e => {
        const icon = e.type === 'Goal' ? '⚽' : e.detail.includes('Red') ? '🟥' : '🟨';
        text += `${e.time.elapsed}' ${icon} ${e.player.name} (${e.team.name})${e.assist?.name ? ` — passe : ${e.assist.name}` : ''}\n`;
      });
    }

    return ctx.reply(text);
  } catch (error) {
    console.error(error.response?.data || error.message);
    return ctx.reply("Erreur lors de la récupération du résumé.");
  }
});

bot.command('cotes', async (ctx) => {
  const query = ctx.message.text.replace('/cotes', '').trim();
  const parts = query.split(/\s+vs\s+/i);
  if (parts.length !== 2) return ctx.reply("Utilise : /cotes Real Madrid vs Barcelone");

  try {
    const fixture = await findOddsFixture(parts[0].trim(), parts[1].trim());
    if (!fixture) return ctx.reply("Match introuvable dans les prochaines rencontres suivies par OddsPapi.");

    if (!fixture.hasOdds) {
      return ctx.reply(`Match trouvé (${fixture.participant1Name} vs ${fixture.participant2Name}, ${fixture.tournamentName}) mais les cotes ne sont pas encore publiées pour ce match.`);
    }

    const odds = await getOddsForFixtureV5(fixture.fixtureId);

    // Format encore générique tant qu'on n'a pas confirmé la structure exacte de la réponse —
    // renvoie les données brutes (tronquées) pour ajuster l'affichage si besoin.
    let text = `💰 Cotes — ${fixture.participant1Name} vs ${fixture.participant2Name} (${fixture.tournamentName})\n\n`;
    text += JSON.stringify(odds).slice(0, 1200);

    return ctx.reply(text);
  } catch (error) {
    console.error(error.response?.data || error.message);
    return ctx.reply("Erreur lors de la récupération des cotes.");
  }
});

// ==================== DÉTECTION DE DATE ====================

bot.hears(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, async (ctx) => {
  const [, day, month, year] = ctx.match;
  const dateStr = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;

  const parsedDate = new Date(dateStr);
  if (isNaN(parsedDate.getTime())) {
    return ctx.reply("Date invalide. Utilise le format JJ/MM/AAAA, par exemple 20/09/2026.");
  }

  try {
    const matches = await getMatchesByDate(dateStr);
    const dateLabel = parsedDate.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
    return ctx.reply(formatMatchesMessage(matches, dateLabel));
  } catch (error) {
    console.error(error.response?.data || error.message);
    return ctx.reply("Erreur lors de la récupération des matchs pour cette date.");
  }
});

// ==================== ANALYSE "Équipe1 vs Équipe2" ====================

bot.hears(/^(.+?)\s+vs\s+(.+)$/i, async (ctx) => {
  const [, nameA, nameB] = ctx.match;

  try {
    const teamA = findTeam(nameA.trim());
    const teamB = findTeam(nameB.trim());

    if (!teamA || !teamB) {
      return ctx.reply("Je n'ai pas trouvé une des deux équipes. Vérifie l'orthographe ou qu'elle joue dans une compétition couverte.");
    }

    await ctx.reply(`🔍 Analyse en cours : ${teamA.name} vs ${teamB.name}...`);

    const [matchesA, matchesB, h2h] = await Promise.all([
      getRecentMatches(teamA.id, 5),
      getRecentMatches(teamB.id, 5),
      getHeadToHead(teamA.id, teamB.id),
    ]);

    const statsA = computeStats(matchesA, teamA.id);
    const statsB = computeStats(matchesB, teamB.id);
    const probs = estimateProbabilities(statsA.avgFor, statsB.avgFor);

    const h2hText = h2h.length
      ? h2h.map(m => `${new Date(m.utcDate).toLocaleDateString('fr-FR')} : ${m.homeTeam.name} ${m.score.fullTime.home}-${m.score.fullTime.away} ${m.awayTeam.name}`).join('\n')
      : "Aucune confrontation récente trouvée.";

    const message = `📊 ${teamA.name} vs ${teamB.name}

📈 Forme (5 derniers matchs)
${teamA.name} : ${statsA.form} (${statsA.wins}V ${statsA.draws}N ${statsA.losses}D)
${teamB.name} : ${statsB.form} (${statsB.wins}V ${statsB.draws}N ${statsB.losses}D)

⚽ Buts marqués/encaissés (moyenne)
${teamA.name} : ${statsA.avgFor} marqués / ${statsA.avgAgainst} encaissés
${teamB.name} : ${statsB.avgFor} marqués / ${statsB.avgAgainst} encaissés

🏠 Domicile / 🚗 Extérieur
${teamA.name} (dom.) : ${statsA.homeAvgFor} marqués / ${statsA.homeAvgAgainst} encaissés
${teamB.name} (ext.) : ${statsB.awayAvgFor} marqués / ${statsB.awayAvgAgainst} encaissés

🤝 Confrontations directes récentes
${h2hText}

📌 Estimations statistiques (modèle Poisson simplifié)
Victoire ${teamA.name} : ${probs.homeWin}%
Match nul : ${probs.draw}%
Victoire ${teamB.name} : ${probs.awayWin}%
Plus de 2.5 buts : ${probs.over25}%
BTTS (les 2 marquent) : ${probs.btts}%

🧠 Conclusion
Ces chiffres reflètent uniquement des tendances statistiques récentes (forme, buts, historique). Ils ignorent blessures, enjeux ou contexte du jour, et ne constituent pas une prédiction certaine — juste une lecture probabiliste.`;

    return ctx.reply(message);
  } catch (error) {
    console.error(error.response?.data || error.message);
    return ctx.reply("Erreur lors de l'analyse. Réessaie dans quelques instants.");
  }
});

// ==================== ABONNEMENT AUX BUTS EN DIRECT (API-Football) ====================
// ⚠️ Consomme du quota API-Football (surveillance périodique) : reste raisonnable sur le nombre d'équipes suivies.

const subscriptions = {}; // teamId (API-Football) -> Set(chatId)
const lastKnownState = {}; // fixtureId -> { home, away, status }
const POLL_INTERVAL_MINUTES = 30;

bot.command('suivre', async (ctx) => {
  const teamName = ctx.message.text.replace('/suivre', '').trim();
  if (!teamName) return ctx.reply("Utilise : /suivre Real Madrid");

  try {
    const team = await findAFTeam(teamName);
    if (!team) return ctx.reply(`Équipe "${teamName}" introuvable.`);

    if (!subscriptions[team.id]) subscriptions[team.id] = new Set();
    subscriptions[team.id].add(ctx.chat.id);

    return ctx.reply(`🔔 Abonné aux buts/résultats de ${team.name}. Vérification toutes les ${POLL_INTERVAL_MINUTES} min pendant les matchs en direct.\nPour te désabonner : /arreter ${team.name}`);
  } catch (error) {
    console.error(error.response?.data || error.message);
    return ctx.reply("Erreur lors de l'abonnement.");
  }
});

bot.command('arreter', async (ctx) => {
  const teamName = ctx.message.text.replace('/arreter', '').trim();
  if (!teamName) return ctx.reply("Utilise : /arreter Real Madrid");

  try {
    const team = await findAFTeam(teamName);
    if (!team || !subscriptions[team.id]) return ctx.reply("Tu n'étais pas abonné à cette équipe.");

    subscriptions[team.id].delete(ctx.chat.id);
    return ctx.reply(`🔕 Désabonné de ${team.name}.`);
  } catch (error) {
    console.error(error.response?.data || error.message);
    return ctx.reply("Erreur lors du désabonnement.");
  }
});

async function pollSubscribedMatches() {
  const teamIds = Object.keys(subscriptions).filter(id => subscriptions[id].size > 0);
  if (teamIds.length === 0) return;

  try {
    const live = await getLiveMatches();
    for (const match of live) {
      const homeId = match.teams.home.id;
      const awayId = match.teams.away.id;
      const relevantTeamId = teamIds.find(id => Number(id) === homeId || Number(id) === awayId);
      if (!relevantTeamId) continue;

      const fixtureId = match.fixture.id;
      const prev = lastKnownState[fixtureId];
      const scoreChanged = !prev || prev.home !== match.goals.home || prev.away !== match.goals.away;

      if (scoreChanged) {
        const text = `⚽ ${match.teams.home.name} ${match.goals.home ?? 0} - ${match.goals.away ?? 0} ${match.teams.away.name} (${match.fixture.status.elapsed ?? ''}')`;
        for (const chatId of subscriptions[relevantTeamId]) {
          bot.telegram.sendMessage(chatId, text).catch(() => {});
        }
      }

      lastKnownState[fixtureId] = { home: match.goals.home, away: match.goals.away, status: match.fixture.status.short };
    }
  } catch (error) {
    console.error('Erreur polling:', error.response?.data || error.message);
  }
}

setInterval(pollSubscribedMatches, POLL_INTERVAL_MINUTES * 60 * 1000);

// ==================== DÉMARRAGE ====================

loadFDTeamsCache().then(() => {
  bot.launch();
  console.log('Bot en écoute.');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
