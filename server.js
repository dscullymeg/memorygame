const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

const COLORS = [
  { hex: '#FF4455', name: 'Red' },
  { hex: '#4488FF', name: 'Blue' },
  { hex: '#44CC66', name: 'Green' },
  { hex: '#FF8833', name: 'Orange' },
  { hex: '#BB44FF', name: 'Purple' },
  { hex: '#00CCCC', name: 'Cyan' },
  { hex: '#FF44BB', name: 'Pink' },
  { hex: '#CCBB00', name: 'Yellow' },
  { hex: '#44FFAA', name: 'Mint' },
  { hex: '#FF6677', name: 'Coral' },
];

let nextColorIndex = 0;
let players = {};

let gameState = {
  phase: 'waiting', // waiting | revealing | playing | result | redemption | redemption_result | ended
  round: 0,
  allNumbers: [],
  batches: [],
  currentBatch: [],
  timeLeft: 10,
  redemptionTimeLeft: 0,
  expectedAnswer: '',
  timerInterval: null,
};

function randomBatch() {
  // Round 1 is always 1, 2, 3 — anchors the analogy to AI remembering conversation starts
  if (gameState.round === 1) return [1, 2, 3];
  return [1, 2, 3].map(() => Math.floor(Math.random() * 9) + 1);
}

function computeExpected(allNums) {
  return [...allNums].reverse().join('');
}

function getRoundTime(round) {
  return 10 + (round - 1) * 5;
}

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

function buildSnapshot() {
  const pdata = {};
  Object.values(players).forEach(p => {
    pdata[p.id] = {
      id: p.id,
      color: p.color,
      colorName: p.colorName,
      cursor: p.cursor,
      submitted: p.submitted,
      correct: p.correct,
      // Redemption fields
      canRedeem: p.correct === false && !p.hasUsedRedemption,
      hasUsedRedemption: p.hasUsedRedemption,
      redemptionSubmitted: p.redemptionSubmitted,
      redeemed: p.redeemed,
      // Never expose input value to other players
    };
  });
  return {
    type: 'state',
    players: pdata,
    game: {
      phase: gameState.phase,
      round: gameState.round,
      allNumbers: gameState.allNumbers,
      batches: gameState.batches,
      currentBatch: gameState.currentBatch,
      timeLeft: gameState.timeLeft,
      redemptionTimeLeft: gameState.redemptionTimeLeft,
      expectedAnswer: gameState.expectedAnswer,
    },
  };
}

function broadcastState() {
  broadcast(buildSnapshot());
}

function startRound() {
  if (gameState.round >= 10) { endGame(); return; }

  gameState.round++;
  const batch = randomBatch();
  gameState.currentBatch = batch;
  gameState.batches = [...gameState.batches, batch];
  gameState.allNumbers = [...gameState.allNumbers, ...batch];
  gameState.expectedAnswer = computeExpected(gameState.allNumbers);
  gameState.phase = 'revealing';
  gameState.timeLeft = getRoundTime(gameState.round);

  Object.values(players).forEach(p => {
    p.input = '';
    p.submitted = false;
    p.correct = null;
    p.redeemed = null;
    p.redemptionInput = '';
    p.redemptionSubmitted = false;
  });

  clearTimer();
  broadcastState();

  setTimeout(() => {
    if (gameState.phase !== 'revealing') return;
    gameState.phase = 'playing';
    broadcastState();

    gameState.timerInterval = setInterval(() => {
      gameState.timeLeft--;
      broadcastState();
      if (gameState.timeLeft <= 0) {
        clearTimer();
        resolveRound();
      }
    }, 1000);
  }, 3000);
}

function clearTimer() {
  if (gameState.timerInterval) {
    clearInterval(gameState.timerInterval);
    gameState.timerInterval = null;
  }
}

function resolveRound() {
  clearTimer();
  const expected = gameState.expectedAnswer;
  Object.values(players).forEach(p => {
    if (!p.submitted) p.submitted = true;
    p.correct = p.input.trim() === expected;
  });
  gameState.phase = 'result';
  broadcastState();

  const isLastRound = gameState.round >= 10;
  const allFailed = Object.values(players).length > 0 && Object.values(players).every(p => !p.correct);
  const anyCanRedeem = Object.values(players).some(p => p.correct === false && !p.hasUsedRedemption);

  if (isLastRound) {
    setTimeout(endGame, 4000);
  } else if (allFailed && anyCanRedeem) {
    // Brief result display then offer second chance
    setTimeout(startRedemption, 2000);
  } else if (allFailed) {
    setTimeout(endGame, 4000);
  } else {
    setTimeout(startRound, 3000);
  }
}

function startRedemption() {
  gameState.phase = 'redemption';
  gameState.redemptionTimeLeft = 10;

  Object.values(players).forEach(p => {
    p.redemptionInput = '';
    p.redemptionSubmitted = false;
    p.redeemed = null;
  });

  clearTimer();
  broadcastState();

  gameState.timerInterval = setInterval(() => {
    gameState.redemptionTimeLeft--;
    broadcastState();
    if (gameState.redemptionTimeLeft <= 0) {
      clearTimer();
      resolveRedemption();
    }
  }, 1000);
}

function eligibleForRedemption(p) {
  return p.correct === false && !p.hasUsedRedemption;
}

function allEligibleSubmitted() {
  const eligible = Object.values(players).filter(eligibleForRedemption);
  return eligible.length > 0 && eligible.every(p => p.redemptionSubmitted);
}

function resolveRedemption() {
  clearTimer();

  Object.values(players).forEach(p => {
    if (eligibleForRedemption(p)) {
      p.hasUsedRedemption = true;
      if (!p.redemptionSubmitted) p.redemptionSubmitted = true;
      p.redeemed = p.redemptionInput.trim() === '321';
    }
  });

  gameState.phase = 'redemption_result';
  broadcastState();

  const anyoneSurvived = Object.values(players).some(p => p.correct || p.redeemed);

  setTimeout(() => {
    if (anyoneSurvived) startRound();
    else endGame();
  }, 3000);
}

function endGame() {
  clearTimer();
  gameState.phase = 'ended';
  broadcastState();
}

function resetGame() {
  clearTimer();
  gameState.phase = 'waiting';
  gameState.round = 0;
  gameState.allNumbers = [];
  gameState.batches = [];
  gameState.currentBatch = [];
  gameState.timeLeft = 10;
  gameState.redemptionTimeLeft = 0;
  gameState.expectedAnswer = '';
  Object.values(players).forEach(p => {
    p.input = '';
    p.submitted = false;
    p.correct = null;
    p.hasUsedRedemption = false;
    p.redeemed = null;
    p.redemptionInput = '';
    p.redemptionSubmitted = false;
  });
  broadcastState();
}

wss.on('connection', ws => {
  const id = `p_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const ci = nextColorIndex++ % COLORS.length;
  const player = {
    id, ws,
    color: COLORS[ci].hex,
    colorName: COLORS[ci].name,
    cursor: { x: 0.5, y: 0.5 },
    input: '',
    submitted: false,
    correct: null,
    hasUsedRedemption: false,
    redeemed: null,
    redemptionInput: '',
    redemptionSubmitted: false,
  };
  players[id] = player;

  ws.send(JSON.stringify({ type: 'welcome', id, color: player.color, colorName: player.colorName }));
  broadcastState();

  ws.on('message', raw => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    switch (data.type) {
      case 'cursor':
        player.cursor = data.cursor;
        broadcastState();
        break;

      case 'input':
        if (gameState.phase === 'playing' && !player.submitted) {
          player.input = data.value;
          broadcastState();
        }
        break;

      case 'submit':
        if (gameState.phase === 'playing' && !player.submitted) {
          player.input = data.value || player.input;
          player.submitted = true;
          broadcastState();
          const all = Object.values(players);
          if (all.length > 0 && all.every(p => p.submitted)) resolveRound();
        }
        break;

      case 'redemption_input':
        if (gameState.phase === 'redemption' && eligibleForRedemption(player) && !player.redemptionSubmitted) {
          player.redemptionInput = data.value;
          broadcastState();
        }
        break;

      case 'redemption_submit':
        if (gameState.phase === 'redemption' && eligibleForRedemption(player) && !player.redemptionSubmitted) {
          player.redemptionInput = data.value || player.redemptionInput;
          player.redemptionSubmitted = true;
          broadcastState();
          if (allEligibleSubmitted()) resolveRedemption();
        }
        break;

      case 'start':
        if (gameState.phase === 'waiting') startRound();
        break;

      case 'reset':
        resetGame();
        break;
    }
  });

  ws.on('close', () => {
    delete players[id];
    broadcastState();
    const remaining = Object.values(players);
    if (gameState.phase === 'playing' && remaining.length > 0 && remaining.every(p => p.submitted)) {
      resolveRound();
    }
    if (gameState.phase === 'redemption' && remaining.length > 0 && allEligibleSubmitted()) {
      resolveRedemption();
    }
  });
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`\n  Context Window Game running at http://localhost:${PORT}`);
  console.log(`  Open multiple browser tabs to add players.\n`);
});
