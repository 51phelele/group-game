const socket = io();

const AVATARS = ['🦊','🐸','🦄','🐙','👻','🤖','🎃','🦖','🐷','🦋','🍕','🌮','🧁','🎸','🚀','🌈'];

let isAdmin = false;
let roomCode = '';
let mySocketId = '';
let hasVoted = false;
let hasAnswered = false;
let preloadedQuestions = [];
let selectedSetupType = 'open';
let selectedAvatar = AVATARS[0];
let currentTimeLimit = 30;
let currentQuestionType = 'open';
let pendingResultsData = null;
let choiceResultsScores = null;
let leaderboardMode = null;

socket.on('connect', () => { mySocketId = socket.id; });

// ── Screen management ──
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// ── Avatar picker ──
function renderAvatarPicker(containerId) {
  const el = document.getElementById(containerId);
  el.innerHTML = AVATARS.map((a, i) =>
    '<button class="avatar-option' + (i === 0 ? ' selected' : '') + '" data-avatar="' + a + '" onclick="pickAvatar(this, \'' + containerId + '\')">' + a + '</button>'
  ).join('');
}

function pickAvatar(btn, containerId) {
  document.querySelectorAll('#' + containerId + ' .avatar-option').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  selectedAvatar = btn.dataset.avatar;
}

// Init avatar pickers
renderAvatarPicker('create-avatar-picker');
renderAvatarPicker('join-avatar-picker');

// Handle URL params for join links
handleUrlParams();

// ── Setup — question type tabs ──
function selectQuestionType(type, btn) {
  selectedSetupType = type;
  document.querySelectorAll('.type-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('.setup-fields').forEach(f => f.style.display = 'none');
  document.getElementById('fields-' + type).style.display = 'block';

  // Update time pills based on type
  updateTimePills(type);

  // Show/hide points selector (not for consensus)
  document.getElementById('points-selector').style.display =
    type === 'consensus' ? 'none' : '';
}

function updateTimePills(type) {
  var container = document.getElementById('time-pills');
  var times, labels;
  if (type === 'consensus') {
    times = [30, 60, 90, 120, 180];
    labels = ['30s', '1min', '1:30', '2min', '3min'];
  } else {
    times = [10, 20, 30, 45, 60];
    labels = ['10s', '20s', '30s', '45s', '60s'];
  }
  container.innerHTML = times.map(function(t, i) {
    return '<label class="time-pill"><input type="radio" name="time-limit" value="' + t + '"' +
      (t === 30 ? ' checked' : '') + '><span>' + labels[i] + '</span></label>';
  }).join('');
}

// ── Setup — add question ──
function addPreloadedQuestion() {
  const type = selectedSetupType;
  const timeRadio = document.querySelector('input[name="time-limit"]:checked');
  const timeLimit = timeRadio ? parseInt(timeRadio.value) : 30;
  const pointsRadio = document.querySelector('input[name="max-points"]:checked');
  const maxPoints = pointsRadio ? parseInt(pointsRadio.value) : 1000;
  let data;

  if (type === 'open') {
    const q = document.getElementById('setup-q-open').value.trim();
    if (!q) return;
    const a = document.getElementById('setup-a-open').value.trim();
    if (!a) { alert('Enter the correct answer'); return; }
    data = { type, question: q, hostAnswer: a, timeLimit, maxPoints };
    document.getElementById('setup-q-open').value = '';
    document.getElementById('setup-a-open').value = '';
    document.getElementById('setup-q-open').focus();
  } else if (type === 'consensus') {
    const q = document.getElementById('setup-q-consensus').value.trim();
    if (!q) return;
    const a = document.getElementById('setup-a-consensus').value.trim();
    data = { type, question: q, hostAnswer: a || null, timeLimit };
    document.getElementById('setup-q-consensus').value = '';
    document.getElementById('setup-a-consensus').value = '';
    document.getElementById('setup-q-consensus').focus();
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
    data = { type, question: q, options: opts, correctIndex: ci, timeLimit, maxPoints };
    document.getElementById('setup-q-choice').value = '';
    for (let i = 0; i < 4; i++) document.getElementById('setup-opt-' + i).value = '';
    document.getElementById('setup-q-choice').focus();
  } else if (type === 'truefalse') {
    const q = document.getElementById('setup-q-tf').value.trim();
    if (!q) return;
    const ci = parseInt(document.querySelector('input[name="correct-tf"]:checked').value);
    data = { type, question: q, correctIndex: ci, timeLimit, maxPoints };
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
    document.getElementById('save-quiz-row').style.display = 'none';
    return;
  }
  document.getElementById('save-quiz-row').style.display = 'flex';
  var icons = { open: '\u270D', choice: '\uD83D\uDD20', truefalse: '\u2705', consensus: '\uD83E\uDD1D' };
  var labels = { open: 'Open', choice: 'Choice', truefalse: 'T/F', consensus: 'Consensus' };
  list.innerHTML = preloadedQuestions.map(function(q, i) {
    var meta = labels[q.type] + ' \u00B7 ' + q.timeLimit + 's';
    if (q.maxPoints && q.type !== 'consensus') meta += ' \u00B7 ' + q.maxPoints + 'pts';
    return '<div class="setup-item">' +
      '<span class="setup-type-icon">' + (icons[q.type] || '') + '</span>' +
      '<div class="setup-item-content">' +
        '<div class="setup-q">' + escapeHtml(q.question) + '</div>' +
        '<div class="setup-meta">' + meta + '</div>' +
      '</div>' +
      '<button class="btn-remove" onclick="removePreloadedQuestion(' + i + ')">&#10005;</button>' +
    '</div>';
  }).join('');
}

// ── Saved Quizzes ──
var STORAGE_KEY = 'vibecheck_saved_quizzes';

function getSavedQuizzes() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch (e) {
    return [];
  }
}

function saveSavedQuizzes(quizzes) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(quizzes));
}

function saveCurrentQuiz() {
  var nameInput = document.getElementById('save-quiz-name');
  var name = nameInput.value.trim();
  if (!name) { alert('Enter a name for this quiz'); return; }
  if (preloadedQuestions.length === 0) { alert('Add questions first'); return; }

  var quizzes = getSavedQuizzes();
  var existing = quizzes.findIndex(function(q) { return q.name === name; });
  if (existing >= 0) {
    if (!confirm('A quiz named "' + name + '" already exists. Overwrite it?')) return;
    quizzes[existing] = { name: name, questions: preloadedQuestions, savedAt: new Date().toISOString() };
  } else {
    quizzes.push({ name: name, questions: preloadedQuestions, savedAt: new Date().toISOString() });
  }

  saveSavedQuizzes(quizzes);
  nameInput.value = '';
  renderSavedQuizzes();
  alert('Quiz "' + name + '" saved!');
}

function loadSavedQuiz(index) {
  var quizzes = getSavedQuizzes();
  var quiz = quizzes[index];
  if (!quiz) return;

  if (preloadedQuestions.length > 0) {
    if (!confirm('This will replace your current questions. Continue?')) return;
  }

  preloadedQuestions = quiz.questions.map(function(q) { return Object.assign({}, q); });
  renderSetupList();
  renderSavedQuizzes();
}

function deleteSavedQuiz(index) {
  var quizzes = getSavedQuizzes();
  var quiz = quizzes[index];
  if (!quiz) return;
  if (!confirm('Delete "' + quiz.name + '"?')) return;
  quizzes.splice(index, 1);
  saveSavedQuizzes(quizzes);
  renderSavedQuizzes();
}

function renderSavedQuizzes() {
  var quizzes = getSavedQuizzes();
  var container = document.getElementById('saved-quizzes-list');
  var header = document.getElementById('saved-header');

  if (quizzes.length === 0) {
    header.style.display = 'none';
    container.innerHTML = '';
    return;
  }

  header.style.display = 'block';
  var typeLabels = { open: 'Open', choice: 'Choice', truefalse: 'T/F', consensus: 'Consensus' };

  container.innerHTML = quizzes.map(function(quiz, i) {
    var counts = {};
    quiz.questions.forEach(function(q) {
      counts[q.type] = (counts[q.type] || 0) + 1;
    });
    var summary = Object.entries(counts).map(function(e) {
      return e[1] + ' ' + (typeLabels[e[0]] || e[0]);
    }).join(', ');

    return '<div class="saved-quiz-item">' +
      '<div class="saved-quiz-info">' +
        '<div class="saved-quiz-name">' + escapeHtml(quiz.name) + '</div>' +
        '<div class="saved-quiz-meta">' + quiz.questions.length + ' questions \u00B7 ' + summary + '</div>' +
      '</div>' +
      '<div class="saved-quiz-actions">' +
        '<button class="btn btn-small btn-primary" onclick="loadSavedQuiz(' + i + ')">Load</button>' +
        '<button class="btn-remove" onclick="deleteSavedQuiz(' + i + ')">\u2715</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

// Init saved quizzes on page load
renderSavedQuizzes();

// ── Create Room ──
function createRoom() {
  const name = document.getElementById('admin-name').value.trim();
  if (!name) return;
  socket.emit('create-room', { name, avatar: selectedAvatar }, function(res) {
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
  if (preloadedQuestions.length === 0) {
    alert('Add at least one question before opening the lobby.');
    return;
  }
  socket.emit('load-questions', preloadedQuestions);
  document.getElementById('lobby-code').textContent = roomCode;
  document.getElementById('admin-controls').style.display = 'block';
  document.getElementById('queue-count').textContent = preloadedQuestions.length;
  setJoinLink(roomCode);
  showScreen('screen-lobby');
  generateQR('lobby-qr', roomCode);
}

function startNextQuestion() {
  socket.emit('start-question');
}

// ── Join Link Handling ──
function generateJoinLink(code) {
  const baseUrl = window.location.origin + window.location.pathname;
  return baseUrl + '?code=' + encodeURIComponent(code);
}

function setJoinLink(code) {
  const link = generateJoinLink(code);
  document.getElementById('join-link').value = link;
}

function copyJoinLink() {
  const linkInput = document.getElementById('join-link');
  linkInput.select();
  document.execCommand('copy');
  alert('Join link copied to clipboard!');
}

function handleUrlParams() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  if (code) {
    document.getElementById('join-code').value = code.toUpperCase();
    showScreen('screen-join');
  }
}

// ── Join Room ──
function joinRoom() {
  const code = document.getElementById('join-code').value.trim().toUpperCase();
  const name = document.getElementById('join-name').value.trim();
  const err = document.getElementById('join-error');
  err.textContent = '';
  if (!code || !name) { err.textContent = 'Enter both a room code and name.'; return; }
  socket.emit('join-room', { code, name, avatar: selectedAvatar }, function(res) {
    if (res.success) {
      roomCode = code;
      document.getElementById('waiting-code').textContent = code;
      showScreen('screen-waiting');
    } else {
      err.textContent = res.error;
    }
  });
}

// ── Submit Answer — open / consensus (players only) ──
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

// ── Submit Answer — choice/tf (players only) ──
function submitChoice(index) {
  if (hasAnswered) return;
  hasAnswered = true;
  socket.emit('submit-answer', String(index));
  document.querySelectorAll('.choice-btn').forEach(function(b) {
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

socket.on('player-list', function(players) {
  renderPlayerList('player-list', players);
  renderPlayerList('waiting-player-list', players);
});

// ── Host sees spectator view ──
socket.on('host-question-view', function(data) {
  currentTimeLimit = data.timeLimit;
  currentQuestionType = data.type;
  hasAnswered = true; // host never answers

  var label = 'Question ' + data.round + ' of ' + data.totalQuestions;
  document.getElementById('host-round-badge').textContent = label;
  document.getElementById('host-question-text').textContent = data.question;
  document.getElementById('host-timer-num').textContent = data.timeLimit;
  document.getElementById('host-timer-bar').style.width = '100%';
  document.getElementById('host-answer-count').textContent = 'Waiting for answers...';
  // Show force-vote button only for consensus (needs voting phase)
  document.getElementById('host-force-vote-btn').style.display =
    data.type === 'consensus' ? 'inline-block' : 'none';

  showScreen('screen-host-waiting');
});

// ── Players see question ──
socket.on('new-question', function(data) {
  hasAnswered = false;
  hasVoted = false;
  currentTimeLimit = data.timeLimit;
  currentQuestionType = data.type;

  var label = 'Question ' + data.round + ' of ' + data.totalQuestions;

  if (data.type === 'choice' || data.type === 'truefalse') {
    document.getElementById('choice-round-badge').textContent = label;
    document.getElementById('choice-question-text').textContent = data.question;
    document.getElementById('choice-timer-num').textContent = data.timeLimit;
    document.getElementById('choice-timer-bar').style.width = '100%';
    document.getElementById('choice-answer-status').textContent = '';

    var grid = document.getElementById('choice-options-grid');
    grid.innerHTML = '';
    var shapes = ['\u25B2', '\u25C6', '\u25CF', '\u25A0'];
    var colors = ['#e21b3c', '#1368ce', '#d89e00', '#26890c'];

    data.options.forEach(function(opt, i) {
      var btn = document.createElement('button');
      btn.className = 'choice-btn';
      btn.dataset.idx = i;
      btn.style.background = colors[i];
      btn.innerHTML = '<span class="choice-shape">' + shapes[i] + '</span> ' + escapeHtml(opt);
      btn.addEventListener('click', function() { submitChoice(i); });
      grid.appendChild(btn);
    });

    grid.className = data.type === 'truefalse' ? 'choice-grid tf-grid' : 'choice-grid';
    showScreen('screen-answer-choice');
  } else {
    // open and consensus both use the text input screen
    document.getElementById('round-badge').textContent = label;
    document.getElementById('answer-question').textContent = data.question;
    document.getElementById('answer-input').value = '';
    document.getElementById('answer-input').disabled = false;
    document.getElementById('submit-answer-btn').disabled = false;
    document.getElementById('submit-answer-btn').textContent = 'Lock In';
    document.getElementById('answer-status').textContent = '';
    document.getElementById('open-timer-num').textContent = data.timeLimit;
    document.getElementById('open-timer-bar').style.width = '100%';
    showScreen('screen-answer');
  }
});

// ── Timer ──
socket.on('timer-tick', function(remaining) {
  var pct = ((remaining / currentTimeLimit) * 100) + '%';
  var isLow = remaining <= 5;

  // Update all timer bars (host + player screens)
  ['choice-timer-bar', 'open-timer-bar', 'host-timer-bar'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.style.width = pct;
  });
  ['choice-timer-num', 'open-timer-num', 'host-timer-num'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) {
      el.textContent = remaining;
      el.classList.toggle('timer-low', isLow);
    }
  });
});

socket.on('time-up', function() {
  ['choice-timer-bar', 'open-timer-bar', 'host-timer-bar'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.style.width = '0%';
  });
  ['choice-timer-num', 'open-timer-num', 'host-timer-num'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.textContent = '0';
  });
});

// ── Answer count ──
socket.on('answer-count', function(data) {
  var text = data.answered + ' / ' + data.total + ' answered';
  var el1 = document.getElementById('answer-status');
  var el2 = document.getElementById('choice-answer-status');
  var el3 = document.getElementById('host-answer-count');
  if (el1) el1.textContent = text;
  if (el2) el2.textContent = text;
  if (el3) el3.textContent = text;
});

// ── Host voting view ──
socket.on('host-voting-view', function(data) {
  document.getElementById('host-vote-question').textContent = data.question;
  document.getElementById('host-vote-count').textContent = '';
  showScreen('screen-host-voting');
});

// ── Player voting (consensus) ──
socket.on('start-voting', function(data) {
  hasVoted = false;
  document.getElementById('vote-question').textContent = data.question;
  document.getElementById('vote-status').textContent = '';

  var container = document.getElementById('vote-options');
  container.innerHTML = '';

  data.answers.forEach(function(a) {
    var card = document.createElement('div');
    card.className = 'vote-card' + (a.isMine ? ' mine' : '');
    card.textContent = a.answer;
    if (!a.isMine) {
      card.addEventListener('click', function() {
        if (hasVoted) return;
        hasVoted = true;
        container.querySelectorAll('.vote-card').forEach(function(c) { c.classList.remove('selected'); });
        card.classList.add('selected');
        socket.emit('submit-vote', a.id);
      });
    }
    container.appendChild(card);
  });

  showScreen('screen-vote');
});

socket.on('vote-count', function(data) {
  var text = data.voted + ' / ' + data.total + ' voted';
  document.getElementById('vote-status').textContent = text;
  document.getElementById('host-vote-count').textContent = text;
});

// ── Choice / TF results ──
socket.on('choice-results', function(data) {
  choiceResultsScores = data.scores;
  document.getElementById('cr-question').textContent = data.question;

  var fb = document.getElementById('cr-feedback');
  if (data.myChoice === -2) {
    // Host view
    fb.innerHTML = '<div class="fb-host">You\'re the host!</div>';
  } else if (data.myChoice === -1) {
    fb.innerHTML = '<div class="fb-miss">Time\'s up! No answer</div>';
  } else if (data.isCorrect) {
    fb.innerHTML = '<div class="fb-correct">Correct!</div>';
  } else {
    fb.innerHTML = '<div class="fb-wrong">Wrong! Answer: ' + escapeHtml(data.options[data.correctIndex]) + '</div>';
  }

  var maxC = Math.max.apply(null, data.breakdown.concat([1]));
  var shapes = ['\u25B2', '\u25C6', '\u25CF', '\u25A0'];
  var colors = ['#e21b3c', '#1368ce', '#d89e00', '#26890c'];
  var bd = document.getElementById('cr-breakdown');
  bd.innerHTML = data.options.map(function(opt, i) {
    var w = Math.max((data.breakdown[i] / maxC) * 100, 8);
    var correct = i === data.correctIndex;
    return '<div class="bd-row">' +
      '<div class="bd-label' + (correct ? ' bd-correct' : '') + '" style="color:' + colors[i] + '">' +
        shapes[i] + ' ' + escapeHtml(opt) + (correct ? ' \u2713' : '') +
      '</div>' +
      '<div class="bd-bar-bg">' +
        '<div class="bd-bar" style="width:' + w + '%;background:' + colors[i] + '">' + data.breakdown[i] + '</div>' +
      '</div>' +
    '</div>';
  }).join('');

  var pts = document.getElementById('cr-points');
  if (data.myChoice === -2) {
    pts.innerHTML = '';
  } else if (data.pointsEarned > 0) {
    pts.innerHTML = '<div class="pts-value">+' + data.pointsEarned + '</div>';
  } else {
    pts.innerHTML = '<div class="pts-zero">+0</div>';
  }

  document.getElementById('cr-continue-btn').style.display = 'none';
  document.getElementById('cr-waiting').style.display = 'none';

  showScreen('screen-choice-results');

  setTimeout(function() {
    if (isAdmin) {
      document.getElementById('cr-continue-btn').style.display = 'inline-block';
    } else {
      document.getElementById('cr-waiting').style.display = 'block';
    }
  }, 3000);
});

// ── Open-ended auto-graded results (Kahoot-style) ──
socket.on('open-graded-results', function(data) {
  choiceResultsScores = data.scores;
  document.getElementById('cr-question').textContent = data.question;

  var fb = document.getElementById('cr-feedback');
  if (data.isHost) {
    fb.innerHTML = '<div class="fb-host">You\'re the host!</div>';
  } else if (data.myAnswer === null) {
    fb.innerHTML = '<div class="fb-miss">Time\'s up! No answer</div>';
  } else if (data.isCorrect) {
    fb.innerHTML = '<div class="fb-correct">\u2705 Correct!</div>';
  } else {
    fb.innerHTML = '<div class="fb-wrong">\u274C Incorrect!</div>';
  }

  var bd = document.getElementById('cr-breakdown');
  bd.innerHTML =
    '<div class="open-graded-info">' +
      '<div class="og-correct-answer"><span class="og-label">Correct answer:</span> <strong>' + escapeHtml(data.correctAnswer) + '</strong></div>' +
      (data.myAnswer !== null && !data.isHost ?
        '<div class="og-your-answer"><span class="og-label">Your answer:</span> <strong>' + escapeHtml(data.myAnswer) + '</strong></div>' : '') +
    '</div>';

  var pts = document.getElementById('cr-points');
  if (data.isHost) {
    pts.innerHTML = '';
  } else if (data.pointsEarned > 0) {
    pts.innerHTML = '<div class="pts-value">+' + data.pointsEarned + '</div>';
  } else {
    pts.innerHTML = '<div class="pts-zero">+0</div>';
  }

  document.getElementById('cr-continue-btn').style.display = 'none';
  document.getElementById('cr-waiting').style.display = 'none';

  showScreen('screen-choice-results');

  setTimeout(function() {
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

// ── Consensus / open results (vote-based) ──
socket.on('show-results', function(data) {
  pendingResultsData = data;
  showLeaderboard(data.scores, 'open-results');
});

// ═══════════════════════════════
// LEADERBOARD
// ═══════════════════════════════

function showLeaderboard(scores, mode) {
  leaderboardMode = mode;
  launchConfetti();

  var podium = document.getElementById('leaderboard-podium');
  var rest = document.getElementById('leaderboard-rest');
  var btn = document.getElementById('leaderboard-continue-btn');
  var waitMsg = document.getElementById('leaderboard-waiting');
  btn.style.display = 'none';
  waitMsg.style.display = 'none';
  podium.innerHTML = '';
  rest.innerHTML = '';

  var top3 = scores.slice(0, 3);
  var others = scores.slice(3);
  var medals = ['\uD83E\uDD47', '\uD83E\uDD48', '\uD83E\uDD49'];
  var barHeights = ['110px', '75px', '50px'];
  var order = [1, 0, 2];

  order.forEach(function(idx) {
    if (!top3[idx]) return;
    var p = top3[idx];
    var slot = document.createElement('div');
    slot.className = 'podium-slot rank-' + (idx + 1);
    slot.innerHTML =
      '<div class="podium-info">' +
        '<div class="podium-avatar">' + (p.avatar || '') + '</div>' +
        '<div class="podium-name">' + escapeHtml(p.name) + '</div>' +
        '<div class="podium-medal">' + medals[idx] + '</div>' +
        '<div class="podium-score">' + p.score + ' pts</div>' +
      '</div>' +
      '<div class="podium-bar" data-height="' + barHeights[idx] + '"></div>' +
      '<div class="podium-rank">' + (idx + 1) + '</div>';
    podium.appendChild(slot);
  });

  if (others.length > 0) {
    rest.innerHTML = others.map(function(p, i) {
      return '<div class="lb-row" style="animation-delay:' + (i * 0.12 + 0.6) + 's">' +
        '<span class="lb-rank">' + (i + 4) + '</span>' +
        '<span class="lb-avatar">' + (p.avatar || '') + '</span>' +
        '<span class="lb-name">' + escapeHtml(p.name) + '</span>' +
        '<span class="lb-score">' + p.score + ' pts</span>' +
      '</div>';
    }).join('');
  }

  showScreen('screen-leaderboard');

  setTimeout(function() {
    podium.querySelectorAll('.podium-bar').forEach(function(bar) {
      bar.style.height = bar.dataset.height;
    });
  }, 250);

  setTimeout(function() {
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
  var data = pendingResultsData;

  document.getElementById('results-question').textContent = data.question;

  var list = document.getElementById('results-list');
  list.innerHTML = '';
  data.results.forEach(function(r, i) {
    var item = document.createElement('div');
    item.className = 'result-item' + (i === 0 && r.votes > 0 ? ' winner' : '');
    item.innerHTML =
      '<div class="result-rank">' + (i + 1) + '</div>' +
      '<div class="result-content">' +
        '<div class="result-answer">' + escapeHtml(r.answer) + '</div>' +
        '<div class="result-author">' + (r.avatar || '') + ' ' + escapeHtml(r.name) + '</div>' +
      '</div>' +
      '<div class="result-votes">' + r.votes + ' vote' + (r.votes !== 1 ? 's' : '') + '</div>';
    list.appendChild(item);
  });

  var sb = document.getElementById('scoreboard');
  sb.innerHTML = '';
  data.scores.forEach(function(s) {
    var row = document.createElement('div');
    row.className = 'score-row';
    row.innerHTML = '<span>' + (s.avatar || '') + ' ' + escapeHtml(s.name) + '</span><span class="score-points">' + s.score + '</span>';
    sb.appendChild(row);
  });

  document.getElementById('next-round-btn').style.display = isAdmin ? 'inline-block' : 'none';
  document.getElementById('results-waiting').style.display = isAdmin ? 'none' : 'block';
  showScreen('screen-results');
}

// ── Back to lobby ──
socket.on('back-to-lobby', function(data) {
  renderPlayerList('player-list', data.players);
  renderPlayerList('waiting-player-list', data.players);
  if (isAdmin) {
    document.getElementById('queue-count').textContent = data.questionsRemaining;
    document.getElementById('btn-start-next').textContent = 'Next Question';
    showScreen('screen-lobby');
  } else {
    showScreen('screen-waiting');
  }
});

// ── Game over ──
socket.on('game-over', function(data) {
  // Final standings
  var fs = document.getElementById('final-standings');
  var medals = ['\uD83E\uDD47', '\uD83E\uDD48', '\uD83E\uDD49'];
  fs.innerHTML = data.finalStandings.map(function(p, i) {
    return '<div class="fs-row' + (i === 0 ? ' fs-winner' : '') + '">' +
      '<span class="fs-rank">' + (medals[i] || (i + 1)) + '</span>' +
      '<span class="fs-avatar">' + (p.avatar || '') + '</span>' +
      '<span class="fs-name">' + escapeHtml(p.name) + '</span>' +
      '<span class="fs-score">' + p.score + ' pts</span>' +
    '</div>';
  }).join('');

  // Round-by-round summary
  var gs = document.getElementById('game-summary');
  gs.innerHTML = data.history.map(function(round) {
    var rows = round.playerResults.map(function(pr) {
      var icon, detail;
      if (round.type === 'consensus') {
        icon = pr.votes > 0 ? '\u2B50' : '\u2014';
        detail = pr.votes > 0 ? pr.votes + ' vote' + (pr.votes !== 1 ? 's' : '') : (pr.answered ? 'no votes' : 'no answer');
        if (pr.votedForHost) detail += ' \u00B7 +1 bonus';
      } else if (round.type === 'open') {
        icon = pr.correct ? '\u2705' : (pr.answered ? '\u274C' : '\u23F0');
        detail = pr.correct ? 'Correct' : (pr.answered ? 'Wrong' : 'No answer');
      } else {
        icon = pr.correct ? '\u2705' : (pr.answered ? '\u274C' : '\u23F0');
        detail = pr.correct ? 'Correct' : (pr.answered ? 'Wrong' : 'No answer');
      }
      return '<div class="gs-player">' +
        '<span class="gs-icon">' + icon + '</span>' +
        '<span class="gs-avatar">' + (pr.avatar || '') + '</span>' +
        '<span class="gs-name">' + escapeHtml(pr.name) + '</span>' +
        '<span class="gs-detail">' + detail + '</span>' +
      '</div>';
    }).join('');

    var typeLabels = { open: 'Open', choice: 'Choice', truefalse: 'T/F', consensus: 'Consensus' };
    var typeLabel = typeLabels[round.type] || round.type;
    return '<div class="gs-round">' +
      '<div class="gs-header">' +
        '<span class="gs-round-num">Q' + round.round + '</span>' +
        '<span class="gs-round-type">' + typeLabel + '</span>' +
        '<span class="gs-round-q">' + escapeHtml(round.question) + '</span>' +
      '</div>' +
      rows +
    '</div>';
  }).join('');

  showScreen('screen-game-over');
});

socket.on('room-closed', function() {
  showScreen('screen-closed');
});

// ═══════════════════════════════
// UTILITIES
// ═══════════════════════════════

function generateQR(containerId, code) {
  var container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';
  var joinUrl = window.location.origin + '?code=' + code;
  new QRCode(container, {
    text: joinUrl, width: 180, height: 180,
    colorDark: '#1a1a2e', colorLight: '#ffffff',
    correctLevel: QRCode.CorrectLevel.M,
  });
}

function launchConfetti() {
  var c = document.getElementById('confetti-container');
  c.innerHTML = '';
  var colors = ['#ffd200', '#f7971e', '#ff6b9d', '#00d4ff', '#7fff6b', '#c77dff'];
  for (var i = 0; i < 70; i++) {
    var d = document.createElement('div');
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
  var el = document.getElementById(elementId);
  if (!el) return;
  el.innerHTML = players.map(function(p) {
    return '<div class="player-chip">' +
      '<span class="player-avatar">' + (p.avatar || '') + '</span> ' +
      escapeHtml(p.name) +
      (p.score > 0 ? '<span class="score">' + p.score + '</span>' : '') +
    '</div>';
  }).join('');
}

function escapeHtml(text) {
  var d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

// ── Auto-fill room code from URL ──
(function() {
  var params = new URLSearchParams(window.location.search);
  var code = params.get('code');
  if (code) {
    document.getElementById('join-code').value = code.toUpperCase();
    showScreen('screen-join');
  }
})();

// ── Enter key support ──
document.getElementById('admin-name').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') createRoom();
});
document.getElementById('join-name').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') joinRoom();
});
document.getElementById('answer-input').addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitAnswer(); }
});
document.getElementById('setup-q-open').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') { e.preventDefault(); document.getElementById('setup-a-open').focus(); }
});
document.getElementById('setup-a-open').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') { e.preventDefault(); addPreloadedQuestion(); }
});
document.getElementById('setup-q-consensus').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') { e.preventDefault(); document.getElementById('setup-a-consensus').focus(); }
});
document.getElementById('setup-a-consensus').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') { e.preventDefault(); addPreloadedQuestion(); }
});
document.getElementById('setup-q-tf').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') { e.preventDefault(); addPreloadedQuestion(); }
});
