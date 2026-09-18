require('dotenv').config();
const { Telegraf } = require('telegraf');
const axios = require('axios');

const token = process.env.TELEGRAM_TOKEN;
const footballApiKey = process.env.FOOTBALL_API_KEY;

const bot = new Telegraf(token);

const API_BASE = 'https://v3.football.api-sports.io';
const API_HEADERS = { 'x-apisports-key': footballApiKey };

console.log('Bot démarré...');

// Ligues suivies (IDs API-Football)
const LEAGUES = {
  39: 'Premier League',
  140: 'La Liga',
  78: 'Bundesliga',
  135: 'Serie A',
  61: 'Ligue 1',
  2: 'Champions League',
  3: 'Europa League',
  848: 'Conference League',
  88: 'Eredivisie',
  94: 'Primeira Liga',
  40: 'Championship',
};

const SEASON = new Date().getFullYear(); // saison en cours (utilisée où la saison est optionnelle)
const FALLBACK_SEASON = 2024; // le plan gratuit d'API-Football ne couvre que 2022-2024 pour les endpoints qui exigent une saison

function findLeague(name) {
  const query = normalize(name);
  const entry = Object.entries(LEAGUES).find(([, leagueName]) => normalize(leagueName).includes(query));
  return entry ? { id: Number(entry[0]), name: entry[1] } : null;
}

function normalize(str) {
  return str.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// ==================== CACHE ÉQUIPES (en mémoire, rempli à la demande pour économiser le quota) ====================

let teamsCache = {}; // clé : nom normalisé -> objet équipe {id, name}

async function findTeam(name) {
  const query = normalize(name);

  const cached = Object.values(teamsCache).find(t => normalize(t.name).includes(query));
  if (cached) return cached;

  try {
    const res = await axios.get(`${API_BASE}/teams`, {
      headers: API_HEADERS,
      params: { search: name },
    });
    console.log('DEBUG findTeam search="' + name + '"', JSON.stringify(res.data.errors), 'results=' + res.data.results, 'first=' + JSON.stringify(res.data.response?.[0]?.team));
    const found = res.data.response?.[0]?.team;
    if (found) {
      teamsCache[normalize(found.name)] = found;
      return found;
    }
    return null;
  } catch (err) {
    console.error('Erreur recherche équipe:', err.response?.data || err.message);
    return null;
  }
}

// ==================== UTILITAIRES API ====================

// Le plan gratuit d'API-Football n'autorise ni "last"/"next", ni la saison en cours (2026) :
// on interroge donc par statut (terminé / à venir) sans préciser de saison.
async function getTeamFixturesByStatus(teamId, status) {
  const res = await axios.get(`${API_BASE}/fixtures`, {
    headers: API_HEADERS,
    params: { team: teamId, status },
  });
  console.log('DEBUG getTeamFixturesByStatus teamId=' + teamId + ' status=' + status, JSON.stringify(res.data.errors), 'results=' + res.data.results);
  return res.data.response || [];
}

async function getRecentMatches(teamId, limit = 5) {
  const fixtures = await getTeamFixturesByStatus(teamId, 'FT');
  return fixtures
    .sort((a, b) => new Date(b.fixture.date) - new Date(a.fixture.date))
    .slice(0, limit);
}

async function getNextMatch(teamId) {
  const fixtures = await getTeamFixturesByStatus(teamId, 'NS');
  const upcoming = fixtures.sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date));
  return upcoming[0] || null;
}

async function getHeadToHead(teamAId, teamBId) {
  const res = await axios.get(`${API_BASE}/fixtures/headtohead`, {
    headers: API_HEADERS,
    params: { h2h: `${teamAId}-${teamBId}` },
  });
  console.log('DEBUG getHeadToHead ' + teamAId + '-' + teamBId, JSON.stringify(res.data.errors), 'results=' + res.data.results);
  const matches = res.data.response || [];
  return matches
    .filter(m => m.fixture.status.short === 'FT')
    .sort((a, b) => new Date(b.fixture.date) - new Date(a.fixture.date))
    .slice(0, 5);
}

async function getLiveMatches() {
  const res = await axios.get(`${API_BASE}/fixtures`, {
    headers: API_HEADERS,
    params: { live: 'all' },
  });
  console.log('DEBUG getLiveMatches', JSON.stringify(res.data.errors), 'results=' + res.data.results);
  const matches = res.data.response || [];
  return matches.filter(m => LEAGUES[m.league.id]);
}

async function getMatchesByDate(dateStr) {
  const res = await axios.get(`${API_BASE}/fixtures`, {
    headers: API_HEADERS,
    params: { date: dateStr },
  });
  console.log('DEBUG getMatchesByDate ' + dateStr, JSON.stringify(res.data.errors), 'results=' + res.data.results);
  const matches = res.data.response || [];
  return matches.filter(m => LEAGUES[m.league.id]);
}

async function getStandings(leagueId) {
  const res = await axios.get(`${API_BASE}/standings`, {
    headers: API_HEADERS,
    params: { league: leagueId, season: FALLBACK_SEASON },
  });
  console.log('DEBUG getStandings league=' + leagueId, JSON.stringify(res.data.errors), 'results=' + res.data.results);
  return res.data.response?.[0]?.league?.standings?.[0] || [];
}

async function getTopScorers(leagueId) {
  const res = await axios.get(`${API_BASE}/players/topscorers`, {
    headers: API_HEADERS,
    params: { league: leagueId, season: FALLBACK_SEASON },
  });
  console.log('DEBUG getTopScorers league=' + leagueId, JSON.stringify(res.data.errors), 'results=' + res.data.results);
  return res.data.response || [];
}

async function getUpcomingFixtures(teamId, count = 10) {
  const fixtures = await getTeamFixturesByStatus(teamId, 'NS');
  return fixtures
    .sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date))
    .slice(0, count);
}

async function getLineups(fixtureId) {
  const res = await axios.get(`${API_BASE}/fixtures/lineups`, {
    headers: API_HEADERS,
    params: { fixture: fixtureId },
  });
  console.log('DEBUG getLineups fixture=' + fixtureId, JSON.stringify(res.data.errors), 'results=' + res.data.results);
  return res.data.response || [];
}

async function getInjuries(teamId) {
  const res = await axios.get(`${API_BASE}/injuries`, {
    headers: API_HEADERS,
    params: { team: teamId, season: FALLBACK_SEASON },
  });
  console.log('DEBUG getInjuries teamId=' + teamId, JSON.stringify(res.data.errors), 'results=' + res.data.results);
  return res.data.response || [];
}

async function getLastFinishedMatch(teamId) {
  const matches = await getRecentMatches(teamId, 1);
  return matches[0] || null;
}

async function getMatchEvents(fixtureId) {
  const res = await axios.get(`${API_BASE}/fixtures/events`, {
    headers: API_HEADERS,
    params: { fixture: fixtureId },
  });
  console.log('DEBUG getMatchEvents fixture=' + fixtureId, JSON.stringify(res.data.errors), 'results=' + res.data.results);
  return res.data.response || [];
}

async function searchPlayer(name) {
  const res = await axios.get(`${API_BASE}/players`, {
    headers: API_HEADERS,
    params: { search: name, season: FALLBACK_SEASON },
  });
  console.log('DEBUG searchPlayer "' + name + '"', JSON.stringify(res.data.errors), 'results=' + res.data.results);
  return res.data.response || [];
}

function formatMatchesMessage(matches, dateLabel) {
  if (matches.length === 0) {
    return `Aucun match prévu le ${dateLabel} dans les compétitions suivies.`;
  }

  const byCompetition = {};
  matches.forEach(m => {
    const comp = m.league.name;
    if (!byCompetition[comp]) byCompetition[comp] = [];
    byCompetition[comp].push(m);
  });

  let text = `📅 Matchs du ${dateLabel} :\n\n`;
  for (const comp in byCompetition) {
    text += `🏆 ${comp}\n`;
    byCompetition[comp].forEach(m => {
      const time = new Date(m.fixture.date).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
      const status = m.fixture.status.short;
      const isLive = ['1H', '2H', 'HT', 'ET', 'P', 'LIVE'].includes(status);
      const isFinished = status === 'FT';
      const scoreStr = isFinished
        ? `${m.goals.home}-${m.goals.away}`
        : isLive
        ? `🔴 ${m.goals.home ?? 0}-${m.goals.away ?? 0}`
        : time;
      text += `  ${m.teams.home.name} vs ${m.teams.away.name} — ${scoreStr}\n`;
    });
    text += '\n';
  }

  if (text.length > 4000) {
    text = text.slice(0, 4000) + '\n...(liste tronquée, trop de matchs)';
  }

  return text;
}

// ==================== CALCULS STATS ====================

function computeStats(matches, teamId) {
  let wins = 0, draws = 0, losses = 0, goalsFor = 0, goalsAgainst = 0;
  let homeFor = 0, homeAgainst = 0, homeCount = 0;
  let awayFor = 0, awayAgainst = 0, awayCount = 0;
  let form = '';

  matches.forEach(m => {
    const isHome = m.teams.home.id === teamId;
    const gf = isHome ? m.goals.home : m.goals.away;
    const ga = isHome ? m.goals.away : m.goals.home;

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
    "/blessures <équipe> - blessés/suspendus\n" +
    "/resume <équipe> - résumé du dernier match\n" +
    "/joueur <nom> - stats d'un joueur\n" +
    "/live - scores en direct\n" +
    "/today - tous les matchs du jour\n" +
    "/suivre <équipe> - alertes buts en direct\n" +
    "/arreter <équipe> - stopper les alertes\n\n" +
    "Envoie une date (JJ/MM/AAAA) pour voir les matchs de ce jour-là.\n" +
    "Ou envoie : Équipe1 vs Équipe2\n" +
    "pour une analyse complète du duel."
  );
});

bot.command('live', async (ctx) => {
  try {
    const matches = await getLiveMatches();

    if (matches.length === 0) {
      return ctx.reply("Aucun match en direct actuellement.");
    }

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

bot.command('match', async (ctx) => {
  const teamName = ctx.message.text.replace('/match', '').trim();

  if (!teamName) {
    return ctx.reply("Utilise la commande comme ça : /match Real Madrid");
  }

  try {
    const team = await findTeam(teamName);
    if (!team) {
      return ctx.reply(`Équipe "${teamName}" introuvable (vérifie qu'elle joue dans une compétition couverte : PL, Liga, Bundesliga, Ligue 1, Serie A, C1...).`);
    }

    const nextMatch = await getNextMatch(team.id);
    if (!nextMatch) {
      return ctx.reply(`Aucun match à venir trouvé pour ${team.name}.`);
    }

    const date = new Date(nextMatch.fixture.date).toLocaleString('fr-FR', { dateStyle: 'full', timeStyle: 'short' });

    return ctx.reply(
      `⚽ ${team.name}\n\nProchain match :\n${nextMatch.teams.home.name} vs ${nextMatch.teams.away.name}\n📅 ${date}\n🏆 ${nextMatch.league.name}`
    );
  } catch (error) {
    console.error(error.response?.data || error.message);
    return ctx.reply("Erreur lors de la récupération des infos.");
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
    const teamA = await findTeam(nameA.trim());
    const teamB = await findTeam(nameB.trim());

    if (!teamA || !teamB) {
      return ctx.reply("Je n'ai pas trouvé une des deux équipes. Vérifie l'orthographe ou qu'elle joue dans une compétition couverte.");
    }

    await ctx.reply(`🔍 Analyse en cours : ${teamA.name} vs ${teamB.name}...`);

    const [matchesA, matchesB, h2h] = await Promise.all([
      getRecentMatches(teamA.id, 5),
      getRecentMatches(teamB.id, 5),
      getHeadToHead(teamA.id, teamB.id)
    ]);

    const statsA = computeStats(matchesA, teamA.id);
    const statsB = computeStats(matchesB, teamB.id);
    const probs = estimateProbabilities(statsA.avgFor, statsB.avgFor);

    const h2hText = h2h.length
      ? h2h.map(m => `${new Date(m.fixture.date).toLocaleDateString('fr-FR')} : ${m.teams.home.name} ${m.goals.home}-${m.goals.away} ${m.teams.away.name}`).join('\n')
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

// ==================== CLASSEMENT ====================

bot.command('classement', async (ctx) => {
  const leagueName = ctx.message.text.replace('/classement', '').trim();
  const league = findLeague(leagueName);

  if (!league) {
    return ctx.reply("Championnat non reconnu. Essaie par exemple : /classement Ligue 1");
  }

  try {
    const standings = await getStandings(league.id);
    if (standings.length === 0) {
      return ctx.reply(`Aucun classement disponible pour ${league.name} actuellement.`);
    }

    let text = `🏆 Classement — ${league.name} (saison ${FALLBACK_SEASON}, plan gratuit)\n\n`;
    standings.forEach(s => {
      text += `${s.rank}. ${s.team.name} — ${s.points} pts (${s.all.played}J, ${s.all.win}V ${s.all.draw}N ${s.all.lose}D, diff ${s.goalsDiff})\n`;
    });

    if (text.length > 4000) text = text.slice(0, 4000) + '\n...(tronqué)';
    return ctx.reply(text);
  } catch (error) {
    console.error(error.response?.data || error.message);
    return ctx.reply("Erreur lors de la récupération du classement.");
  }
});

// ==================== TOP BUTEURS ====================

bot.command('buteurs', async (ctx) => {
  const leagueName = ctx.message.text.replace('/buteurs', '').trim();
  const league = findLeague(leagueName);

  if (!league) {
    return ctx.reply("Championnat non reconnu. Essaie par exemple : /buteurs Premier League");
  }

  try {
    const scorers = await getTopScorers(league.id);
    if (scorers.length === 0) {
      return ctx.reply(`Aucune donnée de buteurs disponible pour ${league.name}.`);
    }

    let text = `⚽ Top buteurs — ${league.name} (saison ${FALLBACK_SEASON}, plan gratuit)\n\n`;
    scorers.slice(0, 10).forEach((p, i) => {
      const stat = p.statistics[0];
      text += `${i + 1}. ${p.player.name} (${stat.team.name}) — ${stat.goals.total} buts\n`;
    });

    return ctx.reply(text);
  } catch (error) {
    console.error(error.response?.data || error.message);
    return ctx.reply("Erreur lors de la récupération des buteurs.");
  }
});

// ==================== CALENDRIER COMPLET D'UNE ÉQUIPE ====================

bot.command('calendrier', async (ctx) => {
  const teamName = ctx.message.text.replace('/calendrier', '').trim();
  if (!teamName) return ctx.reply("Utilise : /calendrier Real Madrid");

  try {
    const team = await findTeam(teamName);
    if (!team) return ctx.reply(`Équipe "${teamName}" introuvable.`);

    const fixtures = await getUpcomingFixtures(team.id, 10);
    if (fixtures.length === 0) return ctx.reply(`Aucun match à venir trouvé pour ${team.name}.`);

    let text = `📅 Calendrier — ${team.name}\n\n`;
    fixtures.forEach(f => {
      const date = new Date(f.fixture.date).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
      const opponent = f.teams.home.id === team.id ? f.teams.away.name : f.teams.home.name;
      const venue = f.teams.home.id === team.id ? '🏠' : '🚗';
      text += `${date} ${venue} vs ${opponent} (${f.league.name})\n`;
    });

    return ctx.reply(text);
  } catch (error) {
    console.error(error.response?.data || error.message);
    return ctx.reply("Erreur lors de la récupération du calendrier.");
  }
});

// ==================== COMPOSITION D'ÉQUIPE ====================

bot.command('compo', async (ctx) => {
  const teamName = ctx.message.text.replace('/compo', '').trim();
  if (!teamName) return ctx.reply("Utilise : /compo Real Madrid");

  try {
    const team = await findTeam(teamName);
    if (!team) return ctx.reply(`Équipe "${teamName}" introuvable.`);

    const nextMatch = await getNextMatch(team.id);
    if (!nextMatch) return ctx.reply(`Aucun match à venir trouvé pour ${team.name}.`);

    const lineups = await getLineups(nextMatch.fixture.id);
    if (lineups.length === 0) {
      return ctx.reply("Composition pas encore disponible (généralement publiée ~1h avant le coup d'envoi).");
    }

    let text = `📋 Compositions — ${nextMatch.teams.home.name} vs ${nextMatch.teams.away.name}\n\n`;
    lineups.forEach(l => {
      text += `${l.team.name} (${l.formation}) — Coach : ${l.coach.name}\n`;
      l.startXI.forEach(p => {
        text += `  ${p.player.number}. ${p.player.name} (${p.player.pos})\n`;
      });
      text += '\n';
    });

    if (text.length > 4000) text = text.slice(0, 4000) + '\n...(tronqué)';
    return ctx.reply(text);
  } catch (error) {
    console.error(error.response?.data || error.message);
    return ctx.reply("Erreur lors de la récupération de la composition.");
  }
});

// ==================== BLESSURES / SUSPENSIONS ====================

bot.command('blessures', async (ctx) => {
  const teamName = ctx.message.text.replace('/blessures', '').trim();
  if (!teamName) return ctx.reply("Utilise : /blessures Real Madrid");

  try {
    const team = await findTeam(teamName);
    if (!team) return ctx.reply(`Équipe "${teamName}" introuvable.`);

    const injuries = await getInjuries(team.id);
    if (injuries.length === 0) return ctx.reply(`Aucune blessure/suspension signalée pour ${team.name}.`);

    let text = `🩹 Blessures/suspensions — ${team.name} (saison ${FALLBACK_SEASON}, plan gratuit)\n\n`;
    const seen = new Set();
    injuries.forEach(i => {
      const name = i.player?.name;
      if (!name || seen.has(name)) return;
      seen.add(name);
      const reason = i.player?.reason || i.player?.type || 'Non précisé';
      text += `${name} — ${reason}\n`;
    });

    return ctx.reply(text);
  } catch (error) {
    console.error(error.response?.data || error.message);
    return ctx.reply("Erreur lors de la récupération des blessures.");
  }
});

// ==================== RÉSUMÉ DU DERNIER MATCH ====================

bot.command('resume', async (ctx) => {
  const teamName = ctx.message.text.replace('/resume', '').trim();
  if (!teamName) return ctx.reply("Utilise : /resume Real Madrid");

  try {
    const team = await findTeam(teamName);
    if (!team) return ctx.reply(`Équipe "${teamName}" introuvable.`);

    const lastMatch = await getLastFinishedMatch(team.id);
    if (!lastMatch) return ctx.reply(`Aucun match terminé trouvé pour ${team.name}.`);

    const events = await getMatchEvents(lastMatch.fixture.id);
    const date = new Date(lastMatch.fixture.date).toLocaleDateString('fr-FR');

    let text = `📝 Résumé — ${lastMatch.teams.home.name} ${lastMatch.goals.home}-${lastMatch.goals.away} ${lastMatch.teams.away.name} (${date})\n\n`;

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

// ==================== STATS D'UN JOUEUR ====================

bot.command('joueur', async (ctx) => {
  const name = ctx.message.text.replace('/joueur', '').trim();
  if (!name) return ctx.reply("Utilise : /joueur Kylian Mbappé");

  try {
    const results = await searchPlayer(name);
    if (results.length === 0) return ctx.reply(`Aucun joueur trouvé pour "${name}".`);

    const p = results[0];
    const stat = p.statistics[0];

    const text = `👤 ${p.player.name} (saison ${FALLBACK_SEASON}, plan gratuit)\n` +
      `Âge : ${p.player.age} | Nationalité : ${p.player.nationality}\n` +
      `Équipe : ${stat.team.name} (${stat.league.name})\n\n` +
      `Matchs joués : ${stat.games.appearences ?? 'N/A'}\n` +
      `Buts : ${stat.goals.total ?? 0} | Passes déc. : ${stat.goals.assists ?? 0}\n` +
      `Cartons jaunes : ${stat.cards.yellow ?? 0} | Cartons rouges : ${stat.cards.red ?? 0}`;

    return ctx.reply(text);
  } catch (error) {
    console.error(error.response?.data || error.message);
    return ctx.reply("Erreur lors de la récupération des infos joueur.");
  }
});

// ==================== ABONNEMENT AUX BUTS EN DIRECT ====================
// ⚠️ Consomme beaucoup de quota (surveillance périodique) : reste raisonnable sur le nombre d'équipes suivies.

const subscriptions = {}; // teamId -> Set(chatId)
const lastKnownState = {}; // fixtureId -> { home, away, status }
const POLL_INTERVAL_MINUTES = 30;

bot.command('suivre', async (ctx) => {
  const teamName = ctx.message.text.replace('/suivre', '').trim();
  if (!teamName) return ctx.reply("Utilise : /suivre Real Madrid");

  try {
    const team = await findTeam(teamName);
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
    const team = await findTeam(teamName);
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

bot.launch();
console.log('Bot en écoute.');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
