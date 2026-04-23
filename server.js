const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

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
  } while (rooms[code] || sfRooms[code]);
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
    // Send the question so they can still answer
    io.to(socket.id).emit('new-question', payload);
  } else if (room.phase === 'voting') {
    // They missed answering but can see the voting screen
    io.to(socket.id).emit('host-voting-view', { question: qData.question });
  } else if (room.phase === 'results' || room.phase === 'lobby') {
    // Show waiting screen
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

    if (room.phase !== 'lobby') return callback({ success: false, error: 'Game already in progress' });

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
      if (Object.keys(room.answers).length >= 2) {
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

  // ── Disconnect ──
  socket.on('disconnect', () => {
    const code = socket.roomCode;

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
      // Permanently remove after grace period
      const r = rooms[code];
      if (!r) return;
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
    // Voting-based: players vote for best answer
    if (Object.keys(room.answers).length >= 2) {
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

  // Send host the spectator voting view with all answers visible
  const hostAnswerList = answerList.map(a => ({
    answer: a.answer,
    name: a.id === '__host__' ? room.admin.name : (room.answers[a.id] ? room.answers[a.id].name : ''),
    avatar: a.id === '__host__' ? room.admin.avatar : (() => { const p = room.players.find(p => p.id === a.id); return p ? p.avatar : ''; })(),
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
