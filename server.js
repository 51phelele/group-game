const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Game state
const rooms = {};

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  // Admin creates a room
  socket.on('create-room', (adminName, callback) => {
    const code = generateRoomCode();
    rooms[code] = {
      admin: { id: socket.id, name: adminName },
      players: [{ id: socket.id, name: adminName, score: 0 }],
      phase: 'lobby', // lobby | question | answering | voting | results
      currentQuestion: null,
      answers: {},
      votes: {},
      round: 0,
    };
    socket.join(code);
    socket.roomCode = code;
    socket.playerName = adminName;
    callback({ success: true, code });
    io.to(code).emit('player-list', rooms[code].players.map(p => ({ name: p.name, score: p.score })));
  });

  // Player joins a room
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
    callback({ success: true, isAdmin: false });
    io.to(code).emit('player-list', room.players.map(p => ({ name: p.name, score: p.score })));
  });

  // Admin starts a question round
  socket.on('start-question', (question) => {
    const room = rooms[socket.roomCode];
    if (!room || room.admin.id !== socket.id) return;

    room.round++;
    room.currentQuestion = question;
    room.answers = {};
    room.votes = {};
    room.phase = 'answering';

    io.to(socket.roomCode).emit('new-question', { question, round: room.round });
  });

  // Player submits an answer
  socket.on('submit-answer', (answer) => {
    const room = rooms[socket.roomCode];
    if (!room || room.phase !== 'answering') return;

    room.answers[socket.id] = { name: socket.playerName, answer };

    // Check if all players answered
    const answered = Object.keys(room.answers).length;
    io.to(socket.roomCode).emit('answer-count', { answered, total: room.players.length });

    if (answered === room.players.length) {
      startVoting(socket.roomCode);
    }
  });

  // Admin force-starts voting
  socket.on('force-voting', () => {
    const room = rooms[socket.roomCode];
    if (!room || room.admin.id !== socket.id) return;
    if (room.phase === 'answering' && Object.keys(room.answers).length >= 2) {
      startVoting(socket.roomCode);
    }
  });

  // Player submits a vote
  socket.on('submit-vote', (votedForId) => {
    const room = rooms[socket.roomCode];
    if (!room || room.phase !== 'voting') return;
    if (votedForId === socket.id) return; // Can't vote for yourself

    room.votes[socket.id] = votedForId;

    // Count eligible voters (players who submitted answers)
    const eligibleVoters = Object.keys(room.answers);
    const votesIn = Object.keys(room.votes).length;

    io.to(socket.roomCode).emit('vote-count', { voted: votesIn, total: eligibleVoters.length });

    if (votesIn === eligibleVoters.length) {
      showResults(socket.roomCode);
    }
  });

  // Admin force-shows results
  socket.on('force-results', () => {
    const room = rooms[socket.roomCode];
    if (!room || room.admin.id !== socket.id) return;
    if (room.phase === 'voting') {
      showResults(socket.roomCode);
    }
  });

  // Admin goes back to lobby for next question
  socket.on('next-round', () => {
    const room = rooms[socket.roomCode];
    if (!room || room.admin.id !== socket.id) return;
    room.phase = 'lobby';
    room.currentQuestion = null;
    room.answers = {};
    room.votes = {};
    io.to(socket.roomCode).emit('back-to-lobby', {
      players: room.players.map(p => ({ name: p.name, score: p.score })),
    });
  });

  socket.on('disconnect', () => {
    const room = rooms[socket.roomCode];
    if (!room) return;

    room.players = room.players.filter(p => p.id !== socket.id);

    if (room.admin.id === socket.id) {
      // Admin left — end the room
      io.to(socket.roomCode).emit('room-closed');
      delete rooms[socket.roomCode];
    } else {
      io.to(socket.roomCode).emit('player-list', room.players.map(p => ({ name: p.name, score: p.score })));
    }
  });
});

function startVoting(code) {
  const room = rooms[code];
  room.phase = 'voting';

  // Send answers with IDs but without revealing who wrote what
  const answerList = Object.entries(room.answers).map(([id, data]) => ({
    id,
    answer: data.answer,
  }));

  // Shuffle answers
  for (let i = answerList.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [answerList[i], answerList[j]] = [answerList[j], answerList[i]];
  }

  // Send each player the list, marking which one is theirs (so they can't vote for it)
  for (const player of room.players) {
    const personalList = answerList.map(a => ({
      ...a,
      isMine: a.id === player.id,
    }));
    io.to(player.id).emit('start-voting', { question: room.currentQuestion, answers: personalList });
  }
}

function showResults(code) {
  const room = rooms[code];
  room.phase = 'results';

  // Tally votes
  const voteCounts = {};
  for (const votedFor of Object.values(room.votes)) {
    voteCounts[votedFor] = (voteCounts[votedFor] || 0) + 1;
  }

  // Build results
  const results = Object.entries(room.answers).map(([id, data]) => {
    const voteCount = voteCounts[id] || 0;
    return { id, name: data.name, answer: data.answer, votes: voteCount };
  });

  // Sort by votes descending
  results.sort((a, b) => b.votes - a.votes);

  // Award points (each vote = 100 points)
  for (const r of results) {
    const player = room.players.find(p => p.id === r.id);
    if (player) player.score += r.votes * 100;
  }

  io.to(code).emit('show-results', {
    question: room.currentQuestion,
    results,
    scores: room.players.map(p => ({ name: p.name, score: p.score })).sort((a, b) => b.score - a.score),
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
