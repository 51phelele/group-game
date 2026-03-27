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

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  // ── Create room ──
  socket.on('create-room', (adminName, callback) => {
    const code = generateRoomCode();
    rooms[code] = {
      admin: { id: socket.id, name: adminName },
      players: [{ id: socket.id, name: adminName, score: 0 }],
      phase: 'lobby',
      questionQueue: [],
      totalQuestions: 0,
      currentQuestion: null,
      answers: {},
      votes: {},
      round: 0,
      timer: null,
      roundStartTime: null,
    };
    socket.join(code);
    socket.roomCode = code;
    socket.playerName = adminName;
    callback({ success: true, code });
    io.to(code).emit('player-list', rooms[code].players.map(p => ({ name: p.name, score: p.score })));
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
    const { code, name } = data;
    const room = rooms[code];
    if (!room) return callback({ success: false, error: 'Room not found' });
    if (room.phase !== 'lobby') return callback({ success: false, error: 'Game already in progress' });
    if (room.players.some(p => p.name.toLowerCase() === name.toLowerCase())) {
      return callback({ success: false, error: 'Name already taken' });
    }
    room.players.push({ id: socket.id, name, score: 0 });
    socket.join(code);
    socket.roomCode = code;
    socket.playerName = name;
    callback({ success: true });
    io.to(code).emit('player-list', room.players.map(p => ({ name: p.name, score: p.score })));
  });

  // ── Start a question ──
  // questionData: null (next from queue), string (custom open), or object
  socket.on('start-question', (questionData) => {
    const room = rooms[socket.roomCode];
    if (!room || room.admin.id !== socket.id) return;

    room.round++;
    room.answers = {};
    room.votes = {};

    let qData;
    if (questionData === null) {
      qData = room.questionQueue.shift();
      if (!qData) return;
    } else if (typeof questionData === 'string') {
      qData = { type: 'open', question: questionData, timeLimit: 30 };
    } else {
      qData = questionData;
    }

    room.currentQuestion = qData;
    room.phase = 'answering';
    room.roundStartTime = Date.now();

    const payload = {
      type: qData.type,
      question: qData.question,
      round: room.round,
      totalQuestions: Math.max(room.totalQuestions, room.round),
      timeLimit: qData.timeLimit || 30,
    };

    if (qData.type === 'choice') {
      payload.options = qData.options;
    } else if (qData.type === 'truefalse') {
      payload.options = ['True', 'False'];
    }

    io.to(socket.roomCode).emit('new-question', payload);

    // Auto-submit host answer for open questions with preloaded answer
    if (qData.type === 'open' && qData.hostAnswer) {
      const code = socket.roomCode;
      setTimeout(() => {
        const r = rooms[code];
        if (!r || r.phase !== 'answering') return;
        r.answers[room.admin.id] = {
          name: room.admin.name,
          answer: qData.hostAnswer,
          elapsed: 0.5,
        };
        io.to(room.admin.id).emit('answer-prefilled', { answer: qData.hostAnswer });
        const answered = Object.keys(r.answers).length;
        io.to(code).emit('answer-count', { answered, total: r.players.length });
        if (answered === r.players.length) {
          clearTimer(code);
          handleAllAnswered(code);
        }
      }, 300);
    }

    startTimer(socket.roomCode, qData.timeLimit || 30);
  });

  // ── Player submits answer ──
  socket.on('submit-answer', (answer) => {
    const room = rooms[socket.roomCode];
    if (!room || room.phase !== 'answering') return;
    if (room.answers[socket.id]) return;

    const elapsed = (Date.now() - room.roundStartTime) / 1000;
    room.answers[socket.id] = {
      name: socket.playerName,
      answer,
      elapsed,
    };

    const answered = Object.keys(room.answers).length;
    io.to(socket.roomCode).emit('answer-count', { answered, total: room.players.length });

    if (answered === room.players.length) {
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

  // ── Player votes (open only) ──
  socket.on('submit-vote', (votedForId) => {
    const room = rooms[socket.roomCode];
    if (!room || room.phase !== 'voting') return;
    if (votedForId === socket.id) return;
    room.votes[socket.id] = votedForId;

    const eligibleVoters = Object.keys(room.answers);
    const votesIn = Object.keys(room.votes).length;
    io.to(socket.roomCode).emit('vote-count', { voted: votesIn, total: eligibleVoters.length });

    if (votesIn === eligibleVoters.length) {
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

  // ── Next round ──
  socket.on('next-round', () => {
    const room = rooms[socket.roomCode];
    if (!room || room.admin.id !== socket.id) return;
    room.phase = 'lobby';
    room.currentQuestion = null;
    room.answers = {};
    room.votes = {};
    io.to(socket.roomCode).emit('back-to-lobby', {
      players: room.players.map(p => ({ name: p.name, score: p.score })),
      questionsRemaining: room.questionQueue.length,
    });
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
      io.to(socket.roomCode).emit('player-list', room.players.map(p => ({ name: p.name, score: p.score })));
    }
  });
});

// ── Timer ──

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

// ── Phase transitions ──

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

  const answerList = Object.entries(room.answers).map(([id, data]) => ({
    id,
    answer: data.answer,
  }));

  for (let i = answerList.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [answerList[i], answerList[j]] = [answerList[j], answerList[i]];
  }

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

  // Send personalised result to each player
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
      scores: room.players
        .map(p => ({ name: p.name, score: p.score }))
        .sort((a, b) => b.score - a.score),
    });
  }
}

function showOpenResults(code) {
  const room = rooms[code];
  room.phase = 'results';

  const voteCounts = {};
  for (const votedFor of Object.values(room.votes)) {
    voteCounts[votedFor] = (voteCounts[votedFor] || 0) + 1;
  }

  const results = Object.entries(room.answers).map(([id, data]) => {
    const voteCount = voteCounts[id] || 0;
    return { id, name: data.name, answer: data.answer, votes: voteCount };
  });

  results.sort((a, b) => b.votes - a.votes);

  for (const r of results) {
    const player = room.players.find(p => p.id === r.id);
    if (player) player.score += r.votes * 100;
  }

  io.to(code).emit('show-results', {
    question: room.currentQuestion.question,
    results,
    scores: room.players
      .map(p => ({ name: p.name, score: p.score }))
      .sort((a, b) => b.score - a.score),
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
