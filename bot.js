require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// =====================================================
// CONFIGURATION
// =====================================================

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const FOOTBALL_API_KEY = process.env.FOOTBALL_API_KEY;

if (!TELEGRAM_TOKEN) {
  console.error("❌ TELEGRAM_TOKEN manquant dans .env");
  process.exit(1);
}

if (!FOOTBALL_API_KEY) {
  console.error("❌ FOOTBALL_API_KEY manquant dans .env");
  process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_TOKEN, {
  polling: true
});

const API_URL = 'https://v3.football.api-sports.io';

const api = axios.create({
  baseURL: API_URL,
  headers: {
    'x-apisports-key': FOOTBALL_API_KEY,
    'Accept': 'application/json'
  },
  timeout: 15000
});

console.log('🤖 Bot Telegram démarré...');

// =====================================================
// OUTILS
// =====================================================

function normalize(text) {
  return String(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function formatDate(date) {
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Africa/Douala',
    dateStyle: 'full',
    timeStyle: 'short'
  }).format(new Date(date));
}

function shortDate(date) {
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Africa/Douala',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  }).format(new Date(date));
}

function getTeamName(fixture, side) {
  return fixture.teams?.[side]?.name || 'Inconnu';
}

function getScore(fixture, side) {
  return fixture.goals?.[side] ?? '-';
}

// =====================================================
// APPEL API
// =====================================================

async function apiGet(endpoint, params = {}) {
  try {
    const response = await api.get(endpoint, { params });

    if (response.data?.errors && Object.keys(response.data.errors).length > 0) {
      throw new Error(JSON.stringify(response.data.errors));
    }

    return response.data;
  } catch (error) {
    if (error.response) {
      console.error(
        `API ${error.response.status}:`,
        error.response.data
      );
    } else {
      console.error('Erreur API:', error.message);
    }

    throw error;
  }
}

// =====================================================
// RECHERCHE D'ÉQUIPE
// =====================================================

async function findTeam(name) {
  const data = await apiGet('/teams', {
    search: name
  });

  if (!data.response || data.response.length === 0) {
    return null;
  }

  const query = normalize(name);

  // Recherche exacte en priorité
  const exact = data.response.find(item => {
    return normalize(item.team.name) === query;
  });

  if (exact) {
    return exact.team;
  }

  // Sinon recherche approximative
  const approximate = data.response.find(item => {
    const teamName = normalize(item.team.name);

    return (
      teamName.includes(query) ||
      query.includes(teamName)
    );
  });

  return approximate?.team || data.response[0]?.team || null;
}

// =====================================================
// PROCHAINS MATCHS D'UNE ÉQUIPE
// =====================================================

async function getNextMatches(teamId, limit = 5) {
  const data = await apiGet('/fixtures', {
    team: teamId,
    next: limit
  });

  return data.response || [];
}

// =====================================================
// DERNIERS MATCHS D'UNE ÉQUIPE
// =====================================================

async function getRecentMatches(teamId, limit = 5) {
  const data = await apiGet('/fixtures', {
    team: teamId,
    last: limit
  });

  return data.response || [];
}

// =====================================================
// MATCHS D'UNE DATE
// =====================================================

async function getMatchesByDate(date) {
  const data = await apiGet('/fixtures', {
    date
  });

  return data.response || [];
}

// =====================================================
// MATCHS EN DIRECT
// =====================================================

async function getLiveMatches() {
  const data = await apiGet('/fixtures', {
    live: 'all'
  });

  return data.response || [];
}

// =====================================================
// H2H
// =====================================================

async function getHeadToHead(teamA, teamB, limit = 5) {
  const data = await apiGet('/fixtures/headtohead', {
    h2h: `${teamA}-${teamB}`,
    last: limit
  });

  return data.response || [];
}

// =====================================================
// STATISTIQUES D'UN MATCH
// =====================================================

async function getFixtureStatistics(fixtureId) {
  const data = await apiGet('/fixtures/statistics', {
    fixture: fixtureId
  });

  return data.response || [];
}

// =====================================================
// CALCUL DE LA FORME
// =====================================================

function calculateForm(matches, teamId) {
  let wins = 0;
  let draws = 0;
  let losses = 0;

  let goalsFor = 0;
  let goalsAgainst = 0;

  const form = [];

  for (const match of matches) {
    const isHome = match.teams.home.id === teamId;

    const gf = isHome
      ? match.goals.home
      : match.goals.away;

    const ga = isHome
      ? match.goals.away
      : match.goals.home;

    if (gf == null || ga == null) continue;

    goalsFor += gf;
    goalsAgainst += ga;

    if (gf > ga) {
      wins++;
      form.push('V');
    } else if (gf === ga) {
      draws++;
      form.push('N');
    } else {
      losses++;
      form.push('D');
    }
  }

  const total = wins + draws + losses || 1;

  return {
    wins,
    draws,
    losses,
    form: form.join(''),
    goalsFor,
    goalsAgainst,
    avgGoalsFor: (goalsFor / total).toFixed(2),
    avgGoalsAgainst: (goalsAgainst / total).toFixed(2)
  };
}

// =====================================================
// FORMAT H2H
// =====================================================

function formatH2H(matches) {
  if (!matches.length) {
    return 'Aucune confrontation récente trouvée.';
  }

  return matches.map(match => {
    const home = getTeamName(match, 'home');
    const away = getTeamName(match, 'away');

    const homeScore = getScore(match, 'home');
    const awayScore = getScore(match, 'away');

    return (
      `• ${shortDate(match.fixture.date)} : ` +
      `${home} ${homeScore}-${awayScore} ${away}`
    );
  }).join('\n');
}

// =====================================================
// FORMAT MATCHS
// =====================================================

function formatMatch(match) {
  const home = getTeamName(match, 'home');
  const away = getTeamName(match, 'away');

  const status = match.fixture.status.short;

  let score = '';

  if (
    ['FT', 'AET', 'PEN', 'HT', '1H', '2H'].includes(status)
  ) {
    score =
      `${getScore(match, 'home')}-${getScore(match, 'away')}`;
  }

  return (
    `⚽ ${home} - ${away}\n` +
    `🕐 ${formatDate(match.fixture.date)}\n` +
    `📊 Statut : ${match.fixture.status.long}` +
    (score ? `\n🔢 Score : ${score}` : '')
  );
}

// =====================================================
// /START
// =====================================================

bot.onText(/\/start/, async (msg) => {

  const text =
`⚽ Bienvenue sur mon bot d'analyse football !

Commandes disponibles :

/match <équipe>
➡️ Prochains matchs d'une équipe

/recent <équipe>
➡️ Derniers matchs et forme récente

/live
➡️ Matchs actuellement en direct

/today
➡️ Matchs du jour

/analyse <équipe1> vs <équipe2>
➡️ Analyse statistique du duel

/date JJ/MM/AAAA
➡️ Matchs d'une date précise

Exemple :

/match Real Madrid

/recent Barcelona

/analyse Real Madrid vs Barcelona

/date 20/09/2026
`;

  await bot.sendMessage(msg.chat.id, text);
});

// =====================================================
// /MATCH
// =====================================================

bot.onText(/\/match(?:\s+(.+))?/i, async (msg, match) => {

  const chatId = msg.chat.id;
  const name = match[1]?.trim();

  if (!name) {
    return bot.sendMessage(
      chatId,
      'Utilisation : /match Real Madrid'
    );
  }

  try {

    await bot.sendMessage(
      chatId,
      `🔎 Recherche de ${name}...`
    );

    const team = await findTeam(name);

    if (!team) {
      return bot.sendMessage(
        chatId,
        `❌ Équipe "${name}" introuvable.`
      );
    }

    const matches = await getNextMatches(team.id, 5);

    if (!matches.length) {
      return bot.sendMessage(
        chatId,
        `Aucun prochain match trouvé pour ${team.name}.`
      );
    }

    let text =
      `⚽ ${team.name}\n\n` +
      `📅 Prochains matchs :\n\n`;

    matches.forEach((m, index) => {

      text +=
        `${index + 1}. ` +
        `${m.teams.home.name} vs ${m.teams.away.name}\n` +
        `🕐 ${formatDate(m.fixture.date)}\n` +
        `🏆 ${m.league.name}\n\n`;
    });

    return bot.sendMessage(chatId, text);

  } catch (error) {

    return bot.sendMessage(
      chatId,
      '❌ Impossible de récupérer les prochains matchs.'
    );
  }
});

// =====================================================
// /RECENT
// =====================================================

bot.onText(/\/recent(?:\s+(.+))?/i, async (msg, match) => {

  const chatId = msg.chat.id;
  const name = match[1]?.trim();

  if (!name) {
    return bot.sendMessage(
      chatId,
      'Utilisation : /recent Real Madrid'
    );
  }

  try {

    const team = await findTeam(name);

    if (!team) {
      return bot.sendMessage(
        chatId,
        `❌ Équipe "${name}" introuvable.`
      );
    }

    const matches = await getRecentMatches(team.id, 5);

    const stats = calculateForm(matches, team.id);

    let text =
`📊 ${team.name}

📈 FORME — 5 derniers matchs
${stats.form || 'N/A'}

🟢 Victoires : ${stats.wins}
🟡 Nuls : ${stats.draws}
🔴 Défaites : ${stats.losses}

⚽ Buts marqués : ${stats.goalsFor}
🥅 Buts encaissés : ${stats.goalsAgainst}

📊 Moyenne buts marqués : ${stats.avgGoalsFor}
📊 Moyenne buts encaissés : ${stats.avgGoalsAgainst}

📝 Derniers matchs :

`;

    matches.forEach(m => {
      text +=
        `${m.teams.home.name} ` +
        `${m.goals.home ?? '-'}-${m.goals.away ?? '-'} ` +
        `${m.teams.away.name}\n`;
    });

    return bot.sendMessage(chatId, text);

  } catch (error) {

    return bot.sendMessage(
      chatId,
      '❌ Erreur pendant la récupération des statistiques.'
    );
  }
});

// =====================================================
// /LIVE
// =====================================================

bot.onText(/\/live/, async (msg) => {

  const chatId = msg.chat.id;

  try {

    const matches = await getLiveMatches();

    if (!matches.length) {
      return bot.sendMessage(
        chatId,
        '🔴 Aucun match en direct actuellement.'
      );
    }

    let text = '🔴 MATCHS EN DIRECT\n\n';

    matches.slice(0, 30).forEach(match => {

      const status = match.fixture.status.short;

      text +=
        `⚽ ${match.teams.home.name} ` +
        `${match.goals.home ?? 0}-${match.goals.away ?? 0} ` +
        `${match.teams.away.name}\n` +
        `⏱️ ${status}`;

      if (match.fixture.status.elapsed) {
        text += ` ${match.fixture.status.elapsed}'`;
      }

      text += '\n\n';
    });

    return bot.sendMessage(chatId, text);

  } catch (error) {

    return bot.sendMessage(
      chatId,
      '❌ Erreur lors de la récupération des matchs en direct.'
    );
  }
});

// =====================================================
// /TODAY
// =====================================================

bot.onText(/\/today/, async (msg) => {

  const chatId = msg.chat.id;

  try {

    const today = new Intl.DateTimeFormat(
      'en-CA',
      {
        timeZone: 'Africa/Douala',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }
    ).format(new Date());

    const matches = await getMatchesByDate(today);

    if (!matches.length) {
      return bot.sendMessage(
        chatId,
        '📅 Aucun match trouvé aujourd’hui.'
      );
    }

    let text =
      `📅 MATCHS DU ${today}\n\n`;

    matches.slice(0, 40).forEach(m => {

      text +=
        `🏆 ${m.league.name}\n` +
        `⚽ ${m.teams.home.name} vs ${m.teams.away.name}\n` +
        `🕐 ${formatDate(m.fixture.date)}\n\n`;
    });

    if (text.length > 4000) {
      text = text.substring(0, 3900) +
        '\n\n... Liste raccourcie.';
    }

    return bot.sendMessage(chatId, text);

  } catch (error) {

    return bot.sendMessage(
      chatId,
      '❌ Erreur lors de la récupération des matchs.'
    );
  }
});

// =====================================================
// /DATE
// =====================================================

bot.onText(
  /\/date\s+(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/i,
  async (msg, match) => {

    const chatId = msg.chat.id;

    const day = match[1].padStart(2, '0');
    const month = match[2].padStart(2, '0');
    const year = match[3];

    const date = `${year}-${month}-${day}`;

    try {

      const matches = await getMatchesByDate(date);

      if (!matches.length) {
        return bot.sendMessage(
          chatId,
          `📅 Aucun match trouvé le ${day}/${month}/${year}.`
        );
      }

      let text =
        `📅 MATCHS DU ${day}/${month}/${year}\n\n`;

      matches.slice(0, 40).forEach(m => {

        text +=
          `🏆 ${m.league.name}\n` +
          `⚽ ${m.teams.home.name} vs ${m.teams.away.name}\n` +
          `🕐 ${formatDate(m.fixture.date)}\n\n`;
      });

      if (text.length > 4000) {
        text = text.substring(0, 3900) +
          '\n\n... Liste raccourcie.';
      }

      return bot.sendMessage(chatId, text);

    } catch (error) {

      return bot.sendMessage(
        chatId,
        '❌ Erreur lors de la recherche.'
      );
    }
  }
);

// =====================================================
// /ANALYSE
// =====================================================

bot.onText(
  /\/analyse\s+(.+?)\s+vs\s+(.+)/i,
  async (msg, match) => {

    const chatId = msg.chat.id;

    const nameA = match[1].trim();
    const nameB = match[2].trim();

    try {

      await bot.sendMessage(
        chatId,
        `🔍 Analyse de ${nameA} vs ${nameB}...`
      );

      // Recherche des deux équipes
      const [teamA, teamB] = await Promise.all([
        findTeam(nameA),
        findTeam(nameB)
      ]);

      if (!teamA || !teamB) {

        return bot.sendMessage(
          chatId,
          '❌ Une des deux équipes est introuvable.'
        );
      }

      // Récupération des données
      const [
        recentA,
        recentB,
        h2h
      ] = await Promise.all([
        getRecentMatches(teamA.id, 5),
        getRecentMatches(teamB.id, 5),
        getHeadToHead(teamA.id, teamB.id, 5)
      ]);

      const statsA =
        calculateForm(recentA, teamA.id);

      const statsB =
        calculateForm(recentB, teamB.id);

      // -------------------------------------------------
      // ANALYSE
      // -------------------------------------------------

      const totalGoalsA =
        statsA.goalsFor + statsA.goalsAgainst;

      const totalGoalsB =
        statsB.goalsFor + statsB.goalsAgainst;

      const avgTotalA =
        (
          parseFloat(statsA.avgGoalsFor) +
          parseFloat(statsA.avgGoalsAgainst)
        ).toFixed(2);

      const avgTotalB =
        (
          parseFloat(statsB.avgGoalsFor) +
          parseFloat(statsB.avgGoalsAgainst)
        ).toFixed(2);

      const text =
`📊 ANALYSE FOOTBALL

⚽ ${teamA.name}
vs
⚽ ${teamB.name}

━━━━━━━━━━━━━━━━

📈 FORME RÉCENTE

${teamA.name}
${statsA.form}
🟢 ${statsA.wins} victoires
🟡 ${statsA.draws} nuls
🔴 ${statsA.losses} défaites

${teamB.name}
${statsB.form}
🟢 ${statsB.wins} victoires
🟡 ${statsB.draws} nuls
🔴 ${statsB.losses} défaites

━━━━━━━━━━━━━━━━

⚽ MOYENNES DE BUTS

${teamA.name}
➡️ ${statsA.avgGoalsFor} marqué(s)
➡️ ${statsA.avgGoalsAgainst} encaissé(s)

${teamB.name}
➡️ ${statsB.avgGoalsFor} marqué(s)
➡️ ${statsB.avgGoalsAgainst} encaissé(s)

━━━━━━━━━━━━━━━━

📊 VOLUME DE BUTS RÉCENT

${teamA.name} : ${avgTotalA}
${teamB.name} : ${avgTotalB}

━━━━━━━━━━━━━━━━

🤝 5 DERNIÈRES CONFRONTATIONS

${formatH2H(h2h)}

━━━━━━━━━━━━━━━━

ℹ️ Cette analyse repose sur les données disponibles
dans API-Football : résultats récents, buts et
confrontations directes.

Elle ne tient pas compte de tous les éléments
pouvant influencer un match, comme les compositions
officielles ou certains changements de dernière minute.`;

      return bot.sendMessage(chatId, text);

    } catch (error) {

      console.error(error);

      return bot.sendMessage(
        chatId,
        '❌ Une erreur est survenue pendant l’analyse.'
      );
    }
  }
);

// =====================================================
// MATCH DIRECT "ÉQUIPE VS ÉQUIPE"
// =====================================================

bot.onText(
  /^(.+?)\s+vs\s+(.+)$/i,
  async (msg, match) => {

    const chatId = msg.chat.id;

    const nameA = match[1].trim();
    const nameB = match[2].trim();

    // Évite de traiter les commandes /analyse
    if (
      nameA.toLowerCase().startsWith('/analyse')
    ) {
      return;
    }

    try {

      const [teamA, teamB] = await Promise.all([
        findTeam(nameA),
        findTeam(nameB)
      ]);

      if (!teamA || !teamB) {

        return bot.sendMessage(
          chatId,
          '❌ Je n’ai pas trouvé une des deux équipes.'
        );
      }

      return bot.sendMessage(
        chatId,
        `💡 Pour lancer l'analyse complète :\n\n` +
        `/analyse ${teamA.name} vs ${teamB.name}`
      );

    } catch (error) {

      return bot.sendMessage(
        chatId,
        '❌ Erreur lors de la recherche des équipes.'
      );
    }
  }
);

// =====================================================
// ERREURS POLLING
// =====================================================

bot.on('polling_error', (error) => {
  console.error('Telegram polling error:', error.message);
});

// =====================================================
// MESSAGE DE DÉMARRAGE
// =====================================================

console.log('✅ Bot en écoute...');
