const socket = io();

let isAdmin = false;
let roomCode = '';
let mySocketId = '';
let hasVoted = false;
let hasAnswered = false;
let preloadedQuestions = [];
let pendingHostAnswer = null;
let pendingResultsData = null;

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
      document.getElementById('setup-room-code').textContent = res.code;
      showScreen('screen-setup');
    }
  });
}

// --- Setup Screen ---
function addPreloadedQuestion() {
  const q = document.getElementById('setup-question').value.trim();
  const a = document.getElementById('setup-answer').value.trim();
  if (!q) return;
  preloadedQuestions.push({ question: q, answer: a, used: false });
  document.getElementById('setup-question').value = '';
  document.getElementById('setup-answer').value = '';
  document.getElementById('setup-question').focus();
  renderSetupList();
}

function removePreloadedQuestion(i) {
  preloadedQuestions.splice(i, 1);
  renderSetupList();
}

function renderSetupList() {
  const list = document.getElementById('preloaded-list');
  if (preloadedQuestions.length === 0) {
    list.innerHTML = '<p class="empty-hint">No questions added yet.</p>';
    return;
  }
  list.innerHTML = preloadedQuestions.map((q, i) => `
    <div class="setup-item">
      <div class="setup-item-content">
        <div class="setup-q">${escapeHtml(q.question)}</div>
        ${q.answer ? `<div class="setup-a">Your answer: "${escapeHtml(q.answer)}"</div>` : ''}
      </div>
      <button class="btn-remove" onclick="removePreloadedQuestion(${i})">&#10005;</button>
    </div>
  `).join('');
}

function goToLobby() {
  document.getElementById('lobby-code').textContent = roomCode;
  document.getElementById('admin-controls').style.display = 'block';
  renderPreloadedQueue();
  showScreen('screen-lobby');
  generateQR('lobby-qr', roomCode);
}

// --- Preloaded queue in lobby ---
function renderPreloadedQueue() {
  const queue = document.getElementById('preloaded-queue');
  if (!queue) return;
  const remaining = preloadedQuestions.filter(q => !q.used);
  if (remaining.length === 0) {
    queue.style.display = 'none';
    return;
  }
  queue.style.display = 'block';
  queue.innerHTML = `
    <div class="queue-label">Saved Questions</div>
    <div class="queue-items">
      ${preloadedQuestions.map((q, i) => !q.used ? `
        <div class="queue-item" onclick="usePreloadedQuestion(${i})">${escapeHtml(q.question)}</div>
      ` : '').join('')}
    </div>
  `;
}

function usePreloadedQuestion(i) {
  const q = preloadedQuestions[i];
  document.getElementById('question-input').value = q.question;
  pendingHostAnswer = q.answer || null;
  preloadedQuestions[i].used = true;
  renderPreloadedQueue();
  document.getElementById('question-input').focus();
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
  document.getElementById('submit-answer-btn').textContent = 'Locked In ✓';
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

  // Pre-fill host's preloaded answer
  if (isAdmin && pendingHostAnswer) {
    document.getElementById('answer-input').value = pendingHostAnswer;
    pendingHostAnswer = null;
  }

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
  pendingResultsData = data;
  showLeaderboard(data.scores);
});

// --- Leaderboard Animation ---
function showLeaderboard(scores) {
  launchConfetti();

  const podium = document.getElementById('leaderboard-podium');
  const rest = document.getElementById('leaderboard-rest');
  const btn = document.getElementById('leaderboard-continue-btn');
  btn.style.display = 'none';
  podium.innerHTML = '';
  rest.innerHTML = '';

  const top3 = scores.slice(0, 3);
  const others = scores.slice(3);
  const medals = ['🥇', '🥈', '🥉'];
  const barHeights = ['110px', '75px', '50px']; // 1st, 2nd, 3rd

  // Classic podium order: 2nd, 1st, 3rd
  const order = [1, 0, 2];
  order.forEach(idx => {
    if (!top3[idx]) return;
    const player = top3[idx];
    const slot = document.createElement('div');
    slot.className = `podium-slot rank-${idx + 1}`;
    slot.innerHTML = `
      <div class="podium-info">
        <div class="podium-name">${escapeHtml(player.name)}</div>
        <div class="podium-medal">${medals[idx]}</div>
        <div class="podium-score">${player.score} pts</div>
      </div>
      <div class="podium-bar" data-height="${barHeights[idx]}"></div>
      <div class="podium-rank">${idx + 1}</div>
    `;
    podium.appendChild(slot);
  });

  if (others.length > 0) {
    rest.innerHTML = others.map((p, i) => `
      <div class="lb-row" style="animation-delay:${i * 0.12 + 0.6}s">
        <span class="lb-rank">${i + 4}</span>
        <span class="lb-name">${escapeHtml(p.name)}</span>
        <span class="lb-score">${p.score} pts</span>
      </div>
    `).join('');
  }

  showScreen('screen-leaderboard');

  // Animate bars after brief delay
  setTimeout(() => {
    podium.querySelectorAll('.podium-bar').forEach(bar => {
      bar.style.height = bar.dataset.height;
    });
  }, 250);

  // Show continue button after 3.5s
  setTimeout(() => {
    btn.style.display = 'inline-block';
  }, 3500);
}

function showResultsAfterLeaderboard() {
  if (!pendingResultsData) return;
  const data = pendingResultsData;

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
        <div class="result-author">— ${escapeHtml(r.name)}</div>
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
}

socket.on('back-to-lobby', (data) => {
  renderPlayerList('player-list', data.players);
  renderPlayerList('waiting-player-list', data.players);
  renderPreloadedQueue();

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

// --- Confetti ---
function launchConfetti() {
  const container = document.getElementById('confetti-container');
  container.innerHTML = '';
  const colors = ['#ffd200', '#f7971e', '#ff6b9d', '#00d4ff', '#7fff6b', '#c77dff'];
  for (let i = 0; i < 70; i++) {
    const dot = document.createElement('div');
    dot.className = 'confetti-dot';
    dot.style.cssText = `
      left: ${Math.random() * 100}%;
      background: ${colors[Math.floor(Math.random() * colors.length)]};
      animation-delay: ${Math.random() * 2}s;
      animation-duration: ${2.5 + Math.random() * 2}s;
      width: ${6 + Math.random() * 8}px;
      height: ${6 + Math.random() * 8}px;
      border-radius: ${Math.random() > 0.5 ? '50%' : '3px'};
    `;
    container.appendChild(dot);
  }
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
document.getElementById('setup-question').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); document.getElementById('setup-answer').focus(); }
});
document.getElementById('setup-answer').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); addPreloadedQuestion(); }
});
