// ============================================================
// server.js — HideCatCat Backend
// Express + Socket.IO 大廳管理系統
// ============================================================

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;

// ── 靜態資源 ──────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.use('/map', express.static(path.join(__dirname, 'map')));

// ── 地圖清單 API ──────────────────────────────────────────
app.get('/api/maps', (req, res) => {
  const mapDir = path.join(__dirname, 'map');
  const files = fs.readdirSync(mapDir).filter(f =>
    /\.(jpg|jpeg|png|webp)$/i.test(f)
  );
  res.json(files);
});

// ── 房間狀態儲存 ──────────────────────────────────────────
/**
 * rooms: Map<roomId, RoomState>
 *
 * RoomState {
 *   id: string,
 *   hostId: string,
 *   phase: 'lobby' | 'hider' | 'seeker' | 'result',
 *   players: Map<socketId, PlayerState>,
 *   mapIndex: number,
 *   seekerId: string | null,
 *   hiderData: Map<socketId, HiderData>,
 *   bullets: number,
 *   hiderTimer: NodeJS.Timeout | null,
 * }
 *
 * PlayerState {
 *   id: string,
 *   nickname: string,
 *   ready: boolean,
 *   role: 'hider' | 'seeker' | null,
 *   eliminated: boolean,
 * }
 *
 * HiderData {
 *   x: number, y: number,       // 正規化座標 (0-1)
 *   imageDataUrl: string,        // 角色塗裝 DataURL
 *   submitted: boolean,
 * }
 */
const rooms = new Map();

// ── 工具函式 ─────────────────────────────────────────────

/**
 * 產生隨機 6 位英數 Room ID
 */
function generateRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 6; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  // 確保不重複
  return rooms.has(id) ? generateRoomId() : id;
}

/**
 * 將 players Map 序列化為陣列 (安全傳送至前端)
 */
function serializePlayers(players) {
  return Array.from(players.values()).map(p => ({
    id: p.id,
    nickname: p.nickname,
    ready: p.ready,
    role: p.role,
    eliminated: p.eliminated,
  }));
}

/**
 * 取得玩家所在房間
 */
function getPlayerRoom(socketId) {
  for (const [roomId, room] of rooms) {
    if (room.players.has(socketId)) return { roomId, room };
  }
  return null;
}

/**
 * 取得所有處於 lobby 階段的房間列表
 */
function getLobbyRooms() {
  const list = [];
  for (const [id, room] of rooms) {
    if (room.phase === 'lobby' && room.players.size > 0) {
      const host = room.players.get(room.hostId);
      list.push({
        id,
        playerCount: room.players.size,
        maxPlayers:  8,
        hostName:    host?.nickname || '???',
      });
    }
  }
  return list;
}

/**
 * 廣播最新大廳列表給所有連線中的 socket
 */
function broadcastRoomList() {
  io.emit('roomListUpdate', getLobbyRooms());
}

/**
 * 開始 Hider 階段計時器 (60 秒)
 */
function startHiderTimer(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  const HIDER_TIME = room.hiderTime || 60;
  let remaining = HIDER_TIME;

  // 立即廣播剩餘時間
  io.to(roomId).emit('timerUpdate', { remaining });

  room.hiderTimer = setInterval(() => {
    remaining -= 1;
    io.to(roomId).emit('timerUpdate', { remaining });

    if (remaining <= 0) {
      clearInterval(room.hiderTimer);
      room.hiderTimer = null;
      io.to(roomId).emit('forceSubmit');

      // 等待 1.5 秒讓 Hider 能夠送出最後繪圖
      setTimeout(() => {
        forceSubmitUnfinishedHiders(roomId);
      }, 1500);
    }
  }, 1000);
}

/**
 * 強制提交所有未完成的 Hider
 */
function forceSubmitUnfinishedHiders(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  let allSubmitted = true;
  for (const [sid, player] of room.players) {
    if (player.role === 'hider') {
      if (!room.hiderData.has(sid) || !room.hiderData.get(sid).submitted) {
        // 填入預設資料 (躲在地圖左上角)
        room.hiderData.set(sid, {
          x: 0.05, y: 0.05,
          imageDataUrl: null,
          submitted: true,
        });
        io.to(sid).emit('forceSubmit');
      }
    }
  }
  transitionToSeekerPhase(roomId);
}

/**
 * 轉換至 Seeker 尋找階段
 */
function transitionToSeekerPhase(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.phase !== 'hider') return;

  room.phase = 'seeker';

  // 組裝所有 Hider 資料 (不含 seeker)
  const hidersInfo = [];
  for (const [sid, data] of room.hiderData) {
    const player = room.players.get(sid);
    if (player) {
      hidersInfo.push({
        id: sid,
        nickname: player.nickname,
        x: data.x,
        y: data.y,
        poseId: data.poseId || 'stand',
        hitHalfW: data.hitHalfW || 0.04,
        hitHalfH: data.hitHalfH || 0.04,
        imageDataUrl: data.imageDataUrl,
      });
    }
  }

  // 子彈數 = 玩家總數 × 2
  room.bullets = room.players.size * 2;

  io.to(roomId).emit('seekerPhaseStart', {
    hiders: hidersInfo,
    bullets: room.bullets,
    seekerId: room.seekerId,
  });

  // 開始 Seeker 計時器
  startSeekerTimer(roomId);
}

function startSeekerTimer(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  const SEEKER_TIME = room.seekerTime || 120;
  let remaining = SEEKER_TIME;

  io.to(roomId).emit('timerUpdate', { remaining });

  room.seekerTimer = setInterval(() => {
    remaining -= 1;
    io.to(roomId).emit('timerUpdate', { remaining });

    if (remaining <= 0) {
      clearInterval(room.seekerTimer);
      room.seekerTimer = null;
      // 時間到，Seeker 失敗，Hider 勝利
      endGame(roomId, 'hider');
    }
  }, 1000);
}

// ── Socket.IO 事件處理 ───────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[Connect] ${socket.id}`);

  // ─ 取得大廳房間列表 ────────────────────────────────────
  socket.on('getRooms', () => {
    socket.emit('roomList', getLobbyRooms());
  });

  // ─ 建立房間 ────────────────────────────────────────────
  socket.on('createRoom', ({ nickname }) => {
    if (!nickname || nickname.trim() === '') {
      socket.emit('error', { message: '請輸入暱稱' });
      return;
    }

    const roomId = generateRoomId();
    const room = {
      id: roomId,
      hostId: socket.id,
      phase: 'lobby',
      players: new Map(),
      mapIndex: 0,
      seekerId: null,
      hiderData: new Map(),
      bullets: 0,
      hiderTimer: null,
      seekerTimer: null,
      hiderTime: 60,
      seekerTime: 120,
    };

    room.players.set(socket.id, {
      id: socket.id,
      nickname: nickname.trim().slice(0, 16),
      ready: false,
      role: null,
      eliminated: false,
    });

    rooms.set(roomId, room);
    socket.join(roomId);

    socket.emit('roomCreated', {
      roomId,
      players: serializePlayers(room.players),
      isHost: true,
    });

    broadcastRoomList(); // 通知所有人有新房間
    console.log(`[Room] ${roomId} created by ${nickname}`);
  });

  // ─ 更新房間設定 ────────────────────────────────────────────
  socket.on('updateSettings', ({ hiderTime, seekerTime }) => {
    const found = getPlayerRoom(socket.id);
    if (!found) return;
    const { roomId, room } = found;

    if (room.hostId === socket.id && room.phase === 'lobby') {
      room.hiderTime = Math.max(10, Math.min(300, parseInt(hiderTime) || 60));
      room.seekerTime = Math.max(30, Math.min(600, parseInt(seekerTime) || 120));
      
      io.to(roomId).emit('settingsUpdated', {
        hiderTime: room.hiderTime,
        seekerTime: room.seekerTime
      });
    }
  });

  // ─ 加入房間 ────────────────────────────────────────────
  socket.on('joinRoom', ({ roomId, nickname }) => {
    const id = (roomId || '').trim().toUpperCase();
    const name = (nickname || '').trim().slice(0, 16);

    if (!id || !name) {
      socket.emit('joinError', { message: '請填寫房間 ID 與暱稱' });
      return;
    }

    const room = rooms.get(id);
    if (!room) {
      socket.emit('joinError', { message: '找不到房間，請確認 ID' });
      return;
    }
    if (room.phase !== 'lobby') {
      socket.emit('joinError', { message: '遊戲已開始，無法加入' });
      return;
    }
    if (room.players.size >= 8) {
      socket.emit('joinError', { message: '房間已滿（最多 8 人）' });
      return;
    }

    room.players.set(socket.id, {
      id: socket.id,
      nickname: name,
      ready: false,
      role: null,
      eliminated: false,
    });

    socket.join(id);

    socket.emit('joinSuccess', {
      roomId: id,
      players: serializePlayers(room.players),
      isHost: false,
    });

    // 廣播給其他人
    socket.to(id).emit('playerJoined', {
      players: serializePlayers(room.players),
    });

    broadcastRoomList(); // 更新房間人數
    console.log(`[Room] ${name} joined ${id}`);
  });

  // ─ 玩家準備 ────────────────────────────────────────────
  socket.on('playerReady', () => {
    const found = getPlayerRoom(socket.id);
    if (!found) return;
    const { roomId, room } = found;
    if (room.phase !== 'lobby') return;

    const player = room.players.get(socket.id);
    if (!player) return;

    player.ready = !player.ready; // toggle

    io.to(roomId).emit('playerReadyUpdate', {
      players: serializePlayers(room.players),
    });

    // 檢查是否全員準備 (至少需要 2 人)
    const playerList = Array.from(room.players.values());
    const allReady = playerList.length >= 2 && playerList.every(p => p.ready);

    if (allReady) {
      // 隨機選出 Seeker
      const shuffled = [...playerList].sort(() => Math.random() - 0.5);
      const seeker = shuffled[0];
      room.seekerId = seeker.id;

      // 設定角色
      for (const p of room.players.values()) {
        p.role = (p.id === seeker.id) ? 'seeker' : 'hider';
        p.ready = false;
      }

      // 隨機選兩張不同地圖：hider 用的真實地圖 & seeker 初始看到的遮蓋地圖
      const mapCount = 4;
      room.mapIndex = Math.floor(Math.random() * mapCount);
      // seeker 初始地圖必須和 hider 地圖不同
      room.seekerMapIndex = (room.mapIndex + 1 + Math.floor(Math.random() * (mapCount - 1))) % mapCount;

      room.phase = 'hider';

      broadcastRoomList(); // 房間進入遊戲，從公開列表移除

      // 廣播遊戲開始（每個玩家收到自己的角色）
      for (const [sid, p] of room.players) {
        io.to(sid).emit('gameStart', {
          role: p.role,
          seekerId: room.seekerId,
          mapIndex: room.mapIndex,
          seekerMapIndex: room.seekerMapIndex,
          players: serializePlayers(room.players),
        });
      }

      // 啟動 Hider 階段計時器
      startHiderTimer(roomId);

      console.log(`[Game] ${roomId} started. Seeker: ${seeker.nickname}`);
    }
  });

  // ─ Hider 提交偽裝資料 ──────────────────────────────────
  socket.on('submitHiderData', ({ x, y, poseId, hitHalfW, hitHalfH, imageDataUrl }) => {
    const found = getPlayerRoom(socket.id);
    if (!found) return;
    const { roomId, room } = found;
    if (room.phase !== 'hider') return;

    const player = room.players.get(socket.id);
    if (!player || player.role !== 'hider') return;

    room.hiderData.set(socket.id, {
      x: Math.max(0, Math.min(1, x)),
      y: Math.max(0, Math.min(1, y)),
      poseId: poseId || 'stand',
      hitHalfW: hitHalfW || 0.04,
      hitHalfH: hitHalfH || 0.04,
      imageDataUrl: imageDataUrl || null,
      submitted: true,
    });

    socket.emit('submitAck');

    // 檢查是否所有 Hider 都已提交
    const hiders = Array.from(room.players.values()).filter(p => p.role === 'hider');
    const submittedCount = hiders.filter(p => room.hiderData.get(p.id)?.submitted).length;

    if (submittedCount === hiders.length) {
      // 停止計時器並進入 Seeker 階段
      if (room.hiderTimer) {
        clearInterval(room.hiderTimer);
        room.hiderTimer = null;
      }
      io.to(roomId).emit('timerUpdate', { remaining: 0 });
      transitionToSeekerPhase(roomId);
    }
  });

  // ─ Seeker 開槍 ─────────────────────────────────────────
  socket.on('seekerShoot', ({ x, y }) => {
    const found = getPlayerRoom(socket.id);
    if (!found) return;
    const { roomId, room } = found;
    if (room.phase !== 'seeker') return;

    const player = room.players.get(socket.id);
    if (!player || player.role !== 'seeker') return;
    if (room.bullets <= 0) return;

    room.bullets -= 1;

    // AABB 碰撞判定 (使用各 hider 提交的精確碰撞盒)
    let hitId = null;
    let hitData = null;
    for (const [sid, data] of room.hiderData) {
      const p = room.players.get(sid);
      if (!p || p.eliminated) continue;
      const hw = data.hitHalfW || 0.04;
      const hh = data.hitHalfH || 0.04;
      if (
        x >= data.x - hw && x <= data.x + hw &&
        y >= data.y - hh && y <= data.y + hh
      ) {
        hitId = sid;
        hitData = data;
        break;
      }
    }

    if (hitId) {
      const hitPlayer = room.players.get(hitId);
      hitPlayer.eliminated = true;

      io.to(roomId).emit('hiderEliminated', {
        hitId,
        hitX: x,       // 命中座標 (用於爆炸特效)
        hitY: y,
        nickname: hitPlayer.nickname,
        bullets: room.bullets,
        players: serializePlayers(room.players),
      });
    } else {
      io.to(roomId).emit('shotMissed', {
        x, y, bullets: room.bullets,
      });
    }

    // 勝負判定
    const remainingHiders = Array.from(room.players.values())
      .filter(p => p.role === 'hider' && !p.eliminated);

    if (remainingHiders.length === 0) {
      // Seeker 勝利
      endGame(roomId, 'seeker');
    } else if (room.bullets <= 0) {
      // Hider 勝利
      endGame(roomId, 'hider');
    }
  });

  // ─ 斷線處理 ────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`[Disconnect] ${socket.id}`);

    const found = getPlayerRoom(socket.id);
    if (!found) return;
    const { roomId, room } = found;

    room.players.delete(socket.id);

    if (room.players.size === 0) {
      // 清除房間
      if (room.hiderTimer) clearInterval(room.hiderTimer);
      rooms.delete(roomId);
      broadcastRoomList();
      console.log(`[Room] ${roomId} deleted (empty)`);
      return;
    }

    // 若房主離開，轉移給第一位玩家
    if (room.hostId === socket.id) {
      room.hostId = room.players.keys().next().value;
    }

    io.to(roomId).emit('playerLeft', {
      players: serializePlayers(room.players),
      leftId: socket.id,
    });

    broadcastRoomList(); // 更新房間人數

    // 若遊戲中 Seeker 或所有 Hider 都離開，提前結束
    if (room.phase === 'seeker' || room.phase === 'hider') {
      const seekerGone = room.seekerId === socket.id;
      const remainingHiders = Array.from(room.players.values())
        .filter(p => p.role === 'hider');

      if (seekerGone) {
        endGame(roomId, 'hider');
      } else if (remainingHiders.length === 0) {
        endGame(roomId, 'seeker');
      }
    }
  });
});

// ── 遊戲結束 ──────────────────────────────────────────────
function endGame(roomId, winner) {
  const room = rooms.get(roomId);
  if (!room) return;

  if (room.hiderTimer) {
    clearInterval(room.hiderTimer);
    room.hiderTimer = null;
  }
  if (room.seekerTimer) {
    clearInterval(room.seekerTimer);
    room.seekerTimer = null;
  }

  room.phase = 'result';

  io.to(roomId).emit('gameOver', {
    winner, // 'seeker' | 'hider'
    players: serializePlayers(room.players),
  });

  // 5 秒後重設房間回大廳
  setTimeout(() => {
    const r = rooms.get(roomId);
    if (!r) return;
    r.phase = 'lobby';
    r.seekerId = null;
    r.hiderData.clear();
    r.bullets = 0;
    for (const p of r.players.values()) {
      p.role = null;
      p.ready = false;
      p.eliminated = false;
    }
    io.to(roomId).emit('returnToLobby', {
      players: serializePlayers(r.players),
    });
    broadcastRoomList(); // 房間回到大廳，重新公開
  }, 8000);
}

// ── 啟動伺服器 ─────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🐱 HideCatCat server running on http://localhost:${PORT}\n`);
});
