const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ═══════════════════════════════
// QUIZ PERSISTENCE (server-side)
// ═══════════════════════════════

const QUIZZES_FILE = path.join(__dirname, 'quizzes.json');

function readQuizzes() {
  try {
    if (fs.existsSync(QUIZZES_FILE)) {
      return JSON.parse(fs.readFileSync(QUIZZES_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Error reading quizzes.json:', e.message);
  }
  return [];
}

function writeQuizzes(quizzes) {
  try {
    fs.writeFileSync(QUIZZES_FILE, JSON.stringify(quizzes, null, 2));
  } catch (e) {
    console.error('Error writing quizzes.json:', e.message);
  }
}

// GET  /api/quizzes         — return all saved quizzes
app.get('/api/quizzes', (req, res) => {
  res.json(readQuizzes());
});

// POST /api/quizzes         — create or overwrite a quiz by name
app.post('/api/quizzes', (req, res) => {
  const { name, questions } = req.body;
  if (!name || !Array.isArray(questions)) {
    return res.status(400).json({ error: 'name and questions required' });
  }
  const quizzes = readQuizzes();
  const idx = quizzes.findIndex(q => q.name === name);
  const quiz = { name, questions, savedAt: new Date().toISOString() };
  if (idx >= 0) quizzes[idx] = quiz;
  else quizzes.push(quiz);
  writeQuizzes(quizzes);
  res.json({ success: true });
});

// DELETE /api/quizzes/:name — remove a quiz by name
app.delete('/api/quizzes/:name', (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const quizzes = readQuizzes().filter(q => q.name !== name);
  writeQuizzes(quizzes);
  res.json({ success: true });
});

// ── AI Quiz Generation ──
app.post('/api/generate-quiz', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(400).json({ error: 'AI not configured. Ask the host to set the ANTHROPIC_API_KEY environment variable on the server.' });
  }

  const { theme, count } = req.body;
  if (!theme || !count) {
    return res.status(400).json({ error: 'Theme and question count are required.' });
  }

  const prompt = `Generate a fun party quiz with exactly ${count} questions about "${theme}".

Return ONLY a JSON array. Use a mix of these types:

1. "open" — player types the answer, auto-graded:
   {"type":"open","question":"...","hostAnswer":"correct answer","timeLimit":30,"maxPoints":1000}

2. "choice" — pick from 4 options:
   {"type":"choice","question":"...","options":["A","B","C","D"],"correctIndex":0,"timeLimit":30,"maxPoints":1000}

3. "truefalse" — true or false:
   {"type":"truefalse","question":"statement...","correctIndex":0,"timeLimit":20,"maxPoints":1000}
   (correctIndex 0 = True, 1 = False)

4. "consensus" — opinion/debate, players vote for best answer:
   {"type":"consensus","question":"fun opinion question about ${theme}?","hostAnswer":"a witty answer","timeLimit":90}

Rules:
- Include at least one of each type if count >= 4, otherwise mix freely
- Make questions fun, varied in difficulty, and engaging for a group
- For consensus questions, make them opinion-based or debatable
- Return ONLY the raw JSON array, no markdown, no explanation`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error('Anthropic API error:', response.status, errBody);
      return res.status(500).json({ error: 'AI service error. Check your API key.' });
    }

    const data = await response.json();
    const text = data.content[0].text.trim();

    // Extract JSON array from response (handle potential markdown wrapping)
    let jsonStr = text;
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) jsonStr = jsonMatch[0];

    const questions = JSON.parse(jsonStr);
    if (!Array.isArray(questions)) throw new Error('Not an array');

    res.json({ questions });
  } catch (err) {
    console.error('AI generation error:', err.message);
    res.status(500).json({ error: 'Failed to generate quiz. Try again.' });
  }
});

const rooms = {};
const sfRooms = {};
const seqRooms = {};
const SF_ACCUSATION_TIMERS = {};

// ── Spyfall Locations ──
const SPYFALL_LOCATIONS = [
  { name: 'Hospital',       roles: ['Doctor','Nurse','Patient','Surgeon','Receptionist','Paramedic','Security Guard','Janitor'] },
  { name: 'Space Station',  roles: ['Astronaut','Commander','Engineer','Scientist','Mission Control','Medic','Cook','Robot'] },
  { name: 'Casino',         roles: ['Dealer','Security Guard','Bartender','High Roller','Pit Boss','Gambler','Manager','Entertainer'] },
  { name: 'Beach Resort',   roles: ['Lifeguard','Tourist','Bartender','Hotel Manager','Surfer','Vendor','Photographer','Scuba Instructor'] },
  { name: 'Military Base',  roles: ['Private','Sergeant','General','Medic','Intelligence Officer','Cook','Guard','Drill Instructor'] },
  { name: 'Police Station', roles: ['Detective','Officer','Chief','Criminal','Lawyer','Forensic Specialist','Receptionist','Informant'] },
  { name: 'Restaurant',     roles: ['Chef','Waiter','Manager','Food Critic','Customer','Dishwasher','Sommelier','Host'] },
  { name: 'School',         roles: ['Teacher','Principal','Student','Janitor','Coach','Librarian','Security Guard','Counselor'] },
  { name: 'Movie Studio',   roles: ['Director','Actor','Camera Operator','Producer','Stunt Double','Makeup Artist','Writer','Extra'] },
  { name: 'Submarine',      roles: ['Captain','Navigator','Engineer','Cook','Torpedo Officer','Medic','Sonar Operator','Electrician'] },
  { name: 'Bank',           roles: ['Manager','Teller','Security Guard','Loan Officer','Customer','Accountant','Robber','IT Specialist'] },
  { name: 'Circus',         roles: ['Acrobat','Clown','Ringmaster','Lion Tamer','Magician','Juggler','Ticket Seller','Vendor'] },
  { name: 'Pirate Ship',    roles: ['Captain','First Mate','Navigator','Cook','Cannoneer','Lookout','Prisoner','Surgeon'] },
  { name: 'Cruise Ship',    roles: ['Captain','Passenger','Bartender','Entertainment Director','Chef','Housekeeper','Doctor','Waiter'] },
  { name: 'Museum',         roles: ['Curator','Tour Guide','Security Guard','Visitor','Historian','Restorer','Thief','Gift Shop Worker'] },
  { name: 'Airport',        roles: ['Pilot','Flight Attendant','Security Officer','Passenger','Air Traffic Controller','Baggage Handler','Check-in Agent','Customs Officer'] },
  { name: 'Supermarket',    roles: ['Cashier','Manager','Stock Boy','Customer','Security Guard','Baker','Butcher','Delivery Driver'] },
  { name: 'Library',        roles: ['Librarian','Student','Researcher','Author','Janitor','Security Guard','Story Reader','Lost Tourist'] },
  { name: 'Zoo',            roles: ['Zookeeper','Vet','Tour Guide','Visitor','Photographer','Trainer','Manager','Maintenance Worker'] },
  { name: 'Football Stadium', roles: ['Quarterback','Coach','Referee','Spectator','Cheerleader','Commentator','Security Guard','Vendor'] },
  { name: 'Airplane',       roles: ['Pilot','Co-Pilot','Flight Attendant','Passenger','Air Marshal','Mechanic','First Class Passenger','Customs Agent'] },
  { name: 'Day Spa',        roles: ['Masseuse','Receptionist','Manager','Customer','Manicurist','Yoga Instructor','Nutritionist','Sauna Attendant'] },
  { name: 'University',     roles: ['Professor','Student','Dean','Janitor','Librarian','Coach','Graduate Student','Security Guard'] },
  { name: 'Corporate Office', roles: ['CEO','Secretary','IT Specialist','Intern','Sales Manager','Accountant','Security Guard','Janitor'] },
  { name: 'Haunted House',  roles: ['Ghost','Witch','Monster','Frightened Visitor','Tour Guide','Actor','Owner','Paranormal Investigator'] },
  { name: 'Train Station',  roles: ['Conductor','Passenger','Station Master','Pickpocket','Police Officer','Cleaner','Ticket Inspector','Vendor'] },
  { name: 'Hotel',          roles: ['Receptionist','Guest','Bellboy','Housekeeper','Manager','Chef','Security Guard','Concierge'] },
  { name: 'Amusement Park', roles: ['Ride Operator','Visitor','Manager','Cotton Candy Seller','Security Guard','Mascot','Game Attendant','Maintenance Worker'] },
  { name: 'Night Club',     roles: ['DJ','Bartender','Bouncer','Clubber','VIP Guest','Manager','Coat Check','Promoter'] },
  { name: 'Ski Resort',     roles: ['Ski Instructor','Skier','Snowboarder','Lodge Manager','Ski Patrol','Lift Operator','Chef','Equipment Rental Staff'] },
];

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms[code] || sfRooms[code] || seqRooms[code]);
  return code;
}

// Get only actual players (not host)
function getPlayers(room) {
  return room.players.filter(p => p.id !== room.admin.id);
}

function getActivePlayers(room) {
  return room.players.filter(p => p.id !== room.admin.id && !p.disconnected);
}

function playerData(p) {
  return { name: p.name, score: p.score, avatar: p.avatar, disconnected: !!p.disconnected };
}

function normalizeAnswer(answer) {
  return answer.trim().toLowerCase().replace(/\s+/g, ' ');
}

// Send current game state to a reconnecting player
function sendGameState(socket, room) {
  if (!room.currentQuestion) return; // in lobby, nothing to send

  const qData = room.currentQuestion;
  const payload = {
    type: qData.type,
    question: qData.question,
    round: room.round,
    totalQuestions: room.totalQuestions,
    timeLimit: qData.timeLimit || 30,
  };
  if (qData.type === 'choice') payload.options = qData.options;
  else if (qData.type === 'truefalse') payload.options = ['True', 'False'];

  if (room.phase === 'answering') {
    // Send the question — they can still answer if time remains
    io.to(socket.id).emit('new-question', payload);
  } else if (room.phase === 'voting') {
    // Player reconnected mid-vote — show a holding screen, they'll join next round
    io.to(socket.id).emit('rejoin-waiting', {
      phase: 'voting',
      questionsRemaining: room.questionQueue.length,
    });
  } else if (room.phase === 'results' || room.phase === 'lobby') {
    io.to(socket.id).emit('rejoin-waiting', {
      phase: room.phase,
      questionsRemaining: room.questionQueue.length,
    });
  }
}

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  // ── Create room ──
  socket.on('create-room', (data, callback) => {
    const { name, avatar } = data;
    const code = generateRoomCode();
    rooms[code] = {
      admin: { id: socket.id, name, avatar: avatar || '🦊' },
      players: [],
      phase: 'lobby',
      questionQueue: [],
      totalQuestions: 0,
      currentQuestion: null,
      answers: {},
      votes: {},
      round: 0,
      timer: null,
      roundStartTime: null,
      gameHistory: [],
    };
    socket.join(code);
    socket.roomCode = code;
    socket.playerName = name;
    callback({ success: true, code });
    io.to(code).emit('player-list', getPlayers(rooms[code]).map(playerData));
  });

  // ── Host uploads preloaded questions ──
  socket.on('load-questions', (questions) => {
    const room = rooms[socket.roomCode];
    if (!room || room.admin.id !== socket.id) return;
    room.questionQueue = questions.map(q => ({ ...q }));
    room.totalQuestions = questions.length;
  });

  // ── Create Spyfall Room ──
  socket.on('create-sf-room', (data, callback) => {
    const { name, avatar, gameDuration } = data;
    const code = generateRoomCode();
    sfRooms[code] = {
      admin: { id: socket.id, name, avatar: avatar || '🦊' },
      players: [],
      phase: 'lobby',
      location: null,
      spyId: null,
      timer: null,
      timeRemaining: 0,
      gameDuration: gameDuration || 480,
      chat: [],
      accusation: null,
      round: 0,
    };
    socket.join(code);
    socket.roomCode = code;
    socket.playerName = name;
    callback({ success: true, code });
  });

  // ── Player joins ──
  socket.on('join-room', (data, callback) => {
    const { code, name, avatar } = data;
    const room = rooms[code];

    // ── Check if it's a Spyfall room ──
    if (!room) {
      const sfRoom = sfRooms[code];
      if (sfRoom) {
        const existing = sfRoom.players.find(p => p.name.toLowerCase() === name.toLowerCase());
        if (existing) {
          if (existing.disconnected) {
            clearTimeout(existing.disconnectTimer);
            existing.id = socket.id;
            existing.avatar = avatar || existing.avatar;
            existing.disconnected = false;
            delete existing.disconnectTimer;
            socket.join(code);
            socket.roomCode = code;
            socket.playerName = name;
            callback({ success: true, reconnected: true, gameType: 'spyfall' });
            io.to(code).emit('sf-player-list', sfRoom.players.map(playerData));
            return;
          }
          return callback({ success: false, error: 'Name already taken' });
        }
        if (sfRoom.phase !== 'lobby') return callback({ success: false, error: 'Game already in progress' });
        sfRoom.players.push({ id: socket.id, name, avatar: avatar || '🦊', score: 0 });
        socket.join(code);
        socket.roomCode = code;
        socket.playerName = name;
        callback({ success: true, gameType: 'spyfall' });
        io.to(code).emit('sf-player-list', sfRoom.players.map(playerData));
        return;
      }
      // ── Check if it's a Sequence room ──
      const seqRoom = seqRooms[code];
      if (seqRoom) {
        const existingSeq = seqRoom.players.find(p => p.name.toLowerCase() === name.toLowerCase());
        if (existingSeq) {
          if (existingSeq.disconnected) {
            // Reconnect — update socket id everywhere (players array + seqPlayers)
            clearTimeout(existingSeq.disconnectTimer);
            const oldId = existingSeq.id;
            existingSeq.id = socket.id;
            existingSeq.avatar = avatar || existingSeq.avatar;
            existingSeq.disconnected = false;
            delete existingSeq.disconnectTimer;
            // Also patch seqPlayers so turn checks work
            const sp = seqRoom.seqPlayers.find(p => p.id === oldId);
            if (sp) sp.id = socket.id;
            // Patch hands keyed by socket.id
            if (seqRoom.hands[oldId]) {
              seqRoom.hands[socket.id] = seqRoom.hands[oldId];
              delete seqRoom.hands[oldId];
            }
            socket.join(code);
            socket.roomCode = code;
            socket.playerName = name;
            callback({ success: true, reconnected: true, gameType: 'sequence' });
            io.to(code).emit('seq-player-list', seqRoom.players.map(playerData));
            // Send full game state if game is active
            if (seqRoom.phase === 'playing' && seqRoom.board) {
              const mySp = seqRoom.seqPlayers.find(p => p.id === socket.id);
              const turnPlayerId = seqRoom.seqPlayers[seqRoom.turnIdx]
                ? seqRoom.seqPlayers[seqRoom.turnIdx].id : '';
              io.to(socket.id).emit('seq-game-start', {
                board: seqBoardState(seqRoom.board),
                hand: seqRoom.hands[socket.id] || [],
                myTeam: mySp ? mySp.teamIdx : 0,
                teamNames: seqRoom.teamNames,
                players: seqRoom.seqPlayers,
                turnPlayerId,
                seqCounts: seqRoom.seqCounts,
                mode: seqRoom.mode,
                reconnected: true,
              });
            }
            return;
          }
          return callback({ success: false, error: 'Name already taken' });
        }
        if (seqRoom.phase !== 'lobby') return callback({ success: false, error: 'Game already in progress' });
        seqRoom.players.push({ id: socket.id, name, avatar: avatar || '🦊', score: 0 });
        socket.join(code);
        socket.roomCode = code;
        socket.playerName = name;
        callback({ success: true, gameType: 'sequence' });
        io.to(code).emit('seq-player-list', seqRoom.players.map(playerData));
        return;
      }
      return callback({ success: false, error: 'Room not found' });
    }

    if (!room) return callback({ success: false, error: 'Room not found' });

    // Check if this player is reconnecting (same name, was disconnected)
    const existing = room.players.find(p => p.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      if (existing.disconnected) {
        // Reconnecting — restore session
        clearTimeout(existing.disconnectTimer);
        existing.id = socket.id;
        existing.avatar = avatar || existing.avatar;
        existing.disconnected = false;
        delete existing.disconnectTimer;
        socket.join(code);
        socket.roomCode = code;
        socket.playerName = name;
        callback({ success: true, reconnected: true, score: existing.score });
        io.to(code).emit('player-list', getPlayers(room).map(playerData));

        // Send current game state so they can rejoin the active screen
        sendGameState(socket, room);
        return;
      }
      return callback({ success: false, error: 'Name already taken' });
    }

    if (room.phase !== 'lobby') {
      // Allow a player who was in this game to rejoin even after their grace period expired
      const formerKey = name.toLowerCase();
      const former = room.formerPlayers && room.formerPlayers[formerKey];
      if (!former) return callback({ success: false, error: 'Game already in progress' });
      // Restore them
      delete room.formerPlayers[formerKey];
      room.players.push({ id: socket.id, name: former.name, avatar: avatar || former.avatar, score: former.score });
      socket.join(code);
      socket.roomCode = code;
      socket.playerName = former.name;
      callback({ success: true, reconnected: true, score: former.score });
      io.to(code).emit('player-list', getPlayers(room).map(playerData));
      sendGameState(socket, room);
      return;
    }

    room.players.push({ id: socket.id, name, avatar: avatar || '🦊', score: 0 });
    socket.join(code);
    socket.roomCode = code;
    socket.playerName = name;
    callback({ success: true });
    io.to(code).emit('player-list', getPlayers(room).map(playerData));
  });

  // ── Start a question (null = next from queue) ──
  socket.on('start-question', () => {
    const room = rooms[socket.roomCode];
    if (!room || room.admin.id !== socket.id) return;

    const qData = room.questionQueue.shift();
    if (!qData) return;

    room.round++;
    room.answers = {};
    room.votes = {};
    room.currentQuestion = qData;
    room.phase = 'answering';
    room.roundStartTime = Date.now();

    const payload = {
      type: qData.type,
      question: qData.question,
      round: room.round,
      totalQuestions: room.totalQuestions,
      timeLimit: qData.timeLimit || 30,
    };

    if (qData.type === 'choice') {
      payload.options = qData.options;
    } else if (qData.type === 'truefalse') {
      payload.options = ['True', 'False'];
    }

    // Send host the spectator view, players the question
    io.to(room.admin.id).emit('host-question-view', payload);
    for (const p of getActivePlayers(room)) {
      io.to(p.id).emit('new-question', payload);
    }

    startTimer(socket.roomCode, qData.timeLimit || 30);
  });

  // ── Player submits answer (host blocked) ──
  socket.on('submit-answer', (answer) => {
    const room = rooms[socket.roomCode];
    if (!room || room.phase !== 'answering') return;
    if (socket.id === room.admin.id) return; // host cannot answer
    if (room.answers[socket.id]) return;

    const elapsed = (Date.now() - room.roundStartTime) / 1000;
    room.answers[socket.id] = {
      name: socket.playerName,
      answer,
      elapsed,
    };

    const answered = Object.keys(room.answers).length;
    const total = getActivePlayers(room).length;
    io.to(socket.roomCode).emit('answer-count', { answered, total });

    if (answered >= total) {
      clearTimer(socket.roomCode);
      handleAllAnswered(socket.roomCode);
    }
  });

  // ── Admin force-starts voting (consensus only) ──
  socket.on('force-voting', () => {
    const room = rooms[socket.roomCode];
    if (!room || room.admin.id !== socket.id) return;
    if (room.phase === 'answering' && room.currentQuestion.type === 'consensus') {
      clearTimer(socket.roomCode);
      const playerAnswerCount = Object.keys(room.answers).length;
      const minNeeded = room.currentQuestion.hostAnswer ? 1 : 2;
      if (playerAnswerCount >= minNeeded) {
        startVoting(socket.roomCode);
      } else {
        showConsensusResults(socket.roomCode);
      }
    }
  });

  // ── Player votes (host blocked) ──
  socket.on('submit-vote', (votedForId) => {
    const room = rooms[socket.roomCode];
    if (!room || room.phase !== 'voting') return;
    if (socket.id === room.admin.id) return; // host cannot vote
    if (votedForId === socket.id) return;
    room.votes[socket.id] = votedForId;

    const eligibleVoters = Object.keys(room.answers);
    const votesIn = Object.keys(room.votes).length;
    io.to(socket.roomCode).emit('vote-count', { voted: votesIn, total: eligibleVoters.length });

    if (votesIn >= eligibleVoters.length) {
      showConsensusResults(socket.roomCode);
    }
  });

  // ── Admin force-shows results ──
  socket.on('force-results', () => {
    const room = rooms[socket.roomCode];
    if (!room || room.admin.id !== socket.id) return;
    if (room.phase === 'voting') {
      showConsensusResults(socket.roomCode);
    }
  });

  // ── Next round / game over ──
  socket.on('next-round', () => {
    const room = rooms[socket.roomCode];
    if (!room || room.admin.id !== socket.id) return;
    room.phase = 'lobby';
    room.currentQuestion = null;
    room.answers = {};
    room.votes = {};

    if (room.questionQueue.length === 0) {
      // Game over — send summary
      io.to(socket.roomCode).emit('game-over', {
        history: room.gameHistory,
        finalStandings: room.players
          .map(p => ({ name: p.name, avatar: p.avatar, score: p.score }))
          .sort((a, b) => b.score - a.score),
      });
    } else {
      io.to(socket.roomCode).emit('back-to-lobby', {
        players: room.players.map(playerData),
        questionsRemaining: room.questionQueue.length,
      });
    }
  });

  // ── Spyfall: Start Game ──
  socket.on('sf-start-game', (opts) => {
    const code = socket.roomCode;
    const room = sfRooms[code];
    if (!room || room.admin.id !== socket.id) return;
    const activePlayers = room.players.filter(p => !p.disconnected);
    if (activePlayers.length < 2) {
      io.to(socket.id).emit('sf-error', { message: 'Need at least 2 players to start Spyfall!' });
      return;
    }

    const locData = SPYFALL_LOCATIONS[Math.floor(Math.random() * SPYFALL_LOCATIONS.length)];
    room.location = locData.name;
    const spyIndex = Math.floor(Math.random() * activePlayers.length);
    room.spyId = activePlayers[spyIndex].id;

    const shuffledRoles = [...locData.roles].sort(() => Math.random() - 0.5);
    room.phase = 'playing';
    room.timeRemaining = (opts && opts.duration) ? opts.duration : room.gameDuration;
    room.chat = [];
    room.accusation = null;
    room.round++;

    let roleIdx = 0;
    for (const player of activePlayers) {
      const isSpy = player.id === room.spyId;
      io.to(player.id).emit('sf-role', {
        isSpy,
        location: isSpy ? null : room.location,
        role: isSpy ? null : shuffledRoles[roleIdx++ % shuffledRoles.length],
        allLocations: isSpy ? SPYFALL_LOCATIONS.map(l => l.name) : null,
        playerCount: activePlayers.length,
        round: room.round,
      });
    }

    // Admin sees everything
    io.to(room.admin.id).emit('sf-admin-view', {
      location: room.location,
      spyId: room.spyId,
      round: room.round,
      players: activePlayers.map((p, i) => ({
        id: p.id, name: p.name, avatar: p.avatar,
        isSpy: p.id === room.spyId,
        role: p.id === room.spyId ? '🕵️ THE SPY' : shuffledRoles[i % shuffledRoles.length],
      })),
    });

    sfStartTimer(code);
  });

  // ── Spyfall: Chat ──
  socket.on('sf-send-chat', (message) => {
    const code = socket.roomCode;
    const room = sfRooms[code];
    if (!room || room.phase !== 'playing') return;
    if (!message || !message.trim()) return;
    const isAdmin = socket.id === room.admin.id;
    const player = room.players.find(p => p.id === socket.id);
    const sender = isAdmin ? room.admin : player;
    if (!sender) return;
    const msg = {
      senderId: socket.id,
      name: sender.name,
      avatar: sender.avatar,
      text: message.trim().slice(0, 200),
      ts: Date.now(),
    };
    room.chat.push(msg);
    if (room.chat.length > 150) room.chat.shift();
    io.to(code).emit('sf-chat-message', msg);
  });

  // ── Spyfall: Call Accusation ──
  socket.on('sf-call-accusation', (accusedId) => {
    const code = socket.roomCode;
    const room = sfRooms[code];
    if (!room || room.phase !== 'playing') return;
    if (socket.id === room.admin.id) return;
    if (accusedId === socket.id) return;
    const accused = room.players.find(p => p.id === accusedId && !p.disconnected);
    if (!accused) return;

    sfClearTimer(code);
    room.phase = 'accusation';
    room.accusation = {
      accuserId: socket.id,
      accuserName: socket.playerName,
      accusedId,
      accusedName: accused.name,
      accusedAvatar: accused.avatar,
      votes: {},
    };

    io.to(code).emit('sf-accusation-called', {
      accuserName: socket.playerName,
      accusedId,
      accusedName: accused.name,
      accusedAvatar: accused.avatar,
    });

    sfStartAccusationTimer(code, 30);
  });

  // ── Spyfall: Vote on Accusation ──
  socket.on('sf-accusation-vote', (guilty) => {
    const code = socket.roomCode;
    const room = sfRooms[code];
    if (!room || room.phase !== 'accusation') return;
    if (socket.id === room.admin.id) return;
    if (room.accusation.votes[socket.id] !== undefined) return;

    room.accusation.votes[socket.id] = !!guilty;
    const voters = room.players.filter(p => !p.disconnected);
    const votesIn = Object.keys(room.accusation.votes).length;
    io.to(code).emit('sf-accusation-vote-count', { voted: votesIn, total: voters.length });

    if (votesIn >= voters.length) {
      sfClearAccusationTimer(code);
      sfResolveAccusation(code);
    }
  });

  // ── Spyfall: Spy Guesses Location ──
  socket.on('sf-spy-guess', (guess) => {
    const code = socket.roomCode;
    const room = sfRooms[code];
    if (!room || room.phase !== 'spy-guess') return;
    if (socket.id !== room.spyId) return;
    sfClearAccusationTimer(code);
    const correct = guess === room.location;
    room.phase = 'results';
    const spyPlayer = room.players.find(p => p.id === room.spyId);
    io.to(code).emit('sf-game-over', {
      spyId: room.spyId,
      spyName: spyPlayer ? spyPlayer.name : '?',
      spyAvatar: spyPlayer ? spyPlayer.avatar : '',
      location: room.location,
      locationGuess: guess,
      winner: correct ? 'spy' : 'players',
      reason: correct ? `The spy guessed "${guess}" — correct! Spy wins!` : `The spy guessed "${guess}" — wrong! Players win!`,
    });
  });

  // ── Spyfall: End Game (host) ──
  socket.on('sf-end-game', () => {
    const code = socket.roomCode;
    const room = sfRooms[code];
    if (!room || room.admin.id !== socket.id) return;
    sfClearTimer(code);
    sfClearAccusationTimer(code);
    room.phase = 'results';
    const spyPlayer = room.players.find(p => p.id === room.spyId);
    io.to(code).emit('sf-game-over', {
      spyId: room.spyId,
      spyName: spyPlayer ? spyPlayer.name : '?',
      spyAvatar: spyPlayer ? spyPlayer.avatar : '',
      location: room.location,
      winner: 'revealed',
      reason: 'The host revealed the results.',
    });
  });

  // ── Spyfall: Play Again ──
  socket.on('sf-play-again', () => {
    const code = socket.roomCode;
    const room = sfRooms[code];
    if (!room || room.admin.id !== socket.id) return;
    room.phase = 'lobby';
    room.location = null;
    room.spyId = null;
    room.chat = [];
    room.accusation = null;
    io.to(code).emit('sf-back-to-lobby', { players: room.players.map(playerData) });
  });

  // ══════════════════════════════════════════
  // SEQUENCE GAME
  // ══════════════════════════════════════════

  const SEQ_BOARD_LAYOUT = [
    ['FR','2S','3S','4S','5S','6S','7S','8S','9S','FR'],
    ['10S','QS','KS','AS','2H','3H','4H','5H','6H','7H'],
    ['8H','9H','10H','QH','KH','AH','2D','3D','4D','5D'],
    ['6D','7D','8D','9D','10D','QD','KD','AD','2C','3C'],
    ['4C','5C','6C','7C','8C','9C','10C','QC','KC','AC'],
    ['AC','KC','QC','10C','9C','8C','7C','6C','5C','4C'],
    ['3C','2C','AD','KD','QD','10D','9D','8D','7D','6D'],
    ['5D','4D','3D','2D','AH','KH','QH','10H','9H','8H'],
    ['7H','6H','5H','4H','3H','2H','AS','KS','QS','10S'],
    ['FR','9S','8S','7S','6S','5S','4S','3S','2S','FR'],
  ];

  function createSeqBoard() {
    return SEQ_BOARD_LAYOUT.map(row =>
      row.map(card => ({ card, chip: null, sequenced: false }))
    );
  }

  function createSeqDeck() {
    const suits = ['S','H','D','C'];
    const ranks = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
    const deck = [];
    for (let d = 0; d < 2; d++) {
      for (const suit of suits) {
        for (const rank of ranks) {
          deck.push(rank + suit);
        }
      }
    }
    // Shuffle
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
  }

  function getSeqHandSize(n) {
    if (n <= 2) return 7;
    if (n <= 4) return 6;
    if (n <= 6) return 5;
    if (n <= 8) return 4;
    return 3;
  }

  function isOneEyedJack(c) {
    return c === 'JH' || c === 'JS';
  }

  function isTwoEyedJack(c) {
    return c === 'JD' || c === 'JC';
  }

  function getSeqTeam(room, playerId) {
    const p = room.seqPlayers.find(sp => sp.id === playerId);
    return p ? p.teamIdx : -1;
  }

  function getSeqPositions(card) {
    const positions = [];
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 10; c++) {
        if (SEQ_BOARD_LAYOUT[r][c] === card) {
          positions.push({ r, c });
        }
      }
    }
    return positions;
  }

  function seqBoardState(board) {
    return board.map(row => row.map(cell => ({
      card: cell.card,
      chip: cell.chip,
      sequenced: cell.sequenced,
    })));
  }

  function findAllSequences(board) {
    const directions = [[0,1],[1,0],[1,1],[1,-1]];
    const seqs = new Map();

    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 10; c++) {
        for (const [dr, dc] of directions) {
          // Try to find a sequence starting at (r,c) in direction (dr,dc)
          const cells = [];
          let teamIdx = -1;
          for (let k = 0; k < 5; k++) {
            const nr = r + dr * k;
            const nc = c + dc * k;
            if (nr < 0 || nr >= 10 || nc < 0 || nc >= 10) break;
            const cell = board[nr][nc];
            if (cell.card === 'FR') {
              // FR is wild — accept any team, just add to cells
              cells.push([nr, nc]);
              continue;
            }
            if (cell.chip === null) break;
            if (teamIdx === -1) {
              teamIdx = cell.chip;
            } else if (cell.chip !== teamIdx) {
              break;
            }
            cells.push([nr, nc]);
          }
          if (cells.length === 5 && teamIdx !== -1) {
            const hash = cells.map(([cr,cc]) => cr+','+cc).join('|');
            if (!seqs.has(hash)) {
              seqs.set(hash, { teamIdx, cells });
            }
          }
        }
      }
    }
    return seqs;
  }

  // ── Create Sequence Room ──
  socket.on('create-seq-room', (data, callback) => {
    const { name, avatar, mode } = data;
    const code = generateRoomCode();
    seqRooms[code] = {
      admin: { id: socket.id, name, avatar: avatar || '🦊' },
      players: [],
      phase: 'lobby',
      mode: mode || 'ffa',
      board: null,
      deck: [],
      hands: {},
      seqPlayers: [],
      turnIdx: 0,
      seqCounts: [],
      seqHashes: new Set(),
      seqCells: [],
      teamNames: [],
    };
    socket.join(code);
    socket.roomCode = code;
    socket.playerName = name;
    callback({ success: true, code });
  });

  // ── Start Sequence Game ──
  socket.on('seq-start-game', () => {
    const code = socket.roomCode;
    const room = seqRooms[code];
    if (!room || room.admin.id !== socket.id) return;
    const activePlayers = room.players.filter(p => !p.disconnected);
    if (activePlayers.length < 2) {
      io.to(socket.id).emit('seq-error', { message: 'Need at least 2 players!' });
      return;
    }

    room.board = createSeqBoard();
    room.deck = createSeqDeck();
    room.phase = 'playing';
    room.turnIdx = 0;
    room.seqCounts = [];
    room.seqHashes = new Set();
    room.seqCells = [];

    // Assign teams
    const n = activePlayers.length;
    const mode = room.mode;

    if (mode === 'ffa') {
      // Each player is their own team
      room.seqPlayers = activePlayers.map((p, i) => ({ id: p.id, name: p.name, avatar: p.avatar, teamIdx: i }));
      room.teamNames = activePlayers.map(p => p.name);
      room.seqCounts = activePlayers.map(() => 0);
    } else {
      // 2-team mode: alternate assignment
      room.seqPlayers = activePlayers.map((p, i) => ({ id: p.id, name: p.name, avatar: p.avatar, teamIdx: i % 2 }));
      room.teamNames = ['Team Red', 'Team Blue'];
      room.seqCounts = [0, 0];
    }

    // Deal hands
    const handSize = getSeqHandSize(n);
    room.hands = {};
    for (const sp of room.seqPlayers) {
      room.hands[sp.id] = room.deck.splice(0, handSize);
    }

    const boardState = seqBoardState(room.board);
    const turnPlayerId = room.seqPlayers[room.turnIdx].id;

    // Emit to each player
    for (const sp of room.seqPlayers) {
      io.to(sp.id).emit('seq-game-start', {
        board: boardState,
        hand: room.hands[sp.id],
        myTeam: sp.teamIdx,
        teamNames: room.teamNames,
        players: room.seqPlayers.map(s => ({ id: s.id, name: s.name, avatar: s.avatar, teamIdx: s.teamIdx })),
        turnPlayerId,
        seqCounts: room.seqCounts,
        mode: room.mode,
      });
    }

    // Emit to admin/host
    io.to(room.admin.id).emit('seq-admin-start', {
      board: boardState,
      players: room.seqPlayers.map(s => ({ id: s.id, name: s.name, avatar: s.avatar, teamIdx: s.teamIdx })),
      teamNames: room.teamNames,
      turnPlayerId,
      seqCounts: room.seqCounts,
      mode: room.mode,
    });
  });

  // ── Play a card (normal or two-eyed Jack) ──
  socket.on('seq-play-card', ({ card, row, col }) => {
    const code = socket.roomCode;
    const room = seqRooms[code];
    if (!room || room.phase !== 'playing') return;

    const sp = room.seqPlayers.find(p => p.id === socket.id);
    if (!sp) return;
    if (room.seqPlayers[room.turnIdx].id !== socket.id) return;

    const hand = room.hands[socket.id];
    const cardIdx = hand.indexOf(card);
    if (cardIdx === -1) return;

    const cell = room.board[row][col];
    if (cell.card === 'FR') return; // can't place on free corner directly
    if (cell.chip !== null) return; // occupied

    if (isTwoEyedJack(card)) {
      // Wild — can go anywhere empty (non-FR handled above)
    } else if (!isOneEyedJack(card)) {
      // Normal card — must match board position
      if (cell.card !== card) return;
    } else {
      return; // one-eyed jack should use seq-remove-chip
    }

    // Place chip
    cell.chip = sp.teamIdx;

    // Remove card from hand, draw replacement
    hand.splice(cardIdx, 1);
    if (room.deck.length > 0) {
      hand.push(room.deck.shift());
    }

    // Detect new sequences
    const allSeqs = findAllSequences(room.board);
    let newSeqFound = false;
    let winner = -1;

    for (const [hash, seqData] of allSeqs) {
      if (!room.seqHashes.has(hash)) {
        room.seqHashes.add(hash);
        room.seqCounts[seqData.teamIdx]++;
        room.seqCells.push({ hash, teamIdx: seqData.teamIdx, cells: seqData.cells });
        newSeqFound = true;
        // Mark cells as sequenced
        for (const [cr, cc] of seqData.cells) {
          room.board[cr][cc].sequenced = true;
        }
        if (room.seqCounts[seqData.teamIdx] >= 2) {
          winner = seqData.teamIdx;
        }
      }
    }

    // Advance turn
    room.turnIdx = (room.turnIdx + 1) % room.seqPlayers.length;
    const nextTurnPlayerId = room.seqPlayers[room.turnIdx].id;

    const boardState = seqBoardState(room.board);

    if (winner >= 0) {
      room.phase = 'gameover';
      const winnerName = room.teamNames[winner];
      io.to(code).emit('seq-game-over', {
        board: boardState,
        winnerTeamIdx: winner,
        winnerName,
        seqCounts: room.seqCounts,
        seqCells: room.seqCells,
        teamNames: room.teamNames,
        players: room.seqPlayers,
      });
    } else {
      io.to(code).emit('seq-board-update', {
        board: boardState,
        turnPlayerId: nextTurnPlayerId,
        seqCounts: room.seqCounts,
        seqCells: room.seqCells,
        lastPlay: { playerId: socket.id, playerName: sp.name, card, row, col, teamIdx: sp.teamIdx },
      });
      io.to(socket.id).emit('seq-hand-update', { hand: room.hands[socket.id] });
    }
  });

  // ── Remove a chip (one-eyed Jack) ──
  socket.on('seq-remove-chip', ({ card, row, col }) => {
    const code = socket.roomCode;
    const room = seqRooms[code];
    if (!room || room.phase !== 'playing') return;

    const sp = room.seqPlayers.find(p => p.id === socket.id);
    if (!sp) return;
    if (room.seqPlayers[room.turnIdx].id !== socket.id) return;

    if (!isOneEyedJack(card)) return;

    const hand = room.hands[socket.id];
    const cardIdx = hand.indexOf(card);
    if (cardIdx === -1) return;

    const cell = room.board[row][col];
    if (cell.chip === null) return; // no chip to remove
    if (cell.chip === sp.teamIdx) return; // can't remove own chip
    if (cell.sequenced) return; // can't remove sequenced chip
    if (cell.card === 'FR') return; // can't remove from free corner

    // Remove chip
    cell.chip = null;

    // Remove card from hand, draw replacement
    hand.splice(cardIdx, 1);
    if (room.deck.length > 0) {
      hand.push(room.deck.shift());
    }

    // Advance turn
    room.turnIdx = (room.turnIdx + 1) % room.seqPlayers.length;
    const nextTurnPlayerId = room.seqPlayers[room.turnIdx].id;

    const boardState = seqBoardState(room.board);

    io.to(code).emit('seq-board-update', {
      board: boardState,
      turnPlayerId: nextTurnPlayerId,
      seqCounts: room.seqCounts,
      seqCells: room.seqCells,
      lastPlay: { playerId: socket.id, playerName: sp.name, card, row, col, teamIdx: sp.teamIdx, removed: true },
    });
    io.to(socket.id).emit('seq-hand-update', { hand: room.hands[socket.id] });
  });

  // ── Declare dead card ──
  socket.on('seq-declare-dead', ({ card }) => {
    const code = socket.roomCode;
    const room = seqRooms[code];
    if (!room || room.phase !== 'playing') return;

    const sp = room.seqPlayers.find(p => p.id === socket.id);
    if (!sp) return;
    if (room.seqPlayers[room.turnIdx].id !== socket.id) return;

    const hand = room.hands[socket.id];
    const cardIdx = hand.indexOf(card);
    if (cardIdx === -1) return;

    // Verify it's actually dead: all positions for this card are occupied by own team
    if (!isOneEyedJack(card) && !isTwoEyedJack(card)) {
      const positions = getSeqPositions(card);
      const allOccupied = positions.every(({ r, c }) => room.board[r][c].chip === sp.teamIdx);
      if (!allOccupied) return; // not actually dead
    }

    // Discard and draw — no turn advancement (same turn continues without penalty)
    hand.splice(cardIdx, 1);
    if (room.deck.length > 0) {
      hand.push(room.deck.shift());
    }

    io.to(socket.id).emit('seq-hand-update', { hand: room.hands[socket.id] });
    io.to(code).emit('seq-dead-card', { playerName: sp.name, card });
  });

  // ── Play again (back to lobby) ──
  socket.on('seq-play-again', () => {
    const code = socket.roomCode;
    const room = seqRooms[code];
    if (!room || room.admin.id !== socket.id) return;
    room.phase = 'lobby';
    room.board = null;
    room.deck = [];
    room.hands = {};
    room.seqPlayers = [];
    room.turnIdx = 0;
    room.seqCounts = [];
    room.seqHashes = new Set();
    room.seqCells = [];
    io.to(code).emit('seq-back-to-lobby', { players: room.players.map(playerData) });
  });

  // ── Host ends game early ──
  socket.on('seq-end-game', () => {
    const code = socket.roomCode;
    const room = seqRooms[code];
    if (!room || room.admin.id !== socket.id) return;
    room.phase = 'gameover';
    io.to(code).emit('seq-game-over', {
      board: room.board ? seqBoardState(room.board) : null,
      winnerTeamIdx: -1,
      winnerName: 'No winner',
      seqCounts: room.seqCounts,
      seqCells: room.seqCells,
      teamNames: room.teamNames,
      players: room.seqPlayers,
      hostEnded: true,
    });
  });

  // ── Disconnect ──
  socket.on('disconnect', () => {
    const code = socket.roomCode;

    // Handle Sequence room disconnect
    const seqRoomDC = seqRooms[code];
    if (seqRoomDC) {
      if (seqRoomDC.admin && seqRoomDC.admin.id === socket.id) {
        io.to(code).emit('room-closed');
        seqRoomDC.players.forEach(p => { if (p.disconnectTimer) clearTimeout(p.disconnectTimer); });
        delete seqRooms[code];
        return;
      }
      const seqPlayerDC = seqRoomDC.players.find(p => p.id === socket.id);
      if (seqPlayerDC) {
        seqPlayerDC.disconnected = true;
        seqPlayerDC.disconnectTimer = setTimeout(() => {
          const r = seqRooms[code];
          if (!r) return;
          r.players = r.players.filter(p => p.id !== seqPlayerDC.id);
          io.to(code).emit('seq-player-list', r.players.map(playerData));
        }, 120000);
        io.to(code).emit('seq-player-list', seqRoomDC.players.map(playerData));

        // If game is active and it's this player's turn, skip to next connected player
        if (seqRoomDC.phase === 'playing' && seqRoomDC.seqPlayers.length > 0) {
          const isTurn = seqRoomDC.seqPlayers[seqRoomDC.turnIdx] &&
                         seqRoomDC.seqPlayers[seqRoomDC.turnIdx].id === socket.id;
          if (isTurn) {
            const total = seqRoomDC.seqPlayers.length;
            for (let i = 1; i < total; i++) {
              const next = (seqRoomDC.turnIdx + i) % total;
              const nextSp = seqRoomDC.seqPlayers[next];
              const nextPlayer = seqRoomDC.players.find(p => p.id === nextSp.id);
              if (!nextPlayer || !nextPlayer.disconnected) {
                seqRoomDC.turnIdx = next;
                break;
              }
            }
            io.to(code).emit('seq-board-update', {
              board: seqBoardState(seqRoomDC.board),
              turnPlayerId: seqRoomDC.seqPlayers[seqRoomDC.turnIdx].id,
              seqCounts: seqRoomDC.seqCounts,
              seqCells: seqRoomDC.seqCells,
              lastPlay: { playerName: seqPlayerDC.name, card: null, removed: false, skipped: true },
            });
          }
        }
      }
      return;
    }

    // Handle Spyfall room disconnect
    const sfRoom = sfRooms[code];
    if (sfRoom) {
      if (sfRoom.admin.id === socket.id) {
        sfClearTimer(code);
        sfClearAccusationTimer(code);
        io.to(code).emit('room-closed');
        sfRoom.players.forEach(p => { if (p.disconnectTimer) clearTimeout(p.disconnectTimer); });
        delete sfRooms[code];
        return;
      }
      const sfPlayer = sfRoom.players.find(p => p.id === socket.id);
      if (sfPlayer) {
        sfPlayer.disconnected = true;
        sfPlayer.disconnectTimer = setTimeout(() => {
          const r = sfRooms[code];
          if (!r) return;
          r.players = r.players.filter(p => p.id !== sfPlayer.id);
          io.to(code).emit('sf-player-list', r.players.map(playerData));
        }, 120000);
        io.to(code).emit('sf-player-list', sfRoom.players.map(playerData));
      }
      return;
    }

    const room = rooms[code];
    if (!room) return;

    if (room.admin.id === socket.id) {
      clearTimer(code);
      io.to(code).emit('room-closed');
      // Clear all disconnect timers before deleting room
      room.players.forEach(p => { if (p.disconnectTimer) clearTimeout(p.disconnectTimer); });
      delete rooms[code];
      return;
    }

    // Player disconnect — grace period (2 minutes to reconnect)
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    player.disconnected = true;
    player.disconnectTimer = setTimeout(() => {
      // Permanently remove after grace period — but keep a record so they can rejoin
      const r = rooms[code];
      if (!r) return;
      if (!r.formerPlayers) r.formerPlayers = {};
      r.formerPlayers[player.name.toLowerCase()] = { name: player.name, avatar: player.avatar, score: player.score };
      r.players = r.players.filter(p => p.id !== player.id);
      io.to(code).emit('player-list', getPlayers(r).map(playerData));
    }, 120000); // 2 minute grace period

    io.to(code).emit('player-list', getPlayers(room).map(playerData));
  });
});

// ═══════════════════════════════
// TIMER
// ═══════════════════════════════

function startTimer(code, seconds) {
  const room = rooms[code];
  if (!room) return;
  room.timeRemaining = seconds;
  clearInterval(room.timer);
  room.timer = setInterval(() => {
    room.timeRemaining--;
    io.to(code).emit('timer-tick', room.timeRemaining);
    if (room.timeRemaining <= 0) {
      clearInterval(room.timer);
      room.timer = null;
      io.to(code).emit('time-up');
      handleAllAnswered(code);
    }
  }, 1000);
}

function clearTimer(code) {
  const room = rooms[code];
  if (room && room.timer) {
    clearInterval(room.timer);
    room.timer = null;
  }
}

// ═══════════════════════════════
// PHASE TRANSITIONS
// ═══════════════════════════════

function handleAllAnswered(code) {
  const room = rooms[code];
  if (!room || room.phase !== 'answering') return;

  const qType = room.currentQuestion.type;
  if (qType === 'choice' || qType === 'truefalse') {
    showChoiceResults(code);
  } else if (qType === 'open') {
    // Kahoot-style: auto-grade against correct answer
    showOpenGradedResults(code);
  } else if (qType === 'consensus') {
    // Voting-based: players vote for best answer.
    // Host answer counts as one entry — only need 1 player answer to start voting when host has an answer.
    const playerAnswerCount = Object.keys(room.answers).length;
    const minNeeded = room.currentQuestion.hostAnswer ? 1 : 2;
    if (playerAnswerCount >= minNeeded) {
      startVoting(code);
    } else {
      showConsensusResults(code);
    }
  }
}

function startVoting(code) {
  const room = rooms[code];
  room.phase = 'voting';

  const answerList = Object.entries(room.answers)
    .map(([id, data]) => ({ id, answer: data.answer }));

  // Include the host's pre-loaded answer so players can vote for it
  if (room.currentQuestion.hostAnswer) {
    answerList.push({ id: '__host__', answer: room.currentQuestion.hostAnswer });
  }

  // Shuffle
  for (let i = answerList.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [answerList[i], answerList[j]] = [answerList[j], answerList[i]];
  }

  // Send host the spectator voting view — answers only, no names (keeps voting blind)
  const hostAnswerList = answerList.map(a => ({
    answer: a.answer,
    isHostAnswer: a.id === '__host__',
  }));
  io.to(room.admin.id).emit('host-voting-view', {
    question: room.currentQuestion.question,
    answers: hostAnswerList,
  });

  // Send voting options to each player
  for (const player of room.players) {
    const personalList = answerList.map(a => ({
      ...a,
      isMine: a.id === player.id,
    }));
    io.to(player.id).emit('start-voting', {
      question: room.currentQuestion.question,
      answers: personalList,
    });
  }
}

function showChoiceResults(code) {
  const room = rooms[code];
  room.phase = 'results';

  const correctIndex = room.currentQuestion.correctIndex;
  const timeLimit = room.currentQuestion.timeLimit || 30;
  const maxPoints = room.currentQuestion.maxPoints || 1000;
  const options =
    room.currentQuestion.type === 'truefalse'
      ? ['True', 'False']
      : room.currentQuestion.options;

  const breakdown = options.map(() => 0);

  // Score each player
  for (const [id, data] of Object.entries(room.answers)) {
    const idx = parseInt(data.answer);
    if (idx >= 0 && idx < options.length) breakdown[idx]++;

    const isCorrect = idx === correctIndex;
    let points = 0;
    if (isCorrect) {
      const timeFraction = Math.max(0, 1 - data.elapsed / timeLimit);
      points = Math.round(maxPoints * (0.5 + 0.5 * timeFraction));
    }
    const player = room.players.find(p => p.id === id);
    if (player) player.score += points;
  }

  // Record history
  room.gameHistory.push({
    round: room.round,
    question: room.currentQuestion.question,
    type: room.currentQuestion.type,
    maxPoints,
    playerResults: room.players
      .map(p => {
        const ans = room.answers[p.id];
        const correct = ans ? parseInt(ans.answer) === correctIndex : false;
        return { name: p.name, avatar: p.avatar, correct, answered: !!ans };
      }),
  });

  // Send personalised result to each player
  const scores = room.players
    .map(p => ({ name: p.name, avatar: p.avatar, score: p.score }))
    .sort((a, b) => b.score - a.score);

  for (const player of room.players) {
    const myAnswer = room.answers[player.id];
    const myChoice = myAnswer ? parseInt(myAnswer.answer) : -1;
    const isCorrect = myChoice === correctIndex;
    const timeFraction =
      myAnswer ? Math.max(0, 1 - myAnswer.elapsed / timeLimit) : 0;
    const pointsEarned = isCorrect ? Math.round(maxPoints * (0.5 + 0.5 * timeFraction)) : 0;

    io.to(player.id).emit('choice-results', {
      question: room.currentQuestion.question,
      options,
      correctIndex,
      breakdown,
      myChoice,
      isCorrect,
      pointsEarned,
      scores,
    });
  }

  // Send host the results as spectator
  io.to(room.admin.id).emit('choice-results', {
    question: room.currentQuestion.question,
    options,
    correctIndex,
    breakdown,
    myChoice: -2,
    isCorrect: null,
    pointsEarned: 0,
    scores,
  });
}

// ── Open-ended: Kahoot-style auto-grading ──
function showOpenGradedResults(code) {
  const room = rooms[code];
  room.phase = 'results';

  const correctAnswer = room.currentQuestion.hostAnswer || '';
  const timeLimit = room.currentQuestion.timeLimit || 30;
  const maxPoints = room.currentQuestion.maxPoints || 1000;

  // Grade each player
  for (const [id, data] of Object.entries(room.answers)) {
    const isCorrect = normalizeAnswer(data.answer) === normalizeAnswer(correctAnswer);
    let points = 0;
    if (isCorrect) {
      const timeFraction = Math.max(0, 1 - data.elapsed / timeLimit);
      points = Math.round(maxPoints * (0.5 + 0.5 * timeFraction));
    }
    const player = room.players.find(p => p.id === id);
    if (player) player.score += points;
  }

  // Record history
  room.gameHistory.push({
    round: room.round,
    question: room.currentQuestion.question,
    type: 'open',
    correctAnswer,
    maxPoints,
    playerResults: room.players.map(p => {
      const ans = room.answers[p.id];
      const correct = ans ? normalizeAnswer(ans.answer) === normalizeAnswer(correctAnswer) : false;
      return { name: p.name, avatar: p.avatar, correct, answered: !!ans };
    }),
  });

  const scores = room.players
    .map(p => ({ name: p.name, avatar: p.avatar, score: p.score }))
    .sort((a, b) => b.score - a.score);

  // Send personalized results to each player
  for (const player of room.players) {
    const myAnswer = room.answers[player.id];
    const isCorrect = myAnswer ? normalizeAnswer(myAnswer.answer) === normalizeAnswer(correctAnswer) : false;
    const timeFraction = myAnswer ? Math.max(0, 1 - myAnswer.elapsed / timeLimit) : 0;
    const pointsEarned = isCorrect ? Math.round(maxPoints * (0.5 + 0.5 * timeFraction)) : 0;

    io.to(player.id).emit('open-graded-results', {
      question: room.currentQuestion.question,
      correctAnswer,
      myAnswer: myAnswer ? myAnswer.answer : null,
      isCorrect,
      pointsEarned,
      scores,
    });
  }

  // Host spectator view
  io.to(room.admin.id).emit('open-graded-results', {
    question: room.currentQuestion.question,
    correctAnswer,
    myAnswer: null,
    isCorrect: null,
    pointsEarned: 0,
    scores,
    isHost: true,
  });
}

// ── Consensus: vote-based scoring ──
function showConsensusResults(code) {
  const room = rooms[code];
  room.phase = 'results';

  const voteCounts = {};
  for (const votedFor of Object.values(room.votes)) {
    voteCounts[votedFor] = (voteCounts[votedFor] || 0) + 1;
  }

  const results = Object.entries(room.answers)
    .map(([id, data]) => {
      const voteCount = voteCounts[id] || 0;
      const player = room.players.find(p => p.id === id);
      return {
        id,
        name: data.name,
        avatar: player ? player.avatar : '',
        answer: data.answer,
        votes: voteCount,
      };
    });

  // Include host's pre-loaded answer in results
  if (room.currentQuestion.hostAnswer) {
    results.push({
      id: '__host__',
      name: room.admin.name,
      avatar: room.admin.avatar,
      answer: room.currentQuestion.hostAnswer,
      votes: voteCounts['__host__'] || 0,
    });
  }

  results.sort((a, b) => b.votes - a.votes);

  // Score: 1 point per vote received on your answer
  for (const r of results) {
    if (r.id === '__host__') continue; // host doesn't earn score
    const player = room.players.find(p => p.id === r.id);
    if (player) player.score += r.votes;
  }

  // Score: 0.5 points if you voted for the host's answer
  for (const [voterId, votedForId] of Object.entries(room.votes)) {
    if (votedForId === '__host__') {
      const player = room.players.find(p => p.id === voterId);
      if (player) player.score += 0.5;
    }
  }

  // Record history
  room.gameHistory.push({
    round: room.round,
    question: room.currentQuestion.question,
    type: 'consensus',
    playerResults: room.players
      .map(p => {
        const votes = voteCounts[p.id] || 0;
        const votedForHost = room.votes[p.id] === '__host__';
        return { name: p.name, avatar: p.avatar, votes, answered: !!room.answers[p.id], votedForHost };
      }),
  });

  io.to(code).emit('show-results', {
    question: room.currentQuestion.question,
    results,
    scores: room.players
      .map(p => ({ name: p.name, avatar: p.avatar, score: p.score }))
      .sort((a, b) => b.score - a.score),
  });
}

// ═══════════════════════════════
// SPYFALL TIMERS & HELPERS
// ═══════════════════════════════

function sfStartTimer(code) {
  const room = sfRooms[code];
  if (!room) return;
  sfClearTimer(code);
  room.timer = setInterval(() => {
    room.timeRemaining--;
    const mins = Math.floor(room.timeRemaining / 60);
    const secs = room.timeRemaining % 60;
    const display = mins + ':' + String(secs).padStart(2, '0');
    io.to(code).emit('sf-timer', { seconds: room.timeRemaining, display });
    if (room.timeRemaining <= 0) {
      sfClearTimer(code);
      room.phase = 'results';
      const spyPlayer = room.players.find(p => p.id === room.spyId);
      io.to(code).emit('sf-game-over', {
        spyId: room.spyId,
        spyName: spyPlayer ? spyPlayer.name : '?',
        spyAvatar: spyPlayer ? spyPlayer.avatar : '',
        location: room.location,
        winner: 'spy',
        reason: 'Time ran out — the spy survived!',
      });
    }
  }, 1000);
}

function sfClearTimer(code) {
  const room = sfRooms[code];
  if (room && room.timer) { clearInterval(room.timer); room.timer = null; }
}

function sfStartAccusationTimer(code, seconds) {
  sfClearAccusationTimer(code);
  let t = seconds;
  SF_ACCUSATION_TIMERS[code] = setInterval(() => {
    t--;
    io.to(code).emit('sf-accusation-timer', t);
    if (t <= 0) { sfClearAccusationTimer(code); sfResolveAccusation(code); }
  }, 1000);
}

function sfClearAccusationTimer(code) {
  if (SF_ACCUSATION_TIMERS[code]) { clearInterval(SF_ACCUSATION_TIMERS[code]); delete SF_ACCUSATION_TIMERS[code]; }
}

function sfResolveAccusation(code) {
  const room = sfRooms[code];
  if (!room) return;
  const { accusation } = room;
  const voters = room.players.filter(p => !p.disconnected);
  const guiltyCount = Object.values(accusation.votes).filter(v => v === true).length;
  const totalVoted = Object.keys(accusation.votes).length;
  const guilty = guiltyCount > voters.length / 2;

  if (guilty) {
    const accusedIsSpy = accusation.accusedId === room.spyId;
    if (accusedIsSpy) {
      room.phase = 'spy-guess';
      io.to(code).emit('sf-spy-caught', {
        accusedId: accusation.accusedId,
        accusedName: accusation.accusedName,
        accusedAvatar: accusation.accusedAvatar,
        guiltyCount,
        totalVoted,
        allLocations: SPYFALL_LOCATIONS.map(l => l.name),
      });
      // Give spy 30s to guess — use accusation timer slot
      sfStartAccusationTimer(code, 30);
      // Override: when this timer fires, players win
      const orig = SF_ACCUSATION_TIMERS[code];
      SF_ACCUSATION_TIMERS[code] = setInterval(() => {}, 0); // placeholder replaced above
      // Reset properly
      sfClearAccusationTimer(code);
      let guessTime = 30;
      SF_ACCUSATION_TIMERS[code] = setInterval(() => {
        guessTime--;
        io.to(code).emit('sf-accusation-timer', guessTime);
        if (guessTime <= 0) {
          sfClearAccusationTimer(code);
          if (room.phase === 'spy-guess') {
            room.phase = 'results';
            const spyPlayer = room.players.find(p => p.id === room.spyId);
            io.to(code).emit('sf-game-over', {
              spyId: room.spyId,
              spyName: spyPlayer ? spyPlayer.name : '?',
              spyAvatar: spyPlayer ? spyPlayer.avatar : '',
              location: room.location,
              winner: 'players',
              reason: 'The spy ran out of time to guess!',
            });
          }
        }
      }, 1000);
    } else {
      room.phase = 'results';
      const spyPlayer = room.players.find(p => p.id === room.spyId);
      io.to(code).emit('sf-game-over', {
        spyId: room.spyId,
        spyName: spyPlayer ? spyPlayer.name : '?',
        spyAvatar: spyPlayer ? spyPlayer.avatar : '',
        location: room.location,
        winner: 'spy',
        reason: `${accusation.accusedName} was innocent — the real spy goes free!`,
        wrongAccused: accusation.accusedName,
      });
    }
  } else {
    // Not guilty — resume game
    room.phase = 'playing';
    room.accusation = null;
    io.to(code).emit('sf-accusation-result', {
      guilty: false,
      accusedName: accusation.accusedName,
      guiltyCount,
      totalVoted,
    });
    sfStartTimer(code);
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
