const $ = id => document.getElementById(id);
const show = (id, on) => $(id).classList.toggle('hidden', !on);
let token = sessionStorage.getItem('fgh_token'), me = null, ws = null, state = null, roomCode = null;
let creating = false, reconnectTimer = null, reconnectAttempts = 0, currentGame = 'dice';

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUITS = ['♠', '♥', '♣', '♦'];
function cardLabel(c) { return RANKS[c % 13] + SUITS[Math.floor(c / 13)]; }
function cardRed(c) { return Math.floor(c / 13) === 1 || Math.floor(c / 13) === 3; }

function toast(s) {
  const t = $('toast');
  t.textContent = s; t.style.display = 'block';
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.style.display = 'none', 3200);
}

async function api(path, method = 'GET', data) {
  const r = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: data ? JSON.stringify(data) : undefined
  });
  const j = await r.json();
  if (!r.ok) throw Error(j.error || '操作失败');
  return j;
}

function display() {
  show('auth', !me);
  show('lobby', !!me && !roomCode);
  show('room', !!me && !!roomCode);
  $('who').textContent = me ? '👤 ' + me.username : '';
}

async function login() {
  try {
    const j = await api('/login', 'POST', { username: $('username').value, password: $('password').value });
    token = j.token;
    sessionStorage.setItem('fgh_token', token);
    me = j.user;
    display();
    const code = new URL(location.href).searchParams.get('room');
    if (code) await joinRoom(code);
  } catch (e) { toast(e.message); }
}
$('login').onclick = login;
$('register').onclick = async () => {
  try {
    await api('/register', 'POST', { username: $('username').value, password: $('password').value });
    toast('注册成功，正在登录');
    await login();
  } catch (e) { toast(e.message); }
};

// 大厅：选择游戏
document.querySelectorAll('.game').forEach(g => {
  g.onclick = () => {
    document.querySelectorAll('.game').forEach(x => x.classList.remove('sel'));
    g.classList.add('sel');
    currentGame = g.dataset.game;
  };
});

$('create').onclick = async () => {
  if (creating) return;
  creating = true;
  try {
    const r = await api('/rooms', 'POST', { game: currentGame });
    await joinRoom(r.code);
  } catch (e) { toast(e.message); }
  finally { creating = false; }
};
$('join').onclick = () => joinRoom($('roomcode').value);

async function joinRoom(code) {
  code = String(code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) return toast('请输入6位房间码');
  try {
    await api('/rooms/' + code + '/join', 'POST');
    roomCode = code;
    state = null;
    history.replaceState(null, '', '?room=' + code);
    display();
    connect();
  } catch (e) { toast(e.message); }
}

function setConn(msg, ok) {
  const el = $('conn');
  if (el) {
    el.textContent = msg;
    el.style.color = ok ? '#62e9bb' : '#f98e8e';
  }
  // 连接未就绪时禁用游戏操作按钮，避免误点
  const ready = !!ok;
  ['ready', 'start', 'bid', 'challenge', 'restart', 'bjbetbtn', 'bjstart', 'bjhit', 'bjstand', 'bjnext', 'bjreset'].forEach(id => {
    const b = $(id);
    if (b) b.disabled = !ready;
  });
}

function connect() {
  if (ws) { try { ws.close(); } catch {} }
  ws = null;
  if (!roomCode || !token) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/api/rooms/${roomCode}/ws?token=${encodeURIComponent(token)}`);
  setConn('正在连接服务器…', false);
  ws.onopen = () => {
    reconnectAttempts = 0;
    setConn('已连接', true);
    if (state) render();
  };
  ws.onmessage = e => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'error') toast(msg.message);
    if (msg.type === 'state') { state = msg.state; render(); }
  };
  ws.onclose = () => {
    ws = null;
    setConn('连接断开，正在重连…', false);
    scheduleReconnect();
  };
  ws.onerror = () => { /* error 后必然触发 close，由 onclose 统一处理重连 */ };
}

function scheduleReconnect() {
  if (!roomCode) return;
  clearTimeout(reconnectTimer);
  if (reconnectAttempts < 10) {
    const delay = Math.min(1000 * 2 ** reconnectAttempts, 15000);
    reconnectAttempts++;
    reconnectTimer = setTimeout(connect, delay);
  } else {
    toast('无法连接服务器，请刷新页面重试');
  }
}

function leaveRoom() {
  clearTimeout(reconnectTimer);
  if (ws) { try { ws.close(); } catch {} }
  ws = null; roomCode = null; state = null; reconnectAttempts = 0;
  history.replaceState(null, '', location.pathname);
  display();
}
$('leave').onclick = leaveRoom;

function send(x) {
  if (ws && ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(x)); return true; }
  if (ws && ws.readyState === WebSocket.CONNECTING) { toast('正在连接服务器，请稍候…'); return false; }
  toast('连接已断开，正在重连…');
  return false;
}

function render() {
  if (!state) return;
  $('code').textContent = state.code;
  $('status').textContent = state.message;
  $('gamename').textContent = state.game === 'blackjack' ? '🃏 21点 · 对战机器人庄家' : '🎲 大话骰';
  const isBJ = state.game === 'blackjack';
  show('diceui', !isBJ);
  show('bj', isBJ);
  if (isBJ) renderBJ(); else renderDice();
}

// ===== 大话骰渲染 =====
function renderDice() {
  $('playercount').textContent = `(${state.players.length}/8)`;
  $('players').replaceChildren(...state.players.map(p => {
    const d = document.createElement('div');
    d.className = 'player' + (state.turnPlayerId === p.id ? ' active' : '');
    d.textContent = `${p.connected ? '🟢' : '⚪'} ${p.name}${p.id === state.hostId ? ' 👑' : ''} · 🎲 ${p.dice} ${p.ready ? '✓ 已准备' : ''}`;
    return d;
  }));
  show('waiting', state.phase === 'waiting');
  show('playing', state.phase === 'playing');
  show('finished', state.phase === 'finished');
  const you = state.players.find(p => p.id === me.id);
  $('ready').textContent = you?.ready ? '取消准备' : '准备';
  $('start').style.display = state.hostId === me.id ? 'inline-block' : 'none';
  $('start').disabled = state.players.length < 2 || !state.players.every(p => p.ready);
  if (state.phase === 'playing') {
    $('mydice').replaceChildren(...(you?.roll || []).map(v => {
      const d = document.createElement('div');
      d.className = 'die';
      d.textContent = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'][v];
      return d;
    }));
    const mine = state.turnPlayerId === me.id;
    $('turn').textContent = mine ? '轮到你操作！' : '等待其他玩家操作…';
    $('bidinfo').textContent = state.bid ? `当前叫点：${state.bid.count} 个 ${state.bid.face}` : '本轮还没有叫点';
    $('bid').disabled = !mine;
    $('challenge').disabled = !mine || !state.bid;
  }
  $('winner').textContent = state.winnerId === me.id ? '🎉 你赢了！' : '🏆 ' + (state.players.find(p => p.id === state.winnerId)?.name || '玩家') + ' 获胜';
  $('restart').style.display = state.hostId === me.id ? 'inline-block' : 'none';
}

// ===== 21点渲染 =====
function renderBJ() {
  $('bjcount').textContent = `(${state.players.length}/8)`;
  // 庄家
  $('dealerhand').replaceChildren(...state.dealer.cards.map(c => {
    const d = document.createElement('div');
    if (!c) { d.className = 'card back'; d.textContent = '?'; return d; }
    d.className = 'card' + (cardRed(c) ? ' red' : '');
    d.textContent = cardLabel(c);
    return d;
  }));
  $('dealerinfo').textContent = state.dealer.revealed ? `庄家 ${state.dealer.value} 点` : `庄家明牌 ${state.dealer.cards[0] ? cardLabel(state.dealer.cards[0]) : ''}`;
  // 玩家
  $('bjplayers').replaceChildren(...state.players.map(p => {
    const d = document.createElement('div');
    d.className = 'player' + (state.turnPlayerId === p.id ? ' active' : '');
    const head = document.createElement('div');
    head.textContent = `${p.connected ? '🟢' : '⚪'} ${p.name} · 💰${p.chips} · 下注 ${p.bet}`;
    d.appendChild(head);
    p.hand.forEach(c => {
      const s = document.createElement('span');
      s.className = 'card sm' + (cardRed(c) ? ' red' : '');
      s.textContent = cardLabel(c);
      d.appendChild(s);
    });
    const info = document.createElement('div');
    if (p.bust) info.textContent = '💥 爆牌';
    else if (p.stand) info.textContent = `✋ 停牌 · ${p.value} 点`;
    else info.textContent = `${p.value} 点`;
    d.appendChild(info);
    return d;
  }));
  const you = state.players.find(p => p.id === me.id);
  show('bjwaiting', state.phase === 'waiting');
  show('bjacting', state.phase === 'playing' && state.turnPlayerId === me.id);
  show('bjresult', state.phase === 'finished');
  if (state.phase === 'waiting') {
    $('bjbet').value = you ? you.bet : 10;
    $('bjstart').style.display = state.hostId === me.id ? 'inline-block' : 'none';
    $('bjstart').disabled = state.players.length < 1;
  }
  if (state.phase === 'playing') {
    $('bjturn').textContent = state.turnPlayerId === me.id ? '轮到你：要牌 or 停牌' : '等待其他玩家操作…';
  }
  if (state.phase === 'finished') {
    $('bjwinner').textContent = state.winnerId === me.id ? '🎉 你赢了这局！' : '这局结束';
    $('bjnext').style.display = state.hostId === me.id ? 'inline-block' : 'none';
    $('bjreset').style.display = state.hostId === me.id ? 'inline-block' : 'none';
  }
}

$('ready').onclick = () => send({ type: 'ready', value: !state?.players.find(p => p.id === me.id)?.ready });
$('start').onclick = () => send({ type: 'start' });
$('bid').onclick = () => send({ type: 'bid', count: Number($('count').value), face: Number($('face').value) });
$('challenge').onclick = () => send({ type: 'challenge' });
$('restart').onclick = () => send({ type: 'restart' });
$('bjbetbtn').onclick = () => send({ type: 'bet', amount: Number($('bjbet').value) });
$('bjstart').onclick = () => send({ type: 'start' });
$('bjhit').onclick = () => send({ type: 'hit' });
$('bjstand').onclick = () => send({ type: 'stand' });
$('bjnext').onclick = () => send({ type: 'next' });
$('bjreset').onclick = () => send({ type: 'restart' });
$('copy').onclick = async () => {
  await navigator.clipboard.writeText(location.href);
  toast('邀请链接已复制');
};

(async () => {
  if (token) {
    try {
      me = (await api('/me')).user;
      display();
      const code = new URL(location.href).searchParams.get('room');
      if (code) await joinRoom(code);
    } catch {
      sessionStorage.removeItem('fgh_token');
      token = null; me = null;
      display();
    }
  } else display();
})();
