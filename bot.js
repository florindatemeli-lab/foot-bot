require('dotenv').config();
const { Bot } = require('node-telegram-bot-api');
const axios = require('axios');

const token = process.env.TELEGRAM_TOKEN;
const footballApiKey = process.env.FOOTBALL_API_KEY;

const bot = new Bot(token);

console.log('Bot démarré...');

// ==================== CACHE DES ÉQUIPES ====================

const COMPETITIONS = ['PL', 'PD', 'BL1', 'SA', 'FL1', 'CL', 'DED', 'PPL', 'ELC'];
let teamsCache = [];

async function loadTeamsCache() {
  console.log('Chargement du cache des équipes...');
  for (const comp of COMPETITIONS) {
    try {
      const res = await axios.get(`https://api.football-data.org/v4/competitions/${comp}/teams`, {
        headers: { 'X-Auth-Token': footballApiKey }
      });
      teamsCache.push(...res.data.teams);
      await new Promise(r => setTimeout(r, 6500));
    } catch (err) {
      console.error(`Erreur chargement ${comp}:`, err.response?.status || err.message);
    }
  }
  console.log(`Cache chargé : ${teamsCache.length} équipes.`);
}

function normalize(str) {
  return str.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

async function findTeam(name) {
  const query = normalize(name);
  return teamsCache.find(t =>
    normalize(t.name).includes(query) ||
    normalize(t.shortName || '').includes(query) ||
    normalize(t.tla || '').includes(query)
  ) || null;
}

// ==================== UTILITAIRES API ====================

async function getRecentMatches(teamId, limit = 5) {
  const res = await axios.get(`https://api.football-data.org/v4/teams/${teamId}/matches`, {
    headers: { 'X-Auth-Token': footballApiKey },
    params: { status: 'FINISHED', limit }
  });
  return res.data.matches || [];
}

async function getNextMatch(teamId) {
  const res = await axios.get(`https://api.football-data.org/v4/teams/${teamId}/matches`, {
    headers: { 'X-Auth-Token': footballApiKey },
    params: { status: 'SCHEDULED', limit: 1 }
  });
  return res.data.matches?.[0] || null;
}

async function getHeadToHead(teamAId, teamBId) {
  const res = await axios.get(`https://api.football-data.org/v4/teams/${teamAId}/matches`, {
    headers: { 'X-Auth-Token': footballApiKey },
    params: { status: 'FINISHED', limit: 50 }
  });
  return (res.data.matches || [])
    .filter(m => m.homeTeam.id === teamBId || m.awayTeam.id === teamBId)
    .slice(0, 5);
}

async function getLiveMatches() {
  const res = await axios.get('https://api.football-data.org/v4/matches', {
    headers: { 'X-Auth-Token': footballApiKey },
    params: { status: 'LIVE' }
  });
  return res.data.matches || [];
}

async function getMatchesByDate(dateStr) {
  const res = await axios.get('https://api.football-data.org/v4/matches', {
    headers: { 'X-Auth-Token': footballApiKey },
    params: { dateFrom: dateStr, dateTo: dateStr }
  });
  return res.data.matches || [];
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

// ==================== COMMANDES ====================

bot.command('start', (ctx) => {
  return ctx.reply(
    "⚽ Salut ! Je suis ton bot d'analyse foot.\n\n" +
    "Commandes disponibles :\n" +
    "/match <équipe> - prochain match d'une équipe\n" +
    "/live - scores en direct\n" +
    "/today - tous les matchs du jour\n\n" +
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
      text += `${m.homeTeam.name} ${m.score.fullTime.home ?? 0} - ${m.score.fullTime.away ?? 0} ${m.awayTeam.name}\n`;
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
  const teamName = ctx.match?.trim();

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

    const date = new Date(nextMatch.utcDate).toLocaleString('fr-FR', { dateStyle: 'full', timeStyle: 'short' });

    return ctx.reply(
      `⚽ ${team.name}\n\nProchain match :\n${nextMatch.homeTeam.name} vs ${nextMatch.awayTeam.name}\n📅 ${date}\n🏆 ${nextMatch.competition.name}`
    );
  } catch (error) {
    console.error(error.response?.data || error.message);
    return ctx.reply("Erreur lors de la récupération des infos.");
  }
});

// ==================== DÉTECTION DE DATE ====================

bot.hears(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/, async (ctx) => {
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

// ==================== DÉMARRAGE ====================

loadTeamsCache().then(() => {
  bot.startPolling();
  console.log('Bot en écoute.');
});
// redeploy trigger
