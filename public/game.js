const socket = io();

let isAdmin = false;
let roomCode = '';
let mySocketId = '';
let hasVoted = false;
let hasAnswered = false;

socket.on('connect', () => {
  mySocketId = socket.id;
});

// --- Screen management ---
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// --- Create Room ---
function createRoom() {
  const name = document.getElementById('admin-name').value.trim();
  if (!name) return;

  socket.emit('create-room', name, (res) => {
    if (res.success) {
      isAdmin = true;
      roomCode = res.code;
      document.getElementById('lobby-code').textContent = res.code;
      document.getElementById('admin-controls').style.display = 'block';
      showScreen('screen-lobby');
      generateQR('lobby-qr', res.code);
    }
  });
}

// --- Join Room ---
function joinRoom() {
  const code = document.getElementById('join-code').value.trim().toUpperCase();
  const name = document.getElementById('join-name').value.trim();
  const errorEl = document.getElementById('join-error');
  errorEl.textContent = '';

  if (!code || !name) {
    errorEl.textContent = 'Please enter both a room code and name.';
    return;
  }

  socket.emit('join-room', { code, name }, (res) => {
    if (res.success) {
      roomCode = code;
      document.getElementById('waiting-code').textContent = code;
      showScreen('screen-waiting');
    } else {
      errorEl.textContent = res.error;
    }
  });
}

// --- Start Question (Admin) ---
function startQuestion() {
  const question = document.getElementById('question-input').value.trim();
  if (!question) return;
  socket.emit('start-question', question);
  document.getElementById('question-input').value = '';
}

// --- Submit Answer ---
function submitAnswer() {
  const input = document.getElementById('answer-input');
  const answer = input.value.trim();
  if (!answer) return;

  socket.emit('submit-answer', answer);
  hasAnswered = true;
  document.getElementById('submit-answer-btn').disabled = true;
  document.getElementById('submit-answer-btn').textContent = 'Locked In';
  input.disabled = true;
}

// --- Force Voting (Admin) ---
function forceVoting() {
  socket.emit('force-voting');
}

// --- Force Results (Admin) ---
function forceResults() {
  socket.emit('force-results');
}

// --- Next Round (Admin) ---
function nextRound() {
  socket.emit('next-round');
}

// --- Socket Events ---

socket.on('player-list', (players) => {
  renderPlayerList('player-list', players);
  renderPlayerList('waiting-player-list', players);
});

socket.on('new-question', (data) => {
  hasAnswered = false;
  hasVoted = false;

  document.getElementById('round-badge').textContent = `Round ${data.round}`;
  document.getElementById('answer-question').textContent = data.question;
  document.getElementById('answer-input').value = '';
  document.getElementById('answer-input').disabled = false;
  document.getElementById('submit-answer-btn').disabled = false;
  document.getElementById('submit-answer-btn').textContent = 'Lock In';
  document.getElementById('answer-status').textContent = '';
  document.getElementById('force-vote-btn').style.display = isAdmin ? 'inline-block' : 'none';

  showScreen('screen-answer');
});

socket.on('answer-count', (data) => {
  document.getElementById('answer-status').textContent = `${data.answered} / ${data.total} answered`;
});

socket.on('start-voting', (data) => {
  hasVoted = false;
  document.getElementById('vote-question').textContent = data.question;
  document.getElementById('vote-status').textContent = '';
  document.getElementById('force-results-btn').style.display = isAdmin ? 'inline-block' : 'none';

  const container = document.getElementById('vote-options');
  container.innerHTML = '';

  data.answers.forEach(a => {
    const card = document.createElement('div');
    card.className = 'vote-card' + (a.isMine ? ' mine' : '');
    card.textContent = a.answer;

    if (!a.isMine) {
      card.addEventListener('click', () => {
        if (hasVoted) return;
        hasVoted = true;

        container.querySelectorAll('.vote-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        socket.emit('submit-vote', a.id);
      });
    }

    container.appendChild(card);
  });

  showScreen('screen-vote');
});

socket.on('vote-count', (data) => {
  document.getElementById('vote-status').textContent = `${data.voted} / ${data.total} voted`;
});

socket.on('show-results', (data) => {
  document.getElementById('results-question').textContent = data.question;

  const list = document.getElementById('results-list');
  list.innerHTML = '';

  data.results.forEach((r, i) => {
    const item = document.createElement('div');
    item.className = 'result-item' + (i === 0 && r.votes > 0 ? ' winner' : '');
    item.innerHTML = `
      <div class="result-rank">${i + 1}</div>
      <div class="result-content">
        <div class="result-answer">${escapeHtml(r.answer)}</div>
        <div class="result-author">- ${escapeHtml(r.name)}</div>
      </div>
      <div class="result-votes">${r.votes} vote${r.votes !== 1 ? 's' : ''}</div>
    `;
    list.appendChild(item);
  });

  const scoreboard = document.getElementById('scoreboard');
  scoreboard.innerHTML = '';

  data.scores.forEach(s => {
    const row = document.createElement('div');
    row.className = 'score-row';
    row.innerHTML = `
      <span>${escapeHtml(s.name)}</span>
      <span class="score-points">${s.score}</span>
    `;
    scoreboard.appendChild(row);
  });

  document.getElementById('next-round-btn').style.display = isAdmin ? 'inline-block' : 'none';
  document.getElementById('results-waiting').style.display = isAdmin ? 'none' : 'block';

  showScreen('screen-results');
});

socket.on('back-to-lobby', (data) => {
  renderPlayerList('player-list', data.players);
  renderPlayerList('waiting-player-list', data.players);

  if (isAdmin) {
    showScreen('screen-lobby');
  } else {
    showScreen('screen-waiting');
  }
});

socket.on('room-closed', () => {
  showScreen('screen-closed');
});

// --- QR Code ---
function generateQR(containerId, code) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';

  const joinUrl = `${window.location.origin}?code=${code}`;

  new QRCode(container, {
    text: joinUrl,
    width: 180,
    height: 180,
    colorDark: '#1a1a2e',
    colorLight: '#ffffff',
    correctLevel: QRCode.CorrectLevel.M,
  });
}

// --- Helpers ---

function renderPlayerList(elementId, players) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.innerHTML = players.map(p =>
    `<div class="player-chip">${escapeHtml(p.name)}${p.score > 0 ? `<span class="score">${p.score}</span>` : ''}</div>`
  ).join('');
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// --- Auto-fill room code from URL ---
(function() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  if (code) {
    document.getElementById('join-code').value = code.toUpperCase();
    showScreen('screen-join');
  }
})();

// Enter key support
document.getElementById('admin-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') createRoom();
});
document.getElementById('join-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinRoom();
});
document.getElementById('answer-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitAnswer(); }
});
