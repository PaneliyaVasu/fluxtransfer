// Flux Zen Games Module
(function (window) {
  'use strict';

  // ──── SNAKE GAME ────
  class SnakeGame {
    constructor(canvas, options = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.onScore = options.onScore || (() => {});
      this.onGameOver = options.onGameOver || (() => {});
      
      this.gridSize = 20; // 20x20 grid
      this.cellSize = 15; // default, will auto-adjust
      this.running = false;
      this.loopId = null;
      
      this.snake = [];
      this.direction = 'right';
      this.nextDirection = 'right';
      this.food = { x: 0, y: 0 };
      this.score = 0;
      this.speed = 130; // ms per tick

      this._keydownHandler = null;
    }

    init() {
      // Auto-scale canvas
      this.cellSize = Math.floor(this.canvas.width / this.gridSize);
      
      this.snake = [
        { x: 10, y: 10 },
        { x: 9, y: 10 },
        { x: 8, y: 10 }
      ];
      this.direction = 'right';
      this.nextDirection = 'right';
      this.score = 0;
      this.running = true;
      this.placeFood();
      this.onScore(this.score);
      
      this.bindKeys();
      
      if (this.loopId) clearTimeout(this.loopId);
      this.gameLoop();
    }

    bindKeys() {
      this.unbindKeys();
      this._keydownHandler = (e) => {
        if (!this.running) return;
        
        const keyMap = {
          'ArrowUp': 'up', 'KeyW': 'up',
          'ArrowDown': 'down', 'KeyS': 'down',
          'ArrowLeft': 'left', 'KeyA': 'left',
          'ArrowRight': 'right', 'KeyD': 'right'
        };

        const dir = keyMap[e.code];
        if (dir) {
          e.preventDefault(); // Prevent page scrolling
          this.setDirection(dir);
        }
      };
      window.addEventListener('keydown', this._keydownHandler);
    }

    unbindKeys() {
      if (this._keydownHandler) {
        window.removeEventListener('keydown', this._keydownHandler);
        this._keydownHandler = null;
      }
    }

    setDirection(dir) {
      const opposites = {
        'up': 'down',
        'down': 'up',
        'left': 'right',
        'right': 'left'
      };
      
      if (opposites[dir] !== this.direction) {
        this.nextDirection = dir;
      }
    }

    placeFood() {
      let tries = 0;
      while (tries < 100) {
        const x = Math.floor(Math.random() * this.gridSize);
        const y = Math.floor(Math.random() * this.gridSize);
        const onSnake = this.snake.some(segment => segment.x === x && segment.y === y);
        if (!onSnake) {
          this.food = { x, y };
          return;
        }
        tries++;
      }
      this.food = { x: 0, y: 0 };
    }

    gameLoop() {
      if (!this.running) return;

      this.update();
      this.draw();

      this.loopId = setTimeout(() => {
        requestAnimationFrame(() => this.gameLoop());
      }, this.speed);
    }

    update() {
      this.direction = this.nextDirection;
      const head = { ...this.snake[0] };

      switch (this.direction) {
        case 'up': head.y--; break;
        case 'down': head.y++; break;
        case 'left': head.x--; break;
        case 'right': head.x++; break;
      }

      // Check collision with walls or self
      if (
        head.x < 0 || head.x >= this.gridSize ||
        head.y < 0 || head.y >= this.gridSize ||
        this.snake.some(segment => segment.x === head.x && segment.y === head.y)
      ) {
        this.gameOver();
        return;
      }

      this.snake.unshift(head);

      // Check food consumption
      if (head.x === this.food.x && head.y === this.food.y) {
        this.score += 10;
        this.onScore(this.score);
        this.placeFood();
        // Speed up slightly
        this.speed = Math.max(70, 130 - Math.floor(this.score / 50) * 8);
      } else {
        this.snake.pop();
      }
    }

    draw() {
      // Clear canvas
      this.ctx.fillStyle = '#16211C'; // matches var(--panel)
      this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

      // Draw grid lines (subtle)
      this.ctx.strokeStyle = '#24332B'; // matches var(--line)
      this.ctx.lineWidth = 0.5;
      for (let i = 0; i <= this.gridSize; i++) {
        // vertical
        this.ctx.beginPath();
        this.ctx.moveTo(i * this.cellSize, 0);
        this.ctx.lineTo(i * this.cellSize, this.canvas.height);
        this.ctx.stroke();

        // horizontal
        this.ctx.beginPath();
        this.ctx.moveTo(0, i * this.cellSize);
        this.ctx.lineTo(this.canvas.width, i * this.cellSize);
        this.ctx.stroke();
      }

      // Draw food
      this.ctx.fillStyle = '#E8A33D'; // matches var(--amber)
      this.ctx.beginPath();
      const radius = this.cellSize / 2;
      const cx = this.food.x * this.cellSize + radius;
      const cy = this.food.y * this.cellSize + radius;
      this.ctx.arc(cx, cy, radius - 1, 0, Math.PI * 2);
      this.ctx.fill();

      // Draw snake
      this.snake.forEach((segment, index) => {
        const isHead = index === 0;
        this.ctx.fillStyle = isHead ? '#6FA8A0' : '#3E5C57'; // sage and sage-dim
        this.ctx.fillRect(
          segment.x * this.cellSize + 1,
          segment.y * this.cellSize + 1,
          this.cellSize - 2,
          this.cellSize - 2
        );
        
        // Draw head eyes
        if (isHead) {
          this.ctx.fillStyle = '#0D1512';
          const eyeSize = 2;
          if (this.direction === 'right' || this.direction === 'left') {
            this.ctx.fillRect(segment.x * this.cellSize + (this.direction === 'right' ? 9 : 3), segment.y * this.cellSize + 3, eyeSize, eyeSize);
            this.ctx.fillRect(segment.x * this.cellSize + (this.direction === 'right' ? 9 : 3), segment.y * this.cellSize + 9, eyeSize, eyeSize);
          } else {
            this.ctx.fillRect(segment.x * this.cellSize + 3, segment.y * this.cellSize + (this.direction === 'down' ? 9 : 3), eyeSize, eyeSize);
            this.ctx.fillRect(segment.x * this.cellSize + 9, segment.y * this.cellSize + (this.direction === 'down' ? 9 : 3), eyeSize, eyeSize);
          }
        }
      });
    }

    gameOver() {
      this.running = false;
      if (this.loopId) clearTimeout(this.loopId);
      this.unbindKeys();
      this.onGameOver(this.score);
    }

    stop() {
      this.running = false;
      if (this.loopId) clearTimeout(this.loopId);
      this.unbindKeys();
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  // ──── MEMORY MATCH GAME ────
  class MemoryMatchGame {
    constructor(container, options = {}) {
      this.container = container;
      this.onMoves = options.onMoves || (() => {});
      this.onWin = options.onWin || (() => {});

      this.emojis = ['🧠', '🎮', '🧘', '⚡', '🚀', '🛸', '👾', '🦄'];
      this.cards = [];
      this.flippedCards = [];
      this.moves = 0;
      this.matches = 0;
      this.lock = false;
    }

    init() {
      this.container.innerHTML = '';
      this.moves = 0;
      this.matches = 0;
      this.flippedCards = [];
      this.lock = false;
      this.onMoves(this.moves);

      // Create duplicated emoji set and shuffle
      const cardSet = [...this.emojis, ...this.emojis];
      this.shuffle(cardSet);

      this.cards = cardSet.map((emoji, index) => {
        return {
          id: index,
          emoji: emoji,
          flipped: false,
          matched: false
        };
      });

      // Build grid layout
      this.container.className = 'zen-memory-grid';
      this.cards.forEach(card => {
        const cardEl = document.createElement('div');
        cardEl.className = 'zen-memory-card';
        cardEl.dataset.id = card.id;

        const cardInner = document.createElement('div');
        cardInner.className = 'zen-memory-card-inner';

        const front = document.createElement('div');
        front.className = 'zen-memory-card-front';
        front.textContent = '❓';

        const back = document.createElement('div');
        back.className = 'zen-memory-card-back';
        back.textContent = card.emoji;

        cardInner.appendChild(front);
        cardInner.appendChild(back);
        cardEl.appendChild(cardInner);
        
        cardEl.onclick = () => this.handleCardClick(card, cardEl);
        
        this.container.appendChild(cardEl);
      });
    }

    shuffle(array) {
      for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
      }
    }

    handleCardClick(card, cardEl) {
      if (this.lock || card.flipped || card.matched || this.flippedCards.length >= 2) return;

      // Flip card
      card.flipped = true;
      cardEl.classList.add('flipped');
      this.flippedCards.push({ card, el: cardEl });

      if (this.flippedCards.length === 2) {
        this.moves++;
        this.onMoves(this.moves);
        this.checkMatch();
      }
    }

    checkMatch() {
      const [c1, c2] = this.flippedCards;

      if (c1.card.emoji === c2.card.emoji) {
        // Match found
        c1.card.matched = true;
        c2.card.matched = true;
        c1.el.classList.add('matched');
        c2.el.classList.add('matched');
        
        this.matches++;
        this.flippedCards = [];

        if (this.matches === this.emojis.length) {
          setTimeout(() => this.onWin(this.moves), 450);
        }
      } else {
        // No match
        this.lock = true;
        setTimeout(() => {
          c1.card.flipped = false;
          c2.card.flipped = false;
          c1.el.classList.remove('flipped');
          c2.el.classList.remove('flipped');
          this.flippedCards = [];
          this.lock = false;
        }, 1000);
      }
    }

    stop() {
      this.container.innerHTML = '';
      this.flippedCards = [];
    }
  }

  // ──── TIC TAC TOE GAME ────
  class TicTacToeGame {
    constructor(container, options = {}) {
      this.container = container;
      this.onWin = options.onWin || (() => {});
      this.onDraw = options.onDraw || (() => {});
      this.onTurnChange = options.onTurnChange || (() => {});
      this.sendMsg = options.sendMsg || (() => {});
      
      this.mode = 'ai'; // 'ai' | 'local' | 'peer'
      this.myRole = null; // 'X' (host) | 'O' (guest) | null
      this.board = Array(9).fill(null);
      this.turn = 'X';
      this.running = false;
      this.scores = { X: 0, O: 0 };
    }

    init(mode = 'ai', myRole = null) {
      this.mode = mode;
      this.myRole = myRole;
      this.board = Array(9).fill(null);
      this.turn = 'X';
      this.running = true;
      this.render();
      this.onTurnChange(this.turn, this.isMyTurn());
      
      if (this.mode === 'ai' && this.myRole === 'O') {
        setTimeout(() => this.makeAIMove(), 500);
      }
    }

    isMyTurn() {
      if (this.mode !== 'peer') return true;
      return this.turn === this.myRole;
    }

    render() {
      this.container.innerHTML = `
        <div class="ttt-wrap">
          <div class="ttt-status-bar" style="display:flex; justify-content:space-between; margin-bottom:10px; font-size:12px; color:var(--text-muted); font-family:var(--font-mono);">
            <span class="ttt-turn-msg" id="tttTurnMsg"></span>
            <span class="ttt-score-msg" id="tttScoreMsg">X: ${this.scores.X} | O: ${this.scores.O}</span>
          </div>
          <div class="ttt-grid" style="display:grid; grid-template-columns:repeat(3, 1fr); gap:8px; width:180px; margin:0 auto;">
            ${this.board.map((val, idx) => `
              <button class="ttt-cell" data-idx="${idx}" style="aspect-ratio:1; font-size:24px; font-weight:700; color:var(--text); background:var(--panel); border:1px solid var(--line); border-radius:6px; cursor:pointer;">${val || ''}</button>
            `).join('')}
          </div>
        </div>
      `;

      this.updateTurnMsg();

      const cells = this.container.querySelectorAll('.ttt-cell');
      cells.forEach(cell => {
        cell.onclick = () => {
          const idx = parseInt(cell.getAttribute('data-idx'));
          this.handleCellClick(idx);
        };
      });
    }

    updateTurnMsg() {
      const msgEl = this.container.querySelector('#tttTurnMsg');
      if (!msgEl) return;
      if (!this.running) return;

      if (this.mode === 'peer') {
        msgEl.textContent = this.isMyTurn() ? "🟢 Your Turn (Player " + this.myRole + ")" : "⏳ Opponent's Turn";
      } else {
        msgEl.textContent = "Turn: Player " + this.turn;
      }
    }

    handleCellClick(idx) {
      if (!this.running) return;
      if (this.board[idx] !== null) return;
      if (!this.isMyTurn()) return;

      this.makeMove(idx);

      if (this.mode === 'peer') {
        this.sendMsg({ action: 'move', game: 'tictactoe', data: { cellIndex: idx } });
      }
    }

    makeMove(idx) {
      this.board[idx] = this.turn;
      this.render();

      const winCombo = this.checkWin();
      if (winCombo) {
        this.endGame(this.turn);
        return;
      }

      if (this.board.every(cell => cell !== null)) {
        this.endGame('draw');
        return;
      }

      this.turn = this.turn === 'X' ? 'O' : 'X';
      this.updateTurnMsg();
      this.onTurnChange(this.turn, this.isMyTurn());

      if (this.running && this.mode === 'ai' && this.turn === 'O') {
        setTimeout(() => this.makeAIMove(), 500);
      }
    }

    receiveMove(data) {
      if (!this.running || this.mode !== 'peer') return;
      const idx = data.cellIndex;
      if (idx !== undefined && this.board[idx] === null && !this.isMyTurn()) {
        this.makeMove(idx);
      }
    }

    makeAIMove() {
      if (!this.running) return;
      const opponent = this.turn === 'X' ? 'O' : 'X';
      
      for (let i = 0; i < 9; i++) {
        if (this.board[i] === null) {
          this.board[i] = this.turn;
          if (this.checkWin()) {
            this.board[i] = null;
            this.makeMove(i);
            return;
          }
          this.board[i] = null;
        }
      }

      for (let i = 0; i < 9; i++) {
        if (this.board[i] === null) {
          this.board[i] = opponent;
          if (this.checkWin()) {
            this.board[i] = null;
            this.makeMove(i);
            return;
          }
          this.board[i] = null;
        }
      }

      const empties = [];
      this.board.forEach((val, idx) => { if (val === null) empties.push(idx); });
      if (empties.length > 0) {
        const pick = empties[Math.floor(Math.random() * empties.length)];
        this.makeMove(pick);
      }
    }

    checkWin() {
      const combos = [
        [0, 1, 2], [3, 4, 5], [6, 7, 8],
        [0, 3, 6], [1, 4, 7], [2, 5, 8],
        [0, 4, 8], [2, 4, 6]
      ];
      for (let c of combos) {
        if (this.board[c[0]] && this.board[c[0]] === this.board[c[1]] && this.board[c[0]] === this.board[c[2]]) {
          return c;
        }
      }
      return null;
    }

    endGame(result) {
      this.running = false;
      const statusEl = this.container.querySelector('#tttTurnMsg');
      if (statusEl) {
        if (result === 'draw') {
          statusEl.textContent = "🤝 Draw!";
          this.onDraw();
        } else {
          statusEl.textContent = `🎉 Player ${result} Wins!`;
          this.scores[result]++;
          const scoreEl = this.container.querySelector('#tttScoreMsg');
          if (scoreEl) {
            scoreEl.textContent = `X: ${this.scores.X} | O: ${this.scores.O}`;
          }
          this.onWin(result);
        }
      }

      const wrap = this.container.querySelector('.ttt-wrap');
      if (wrap) {
        const btnBox = document.createElement('div');
        btnBox.style.marginTop = '15px';
        btnBox.style.textAlign = 'center';

        if (this.mode !== 'peer') {
          btnBox.innerHTML = `<button class="flux-zen-compact-btn" id="tttRestartBtn">Play Again</button>`;
          wrap.appendChild(btnBox);
          const rstBtn = this.container.querySelector('#tttRestartBtn');
          if (rstBtn) {
            rstBtn.onclick = () => {
              this.init(this.mode, this.myRole);
            };
          }
        } else {
          if (this.myRole === 'X') {
            btnBox.innerHTML = `<button class="flux-zen-compact-btn" id="tttRestartBtn">Restart Match</button>`;
          } else {
            btnBox.innerHTML = `<span style="font-size:12px;color:var(--text-muted);">Waiting for host...</span>`;
          }
          wrap.appendChild(btnBox);
          const rstBtn = this.container.querySelector('#tttRestartBtn');
          if (rstBtn) {
            rstBtn.onclick = () => {
              this.sendMsg({ action: 'reset', game: 'tictactoe' });
              this.init(this.mode, this.myRole);
            };
          }
        }
      }
    }

    stop() {
      this.running = false;
      this.container.innerHTML = '';
    }
  }

  // ──── CONNECT FOUR GAME ────
  class ConnectFourGame {
    constructor(container, options = {}) {
      this.container = container;
      this.onWin = options.onWin || (() => {});
      this.onDraw = options.onDraw || (() => {});
      this.onTurnChange = options.onTurnChange || (() => {});
      this.sendMsg = options.sendMsg || (() => {});
      
      this.rows = 6;
      this.cols = 7;
      this.board = Array(this.rows).fill(null).map(() => Array(this.cols).fill(null));
      this.turn = 'R'; // R = Red, Y = Yellow
      this.mode = 'ai';
      this.myRole = null;
      this.running = false;
      this.scores = { R: 0, Y: 0 };
    }

    init(mode = 'ai', myRole = null) {
      this.mode = mode;
      this.myRole = myRole;
      this.board = Array(this.rows).fill(null).map(() => Array(this.cols).fill(null));
      this.turn = 'R';
      this.running = true;
      this.render();
      this.onTurnChange(this.turn, this.isMyTurn());

      if (this.mode === 'ai' && this.myRole === 'Y') {
        setTimeout(() => this.makeAIMove(), 600);
      }
    }

    isMyTurn() {
      if (this.mode !== 'peer') return true;
      return this.turn === this.myRole;
    }

    render() {
      this.container.innerHTML = `
        <div class="c4-wrap">
          <div class="c4-status-bar" style="display:flex; justify-content:space-between; margin-bottom:10px; font-size:12px; color:var(--text-muted); font-family:var(--font-mono);">
            <span id="c4TurnMsg"></span>
            <span id="c4ScoreMsg">Red: ${this.scores.R} | Yellow: ${this.scores.Y}</span>
          </div>
          <div class="c4-board-outer" style="display:flex; flex-direction:column; align-items:center; gap:5px;">
            <div class="c4-columns-row" style="display:grid; grid-template-columns: repeat(${this.cols}, 1fr); gap:6px; width:220px;">
              ${Array(this.cols).fill(null).map((_, idx) => `
                <button class="c4-col-btn" data-col="${idx}" style="background:transparent; border:none; color:var(--sage); cursor:pointer; font-size:11px;">▼</button>
              `).join('')}
            </div>
            <div class="c4-board-grid" style="display:grid; grid-template-columns: repeat(${this.cols}, 1fr); gap:6px; background:#1C2921; padding:8px; border-radius:8px; border:1px solid var(--line); width:220px;">
              ${this.board.map((row) => row.map((cell) => `
                <div class="c4-cell" style="aspect-ratio:1; background:var(--bg); border-radius:50%; display:flex; align-items:center; justify-content:center; overflow:hidden;">
                  <div class="c4-piece ${cell || ''}" style="width:85%; height:85%; border-radius:50%;"></div>
                </div>
              `).join('')).join('')}
            </div>
          </div>
        </div>
      `;

      this.updateTurnMsg();

      const colBtns = this.container.querySelectorAll('.c4-col-btn');
      colBtns.forEach(btn => {
        btn.onclick = () => {
          const col = parseInt(btn.getAttribute('data-col'));
          this.handleColSelect(col);
        };
      });
    }

    updateTurnMsg() {
      const msgEl = this.container.querySelector('#c4TurnMsg');
      if (!msgEl) return;
      if (!this.running) return;

      if (this.mode === 'peer') {
        const roleName = this.myRole === 'R' ? 'Red' : 'Yellow';
        msgEl.textContent = this.isMyTurn() ? `🟢 Your Turn (${roleName})` : `⏳ Opponent's Turn`;
      } else {
        msgEl.textContent = `Turn: ${this.turn === 'R' ? 'Red' : 'Yellow'}`;
      }
    }

    handleColSelect(col) {
      if (!this.running) return;
      if (!this.isMyTurn()) return;
      if (this.getLowestEmptyRow(col) === -1) return;

      this.makeMove(col);

      if (this.mode === 'peer') {
        this.sendMsg({ action: 'move', game: 'connect4', data: { colIndex: col } });
      }
    }

    getLowestEmptyRow(col) {
      for (let r = this.rows - 1; r >= 0; r--) {
        if (this.board[r][col] === null) return r;
      }
      return -1;
    }

    makeMove(col) {
      const row = this.getLowestEmptyRow(col);
      if (row === -1) return;

      this.board[row][col] = this.turn;
      this.render();

      if (this.checkWin(row, col)) {
        this.endGame(this.turn);
        return;
      }

      if (this.board.every(r => r.every(c => c !== null))) {
        this.endGame('draw');
        return;
      }

      this.turn = this.turn === 'R' ? 'Y' : 'R';
      this.updateTurnMsg();
      this.onTurnChange(this.turn, this.isMyTurn());

      if (this.running && this.mode === 'ai' && this.turn === 'Y') {
        setTimeout(() => this.makeAIMove(), 600);
      }
    }

    receiveMove(data) {
      if (!this.running || this.mode !== 'peer') return;
      const col = data.colIndex;
      if (col !== undefined && this.getLowestEmptyRow(col) !== -1 && !this.isMyTurn()) {
        this.makeMove(col);
      }
    }

    makeAIMove() {
      if (!this.running) return;
      const opponent = this.turn === 'R' ? 'Y' : 'R';

      for (let c = 0; c < this.cols; c++) {
        const r = this.getLowestEmptyRow(c);
        if (r !== -1) {
          this.board[r][c] = this.turn;
          if (this.checkWin(r, c)) {
            this.board[r][c] = null;
            this.makeMove(c);
            return;
          }
          this.board[r][c] = null;
        }
      }

      for (let c = 0; c < this.cols; c++) {
        const r = this.getLowestEmptyRow(c);
        if (r !== -1) {
          this.board[r][c] = opponent;
          if (this.checkWin(r, c)) {
            this.board[r][c] = null;
            this.makeMove(c);
            return;
          }
          this.board[r][c] = null;
        }
      }

      const colsWithSpace = [];
      for (let c = 0; c < this.cols; c++) {
        if (this.getLowestEmptyRow(c) !== -1) colsWithSpace.push(c);
      }
      if (colsWithSpace.length > 0) {
        const pick = colsWithSpace[Math.floor(Math.random() * colsWithSpace.length)];
        this.makeMove(pick);
      }
    }

    checkWin(r, c) {
      const color = this.board[r][c];
      if (!color) return false;

      const dirs = [
        [0, 1],
        [1, 0],
        [1, 1],
        [1, -1]
      ];

      for (let [dr, dc] of dirs) {
        let count = 1;
        let nr = r + dr, nc = c + dc;
        while (nr >= 0 && nr < this.rows && nc >= 0 && nc < this.cols && this.board[nr][nc] === color) {
          count++;
          nr += dr;
          nc += dc;
        }
        nr = r - dr; nc = c - dc;
        while (nr >= 0 && nr < this.rows && nc >= 0 && nc < this.cols && this.board[nr][nc] === color) {
          count++;
          nr -= dr;
          nc -= dc;
        }

        if (count >= 4) return true;
      }
      return false;
    }

    endGame(result) {
      this.running = false;
      const statusEl = this.container.querySelector('#c4TurnMsg');
      if (statusEl) {
        if (result === 'draw') {
          statusEl.textContent = "🤝 Draw!";
          this.onDraw();
        } else {
          const winnerName = result === 'R' ? 'Red' : 'Yellow';
          statusEl.textContent = `🎉 ${winnerName} Wins!`;
          this.scores[result]++;
          const scoreEl = this.container.querySelector('#c4ScoreMsg');
          if (scoreEl) {
            scoreEl.textContent = `Red: ${this.scores.R} | Yellow: ${this.scores.Y}`;
          }
          this.onWin(result);
        }
      }

      const wrap = this.container.querySelector('.c4-wrap');
      if (wrap) {
        const btnBox = document.createElement('div');
        btnBox.style.marginTop = '15px';
        btnBox.style.textAlign = 'center';

        if (this.mode !== 'peer') {
          btnBox.innerHTML = `<button class="flux-zen-compact-btn" id="c4RestartBtn">Play Again</button>`;
          wrap.appendChild(btnBox);
          const rstBtn = this.container.querySelector('#c4RestartBtn');
          if (rstBtn) {
            rstBtn.onclick = () => {
              this.init(this.mode, this.myRole);
            };
          }
        } else {
          if (this.myRole === 'R') {
            btnBox.innerHTML = `<button class="flux-zen-compact-btn" id="c4RestartBtn">Restart Match</button>`;
          } else {
            btnBox.innerHTML = `<span style="font-size:12px;color:var(--text-muted);">Waiting for host...</span>`;
          }
          wrap.appendChild(btnBox);
          const rstBtn = this.container.querySelector('#c4RestartBtn');
          if (rstBtn) {
            rstBtn.onclick = () => {
              this.sendMsg({ action: 'reset', game: 'connect4' });
              this.init(this.mode, this.myRole);
            };
          }
        }
      }
    }

    stop() {
      this.running = false;
      this.container.innerHTML = '';
    }
  }

  // ──── PONG GAME ────
  class PongGame {
    constructor(container, options = {}) {
      this.container = container;
      this.onWin = options.onWin || (() => {});
      this.sendMsg = options.sendMsg || (() => {});
      
      this.canvas = null;
      this.ctx = null;
      this.running = false;
      this.loopId = null;
      this.mode = 'ai';
      this.myRole = null;

      this.score = { p1: 0, p2: 0 };
      this.p1 = { y: 80, height: 40, width: 8 };
      this.p2 = { y: 80, height: 40, width: 8 };
      this.ball = { x: 160, y: 100, vx: 2, vy: 1.5, radius: 4 };
      this.width = 320;
      this.height = 200;

      this.keys = {};
      this._keydownHandler = null;
      this._keyupHandler = null;
      this.p2pInterval = null;
    }

    init(mode = 'ai', myRole = null) {
      this.mode = mode;
      this.myRole = myRole;
      this.score = { p1: 0, p2: 0 };
      this.resetBall();
      this.p1.y = 80;
      this.p2.y = 80;
      this.running = true;

      this.container.innerHTML = `
        <div class="pong-wrap" style="position:relative;">
          <div class="pong-status-bar" style="display:flex; justify-content:space-between; margin-bottom:10px; font-size:12px; color:var(--text-muted); font-family:var(--font-mono);">
            <span>Score: <span id="pongP1Score">0</span> - <span id="pongP2Score">0</span></span>
            <span id="pongP2PStatus"></span>
          </div>
          <canvas class="pong-canvas" id="pongCanvas" width="320" height="200" style="background:#16211C; border:1px solid var(--line); display:block; margin:0 auto; max-width:100%; border-radius:6px;"></canvas>
          <div class="pong-controls" style="margin-top:10px; display:flex; gap:10px; justify-content:center;">
            <button class="flux-zen-compact-btn" id="pongUpBtn" style="font-size:12px;">▲ Up</button>
            <button class="flux-zen-compact-btn" id="pongDownBtn" style="font-size:12px;">▼ Down</button>
          </div>
        </div>
      `;

      this.canvas = this.container.querySelector('#pongCanvas');
      this.ctx = this.canvas.getContext('2d');

      this.bindEvents();

      if (this.mode === 'peer') {
        const label = this.container.querySelector('#pongP2PStatus');
        if (label) {
          label.textContent = this.myRole === 'R' ? '🔴 Left Side' : '🟡 Right Side';
        }
        if (this.myRole === 'R') {
          this.p2pInterval = setInterval(() => {
            if (this.running) {
              this.sendMsg({
                action: 'move',
                game: 'pong',
                data: {
                  ballX: this.ball.x,
                  ballY: this.ball.y,
                  p1Y: this.p1.y,
                  score1: this.score.p1,
                  score2: this.score.p2
                }
              });
            }
          }, 33);
        }
      }

      this.gameLoop();
    }

    resetBall() {
      this.ball.x = this.width / 2;
      this.ball.y = this.height / 2;
      this.ball.vx = (Math.random() > 0.5 ? 2.2 : -2.2);
      this.ball.vy = (Math.random() > 0.5 ? 1.5 : -1.5);
    }

    bindEvents() {
      this.unbindEvents();
      this.keys = {};
      this._keydownHandler = (e) => {
        if (['ArrowUp', 'ArrowDown', 'KeyW', 'KeyS', 'Space'].includes(e.code)) {
          e.preventDefault();
        }
        if (e.code === 'KeyW' || e.code === 'ArrowUp') this.keys.up = true;
        if (e.code === 'KeyS' || e.code === 'ArrowDown') this.keys.down = true;

        if (this.mode === 'local') {
          if (e.code === 'KeyW') this.keys.p1up = true;
          if (e.code === 'KeyS') this.keys.p1down = true;
          if (e.code === 'ArrowUp') this.keys.p2up = true;
          if (e.code === 'ArrowDown') this.keys.p2down = true;
        }
      };
      this._keyupHandler = (e) => {
        if (['ArrowUp', 'ArrowDown', 'KeyW', 'KeyS', 'Space'].includes(e.code)) {
          e.preventDefault();
        }
        if (e.code === 'KeyW' || e.code === 'ArrowUp') this.keys.up = false;
        if (e.code === 'KeyS' || e.code === 'ArrowDown') this.keys.down = false;

        if (this.mode === 'local') {
          if (e.code === 'KeyW') this.keys.p1up = false;
          if (e.code === 'KeyS') this.keys.p1down = false;
          if (e.code === 'ArrowUp') this.keys.p2up = false;
          if (e.code === 'ArrowDown') this.keys.p2down = false;
        }
      };
      window.addEventListener('keydown', this._keydownHandler);
      window.addEventListener('keyup', this._keyupHandler);

      const wireTouch = (id, direction) => {
        const btn = this.container.querySelector('#' + id);
        if (btn) {
          const start = (e) => { e.preventDefault(); this.keys[direction] = true; };
          const end = (e) => { e.preventDefault(); this.keys[direction] = false; };
          btn.addEventListener('touchstart', start, { passive: false });
          btn.addEventListener('touchend', end, { passive: false });
          btn.addEventListener('mousedown', start);
          btn.addEventListener('mouseup', end);
          btn.addEventListener('mouseleave', end);
          btn.addEventListener('click', (e) => e.preventDefault());
        }
      };
      wireTouch('pongUpBtn', 'up');
      wireTouch('pongDownBtn', 'down');
    }

    unbindEvents() {
      if (this._keydownHandler) window.removeEventListener('keydown', this._keydownHandler);
      if (this._keyupHandler) window.removeEventListener('keyup', this._keyupHandler);
      if (this.p2pInterval) clearInterval(this.p2pInterval);
    }

    gameLoop() {
      if (!this.running) return;
      this.update();
      this.draw();
      this.loopId = requestAnimationFrame(() => this.gameLoop());
    }

    update() {
      const paddleSpeed = 4.5;
      let myPaddle = (this.myRole === 'Y' && this.mode === 'peer') ? this.p2 : this.p1;
      
      if (this.keys.up) myPaddle.y = Math.max(0, myPaddle.y - paddleSpeed);
      if (this.keys.down) myPaddle.y = Math.min(this.height - myPaddle.height, myPaddle.y + paddleSpeed);

      if (this.mode === 'peer' && this.myRole === 'Y') {
        this.sendMsg({
          action: 'move',
          game: 'pong',
          data: { p2Y: this.p2.y }
        });
      }

      if (this.mode !== 'peer' || this.myRole === 'R') {
        if (this.mode === 'ai') {
          const aiSpeed = 2.2;
          const targetY = this.ball.y - this.p2.height / 2;
          if (this.p2.y < targetY) this.p2.y = Math.min(this.height - this.p2.height, this.p2.y + aiSpeed);
          else if (this.p2.y > targetY) this.p2.y = Math.max(0, this.p2.y - aiSpeed);
        }

        if (this.mode === 'local') {
          if (this.keys.p1up) this.p1.y = Math.max(0, this.p1.y - paddleSpeed);
          if (this.keys.p1down) this.p1.y = Math.min(this.height - this.p1.height, this.p1.y + paddleSpeed);
          if (this.keys.p2up) this.p2.y = Math.max(0, this.p2.y - paddleSpeed);
          if (this.keys.p2down) this.p2.y = Math.min(this.height - this.p2.height, this.p2.y + paddleSpeed);
        }

        this.ball.x += this.ball.vx;
        this.ball.y += this.ball.vy;

        if (this.ball.y - this.ball.radius < 0) {
          this.ball.y = this.ball.radius;
          this.ball.vy = -this.ball.vy;
        } else if (this.ball.y + this.ball.radius > this.height) {
          this.ball.y = this.height - this.ball.radius;
          this.ball.vy = -this.ball.vy;
        }

        if (this.ball.x - this.ball.radius < 15 && this.ball.x - this.ball.radius > 5) {
          if (this.ball.y >= this.p1.y && this.ball.y <= this.p1.y + this.p1.height) {
            this.ball.x = 15 + this.ball.radius;
            this.ball.vx = -this.ball.vx * 1.08;
            this.ball.vy += (this.ball.y - (this.p1.y + this.p1.height / 2)) * 0.08;
          }
        }

        if (this.ball.x + this.ball.radius > this.width - 15 && this.ball.x + this.ball.radius < this.width - 5) {
          if (this.ball.y >= this.p2.y && this.ball.y <= this.p2.y + this.p2.height) {
            this.ball.x = this.width - 15 - this.ball.radius;
            this.ball.vx = -this.ball.vx * 1.08;
            this.ball.vy += (this.ball.y - (this.p2.y + this.p2.height / 2)) * 0.08;
          }
        }

        if (this.ball.x < 0) {
          this.score.p2++;
          this.updateScoreUI();
          if (this.score.p2 >= 5) this.endGame('Right');
          else this.resetBall();
        } else if (this.ball.x > this.width) {
          this.score.p1++;
          this.updateScoreUI();
          if (this.score.p1 >= 5) this.endGame('Left');
          else this.resetBall();
        }
      }
    }

    updateScoreUI() {
      const p1S = this.container.querySelector('#pongP1Score');
      const p2S = this.container.querySelector('#pongP2Score');
      if (p1S) p1S.textContent = this.score.p1;
      if (p2S) p2S.textContent = this.score.p2;
    }

    receiveMove(data) {
      if (!this.running || this.mode !== 'peer') return;
      if (this.myRole === 'R') {
        if (data.p2Y !== undefined) this.p2.y = data.p2Y;
      } else {
        if (data.ballX !== undefined) this.ball.x = data.ballX;
        if (data.ballY !== undefined) this.ball.y = data.ballY;
        if (data.p1Y !== undefined) this.p1.y = data.p1Y;
        if (data.score1 !== undefined) this.score.p1 = data.score1;
        if (data.score2 !== undefined) this.score.p2 = data.score2;
        this.updateScoreUI();

        if (this.score.p1 >= 5) this.endGame('Left');
        else if (this.score.p2 >= 5) this.endGame('Right');
      }
    }

    draw() {
      if (!this.canvas || !this.ctx) return;
      this.ctx.clearRect(0, 0, this.width, this.height);

      this.ctx.strokeStyle = 'rgba(111, 168, 160, 0.2)';
      this.ctx.lineWidth = 2;
      this.ctx.setLineDash([4, 4]);
      this.ctx.beginPath();
      this.ctx.moveTo(this.width / 2, 0);
      this.ctx.lineTo(this.width / 2, this.height);
      this.ctx.stroke();
      this.ctx.setLineDash([]);

      this.ctx.fillStyle = '#D9695F';
      this.ctx.fillRect(8, this.p1.y, this.p1.width, this.p1.height);

      this.ctx.fillStyle = '#6FA8A0';
      this.ctx.fillRect(this.width - 16, this.p2.y, this.p2.width, this.p2.height);

      this.ctx.fillStyle = '#E8A33D';
      this.ctx.beginPath();
      this.ctx.arc(this.ball.x, this.ball.y, this.ball.radius, 0, Math.PI * 2);
      this.ctx.fill();
    }

    endGame(winner) {
      this.running = false;
      this.unbindEvents();

      const canvasWrap = this.container.querySelector('.pong-wrap');
      if (canvasWrap) {
        const overlay = document.createElement('div');
        overlay.style.position = 'absolute';
        overlay.style.top = '0';
        overlay.style.left = '0';
        overlay.style.width = '100%';
        overlay.style.height = '100%';
        overlay.style.background = 'rgba(13, 21, 18, 0.93)';
        overlay.style.display = 'flex';
        overlay.style.flexDirection = 'column';
        overlay.style.alignItems = 'center';
        overlay.style.justifyContent = 'center';
        overlay.style.borderRadius = '10px';

        const isMeWinner = (winner === 'Left' && this.myRole === 'R') || (winner === 'Right' && this.myRole === 'Y');
        
        let winText = `${winner} Wins!`;
        if (this.mode === 'peer') {
          winText = isMeWinner ? '🎉 You Won!' : '💀 Opponent Won!';
        }

        overlay.innerHTML = `
          <h4 style="margin-bottom: 10px; color: var(--amber); font-family: var(--font-display);">${winText}</h4>
          <p style="font-size:12px; color: var(--text-muted); margin-bottom: 15px;">Score: ${this.score.p1} - ${this.score.p2}</p>
        `;

        if (this.mode !== 'peer') {
          overlay.innerHTML += `<button class="flux-zen-compact-btn" id="pongRestartBtn">Play Again</button>`;
          canvasWrap.appendChild(overlay);
          const rstBtn = this.container.querySelector('#pongRestartBtn');
          if (rstBtn) {
            rstBtn.onclick = () => {
              this.init(this.mode, this.myRole);
            };
          }
        } else {
          if (this.myRole === 'R') {
            overlay.innerHTML += `<button class="flux-zen-compact-btn" id="pongRestartBtn">Restart Match</button>`;
          } else {
            overlay.innerHTML += `<span style="font-size:12px;color:var(--text-muted);">Waiting for host...</span>`;
          }
          canvasWrap.appendChild(overlay);
          const rstBtn = this.container.querySelector('#pongRestartBtn');
          if (rstBtn) {
            rstBtn.onclick = () => {
              this.sendMsg({ action: 'reset', game: 'pong' });
              this.init(this.mode, this.myRole);
            };
          }
        }
      }
      this.onWin(winner);
    }

    stop() {
      this.running = false;
      this.unbindEvents();
      this.container.innerHTML = '';
    }
  }

  // ──── ROCK PAPER SCISSORS GAME ────
  class RPSGame {
    constructor(container, options = {}) {
      this.container = container;
      this.onWin = options.onWin || (() => {});
      this.sendMsg = options.sendMsg || (() => {});
      
      this.mode = 'ai';
      this.myRole = null;
      this.running = false;
      this.myChoice = null;
      this.peerChoice = null;
      this.scores = { p1: 0, p2: 0 };
    }

    init(mode = 'ai', myRole = null) {
      this.mode = mode;
      this.myRole = myRole;
      this.myChoice = null;
      this.peerChoice = null;
      this.running = true;
      this.render();
    }

    render() {
      this.container.innerHTML = `
        <div class="rps-wrap" style="text-align:center;">
          <div class="rps-status-bar" style="font-size:12px; color:var(--text-muted); font-family:var(--font-mono); margin-bottom:15px;">
            <span>Score: You: ${this.myRole === 'Y' ? this.scores.p2 : this.scores.p1} | Peer: ${this.myRole === 'Y' ? this.scores.p1 : this.scores.p2}</span>
          </div>
          <div class="rps-choices-grid" id="rpsChoicesGrid">
            <h4 style="font-family:var(--font-display); font-size:14px; margin-bottom:10px;">Make your move:</h4>
            <div style="display:flex; gap:12px; justify-content:center; margin-top:10px;">
              <button class="rps-btn" data-choice="rock" style="font-size:32px; width:64px; height:64px; display:flex; align-items:center; justify-content:center; border-radius:10px; border:1px solid var(--line); background:var(--panel-raised); cursor:pointer;">✊</button>
              <button class="rps-btn" data-choice="paper" style="font-size:32px; width:64px; height:64px; display:flex; align-items:center; justify-content:center; border-radius:10px; border:1px solid var(--line); background:var(--panel-raised); cursor:pointer;">✋</button>
              <button class="rps-btn" data-choice="scissors" style="font-size:32px; width:64px; height:64px; display:flex; align-items:center; justify-content:center; border-radius:10px; border:1px solid var(--line); background:var(--panel-raised); cursor:pointer;">✌️</button>
            </div>
          </div>
          <div class="rps-result hidden" id="rpsResult" style="padding: 10px;">
            <h4 id="rpsResultTitle" style="color:var(--amber); font-family:var(--font-display); font-size:16px;"></h4>
            <p id="rpsChoicesText" style="margin: 10px 0; font-size:13px; color:var(--text-muted); font-family:var(--font-mono);"></p>
            <div id="rpsRestartBox" style="margin-top:15px;"></div>
          </div>
        </div>
      `;

      const btns = this.container.querySelectorAll('.rps-btn');
      btns.forEach(btn => {
        btn.onclick = () => {
          const choice = btn.getAttribute('data-choice');
          this.handleChoice(choice);
        };
      });
    }

    handleChoice(choice) {
      if (!this.running) return;
      this.myChoice = choice;
      
      const grid = this.container.querySelector('#rpsChoicesGrid');
      grid.classList.add('hidden');

      const resultBox = this.container.querySelector('#rpsResult');
      resultBox.classList.remove('hidden');
      
      const title = this.container.querySelector('#rpsResultTitle');

      if (this.mode === 'ai' || this.mode === 'local') {
        const aiChoices = ['rock', 'paper', 'scissors'];
        this.peerChoice = aiChoices[Math.floor(Math.random() * 3)];
        this.revealResult();
      } else if (this.mode === 'peer') {
        title.textContent = "⏳ Waiting for opponent...";
        this.sendMsg({
          action: 'move',
          game: 'rps',
          data: { choice: choice }
        });
        if (this.peerChoice) {
          this.revealResult();
        }
      }
    }

    receiveMove(data) {
      if (!this.running || this.mode !== 'peer') return;
      if (data.choice !== undefined) {
        this.peerChoice = data.choice;
        if (this.myChoice) {
          this.revealResult();
        }
      }
    }

    revealResult() {
      this.running = false;
      const title = this.container.querySelector('#rpsResultTitle');
      const text = this.container.querySelector('#rpsChoicesText');
      const rstBox = this.container.querySelector('#rpsRestartBox');

      const emojiMap = { rock: '✊', paper: '✋', scissors: '✌️' };
      const myEmoji = emojiMap[this.myChoice];
      const peerEmoji = emojiMap[this.peerChoice];

      let resultText = '';
      if (this.myChoice === this.peerChoice) {
        resultText = "🤝 Draw!";
      } else if (
        (this.myChoice === 'rock' && this.peerChoice === 'scissors') ||
        (this.myChoice === 'paper' && this.peerChoice === 'rock') ||
        (this.myChoice === 'scissors' && this.peerChoice === 'paper')
      ) {
        resultText = '🎉 You Won!';
        if (this.myRole === 'Y') this.scores.p2++;
        else this.scores.p1++;
      } else {
        resultText = '💀 Opponent Won!';
        if (this.myRole === 'Y') this.scores.p1++;
        else this.scores.p2++;
      }

      title.textContent = resultText;
      text.textContent = `You: ${myEmoji} | Opponent: ${peerEmoji}`;

      if (this.mode !== 'peer') {
        rstBox.innerHTML = `<button class="flux-zen-compact-btn" id="rpsRestartBtn">Play Again</button>`;
        const rstBtn = this.container.querySelector('#rpsRestartBtn');
        if (rstBtn) {
          rstBtn.onclick = () => {
            this.init(this.mode, this.myRole);
          };
        }
      } else {
        if (this.myRole === 'R') {
          rstBox.innerHTML = `<button class="flux-zen-compact-btn" id="rpsRestartBtn">Restart Match</button>`;
        } else {
          rstBox.innerHTML = `<span style="font-size:12px;color:var(--text-muted);">Waiting for host...</span>`;
        }
        const rstBtn = this.container.querySelector('#rpsRestartBtn');
        if (rstBtn) {
          rstBtn.onclick = () => {
            this.sendMsg({ action: 'reset', game: 'rps' });
            this.init(this.mode, this.myRole);
          };
        }
      }
    }

    stop() {
      this.running = false;
      this.container.innerHTML = '';
    }
  }

  // ──── MINESWEEPER GAME ────
  class MinesweeperGame {
    constructor(container, options = {}) {
      this.container = container;
      this.onGameOver = options.onGameOver || (() => {});
      this.onWin = options.onWin || (() => {});
      
      this.rows = 9;
      this.cols = 9;
      this.minesCount = 10;
      this.grid = [];
      this.running = false;
      this.flagMode = false;
    }

    init() {
      this.grid = Array(this.rows).fill(null).map((_, r) => Array(this.cols).fill(null).map((_, c) => ({
        row: r,
        col: c,
        isMine: false,
        revealed: false,
        flagged: false,
        count: 0
      })));

      this.running = true;
      this.flagMode = false;
      this.placeMines();
      this.calculateCounts();
      this.render();
    }

    placeMines() {
      let minesPlaced = 0;
      while (minesPlaced < this.minesCount) {
        const r = Math.floor(Math.random() * this.rows);
        const c = Math.floor(Math.random() * this.cols);
        if (!this.grid[r][c].isMine) {
          this.grid[r][c].isMine = true;
          minesPlaced++;
        }
      }
    }

    calculateCounts() {
      for (let r = 0; r < this.rows; r++) {
        for (let c = 0; c < this.cols; c++) {
          if (this.grid[r][c].isMine) continue;
          let count = 0;
          this.getNeighbors(r, c).forEach(neighbor => {
            if (neighbor.isMine) count++;
          });
          this.grid[r][c].count = count;
        }
      }
    }

    getNeighbors(r, c) {
      const neighbors = [];
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = r + dr, nc = c + dc;
          if (nr >= 0 && nr < this.rows && nc >= 0 && nc < this.cols) {
            neighbors.push(this.grid[nr][nc]);
          }
        }
      }
      return neighbors;
    }

    render() {
      this.container.innerHTML = `
        <div class="ms-wrap">
          <div class="ms-header" style="display:flex; justify-content:space-between; width:100%; margin-bottom:12px; font-size:12px; color:var(--text-muted); font-family:var(--font-mono);">
            <span id="msMinesLeft">Mines: ${this.minesCount}</span>
            <button class="flux-zen-compact-btn" id="msFlagModeBtn" style="padding:4px 8px; font-size:11px;">
              ${this.flagMode ? '🚩 Flag' : '⛏️ Dig'}
            </button>
          </div>
          <div class="ms-grid" style="display:grid; grid-template-columns: repeat(${this.cols}, 1fr); gap:4px; max-width:240px; margin:0 auto;">
            ${this.grid.map((row) => row.map((cell) => {
              let cellClass = 'ms-cell';
              let content = '';
              let inlineStyle = 'aspect-ratio:1; padding:0; display:flex; align-items:center; justify-content:center; font-family:var(--font-mono); font-size:11px; font-weight:700; cursor:pointer; border-radius:3px; border:1px solid var(--line);';
              
              if (cell.revealed) {
                inlineStyle += ' background:var(--bg); color:var(--text);';
                if (cell.isMine) {
                  content = '💣';
                } else if (cell.count > 0) {
                  content = cell.count;
                  const colors = ['', 'var(--sage)', '#E8A33D', '#D9695F', '#8C6A2E', '#3E5C57', '#D9695F', 'white', 'white'];
                  inlineStyle += ` color: ${colors[cell.count]};`;
                }
              } else {
                inlineStyle += ' background:var(--panel); color:var(--text-muted);';
                if (cell.flagged) {
                  content = '🚩';
                }
              }
              return `<button class="${cellClass}" data-row="${cell.row}" data-col="${cell.col}" style="${inlineStyle}">${content}</button>`;
            }).join('')).join('')}
          </div>
        </div>
      `;

      const cells = this.container.querySelectorAll('.ms-cell');
      cells.forEach(c => {
        const row = parseInt(c.getAttribute('data-row'));
        const col = parseInt(c.getAttribute('data-col'));
        
        c.onclick = (e) => {
          e.preventDefault();
          this.handleCellInteraction(row, col, this.flagMode ? 'flag' : 'reveal');
        };

        c.oncontextmenu = (e) => {
          e.preventDefault();
          this.handleCellInteraction(row, col, 'flag');
        };
      });

      const flagModeBtn = this.container.querySelector('#msFlagModeBtn');
      if (flagModeBtn) {
        flagModeBtn.onclick = () => {
          this.flagMode = !this.flagMode;
          this.render();
        };
      }
    }

    handleCellInteraction(r, c, type) {
      if (!this.running) return;
      const cell = this.grid[r][c];
      if (cell.revealed) return;

      if (type === 'flag') {
        cell.flagged = !cell.flagged;
        this.render();
        this.updateFlagCount();
        return;
      }

      if (cell.flagged) return;

      if (cell.isMine) {
        this.gameOver(false);
        return;
      }

      this.revealCell(r, c);
      this.render();

      if (this.checkWin()) {
        this.gameOver(true);
      }
    }

    updateFlagCount() {
      const flaggedCount = this.grid.reduce((acc, row) => acc + row.filter(cell => cell.flagged).length, 0);
      const label = this.container.querySelector('#msMinesLeft');
      if (label) {
        label.textContent = `Mines: ${Math.max(0, this.minesCount - flaggedCount)}`;
      }
    }

    revealCell(r, c) {
      const cell = this.grid[r][c];
      if (cell.revealed || cell.flagged) return;
      cell.revealed = true;

      if (cell.count === 0 && !cell.isMine) {
        this.getNeighbors(r, c).forEach(neighbor => {
          this.revealCell(neighbor.row, neighbor.col);
        });
      }
    }

    checkWin() {
      for (let r = 0; r < this.rows; r++) {
        for (let c = 0; c < this.cols; c++) {
          const cell = this.grid[r][c];
          if (!cell.isMine && !cell.revealed) return false;
        }
      }
      return true;
    }

    gameOver(won) {
      this.running = false;
      
      for (let r = 0; r < this.rows; r++) {
        for (let c = 0; c < this.cols; c++) {
          if (this.grid[r][c].isMine) this.grid[r][c].revealed = true;
        }
      }
      this.render();

      const wrap = this.container.querySelector('.ms-wrap');
      if (wrap) {
        const overlay = document.createElement('div');
        overlay.style.marginTop = '15px';
        overlay.style.textAlign = 'center';
        overlay.innerHTML = `
          <h4 style="color: ${won ? 'var(--sage)' : 'var(--error)'}; margin-bottom:10px; font-family:var(--font-display); font-size:13px;">
            ${won ? '🎉 Cleared! You Win!' : '💥 BOOM! Game Over.'}
          </h4>
          <button class="flux-zen-compact-btn" id="msRestartBtn">Play Again</button>
        `;
        wrap.appendChild(overlay);
        const rstBtn = this.container.querySelector('#msRestartBtn');
        if (rstBtn) {
          rstBtn.onclick = () => {
            this.init();
          };
        }

        if (won) this.onWin();
        else this.onGameOver();
      }
    }

    stop() {
      this.running = false;
      if (this.container) this.container.innerHTML = '';
    }
  }

  class Game2048 {
    constructor() {
      this.grid = [];
      this.score = 0;
      this.running = false;
      this.container = null;
      this.onWin = () => {};
      this.onGameOver = () => {};
    }

    init(container, callbacks = {}) {
      this.container = container;
      this.onWin = callbacks.onWin || (() => {});
      this.onGameOver = callbacks.onGameOver || (() => {});
      this.grid = Array(4).fill(null).map(() => Array(4).fill(0));
      this.score = 0;
      this.running = true;

      this.spawnTile();
      this.spawnTile();
      this.render();
      this.bindControls();
    }

    spawnTile() {
      const empty = [];
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
          if (this.grid[r][c] === 0) empty.push({ r, c });
        }
      }
      if (empty.length > 0) {
        const { r, c } = empty[Math.floor(Math.random() * empty.length)];
        this.grid[r][c] = Math.random() < 0.9 ? 2 : 4;
      }
    }

    bindControls() {
      this.handleKeyDown = (e) => {
        if (!this.running) return;
        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) {
          e.preventDefault();
        }
        let moved = false;
        if (e.key === 'ArrowUp' || e.key === 'w') { moved = this.moveUp(); }
        else if (e.key === 'ArrowDown' || e.key === 's') { moved = this.moveDown(); }
        else if (e.key === 'ArrowLeft' || e.key === 'a') { moved = this.moveLeft(); }
        else if (e.key === 'ArrowRight' || e.key === 'd') { moved = this.moveRight(); }
        if (moved) {
          this.spawnTile();
          this.render();
          this.checkState();
        }
      };
      window.addEventListener('keydown', this.handleKeyDown);
    }

    moveLeft() {
      let moved = false;
      for (let r = 0; r < 4; r++) {
        let row = this.grid[r].filter(val => val !== 0);
        for (let c = 0; c < row.length - 1; c++) {
          if (row[c] === row[c + 1]) {
            row[c] *= 2;
            this.score += row[c];
            row.splice(c + 1, 1);
            moved = true;
          }
        }
        while (row.length < 4) row.push(0);
        if (JSON.stringify(this.grid[r]) !== JSON.stringify(row)) moved = true;
        this.grid[r] = row;
      }
      return moved;
    }

    moveRight() {
      let moved = false;
      for (let r = 0; r < 4; r++) {
        let row = this.grid[r].filter(val => val !== 0);
        for (let c = row.length - 1; c > 0; c--) {
          if (row[c] === row[c - 1]) {
            row[c] *= 2;
            this.score += row[c];
            row.splice(c - 1, 1);
            moved = true;
          }
        }
        while (row.length < 4) row.unshift(0);
        if (JSON.stringify(this.grid[r]) !== JSON.stringify(row)) moved = true;
        this.grid[r] = row;
      }
      return moved;
    }

    moveUp() {
      let moved = false;
      for (let c = 0; c < 4; c++) {
        let col = [this.grid[0][c], this.grid[1][c], this.grid[2][c], this.grid[3][c]].filter(v => v !== 0);
        for (let r = 0; r < col.length - 1; r++) {
          if (col[r] === col[r + 1]) {
            col[r] *= 2;
            this.score += col[r];
            col.splice(r + 1, 1);
            moved = true;
          }
        }
        while (col.length < 4) col.push(0);
        for (let r = 0; r < 4; r++) {
          if (this.grid[r][c] !== col[r]) moved = true;
          this.grid[r][c] = col[r];
        }
      }
      return moved;
    }

    moveDown() {
      let moved = false;
      for (let c = 0; c < 4; c++) {
        let col = [this.grid[0][c], this.grid[1][c], this.grid[2][c], this.grid[3][c]].filter(v => v !== 0);
        for (let r = col.length - 1; r > 0; r--) {
          if (col[r] === col[r - 1]) {
            col[r] *= 2;
            this.score += col[r];
            col.splice(r - 1, 1);
            moved = true;
          }
        }
        while (col.length < 4) col.unshift(0);
        for (let r = 0; r < 4; r++) {
          if (this.grid[r][c] !== col[r]) moved = true;
          this.grid[r][c] = col[r];
        }
      }
      return moved;
    }

    checkState() {
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
          if (this.grid[r][c] === 2048) { this.onWin(); }
          if (this.grid[r][c] === 0) return;
          if (r < 3 && this.grid[r][c] === this.grid[r + 1][c]) return;
          if (c < 3 && this.grid[r][c] === this.grid[r][c + 1]) return;
        }
      }
      this.running = false;
      this.onGameOver();
    }

    render() {
      if (!this.container) return;
      this.container.innerHTML = `
        <div class="zen-game-container">
          <div class="zen-game-header">
            <span class="font-mono text-primary font-bold">2048</span>
            <span class="font-mono text-on-surface">Score: ${this.score}</span>
          </div>
          <div class="grid grid-cols-4 gap-2 bg-surface-card p-3 rounded-xl border border-glass-border w-64 h-64">
            ${this.grid.map(row => row.map(val => `
              <div class="flex items-center justify-center rounded-lg font-mono font-bold text-sm ${
                val === 0 ? 'bg-surface/40 text-transparent' :
                val === 2 ? 'bg-primary/20 text-primary' :
                val === 4 ? 'bg-primary/30 text-primary' :
                val === 8 ? 'bg-accent-gold/30 text-accent-gold' :
                val === 16 ? 'bg-accent-gold/50 text-accent-gold' :
                'bg-primary text-background'
              }">
                ${val || ''}
              </div>
            `).join('')).join('')}
          </div>
          <!-- Touch Controls (Stitch D-Pad) -->
          <div class="mt-6 w-full flex justify-center">
            <div class="grid grid-cols-3 grid-rows-3 gap-2 w-44 h-44">
              <div></div>
              <button onclick="window.FluxZenGame2048?.moveUp(); window.FluxZenGame2048?.render();" class="d-pad-btn bg-surface-card border border-glass-border rounded-t-xl rounded-b-md flex items-center justify-center text-on-surface-variant hover:text-primary active:scale-95 transition-all">
                <span class="material-symbols-outlined text-2xl">keyboard_arrow_up</span>
              </button>
              <div></div>
              <button onclick="window.FluxZenGame2048?.moveLeft(); window.FluxZenGame2048?.render();" class="d-pad-btn bg-surface-card border border-glass-border rounded-l-xl rounded-r-md flex items-center justify-center text-on-surface-variant hover:text-primary active:scale-95 transition-all">
                <span class="material-symbols-outlined text-2xl">keyboard_arrow_left</span>
              </button>
              <div class="bg-surface-container-lowest rounded-md flex items-center justify-center border border-glass-border">
                <div class="w-2.5 h-2.5 rounded-full bg-primary/30"></div>
              </div>
              <button onclick="window.FluxZenGame2048?.moveRight(); window.FluxZenGame2048?.render();" class="d-pad-btn bg-surface-card border border-glass-border rounded-r-xl rounded-l-md flex items-center justify-center text-on-surface-variant hover:text-primary active:scale-95 transition-all">
                <span class="material-symbols-outlined text-2xl">keyboard_arrow_right</span>
              </button>
              <div></div>
              <button onclick="window.FluxZenGame2048?.moveDown(); window.FluxZenGame2048?.render();" class="d-pad-btn bg-surface-card border border-glass-border rounded-b-xl rounded-t-md flex items-center justify-center text-on-surface-variant hover:text-primary active:scale-95 transition-all">
                <span class="material-symbols-outlined text-2xl">keyboard_arrow_down</span>
              </button>
              <div></div>
            </div>
          </div>
        </div>
      `;
      window.FluxZenGame2048 = this;
    }

    stop() {
      this.running = false;
      if (this.handleKeyDown) window.removeEventListener('keydown', this.handleKeyDown);
      if (this.container) this.container.innerHTML = '';
    }
  }

  window.FluxZenGames = { 
    SnakeGame, 
    MemoryMatchGame, 
    TicTacToeGame, 
    ConnectFourGame, 
    PongGame, 
    RPSGame, 
    MinesweeperGame,
    Game2048
  };
})(window);
