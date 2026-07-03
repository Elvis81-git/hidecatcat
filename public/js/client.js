// ============================================================
// client.js — HideCatCat 前端主控制器 v2
// 新增：火柴人姿勢系統、爆炸特效、找人方換地圖
// ============================================================

const socket = io();

// ── 全域狀態 ──────────────────────────────────────────────
const State = {
  myId:            null,
  myNickname:      '',
  roomId:          null,
  myRole:          null,
  seekerId:        null,
  players:         [],
  mapList:         [],
  mapIndex:        0,
  seekerMapIndex:  0,

  // 縮放與平移
  zoom: 1.0, minZoom: 0.3, maxZoom: 6.0,
  panX: 0,   panY: 0,
  mapImage: null,

  // 火柴人
  stickmanPos:     { x: 0, y: 0 }, // 圖片像素座標（中心）
  stickmanLocked:  false,
  currentPoseIdx:  0,
  stickmanScale:   1,               // image-px per unit
  stickmanH:       120,             // image-px (stickman height)

  // 畫板
  currentTool:  'brush',
  brushSize:    12,
  hslColor:     { h: 180, s: 60, l: 50 },
  undoStack:    [],
  panMode:      false,

  // Seeker
  bullets: 0,
  hiders:  [],
};

// ── DOM 參考 ──────────────────────────────────────────────
const $ = id => document.getElementById(id);
const screens = {
  nickname: $('screen-nickname'),
  lobby:    $('screen-lobby'),
  role:     $('screen-role'),
  game:     $('screen-game'),
  result:   $('screen-result'),
};

// ══════════════════════════════════════════════════════════
// ■ 火柴人姿勢定義
//   座標空間：100×150 單位 (寬×高)，中心 (50, 75)
// ══════════════════════════════════════════════════════════
const STICKMAN_POSES = [
  {
    id: 'stand', name: '站立', icon: '🧍',
    rotation: 0,
    head: [50, 13, 12],
    segments: [
      [[50,25],[50,85]],            // 軀幹
      [[50,38],[25,62],[20,80]],    // 左臂
      [[50,38],[75,62],[80,80]],    // 右臂
      [[50,85],[38,115],[33,145]],  // 左腿
      [[50,85],[62,115],[67,145]],  // 右腿
    ]
  },
  {
    id: 'crouch', name: '蹲下', icon: '🧎',
    rotation: 0,
    head: [50, 13, 12],
    segments: [
      [[50,25],[50,70]],
      [[50,38],[28,55],[15,56]],
      [[50,38],[72,55],[85,56]],
      [[50,70],[22,100],[38,122]],
      [[50,70],[78,100],[62,122]],
    ]
  },
  {
    id: 'handsup', name: '舉手', icon: '🙋',
    rotation: 0,
    head: [50, 13, 12],
    segments: [
      [[50,25],[50,85]],
      [[50,38],[26,14],[18,2]],
      [[50,38],[74,14],[82,2]],
      [[50,85],[38,115],[33,145]],
      [[50,85],[62,115],[67,145]],
    ]
  },
  {
    id: 'spread', name: '大字', icon: '🤸',
    rotation: 0,
    head: [50, 10, 12],
    segments: [
      [[50,22],[50,78]],
      [[50,34],[16,18],[2, 6]],
      [[50,34],[84,18],[98, 6]],
      [[50,78],[24,110],[ 6,138]],
      [[50,78],[76,110],[94,138]],
    ]
  },
  {
    id: 'lie', name: '躺平', icon: '😴',
    rotation: 90,
    // 躺平 = 站立姿勢旋轉 90°，以中心點 (50,75) 為軸
    head: [50, 13, 12],
    segments: [
      [[50,25],[50,85]],
      [[50,38],[25,62],[20,80]],
      [[50,38],[75,62],[80,80]],
      [[50,85],[38,115],[33,145]],
      [[50,85],[62,115],[67,145]],
    ]
  },
];

// ── 火柴人繪製函式 ────────────────────────────────────────
/**
 * 在 Canvas 上繪製火柴人
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} pose - STICKMAN_POSES 中的一個
 * @param {number} cx   - 中心 X (image px)
 * @param {number} cy   - 中心 Y (image px)
 * @param {number} u    - unitScale: image-px per 1 unit
 * @param {string} color
 */
function drawStickmanPose(ctx, pose, cx, cy, u, color = '#1a1a2e') {
  const pivotX = 50 * u;  // 原點到中心的偏移
  const pivotY = 75 * u;

  ctx.save();
  ctx.translate(cx, cy);

  // 躺平：繞中心旋轉 90°
  if (pose.rotation) {
    ctx.rotate(pose.rotation * Math.PI / 180);
  }

  // 移動原點至左上角，讓 (50*u, 75*u) 對齊 cx,cy
  ctx.translate(-pivotX, -pivotY);

  ctx.fillStyle   = color;
  ctx.strokeStyle = color;
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';

  // 頭
  const [hx, hy, hr] = pose.head;
  ctx.beginPath();
  ctx.arc(hx * u, hy * u, hr * u, 0, Math.PI * 2);
  ctx.fill();

  // 肢體
  const lw = Math.max(1.5, 10 * u);
  ctx.lineWidth = lw;
  for (const seg of pose.segments) {
    ctx.beginPath();
    ctx.moveTo(seg[0][0] * u, seg[0][1] * u);
    for (let i = 1; i < seg.length; i++) {
      ctx.lineTo(seg[i][0] * u, seg[i][1] * u);
    }
    ctx.stroke();
  }

  ctx.restore();
}

// ── 火柴人碰撞框（正規化）──────────────────────────────────
function getStickmanHitBox() {
  if (!State.mapImage) return { hw: 0.04, hh: 0.04 };
  const iw = State.mapImage.naturalWidth;
  const ih = State.mapImage.naturalHeight;
  const pose = STICKMAN_POSES[State.currentPoseIdx];
  const u = State.stickmanScale;

  // 基礎半寬/半高 (image px → normalized)
  let hw = (50 * u) / iw;
  let hh = (75 * u) / ih;

  // 躺平時寬高互換
  if (pose.rotation === 90) { [hw, hh] = [hh, hw]; }

  return { hw: Math.max(0.02, hw), hh: Math.max(0.02, hh) };
}

// ── 重繪火柴人 Canvas ─────────────────────────────────────
function redrawStickmanCanvas() {
  const canvas = $('canvas-stickman');
  if (!canvas || !State.mapImage) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const pose  = STICKMAN_POSES[State.currentPoseIdx];
  const color = State.stickmanLocked ? '#1a1a2e' : 'rgba(26,26,46,0.75)';
  drawStickmanPose(ctx, pose, State.stickmanPos.x, State.stickmanPos.y, State.stickmanScale, color);

  // 鎖定前：繪製拖曳提示光暈
  if (!State.stickmanLocked) {
    ctx.save();
    ctx.shadowColor  = 'rgba(34,211,238,0.6)';
    ctx.shadowBlur   = 20 * State.stickmanScale * 10;
    ctx.globalAlpha  = 0.4;
    drawStickmanPose(ctx, pose, State.stickmanPos.x, State.stickmanPos.y, State.stickmanScale, '#22d3ee');
    ctx.restore();
  }
}

// ── 計算火柴人大小（基於視口高度）──────────────────────────
function computeStickmanSize() {
  const viewport = $('canvas-viewport');
  const targetScreenH = Math.max(60, viewport.clientHeight * 0.13);
  State.stickmanH     = targetScreenH / State.zoom;
  State.stickmanScale = State.stickmanH / 150;
}

// ══════════════════════════════════════════════════════════
// ■ 粒子爆炸特效系統
// ══════════════════════════════════════════════════════════
class ExplodeParticle {
  constructor(x, y, spd, sz) {
    const a = Math.random() * Math.PI * 2;
    this.x = x; this.y = y;
    this.vx = Math.cos(a) * spd * (0.5 + Math.random());
    this.vy = Math.sin(a) * spd * (0.5 + Math.random());
    this.life  = 1.0;
    this.decay = 0.018 + Math.random() * 0.022;
    this.size  = sz  * (0.5 + Math.random() * 1.2);
    this.hue   = 10  + Math.random() * 40;   // 橙 - 黃
    this.trail = [];
  }
  update() {
    this.trail.push({ x: this.x, y: this.y });
    if (this.trail.length > 4) this.trail.shift();
    this.x += this.vx;
    this.y += this.vy;
    this.vy += this.size * 0.04; // gravity
    this.vx *= 0.94;
    this.vy *= 0.94;
    this.life -= this.decay;
  }
  draw(ctx) {
    // 尾跡
    if (this.trail.length > 1) {
      ctx.globalAlpha = this.life * 0.3;
      ctx.strokeStyle = `hsl(${this.hue},100%,60%)`;
      ctx.lineWidth   = this.size * this.life * 0.6;
      ctx.lineCap     = 'round';
      ctx.beginPath();
      ctx.moveTo(this.trail[0].x, this.trail[0].y);
      for (const p of this.trail) ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }
    // 粒子本體
    ctx.globalAlpha = this.life;
    ctx.fillStyle   = `hsl(${this.hue},100%,${50 + this.life * 20}%)`;
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.size * Math.max(0.1, this.life), 0, Math.PI * 2);
    ctx.fill();
  }
}

let fxParticles  = [];
let fxShockwaves = [];
let fxFlash      = 0;   // 0-1, flash alpha
let fxRAF        = null;

/**
 * 觸發爆炸特效
 * @param {number} sx - stage 像素 X
 * @param {number} sy - stage 像素 Y
 * @param {boolean} isHit - 命中（較大）/ 未命中（較小）
 */
function triggerExplosion(sx, sy, isHit = true) {
  const stickH = State.stickmanH || 120;
  const spd    = stickH * (isHit ? 0.10 : 0.05);
  const sz     = stickH * (isHit ? 0.06 : 0.03);
  const count  = isHit ? 45 : 18;

  for (let i = 0; i < count; i++) {
    fxParticles.push(new ExplodeParticle(sx, sy, spd, sz));
  }

  fxShockwaves.push({
    x: sx, y: sy,
    r: 0,
    maxR: stickH * (isHit ? 1.5 : 0.7),
    life: 1.0,
    color: isHit ? '#f59e0b' : '#94a3b8',
  });

  if (isHit) fxFlash = 0.6;

  if (!fxRAF) fxRAF = requestAnimationFrame(fxLoop);
}

function fxLoop() {
  const canvas = $('canvas-fx');
  if (!canvas) { fxRAF = null; return; }
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Flash
  if (fxFlash > 0) {
    ctx.globalAlpha = fxFlash * 0.35;
    ctx.fillStyle   = '#f97316';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.globalAlpha = 1;
    fxFlash = Math.max(0, fxFlash - 0.05);
  }

  // 衝擊波環
  for (let i = fxShockwaves.length - 1; i >= 0; i--) {
    const sw  = fxShockwaves[i];
    sw.r     += sw.maxR * 0.07;
    sw.life  -= 0.045;
    if (sw.life <= 0) { fxShockwaves.splice(i, 1); continue; }
    ctx.globalAlpha = sw.life * 0.8;
    ctx.strokeStyle = sw.color;
    ctx.lineWidth   = State.stickmanScale * 15 * sw.life;
    ctx.beginPath();
    ctx.arc(sw.x, sw.y, sw.r, 0, Math.PI * 2);
    ctx.stroke();
    // 內圈（橘色）
    ctx.globalAlpha = sw.life * 0.4;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth   = State.stickmanScale * 5 * sw.life;
    ctx.beginPath();
    ctx.arc(sw.x, sw.y, sw.r * 0.6, 0, Math.PI * 2);
    ctx.stroke();
  }

  // 粒子
  for (let i = fxParticles.length - 1; i >= 0; i--) {
    const p = fxParticles[i];
    p.update();
    p.draw(ctx);
    if (p.life <= 0) fxParticles.splice(i, 1);
  }

  ctx.globalAlpha = 1;

  if (fxParticles.length > 0 || fxShockwaves.length > 0 || fxFlash > 0) {
    fxRAF = requestAnimationFrame(fxLoop);
  } else {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    fxRAF = null;
  }
}

// ══════════════════════════════════════════════════════════
// ■ 粒子背景
// ══════════════════════════════════════════════════════════
(function initBgParticles() {
  const bg  = $('bgCanvas');
  const ctx = bg.getContext('2d');
  const pts = [];
  const N   = 60;
  function resize() { bg.width = innerWidth; bg.height = innerHeight; }
  resize();
  window.addEventListener('resize', resize);
  for (let i = 0; i < N; i++) pts.push({
    x: Math.random() * innerWidth,  y: Math.random() * innerHeight,
    r: Math.random() * 1.4 + 0.3,
    vx: (Math.random() - 0.5) * 0.3, vy: (Math.random() - 0.5) * 0.3,
    hue: Math.random() * 60 + 240,
  });
  (function draw() {
    ctx.clearRect(0, 0, bg.width, bg.height);
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `hsla(${p.hue},80%,70%,0.7)`;
      ctx.fill();
      p.x = (p.x + p.vx + bg.width)  % bg.width;
      p.y = (p.y + p.vy + bg.height) % bg.height;
    }
    requestAnimationFrame(draw);
  })();
})();

// ══════════════════════════════════════════════════════════
// ■ 畫面切換
// ══════════════════════════════════════════════════════════
function showScreen(name) {
  for (const el of Object.values(screens)) el.classList.remove('screen--active');
  screens[name]?.classList.add('screen--active');
}

// ══════════════════════════════════════════════════════════
// ■ Toast 通知
// ══════════════════════════════════════════════════════════
function showToast(msg, type = 'info', duration = 3000) {
  const icons = { info: 'ℹ️', success: '✅', error: '❌', warning: '⚠️' };
  const el = document.createElement('div');
  el.className = `toast toast--${type}`;
  el.innerHTML = `<span>${icons[type]||''}</span><span>${msg}</span>`;
  $('toast-container').appendChild(el);
  setTimeout(() => {
    el.classList.add('toast--out');
    el.addEventListener('animationend', () => el.remove());
  }, duration);
}

// ══════════════════════════════════════════════════════════
// ■ 玩家列表渲染
// ══════════════════════════════════════════════════════════
const AVATARS = ['🐱','🐶','🦊','🐻','🐼','🐨','🐯','🦁','🐸','🐧'];

function renderPlayerList(players) {
  State.players = players;
  const list = $('player-list');
  list.innerHTML = '';
  players.forEach((p, i) => {
    const isMe  = p.id === State.myId;
    const clr   = `hsl(${(i * 47) % 360}, 65%, 55%)`;
    const item  = document.createElement('div');
    item.className = 'player-item';
    item.setAttribute('role', 'listitem');
    item.innerHTML = `
      <div class="player-item__avatar" style="background:${clr}20;border:2px solid ${clr}">${AVATARS[i % AVATARS.length]}</div>
      <span class="player-item__name">${escapeHtml(p.nickname)}</span>
      ${isMe ? '<span class="player-item__badge badge--you">你</span>' : ''}
      <span class="player-item__badge ${p.ready ? 'badge--ready' : 'badge--waiting'}">${p.ready ? '✓ 準備' : '等待中'}</span>
    `;
    list.appendChild(item);
  });
}

function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ══════════════════════════════════════════════════════════
// ■ 大廳 UI 事件
// ══════════════════════════════════════════════════════════
$('btn-create').addEventListener('click', () => {
  const name = $('input-nickname').value.trim();
  if (!name) { showToast('請先輸入暱稱！', 'error'); return; }
  State.myNickname = name;
  socket.emit('createRoom', { nickname: name });
});
$('btn-confirm-join').addEventListener('click', () => {
  const name = $('input-nickname').value.trim();
  if (!name) { showToast('請先輸入暱稱！', 'error'); return; }
  State.myNickname = name;
  const id = $('input-room-id').value.trim().toUpperCase();
  if (!id) { showJoinError('請輸入房間 ID'); return; }
  socket.emit('joinRoom', { roomId: id, nickname: State.myNickname });
});
$('input-nickname').addEventListener('keydown', e => { if(e.key==='Enter') $('btn-create').click(); });
$('input-room-id').addEventListener('keydown', e => { if(e.key==='Enter') $('btn-confirm-join').click(); });
$('btn-ready').addEventListener('click', () => socket.emit('playerReady'));
$('room-id-value').addEventListener('click', () => {
  navigator.clipboard.writeText($('room-id-value').textContent.trim()).then(() => {
    const h = $('copy-hint');
    h.classList.add('copy-hint--show');
    setTimeout(() => h.classList.remove('copy-hint--show'), 1800);
  });
});
function showJoinError(msg) {
  const el = $('join-error');
  el.textContent = msg;
  el.classList.add('error-msg--visible');
}

// ─ 房間列表渲染 ──────────────────────────────────────────
socket.on('roomList', renderPublicRooms);
socket.on('roomListUpdate', renderPublicRooms);

function renderPublicRooms(rooms) {
  $('rooms-count').textContent = `共 ${rooms.length} 個房間`;
  const container = $('room-list-container');
  if (rooms.length === 0) {
    container.innerHTML = `
      <div id="rooms-empty" class="rooms-empty">
        <span class="rooms-empty__icon">🏚️</span>
        <p>目前沒有開放的房間</p>
        <p class="rooms-empty__hint">成為第一個建立房間的玩家！</p>
      </div>`;
    return;
  }
  container.innerHTML = '';
  rooms.forEach(r => {
    const el = document.createElement('div');
    el.className = 'room-item';
    el.innerHTML = `
      <div class="room-info">
        <span class="room-info__id">${r.id}</span>
        <span class="room-info__meta"><span class="room-info__host">${escapeHtml(r.hostName)}</span> 的房間</span>
      </div>
      <button class="btn btn--sm btn--primary room-join-btn">
        加入 (${r.playerCount}/${r.maxPlayers})
      </button>
    `;
    el.querySelector('.room-join-btn').addEventListener('click', () => {
      const name = $('input-nickname').value.trim();
      if (!name) { showToast('請先輸入暱稱！', 'error'); return; }
      State.myNickname = name;
      socket.emit('joinRoom', { roomId: r.id, nickname: State.myNickname });
    });
    container.appendChild(el);
  });
}

// ══════════════════════════════════════════════════════════
// ■ Socket.IO 事件
// ══════════════════════════════════════════════════════════
socket.on('connect', () => {
  State.myId = socket.id;
  socket.emit('getRooms');
});

socket.on('roomCreated', ({ roomId, players, isHost }) => {
  State.roomId = roomId;
  State.isHost = isHost;
  $('room-id-value').textContent = roomId;
  $('input-hider-time').disabled = !isHost;
  $('input-seeker-time').disabled = !isHost;
  $('room-settings').style.opacity = isHost ? '1' : '0.6';
  renderPlayerList(players);
  showScreen('lobby');
  showToast(`房間 ${roomId} 已建立！`, 'success');
});
socket.on('joinSuccess', ({ roomId, players, isHost }) => {
  State.roomId = roomId;
  State.isHost = isHost;
  $('room-id-value').textContent = roomId;
  $('input-hider-time').disabled = !isHost;
  $('input-seeker-time').disabled = !isHost;
  $('room-settings').style.opacity = isHost ? '1' : '0.6';
  renderPlayerList(players);
  showScreen('lobby');
  showToast(`已加入房間 ${roomId}`, 'success');
});
socket.on('joinError', ({ message }) => showJoinError(message));

socket.on('settingsUpdated', ({ hiderTime, seekerTime }) => {
  $('input-hider-time').value = hiderTime;
  $('input-seeker-time').value = seekerTime;
});

// 監聽房長更改設定
['input-hider-time', 'input-seeker-time'].forEach(id => {
  $(id).addEventListener('change', () => {
    if (State.isHost) {
      socket.emit('updateSettings', {
        hiderTime: $('input-hider-time').value,
        seekerTime: $('input-seeker-time').value,
      });
    }
  });
});

socket.on('playerJoined', ({ players }) => {
  const n = players[players.length - 1];
  renderPlayerList(players);
  showToast(`${n?.nickname} 加入了房間`, 'info');
});
socket.on('playerLeft', ({ players, leftId }) => {
  const n = State.players.find(p => p.id === leftId);
  renderPlayerList(players);
  if (n) showToast(`${n.nickname} 離開了房間`, 'warning');
});
socket.on('playerReadyUpdate', ({ players }) => {
  renderPlayerList(players);
  const me = players.find(p => p.id === State.myId);
  if (me) {
    const rdy = me.ready;
    $('btn-ready').classList.toggle('btn--ready-active', rdy);
    $('ready-icon').textContent = rdy ? '✓' : '⚡';
    $('ready-text').textContent = rdy ? '已準備（點擊取消）' : '我準備好了！';
  }
});

// ── 遊戲開始 ──────────────────────────────────────────────
socket.on('gameStart', ({ role, seekerId, mapIndex, seekerMapIndex, players }) => {
  State.myRole        = role;
  State.seekerId      = seekerId;
  State.mapIndex      = mapIndex;
  State.seekerMapIndex = seekerMapIndex;
  State.players       = players;
  showRoleReveal(role, seekerId, players);
});

// ── 倒計時 ────────────────────────────────────────────────
socket.on('timerUpdate', ({ remaining }) => {
  const el = $('timer-value');
  el.textContent = remaining;
  el.classList.toggle('timer-value--urgent', remaining <= 10);
});

// ── Seeker 階段開始 ───────────────────────────────────────
socket.on('seekerPhaseStart', async ({ hiders, bullets, seekerId }) => {
  State.hiders  = hiders;
  State.bullets = bullets;

  if (State.myRole === 'seeker') {
    // 換成真實地圖
    $('hud-phase-info').textContent = '切換到真實地圖…';
    await loadMap(`/map/${State.mapList[State.mapIndex]}`);
    renderHiders(hiders);
  }
  enterSeekerPhase(hiders, bullets);
});

// ── 強制提交 ──────────────────────────────────────────────
socket.on('forceSubmit', () => {
  if (State.myRole === 'hider') compositeAndSubmit();
});

// ── 命中 ──────────────────────────────────────────────────
socket.on('hiderEliminated', ({ hitId, hitX, hitY, nickname, bullets, players }) => {
  State.bullets = bullets;
  State.players = players;
  $('bullet-value').textContent = bullets;

  // 爆炸特效（所有人都看到，位置來自伺服器的正規化座標）
  if (State.mapImage) {
    const sx = hitX * State.mapImage.naturalWidth;
    const sy = hitY * State.mapImage.naturalHeight;
    triggerExplosion(sx, sy, true);
  }

  if (hitId === State.myId) {
    showToast('💥 你被找到了！', 'error', 5000);
  } else {
    showToast(`💥 ${escapeHtml(nickname)} 被找到了！`, 'info');
  }
});

// ── 未命中 ────────────────────────────────────────────────
socket.on('shotMissed', ({ x, y, bullets }) => {
  State.bullets = bullets;
  $('bullet-value').textContent = bullets;
  if (State.mapImage) {
    const sx = x * State.mapImage.naturalWidth;
    const sy = y * State.mapImage.naturalHeight;
    triggerExplosion(sx, sy, false);
  }
});

// ── 遊戲結束 ──────────────────────────────────────────────
socket.on('gameOver', ({ winner, players }) => showResult(winner, players));

socket.on('returnToLobby', ({ players }) => {
  renderPlayerList(players);
  $('btn-ready').classList.remove('btn--ready-active');
  $('ready-icon').textContent = '⚡';
  $('ready-text').textContent = '我準備好了！';
  showScreen('lobby');
  showToast('🔄 返回大廳！', 'info');
});
socket.on('error', ({ message }) => showToast(message, 'error'));

// ══════════════════════════════════════════════════════════
// ■ 角色揭曉動畫
// ══════════════════════════════════════════════════════════
function showRoleReveal(role, seekerId, players) {
  showScreen('role');
  const isSeeker = role === 'seeker';
  const seekerName = players.find(p => p.id === seekerId)?.nickname ?? '???';
  $('role-emoji').textContent = isSeeker ? '🔫' : '🎨';
  $('role-title').textContent = isSeeker ? '你是尋找方！' : '你是躲藏方！';
  $('role-title').className   = `role-title role-title--${role}`;
  $('role-desc').textContent  = isSeeker
    ? `你要找出所有躲藏者！尋找方：${seekerName}`
    : `快速上色偽裝，別被 ${seekerName} 找到！`;

  const TOTAL = 5;
  const circ  = 2 * Math.PI * 54;
  const ring  = $('ring-progress');
  ring.style.strokeDashoffset = 0;
  let count = TOTAL;
  const tick = setInterval(() => {
    count--;
    $('ring-count').textContent = count;
    ring.style.strokeDashoffset = circ - circ * (count / TOTAL);
    if (count <= 0) { clearInterval(tick); initGameScreen(role); }
  }, 1000);
}

// ══════════════════════════════════════════════════════════
// ■ 遊戲畫面初始化
// ══════════════════════════════════════════════════════════
async function initGameScreen(role) {
  showScreen('game');

  const badge = $('hud-role-badge');
  badge.textContent = role === 'seeker' ? '尋找方' : '躲藏方';
  badge.className   = `hud-badge hud-badge--${role}`;

  // 載入地圖清單
  if (State.mapList.length === 0) {
    const res = await fetch('/api/maps');
    State.mapList = await res.json();
  }

  if (role === 'seeker') {
    // Seeker 先看到遮蓋地圖（不同於 hider 地圖）
    const coverFile = State.mapList[State.seekerMapIndex] || State.mapList[0];
    await loadMap(`/map/${coverFile}`);
    $('hud-phase-info').textContent = '等待躲藏方完成偽裝…';
    $('hud-timer').style.display    = 'flex';
    $('hider-toolbar').style.display = 'none';
    $('seeker-hint').style.display   = 'none';
  } else {
    const mapFile = State.mapList[State.mapIndex] || State.mapList[0];
    await loadMap(`/map/${mapFile}`);
    initHiderPhase();
  }
}

// ══════════════════════════════════════════════════════════
// ■ 地圖載入
// ══════════════════════════════════════════════════════════
function loadMap(src) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      State.mapImage = img;
      const IW = img.naturalWidth;
      const IH = img.naturalHeight;

      // 設定所有 canvas 解析度為圖片原始大小
      ['canvas-map','canvas-stickman','canvas-draw','canvas-fx'].forEach(id => {
        const c = $(id);
        if (!c) return;
        c.width  = IW;
        c.height = IH;
      });

      // 繪製背景
      const ctx = $('canvas-map').getContext('2d');
      ctx.clearRect(0, 0, IW, IH);
      ctx.drawImage(img, 0, 0);

      // Stage 尺寸
      const stage = $('canvas-stage');
      stage.style.width  = IW + 'px';
      stage.style.height = IH + 'px';

      // 計算火柴人大小並 fit viewport
      fitMapToViewport();
      computeStickmanSize();

      resolve(img);
    };
    img.src = src;
  });
}

// ── Fit viewport ─────────────────────────────────────────
function fitMapToViewport() {
  const vp = $('canvas-viewport');
  const vw = vp.clientWidth, vh = vp.clientHeight;
  const iw = State.mapImage.naturalWidth, ih = State.mapImage.naturalHeight;
  const scale = Math.min(vw / iw, vh / ih);
  State.zoom = scale;
  State.panX = (vw - iw * scale) / 2;
  State.panY = (vh - ih * scale) / 2;
  applyTransform();
  updateZoomLabel();
}
function applyTransform() {
  $('canvas-stage').style.transform =
    `translate(${State.panX}px,${State.panY}px) scale(${State.zoom})`;
}
function updateZoomLabel() {
  $('zoom-level').textContent = Math.round(State.zoom * 100) + '%';
}

// ── 縮放與移動控制 ─────────────────────────────────────────────
function togglePanMode(force) {
  State.panMode = force !== undefined ? force : !State.panMode;
  $('btn-pan-mode').classList.toggle('zoom-btn--active', State.panMode);
  $('canvas-viewport').style.cursor = State.panMode ? 'grab' : 'default';
}
$('btn-pan-mode').addEventListener('click', () => togglePanMode());

window.addEventListener('keydown', e => {
  if (e.code === 'Space' && e.target.tagName !== 'INPUT') {
    e.preventDefault();
    if (!State.panMode) togglePanMode(true);
  }
  if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') {
    e.preventDefault();
    undoDrawing();
  }
});
window.addEventListener('keyup', e => {
  if (e.code === 'Space' && e.target.tagName !== 'INPUT') togglePanMode(false);
});

let isPanning = false;
let panStartX = 0, panStartY = 0;
let initialPanX = 0, initialPanY = 0;

$('canvas-viewport').addEventListener('pointerdown', e => {
  if (State.panMode || e.button === 1) { // 中鍵或開啟拖曳模式
    isPanning = true;
    panStartX = e.clientX;
    panStartY = e.clientY;
    initialPanX = State.panX;
    initialPanY = State.panY;
    $('canvas-viewport').setPointerCapture(e.pointerId);
    $('canvas-viewport').style.cursor = 'grabbing';
    e.preventDefault();
  }
});
$('canvas-viewport').addEventListener('pointermove', e => {
  if (isPanning) {
    State.panX = initialPanX + (e.clientX - panStartX);
    State.panY = initialPanY + (e.clientY - panStartY);
    applyTransform();
  }
});
$('canvas-viewport').addEventListener('pointerup', e => {
  if (isPanning) {
    isPanning = false;
    $('canvas-viewport').style.cursor = State.panMode ? 'grab' : 'default';
  }
});

$('btn-zoom-in').addEventListener('click',    () => changeZoom(State.zoom * 1.3));
$('btn-zoom-out').addEventListener('click',   () => changeZoom(State.zoom / 1.3));
$('btn-zoom-reset').addEventListener('click', fitMapToViewport);

function changeZoom(z) {
  const vp = $('canvas-viewport');
  zoomAt(vp.clientWidth / 2, vp.clientHeight / 2, z);
}
function zoomAt(cx, cy, z) {
  z = Math.max(State.minZoom, Math.min(State.maxZoom, z));
  const r = z / State.zoom;
  State.panX = cx - (cx - State.panX) * r;
  State.panY = cy - (cy - State.panY) * r;
  State.zoom = z;
  applyTransform();
  updateZoomLabel();
}

// ── 滾輪縮放 ─────────────────────────────────────────────
$('canvas-viewport').addEventListener('wheel', e => {
  e.preventDefault();
  const r = $('canvas-viewport').getBoundingClientRect();
  zoomAt(e.clientX - r.left, e.clientY - r.top, State.zoom * (e.deltaY < 0 ? 1.12 : 0.89));
}, { passive: false });

// ── Pinch 觸控縮放 ────────────────────────────────────────
let _pinchDist = 0;
let _isPinching = false;
$('canvas-viewport').addEventListener('touchstart', e => {
  if (e.touches.length === 2) { _isPinching = true; _pinchDist = pinchDist(e.touches); }
}, { passive: true });
$('canvas-viewport').addEventListener('touchmove', e => {
  if (!_isPinching || e.touches.length !== 2) return;
  e.preventDefault();
  const d = pinchDist(e.touches);
  const vr = $('canvas-viewport').getBoundingClientRect();
  const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - vr.left;
  const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2 - vr.top;
  zoomAt(cx, cy, State.zoom * d / _pinchDist);
  _pinchDist = d;
}, { passive: false });
$('canvas-viewport').addEventListener('touchend', e => { if (e.touches.length < 2) _isPinching = false; }, { passive: true });
function pinchDist(t) { return Math.hypot(t[0].clientX-t[1].clientX, t[0].clientY-t[1].clientY); }

// ── 座標轉換工具 ─────────────────────────────────────────
function viewportToStage(vx, vy) {
  return { x: (vx - State.panX) / State.zoom, y: (vy - State.panY) / State.zoom };
}
function stageToNorm(sx, sy) {
  const iw = State.mapImage.naturalWidth, ih = State.mapImage.naturalHeight;
  return { x: Math.max(0, Math.min(1, sx / iw)), y: Math.max(0, Math.min(1, sy / ih)) };
}
function clientToStage(clientX, clientY) {
  const r = $('canvas-viewport').getBoundingClientRect();
  return viewportToStage(clientX - r.left, clientY - r.top);
}

// ══════════════════════════════════════════════════════════
// ■ Hider 階段
// ══════════════════════════════════════════════════════════
function initHiderPhase() {
  $('hud-phase-info').textContent  = '拖曳火柴人，選擇姿勢，鎖定後上色！';
  $('hud-timer').style.display     = 'flex';
  $('hider-toolbar').style.display = 'flex';
  $('btn-lock-pos').style.display  = 'inline-flex';
  $('btn-submit').style.display    = 'none';
  $('seeker-hint').style.display   = 'none';
  $('pose-section').style.display  = 'flex';

  // 初始位置：地圖中心
  State.stickmanPos = {
    x: State.mapImage.naturalWidth  * 0.5,
    y: State.mapImage.naturalHeight * 0.5,
  };
  State.stickmanLocked  = false;
  State.currentPoseIdx  = 0;

  redrawStickmanCanvas();
  bindPoseButtons();
  bindStickmanDrag();
  bindDrawing();
  bindColorTools();

  // canvas-stickman: pointer-events 開啟（拖曳用）
  $('canvas-stickman').style.pointerEvents = 'all';
  $('canvas-stickman').style.cursor        = 'grab';
  $('canvas-draw').style.pointerEvents     = 'none';
}

// ── 姿勢按鈕綁定 ─────────────────────────────────────────
function bindPoseButtons() {
  document.querySelectorAll('.pose-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (State.stickmanLocked) return; // 鎖定後不可換姿勢
      const idx = parseInt(btn.dataset.pose);
      State.currentPoseIdx = idx;
      document.querySelectorAll('.pose-btn').forEach(b => {
        b.classList.remove('pose-btn--active');
        b.setAttribute('aria-pressed', 'false');
      });
      btn.classList.add('pose-btn--active');
      btn.setAttribute('aria-pressed', 'true');
      redrawStickmanCanvas();
    });
  });
}

// ── 火柴人拖曳 ────────────────────────────────────────────
function bindStickmanDrag() {
  const stickCanvas = $('canvas-stickman');
  let dragging = false;

  stickCanvas.addEventListener('pointerdown', e => {
    if (State.stickmanLocked) return;
    dragging = true;
    stickCanvas.setPointerCapture(e.pointerId);
    stickCanvas.style.cursor = 'grabbing';
    e.stopPropagation();
  });

  stickCanvas.addEventListener('pointermove', e => {
    if (!dragging || State.stickmanLocked) return;
    const sp = clientToStage(e.clientX, e.clientY);
    const iw = State.mapImage.naturalWidth;
    const ih = State.mapImage.naturalHeight;
    State.stickmanPos = {
      x: Math.max(0, Math.min(iw, sp.x)),
      y: Math.max(0, Math.min(ih, sp.y)),
    };
    redrawStickmanCanvas();
  });

  stickCanvas.addEventListener('pointerup', () => {
    dragging = false;
    stickCanvas.style.cursor = State.stickmanLocked ? 'default' : 'grab';
  });
}

// ── 鎖定位置 ─────────────────────────────────────────────
$('btn-lock-pos').addEventListener('click', () => {
  if (!State.mapImage) return;
  State.stickmanLocked = true;
  $('canvas-stickman').style.cursor        = 'default';
  $('canvas-stickman').style.pointerEvents = 'none';
  $('canvas-draw').style.pointerEvents     = 'all';
  $('btn-lock-pos').style.display = 'none';
  $('btn-submit').style.display   = 'inline-flex';
  $('pose-section').style.display = 'none'; // 鎖定後隱藏姿勢選擇

  // 重繪（不帶光暈）
  redrawStickmanCanvas();
  showToast('位置已鎖定！現在開始上色偽裝 🎨', 'success');
});

// ── 完成偽裝，合成並提交 ──────────────────────────────────
$('btn-submit').addEventListener('click', () => compositeAndSubmit());

function compositeAndSubmit() {
  if (!State.mapImage) return;

  // 如果時間到被強制提交時還沒鎖定，自動幫忙鎖定並消除光暈
  if (!State.stickmanLocked) {
    State.stickmanLocked = true;
    redrawStickmanCanvas();
  }

  const stickCanvas = $('canvas-stickman');
  const drawCanvas  = $('canvas-draw');
  const iw = drawCanvas.width, ih = drawCanvas.height;

  // 合成：stickman + painting → 一張圖
  const off = document.createElement('canvas');
  off.width = iw; off.height = ih;
  const ctx = off.getContext('2d');
  ctx.drawImage(stickCanvas, 0, 0);
  ctx.drawImage(drawCanvas,  0, 0);
  const imageDataUrl = off.toDataURL('image/png');

  // 計算精確碰撞框
  const norm = stageToNorm(State.stickmanPos.x, State.stickmanPos.y);
  const { hw, hh } = getStickmanHitBox();

  socket.emit('submitHiderData', {
    x: norm.x, y: norm.y,
    poseId:   STICKMAN_POSES[State.currentPoseIdx].id,
    hitHalfW: hw, hitHalfH: hh,
    imageDataUrl,
  });

  $('hider-toolbar').style.display = 'none';
  $('hud-phase-info').textContent  = '偽裝完成，等待尋找方…';
  showToast('偽裝資料已提交！', 'success');
}

// ══════════════════════════════════════════════════════════
// ■ 畫板系統
// ══════════════════════════════════════════════════════════
function saveUndoState() {
  const canvas = $('canvas-draw');
  const ctx = canvas.getContext('2d');
  State.undoStack.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
  if (State.undoStack.length > 20) State.undoStack.shift();
}

function undoDrawing() {
  if (State.undoStack.length === 0) return;
  const canvas = $('canvas-draw');
  const ctx = canvas.getContext('2d');
  const imgData = State.undoStack.pop();
  ctx.putImageData(imgData, 0, 0);
  showToast('↩️ 復原上一步', 'info', 1000);
}
$('btn-undo').addEventListener('click', undoDrawing);

function bindDrawing() {
  const canvas = $('canvas-draw');
  const ctx    = canvas.getContext('2d');
  let isDrawing = false, lx = 0, ly = 0;

  function canvasPos(clientX, clientY) {
    const sp = clientToStage(clientX, clientY);
    return { x: sp.x, y: sp.y };
  }

  function startDraw(cx, cy, e) {
    // 鎖定後才可畫，如果在拖曳模式或使用中鍵，則不作畫
    if (!State.stickmanLocked || State.panMode || e.button === 1) return;
    if (State.currentTool === 'eyedrop') { eyedropAt(cx, cy); return; }
    saveUndoState(); // 畫下第一筆前儲存狀態
    isDrawing = true;
    lx = cx; ly = cy;
    // 單點
    ctx.globalCompositeOperation = State.currentTool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.fillStyle = getColorStr();
    ctx.beginPath();
    ctx.arc(cx, cy, State.brushSize / 2, 0, Math.PI * 2);
    ctx.fill();
  }
  function doDraw(cx, cy) {
    if (!isDrawing || !State.stickmanLocked) return;
    ctx.globalCompositeOperation = State.currentTool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = getColorStr();
    ctx.lineWidth   = State.brushSize;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(lx, ly); ctx.lineTo(cx, cy);
    ctx.stroke();
    lx = cx; ly = cy;
  }
  function endDraw() { isDrawing = false; }

  // Pointer Events
  canvas.addEventListener('pointerdown', e => { const p = canvasPos(e.clientX, e.clientY); startDraw(p.x, p.y, e); });
  canvas.addEventListener('pointermove', e => { const p = canvasPos(e.clientX, e.clientY); doDraw(p.x, p.y); });
  canvas.addEventListener('pointerup',   endDraw);
  canvas.addEventListener('pointerleave',endDraw);
}

// ── 吸色筆 ───────────────────────────────────────────────
function eyedropAt(sx, sy) {
  const ctx  = $('canvas-map').getContext('2d');
  const data = ctx.getImageData(Math.floor(sx), Math.floor(sy), 1, 1).data;
  const r = data[0]/255, g = data[1]/255, b = data[2]/255;
  const max = Math.max(r,g,b), min = Math.min(r,g,b);
  let h, s, l = (max+min)/2;
  if (max === min) { h = s = 0; } else {
    const d = max - min;
    s = l > 0.5 ? d / (2-max-min) : d / (max+min);
    switch(max) {
      case r: h = ((g-b)/d + (g<b?6:0))/6; break;
      case g: h = ((b-r)/d + 2)/6; break;
      case b: h = ((r-g)/d + 4)/6; break;
    }
  }
  State.hslColor = { h: Math.round(h*360), s: Math.round(s*100), l: Math.round(l*100) };
  $('color-hue').value = State.hslColor.h;
  $('color-sat').value = State.hslColor.s;
  $('color-lit').value = State.hslColor.l;
  updateColorPreview();
  showToast('已吸取顏色', 'info', 1200);
}

// ── 顏色工具 ─────────────────────────────────────────────
function bindColorTools() {
  document.querySelectorAll('.tool-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.id === 'btn-undo') return; // undo 是獨立按鈕，不影響狀態
      document.querySelectorAll('.tool-btn').forEach(b => {
        if (b.id !== 'btn-undo') {
          b.classList.remove('tool-btn--active');
          b.setAttribute('aria-pressed', 'false');
        }
      });
      btn.classList.add('tool-btn--active');
      btn.setAttribute('aria-pressed', 'true');
      State.currentTool = btn.dataset.tool;
      // 點選繪圖工具時，自動關閉拖曳模式
      togglePanMode(false);
    });
  });
  $('brush-size').addEventListener('input', () => {
    State.brushSize = +$('brush-size').value;
    $('brush-size-value').textContent = State.brushSize;
  });
  ['color-hue','color-sat','color-lit'].forEach(id => {
    $(id).addEventListener('input', () => {
      State.hslColor = {
        h: +$('color-hue').value,
        s: +$('color-sat').value,
        l: +$('color-lit').value,
      };
      updateColorPreview();
    });
  });
  updateColorPreview();
}
function getColorStr() {
  const { h, s, l } = State.hslColor;
  return `hsl(${h},${s}%,${l}%)`;
}
function updateColorPreview() { $('color-preview').style.background = getColorStr(); }

// ══════════════════════════════════════════════════════════
// ■ Seeker 階段
// ══════════════════════════════════════════════════════════
function enterSeekerPhase(hiders, bullets) {
  $('hud-timer').style.display   = 'none';
  $('hud-bullets').style.display = 'flex';
  $('bullet-value').textContent  = bullets;
  $('hider-toolbar').style.display = 'none';

  if (State.myRole === 'seeker') {
    $('hud-phase-info').textContent = '點擊地圖找出躲藏者！';
    $('seeker-hint').style.display  = 'flex';
    bindSeekerClick();
  } else {
    $('hud-phase-info').textContent = '祈禱別被找到 🙏';
    $('seeker-hint').style.display  = 'none';
  }
}

// ── 渲染所有 Hider（Seeker 視角）─────────────────────────
function renderHiders(hiders) {
  const canvas = $('canvas-draw');
  const ctx    = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  hiders.forEach(h => {
    if (!h.imageDataUrl) return;
    const img = new Image();
    img.onload = () => ctx.drawImage(img, 0, 0);
    img.src    = h.imageDataUrl;
  });
}

// ── Seeker 點擊開槍 ───────────────────────────────────────
function bindSeekerClick() {
  const vp = $('canvas-viewport');
  let pointerDownTime = 0;

  function shoot(clientX, clientY) {
    if (State.bullets <= 0) { showToast('子彈耗盡！', 'error'); return; }
    if (_isPinching) return;

    const vr   = vp.getBoundingClientRect();
    const sp   = viewportToStage(clientX - vr.left, clientY - vr.top);
    const norm = stageToNorm(sp.x, sp.y);

    // 立即播放待確認特效
    triggerExplosion(sp.x, sp.y, false); // 小爆炸先出現
    socket.emit('seekerShoot', norm);
  }

  vp.addEventListener('pointerdown', e => { pointerDownTime = Date.now(); });
  vp.addEventListener('pointerup', e => {
    // 排除長按拖曳（>300ms 視為 pan 操作）
    if (Date.now() - pointerDownTime < 300 && !_isPinching) {
      shoot(e.clientX, e.clientY);
    }
  });
}

// ══════════════════════════════════════════════════════════
// ■ 遊戲結果
// ══════════════════════════════════════════════════════════
function showResult(winner, players) {
  showScreen('result');
  const isSeeker = winner === 'seeker';
  $('result-emoji').textContent = isSeeker ? '🔫' : '🐱';
  $('result-title').textContent = isSeeker ? '尋找方獲勝！' : '躲藏方獲勝！';
  $('result-desc').textContent  = isSeeker ? '所有躲藏者都被找到了！' : '子彈耗盡，躲藏者成功偽裝！';

  const board = $('result-scoreboard');
  board.innerHTML = '';
  players.forEach(p => {
    const isMe  = p.id === State.myId;
    const item  = document.createElement('div');
    item.className = 'score-item';
    item.setAttribute('role', 'listitem');
    const status = p.role === 'seeker'
      ? (winner === 'seeker' ? '🏆' : '😓')
      : (p.eliminated ? '💀' : '🏆');
    item.innerHTML = `
      <span class="score-item__role role--${p.role}">${p.role === 'seeker' ? '尋找方' : '躲藏方'}</span>
      <span>${escapeHtml(p.nickname)}${isMe ? ' (你)' : ''}</span>
      <span class="score-item__status">${status}</span>
    `;
    board.appendChild(item);
  });
}
