const socket = io();

let isAdmin = false;
let roomCode = '';
let mySocketId = '';
let hasVoted = false;
let hasAnswered = false;
let preloadedQuestions = [];
let selectedSetupType = 'open';
let currentTimeLimit = 30;
let currentQuestionType = 'open';
let pendingResultsData = null;
let choiceResultsScores = null;
let leaderboardMode = null; // 'open-results' or 'next-round'

socket.on('connect', () => {
  mySocketId = socket.id;
});

// ── Screen management ──

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// ── Setup — question type tabs ──

function selectQuestionType(type, btn) {
  selectedSetupType = type;
  document.querySelectorAll('.type-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('.setup-fields').forEach(f => f.style.display = 'none');
  document.getElementById('fields-' + type).style.display = 'block';
}

// ── Setup — add question ──

function addPreloadedQuestion() {
  const type = selectedSetupType;
  const timeRadio = document.querySelector('input[name="time-limit"]:checked');
  const timeLimit = timeRadio ? parseInt(timeRadio.value) : 30;
  let data;

  if (type === 'open') {
    const q = document.getElementById('setup-q-open').value.trim();
    if (!q) return;
    const a = document.getElementById('setup-a-open').value.trim();
    data = { type, question: q, hostAnswer: a || null, timeLimit };
    document.getElementById('setup-q-open').value = '';
    document.getElementById('setup-a-open').value = '';
    document.getElementById('setup-q-open').focus();
  } else if (type === 'choice') {
    const q = document.getElementById('setup-q-choice').value.trim();
    if (!q) return;
    const opts = [];
    for (let i = 0; i < 4; i++) {
      const v = document.getElementById('setup-opt-' + i).value.trim();
      if (v) opts.push(v);
    }
    if (opts.length < 2) { alert('Add at least 2 options'); return; }
    const radio = document.querySelector('input[name="correct-choice"]:checked');
    if (!radio) { alert('Mark the correct answer'); return; }
    const ci = parseInt(radio.value);
    if (ci >= opts.length) { alert('Correct answer must be a filled option'); return; }
    data = { type, question: q, options: opts, correctIndex: ci, timeLimit };
    document.getElementById('setup-q-choice').value = '';
    for (let i = 0; i < 4; i++) document.getElementById('setup-opt-' + i).value = '';
    document.getElementById('setup-q-choice').focus();
  } else if (type === 'truefalse') {
    const q = document.getElementById('setup-q-tf').value.trim();
    if (!q) return;
    const ci = parseInt(document.querySelector('input[name="correct-tf"]:checked').value);
    data = { type, question: q, correctIndex: ci, timeLimit };
    document.getElementById('setup-q-tf').value = '';
    document.getElementById('setup-q-tf').focus();
  }

  preloadedQuestions.push(data);
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
  const icons = { open: '\u270D', choice: '\uD83D\uDD20', truefalse: '\u2705' };
  const labels = { open: 'Open', choice: 'Choice', truefalse: 'T/F' };
  list.innerHTML = preloadedQuestions.map((q, i) => `
    <div class="setup-item">
      <span class="setup-type-icon">${icons[q.type] || ''}</span>
      <div class="setup-item-content">
        <div class="setup-q">${escapeHtml(q.question)}</div>
        <div class="setup-meta">${labels[q.type]} &middot; ${q.timeLimit}s</div>
      </div>
      <button class="btn-remove" onclick="removePreloadedQuestion(${i})">&#10005;</button>
    </div>
  `).join('');
}

// ── Create Room ──

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

// ── Go to Lobby ──

function goToLobby() {
  if (preloadedQuestions.length > 0) {
    socket.emit('load-questions', preloadedQuestions);
  }
  document.getElementById('lobby-code').textContent = roomCode;
  document.getElementById('admin-controls').style.display = 'block';
  updateLobbyControls(preloadedQuestions.length);
  showScreen('screen-lobby');
  generateQR('lobby-qr', roomCode);
}

function updateLobbyControls(remaining) {
  const qi = document.getElementById('queue-info');
  const cs = document.getElementById('custom-q-section');
  const cb = document.getElementById('custom-q-btn');
  if (remaining > 0) {
    qi.style.display = 'block';
    document.getElementById('queue-count').textContent = remaining;
    cb.className = 'btn btn-secondary';
    document.getElementById('question-input').placeholder = 'Or type a custom question...';
  } else {
    qi.style.display = 'none';
    cb.className = 'btn btn-primary';
    document.getElementById('question-input').placeholder = 'Type your question...';
  }
}

function startNextQuestion() {
  socket.emit('start-question', null);
}

function startCustomQuestion() {
  const q = document.getElementById('question-input').value.trim();
  if (!q) return;
  socket.emit('start-question', q);
  document.getElementById('question-input').value = '';
}

// ── Join Room ──

function joinRoom() {
  const code = document.getElementById('join-code').value.trim().toUpperCase();
  const name = document.getElementById('join-name').value.trim();
  const err = document.getElementById('join-error');
  err.textContent = '';
  if (!code || !name) { err.textContent = 'Enter both a room code and name.'; return; }
  socket.emit('join-room', { code, name }, (res) => {
    if (res.success) {
      roomCode = code;
      document.getElementById('waiting-code').textContent = code;
      showScreen('screen-waiting');
    } else {
      err.textContent = res.error;
    }
  });
}

// ── Submit Answer — open ──

function submitAnswer() {
  const input = document.getElementById('answer-input');
  const answer = input.value.trim();
  if (!answer || hasAnswered) return;
  socket.emit('submit-answer', answer);
  hasAnswered = true;
  document.getElementById('submit-answer-btn').disabled = true;
  document.getElementById('submit-answer-btn').textContent = 'Locked In \u2713';
  input.disabled = true;
}

// ── Submit Answer — choice / tf ──

function submitChoice(index) {
  if (hasAnswered) return;
  hasAnswered = true;
  socket.emit('submit-answer', String(index));
  document.querySelectorAll('.choice-btn').forEach(b => {
    b.classList.add('locked');
    if (parseInt(b.dataset.idx) === index) b.classList.add('selected');
  });
}

// ── Admin controls ──

function forceVoting() { socket.emit('force-voting'); }
function forceResults() { socket.emit('force-results'); }
function nextRound() { socket.emit('next-round'); }

// ═══════════════════════════════
// SOCKET EVENTS
// ═══════════════════════════════

socket.on('player-list', (players) => {
  renderPlayerList('player-list', players);
  renderPlayerList('waiting-player-list', players);
});

// ── New question ──

socket.on('new-question', (data) => {
  hasAnswered = false;
  hasVoted = false;
  currentTimeLimit = data.timeLimit;
  currentQuestionType = data.type;

  const label = 'Question ' + data.round + ' of ' + data.totalQuestions;

  if (data.type === 'choice' || data.type === 'truefalse') {
    document.getElementById('choice-round-badge').textContent = label;
    document.getElementById('choice-question-text').textContent = data.question;
    document.getElementById('choice-timer-num').textContent = data.timeLimit;
    document.getElementById('choice-timer-bar').style.width = '100%';
    document.getElementById('choice-answer-status').textContent = '';

    const grid = document.getElementById('choice-options-grid');
    grid.innerHTML = '';
    const shapes = ['\u25B2', '\u25C6', '\u25CF', '\u25A0'];
    const colors = ['#e21b3c', '#1368ce', '#d89e00', '#26890c'];

    data.options.forEach((opt, i) => {
      const btn = document.createElement('button');
      btn.className = 'choice-btn';
      btn.dataset.idx = i;
      btn.style.background = colors[i];
      btn.innerHTML = '<span class="choice-shape">' + shapes[i] + '</span> ' + escapeHtml(opt);
      btn.addEventListener('click', () => submitChoice(i));
      grid.appendChild(btn);
    });

    grid.className = data.type === 'truefalse' ? 'choice-grid tf-grid' : 'choice-grid';
    showScreen('screen-answer-choice');
  } else {
    document.getElementById('round-badge').textContent = label;
    document.getElementById('answer-question').textContent = data.question;
    document.getElementById('answer-input').value = '';
    document.getElementById('answer-input').disabled = false;
    document.getElementById('submit-answer-btn').disabled = false;
    document.getElementById('submit-answer-btn').textContent = 'Lock In';
    document.getElementById('answer-status').textContent = '';
    document.getElementById('open-timer-num').textContent = data.timeLimit;
    document.getElementById('open-timer-bar').style.width = '100%';
    document.getElementById('force-vote-btn').style.display = isAdmin ? 'inline-block' : 'none';
    showScreen('screen-answer');
  }
});

// ── Timer ──

socket.on('timer-tick', (remaining) => {
  const pct = ((remaining / currentTimeLimit) * 100) + '%';
  const isLow = remaining <= 5;

  if (currentQuestionType === 'choice' || currentQuestionType === 'truefalse') {
    document.getElementById('choice-timer-bar').style.width = pct;
    const num = document.getElementById('choice-timer-num');
    num.textContent = remaining;
    num.classList.toggle('timer-low', isLow);
  } else {
    document.getElementById('open-timer-bar').style.width = pct;
    const num = document.getElementById('open-timer-num');
    num.textContent = remaining;
    num.classList.toggle('timer-low', isLow);
  }
});

socket.on('time-up', () => {
  if (currentQuestionType === 'choice' || currentQuestionType === 'truefalse') {
    document.getElementById('choice-timer-bar').style.width = '0%';
    document.getElementById('choice-timer-num').textContent = '0';
  } else {
    document.getElementById('open-timer-bar').style.width = '0%';
    document.getElementById('open-timer-num').textContent = '0';
  }
});

// ── Host answer prefilled ──

socket.on('answer-prefilled', (data) => {
  hasAnswered = true;
  document.getElementById('answer-input').value = data.answer;
  document.getElementById('answer-input').disabled = true;
  document.getElementById('submit-answer-btn').disabled = true;
  document.getElementById('submit-answer-btn').textContent = 'Locked In \u2713';
});

// ── Answer count ──

socket.on('answer-count', (data) => {
  const text = data.answered + ' / ' + data.total + ' answered';
  document.getElementById('answer-status').textContent = text;
  document.getElementById('choice-answer-status').textContent = text;
});

// ── Choice / TF results ──

socket.on('choice-results', (data) => {
  choiceResultsScores = data.scores;

  document.getElementById('cr-question').textContent = data.question;

  // Feedback
  const fb = document.getElementById('cr-feedback');
  if (data.myChoice === -1) {
    fb.innerHTML = '<div class="fb-miss">Time\'s up! No answer</div>';
  } else if (data.isCorrect) {
    fb.innerHTML = '<div class="fb-correct">Correct!</div>';
  } else {
    fb.innerHTML = '<div class="fb-wrong">Wrong! Answer: ' + escapeHtml(data.options[data.correctIndex]) + '</div>';
  }

  // Breakdown
  const maxC = Math.max(...data.breakdown, 1);
  const shapes = ['\u25B2', '\u25C6', '\u25CF', '\u25A0'];
  const colors = ['#e21b3c', '#1368ce', '#d89e00', '#26890c'];
  const bd = document.getElementById('cr-breakdown');
  bd.innerHTML = data.options.map((opt, i) => {
    const w = Math.max((data.breakdown[i] / maxC) * 100, 8);
    const correct = i === data.correctIndex;
    return '<div class="bd-row">' +
      '<div class="bd-label' + (correct ? ' bd-correct' : '') + '" style="color:' + colors[i] + '">' +
        shapes[i] + ' ' + escapeHtml(opt) + (correct ? ' \u2713' : '') +
      '</div>' +
      '<div class="bd-bar-bg">' +
        '<div class="bd-bar" style="width:' + w + '%;background:' + colors[i] + '">' + data.breakdown[i] + '</div>' +
      '</div>' +
    '</div>';
  }).join('');

  // Points
  const pts = document.getElementById('cr-points');
  if (data.pointsEarned > 0) {
    pts.innerHTML = '<div class="pts-value">+' + data.pointsEarned + '</div>';
  } else {
    pts.innerHTML = '<div class="pts-zero">+0</div>';
  }

  document.getElementById('cr-continue-btn').style.display = 'none';
  document.getElementById('cr-waiting').style.display = 'none';

  showScreen('screen-choice-results');

  setTimeout(() => {
    if (isAdmin) {
      document.getElementById('cr-continue-btn').style.display = 'inline-block';
    } else {
      document.getElementById('cr-waiting').style.display = 'block';
    }
  }, 3000);
});

function showChoiceLeaderboard() {
  if (!choiceResultsScores) return;
  showLeaderboard(choiceResultsScores, 'next-round');
}

// ── Voting (open) ──

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
  document.getElementById('vote-status').textContent = data.voted + ' / ' + data.total + ' voted';
});

// ── Open results ──

socket.on('show-results', (data) => {
  pendingResultsData = data;
  showLeaderboard(data.scores, 'open-results');
});

// ═══════════════════════════════
// LEADERBOARD
// ═══════════════════════════════

function showLeaderboard(scores, mode) {
  leaderboardMode = mode;
  launchConfetti();

  const podium = document.getElementById('leaderboard-podium');
  const rest = document.getElementById('leaderboard-rest');
  const btn = document.getElementById('leaderboard-continue-btn');
  const waitMsg = document.getElementById('leaderboard-waiting');
  btn.style.display = 'none';
  waitMsg.style.display = 'none';
  podium.innerHTML = '';
  rest.innerHTML = '';

  const top3 = scores.slice(0, 3);
  const others = scores.slice(3);
  const medals = ['\uD83E\uDD47', '\uD83E\uDD48', '\uD83E\uDD49'];
  const barHeights = ['110px', '75px', '50px'];
  var order = [1, 0, 2];

  order.forEach(idx => {
    if (!top3[idx]) return;
    const p = top3[idx];
    const slot = document.createElement('div');
    slot.className = 'podium-slot rank-' + (idx + 1);
    slot.innerHTML =
      '<div class="podium-info">' +
        '<div class="podium-name">' + escapeHtml(p.name) + '</div>' +
        '<div class="podium-medal">' + medals[idx] + '</div>' +
        '<div class="podium-score">' + p.score + ' pts</div>' +
      '</div>' +
      '<div class="podium-bar" data-height="' + barHeights[idx] + '"></div>' +
      '<div class="podium-rank">' + (idx + 1) + '</div>';
    podium.appendChild(slot);
  });

  if (others.length > 0) {
    rest.innerHTML = others.map((p, i) =>
      '<div class="lb-row" style="animation-delay:' + (i * 0.12 + 0.6) + 's">' +
        '<span class="lb-rank">' + (i + 4) + '</span>' +
        '<span class="lb-name">' + escapeHtml(p.name) + '</span>' +
        '<span class="lb-score">' + p.score + ' pts</span>' +
      '</div>'
    ).join('');
  }

  showScreen('screen-leaderboard');

  setTimeout(() => {
    podium.querySelectorAll('.podium-bar').forEach(bar => {
      bar.style.height = bar.dataset.height;
    });
  }, 250);

  setTimeout(() => {
    if (mode === 'next-round') {
      if (isAdmin) {
        btn.textContent = 'Next Round';
        btn.style.display = 'inline-block';
      } else {
        waitMsg.style.display = 'block';
      }
    } else {
      btn.textContent = 'See Round Results';
      btn.style.display = 'inline-block';
    }
  }, 3500);
}

function leaderboardContinue() {
  if (leaderboardMode === 'next-round') {
    nextRound();
  } else {
    showOpenResultsScreen();
  }
}

function showOpenResultsScreen() {
  if (!pendingResultsData) return;
  const data = pendingResultsData;

  document.getElementById('results-question').textContent = data.question;

  const list = document.getElementById('results-list');
  list.innerHTML = '';
  data.results.forEach((r, i) => {
    const item = document.createElement('div');
    item.className = 'result-item' + (i === 0 && r.votes > 0 ? ' winner' : '');
    item.innerHTML =
      '<div class="result-rank">' + (i + 1) + '</div>' +
      '<div class="result-content">' +
        '<div class="result-answer">' + escapeHtml(r.answer) + '</div>' +
        '<div class="result-author">\u2014 ' + escapeHtml(r.name) + '</div>' +
      '</div>' +
      '<div class="result-votes">' + r.votes + ' vote' + (r.votes !== 1 ? 's' : '') + '</div>';
    list.appendChild(item);
  });

  const sb = document.getElementById('scoreboard');
  sb.innerHTML = '';
  data.scores.forEach(s => {
    const row = document.createElement('div');
    row.className = 'score-row';
    row.innerHTML = '<span>' + escapeHtml(s.name) + '</span><span class="score-points">' + s.score + '</span>';
    sb.appendChild(row);
  });

  document.getElementById('next-round-btn').style.display = isAdmin ? 'inline-block' : 'none';
  document.getElementById('results-waiting').style.display = isAdmin ? 'none' : 'block';
  showScreen('screen-results');
}

// ── Back to lobby ──

socket.on('back-to-lobby', (data) => {
  renderPlayerList('player-list', data.players);
  renderPlayerList('waiting-player-list', data.players);
  if (isAdmin) {
    updateLobbyControls(data.questionsRemaining);
    showScreen('screen-lobby');
  } else {
    showScreen('screen-waiting');
  }
});

socket.on('room-closed', () => {
  showScreen('screen-closed');
});

// ═══════════════════════════════
// UTILITIES
// ═══════════════════════════════

function generateQR(containerId, code) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';
  const joinUrl = window.location.origin + '?code=' + code;
  new QRCode(container, {
    text: joinUrl,
    width: 180,
    height: 180,
    colorDark: '#1a1a2e',
    colorLight: '#ffffff',
    correctLevel: QRCode.CorrectLevel.M,
  });
}

function launchConfetti() {
  const c = document.getElementById('confetti-container');
  c.innerHTML = '';
  const colors = ['#ffd200', '#f7971e', '#ff6b9d', '#00d4ff', '#7fff6b', '#c77dff'];
  for (let i = 0; i < 70; i++) {
    const d = document.createElement('div');
    d.className = 'confetti-dot';
    d.style.cssText =
      'left:' + (Math.random() * 100) + '%;' +
      'background:' + colors[Math.floor(Math.random() * colors.length)] + ';' +
      'animation-delay:' + (Math.random() * 2) + 's;' +
      'animation-duration:' + (2.5 + Math.random() * 2) + 's;' +
      'width:' + (6 + Math.random() * 8) + 'px;' +
      'height:' + (6 + Math.random() * 8) + 'px;' +
      'border-radius:' + (Math.random() > 0.5 ? '50%' : '3px') + ';';
    c.appendChild(d);
  }
}

function renderPlayerList(elementId, players) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.innerHTML = players.map(p =>
    '<div class="player-chip">' + escapeHtml(p.name) +
    (p.score > 0 ? '<span class="score">' + p.score + '</span>' : '') +
    '</div>'
  ).join('');
}

function escapeHtml(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

// ── Auto-fill room code from URL ──
(function () {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  if (code) {
    document.getElementById('join-code').value = code.toUpperCase();
    showScreen('screen-join');
  }
})();

// ── Enter key support ──
document.getElementById('admin-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') createRoom();
});
document.getElementById('join-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinRoom();
});
document.getElementById('answer-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitAnswer(); }
});
document.getElementById('setup-q-open').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); document.getElementById('setup-a-open').focus(); }
});
document.getElementById('setup-a-open').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); addPreloadedQuestion(); }
});
document.getElementById('setup-q-tf').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); addPreloadedQuestion(); }
});
