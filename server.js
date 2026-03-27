const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// Get only actual players (not host)
function getPlayers(room) {
  return room.players.filter(p => p.id !== room.admin.id);
}

function playerData(p) {
  return { name: p.name, score: p.score, avatar: p.avatar };
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

  // ── Player joins ──
  socket.on('join-room', (data, callback) => {
    const { code, name, avatar } = data;
    const room = rooms[code];
    if (!room) return callback({ success: false, error: 'Room not found' });
    if (room.phase !== 'lobby') return callback({ success: false, error: 'Game already in progress' });
    if (room.players.some(p => p.name.toLowerCase() === name.toLowerCase())) {
      return callback({ success: false, error: 'Name already taken' });
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
    for (const p of getPlayers(room)) {
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
    const total = getPlayers(room).length;
    io.to(socket.roomCode).emit('answer-count', { answered, total });

    if (answered >= total) {
      clearTimer(socket.roomCode);
      handleAllAnswered(socket.roomCode);
    }
  });

  // ── Admin force-starts voting (open only) ──
  socket.on('force-voting', () => {
    const room = rooms[socket.roomCode];
    if (!room || room.admin.id !== socket.id) return;
    if (room.phase === 'answering' && room.currentQuestion.type === 'open') {
      clearTimer(socket.roomCode);
      if (Object.keys(room.answers).length >= 2) {
        startVoting(socket.roomCode);
      } else {
        showOpenResults(socket.roomCode);
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
      showOpenResults(socket.roomCode);
    }
  });

  // ── Admin force-shows results ──
  socket.on('force-results', () => {
    const room = rooms[socket.roomCode];
    if (!room || room.admin.id !== socket.id) return;
    if (room.phase === 'voting') {
      showOpenResults(socket.roomCode);
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

  // ── Disconnect ──
  socket.on('disconnect', () => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    room.players = room.players.filter(p => p.id !== socket.id);
    if (room.admin.id === socket.id) {
      clearTimer(socket.roomCode);
      io.to(socket.roomCode).emit('room-closed');
      delete rooms[socket.roomCode];
    } else {
      io.to(socket.roomCode).emit('player-list', room.players.map(playerData));
    }
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
  } else {
    if (Object.keys(room.answers).length >= 2) {
      startVoting(code);
    } else {
      showOpenResults(code);
    }
  }
}

function startVoting(code) {
  const room = rooms[code];
  room.phase = 'voting';

  const answerList = Object.entries(room.answers)
    .map(([id, data]) => ({ id, answer: data.answer }));

  // Shuffle
  for (let i = answerList.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [answerList[i], answerList[j]] = [answerList[j], answerList[i]];
  }

  // Send host the spectator voting view
  io.to(room.admin.id).emit('host-voting-view', { question: room.currentQuestion.question });

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
      points = Math.round(500 + 500 * timeFraction);
    }
    const player = room.players.find(p => p.id === id);
    if (player) player.score += points;
  }

  // Record history
  room.gameHistory.push({
    round: room.round,
    question: room.currentQuestion.question,
    type: room.currentQuestion.type,
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
    const pointsEarned = isCorrect ? Math.round(500 + 500 * timeFraction) : 0;

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

function showOpenResults(code) {
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

  results.sort((a, b) => b.votes - a.votes);

  for (const r of results) {
    const player = room.players.find(p => p.id === r.id);
    if (player) player.score += r.votes * 100;
  }

  // Record history
  room.gameHistory.push({
    round: room.round,
    question: room.currentQuestion.question,
    type: 'open',
    playerResults: room.players
      .map(p => {
        const votes = voteCounts[p.id] || 0;
        return { name: p.name, avatar: p.avatar, votes, answered: !!room.answers[p.id] };
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
