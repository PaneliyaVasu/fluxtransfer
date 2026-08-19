// Flux Zen Core Orchestrator
(function (window) {
  'use strict';

  // Config defaults
  window.FLUX_ZEN_CONFIG = {
    enabled: true,
    minEta: 20,
    fullEta: 60
  };

  const STATE = {
    status: 'full', // Always full by default for permanent 2-panel split UI
    activeMode: null,  // 'play' | 'discover' | 'zen'
    selectedGame: null,
    gameStateMode: 'menu', // 'menu' | 'mode_select' | 'invite_pending' | 'playing'
    gameMode: null, // 'ai' | 'local' | 'peer'
    
    // Game instances
    snakeInstance: null,
    memoryInstance: null,
    gameInstance: null,
    
    // Fact state
    currentFact: null,
    
    // Visual instance
    breathingInstance: null,
    
    // Dismissal states
    userAction: null,
    lastEta: Infinity,

    // Game play toast & transfer completion states
    gamePlayPopupShown: false,
    transferComplete: false
  };

  class FluxZenOrchestrator {
    constructor() {
      this.container = null;
      this.initialized = false;
    }

    initDOM() {
      if (this.initialized) return;

      // Create main container if it doesn't exist
      let container = document.getElementById('flux-zen-container');
      if (!container) {
        container = document.createElement('div');
        container.id = 'flux-zen-container';
        const contentArea = document.querySelector('.content-area');
        if (contentArea) {
          contentArea.appendChild(container);
        } else {
          document.body.appendChild(container);
        }
      }
      this.container = container;
      this.initialized = true;
      STATE.status = 'full';
    }

    showGamePlayPopup() {
      if (STATE.gamePlayPopupShown) return;
      STATE.gamePlayPopupShown = true;

      if (document.getElementById('flux-zen-gameplay-popup')) return;

      const popup = document.createElement('div');
      popup.id = 'flux-zen-gameplay-popup';
      popup.className = 'flux-zen-gameplay-popup';
      popup.innerHTML = `
        <div class="zen-gameplay-header">
          <div class="zen-gameplay-title">🎮 Play Games While You Wait!</div>
          <button class="zen-gameplay-close" id="zenGameplayCloseBtn" title="Dismiss">✖</button>
        </div>
        <div class="zen-gameplay-desc">
          File transfer started! Enjoy Tic-Tac-Toe, Connect 4, Pong, or Minesweeper on the right.
        </div>
        <button class="zen-gameplay-btn" id="zenGameplayPlayBtn">Let's Play! 🎮</button>
      `;
      document.body.appendChild(popup);

      const close = () => this.closeGamePlayPopup();
      document.getElementById('zenGameplayCloseBtn').onclick = close;
      document.getElementById('zenGameplayPlayBtn').onclick = close;

      setTimeout(() => {
        this.closeGamePlayPopup();
      }, 5000);
    }

    closeGamePlayPopup() {
      const popup = document.getElementById('flux-zen-gameplay-popup');
      if (popup) {
        popup.classList.add('closing');
        setTimeout(() => {
          if (popup.parentNode) popup.parentNode.removeChild(popup);
        }, 250);
      }
    }

    reset() {
      try {
        this.stopActiveMode();
        
        STATE.status = 'full';
        STATE.activeMode = null;
        STATE.selectedGame = null;
        STATE.gameStateMode = 'menu';
        STATE.gameMode = null;
        STATE.userAction = null;
        STATE.lastEta = Infinity;
        STATE.gamePlayPopupShown = false;
        STATE.transferComplete = false;

        this.p2pListenersBound = false;
        this.closeGamePlayPopup();
        const invite = document.getElementById('flux-zen-invite-popup');
        if (invite && invite.parentNode) invite.parentNode.removeChild(invite);

        if (this.container) {
          this.render();
        }
      } catch (e) {
        console.error('Flux Zen reset error:', e);
      }
    }

    updateProgress(etaSeconds, progressData) {
      if (!window.FLUX_ZEN_CONFIG.enabled) return;

      try {
        this.initDOM();

        const eta = (typeof etaSeconds === 'number' && isFinite(etaSeconds)) ? etaSeconds : Infinity;
        STATE.lastEta = eta;

        // Show game play toast popup on transfer start
        this.showGamePlayPopup();

        STATE.status = 'full';
        this.updateEtaText(eta);
      } catch (error) {
        console.error('Flux Zen error during progress update (shielded):', error);
      }
    }

    moveContainerToActivePanel() {
      // When in full mode, place the container inside .content-area
      // for the side-by-side split-screen layout
      if (STATE.status === 'full') {
        const contentArea = document.querySelector('.content-area');
        if (contentArea && this.container.parentElement !== contentArea) {
          contentArea.appendChild(this.container);
        }
        return;
      }

      // Otherwise place it inside the active transfer panel (inline)
      const sendProgress = document.getElementById('sendProgressWrap');
      const recvProgress = document.getElementById('recvProgressWrap');
      let targetParent = null;

      if (sendProgress && !sendProgress.classList.contains('hidden')) {
        targetParent = document.getElementById('sendPanel');
      } else if (recvProgress && !recvProgress.classList.contains('hidden')) {
        targetParent = document.getElementById('receivePanel');
      }

      if (targetParent && this.container.parentElement !== targetParent) {
        targetParent.appendChild(this.container);
      }
    }

    applySplitLayoutClasses() {
      const wrap = document.querySelector('.wrap');
      const contentArea = document.querySelector('.content-area');
      if (wrap) wrap.classList.add('zen-active');
      if (contentArea) contentArea.classList.add('zen-active-layout');
    }

    removeSplitLayoutClasses() {
      const wrap = document.querySelector('.wrap');
      const contentArea = document.querySelector('.content-area');
      if (wrap) wrap.classList.remove('zen-active');
      if (contentArea) contentArea.classList.remove('zen-active-layout');
    }

    updateEtaText(eta) {
      const etaEl = document.getElementById('zenEtaDisplay');
      if (etaEl) {
        if (!isFinite(eta) || eta < 0) {
          etaEl.textContent = '--';
        } else if (eta < 60) {
          etaEl.textContent = Math.ceil(eta) + 's';
        } else {
          etaEl.textContent = Math.floor(eta / 60) + 'm ' + Math.ceil(eta % 60) + 's';
        }
      }
    }

    render() {
      if (!this.container) return;

      this.container.className = '';

      if (STATE.status === 'hidden' || STATE.status === 'dismissed') {
        this.container.innerHTML = '';
        this.container.className = 'hidden';
        this.stopActiveMode();
        this.removeSplitLayoutClasses();
        return;
      }

      if (STATE.status === 'compact') {
        this.stopActiveMode();
        this.removeSplitLayoutClasses();
        this.container.innerHTML = `
          <div class="flux-zen-compact" id="zenCompactBanner">
            <span><span class="zen-sparkle">✨</span>While you wait, would you like to relax?</span>
            <button class="flux-zen-compact-btn" id="zenOpenBtn">Open Flux Zen</button>
          </div>
        `;
        document.getElementById('zenOpenBtn').onclick = () => {
          STATE.userAction = 'opened';
          STATE.status = 'full';
          this.render();
        };
        return;
      }

      if (STATE.status === 'minimized') {
        this.stopActiveMode();
        this.removeSplitLayoutClasses();
        this.container.innerHTML = `
          <div class="flux-zen-reopen-bar" id="zenReopenBar">
            <span>✨ Flux Zen is minimized (transfer continues in background)</span>
            <button class="flux-zen-compact-btn" style="padding: 3px 8px; font-size: 11px;" id="zenRestoreBtn">Restore</button>
          </div>
        `;
        document.getElementById('zenRestoreBtn').onclick = () => {
          STATE.userAction = 'opened';
          STATE.status = 'full';
          this.render();
        };
        return;
      }

      if (STATE.status === 'full') {
        this.applySplitLayoutClasses();
        this.moveContainerToActivePanel();
        this.renderFullPanel();
      }
    }

    renderFullPanel() {
      const subtitleText = STATE.transferComplete 
        ? `Transfer complete! 🎉 Feel free to finish your game or activity.`
        : `Your transfer is continuing in the background. <span id="zenEtaDisplay">--</span> remaining`;

      this.container.innerHTML = `
        <div class="flux-zen-panel" id="zenFullPanel">
          <div class="zen-header">
            <div class="zen-title"><span class="sparkle">✨</span> Flux Zen</div>
            <div class="zen-actions">
              <button class="zen-action-btn" id="zenMinimizeBtn" title="Minimize">➖</button>
              <button class="zen-action-btn" id="zenCloseBtn" title="Close">✖</button>
            </div>
          </div>
          <div class="zen-subtitle" id="zenSubtitle">${subtitleText}</div>
          <div class="zen-modes-tabs">
            <div class="zen-mode-tab" id="zenTabPlay" data-mode="play">🎮 Play</div>
            <div class="zen-mode-tab" id="zenTabDiscover" data-mode="discover">🧠 Discover</div>
            <div class="zen-mode-tab" id="zenTabZen" data-mode="zen">🧘 Zen</div>
          </div>
          <div class="zen-mode-content" id="zenModeContent"></div>
        </div>
      `;

      if (!STATE.transferComplete) {
        this.updateEtaText(STATE.lastEta);
      }

      // Wire header buttons
      document.getElementById('zenMinimizeBtn').onclick = () => {
        this.stopActiveMode();
        STATE.activeMode = null;
        STATE.gameStateMode = 'menu';
        this.render();
      };
      document.getElementById('zenCloseBtn').onclick = () => {
        this.stopActiveMode();
        STATE.activeMode = null;
        STATE.gameStateMode = 'menu';
        this.render();
      };

      // Wire tabs
      const tabs = ['zenTabPlay', 'zenTabDiscover', 'zenTabZen'];
      tabs.forEach(tabId => {
        const tabEl = document.getElementById(tabId);
        if (tabEl) {
          tabEl.onclick = () => {
            const mode = tabEl.getAttribute('data-mode');
            this.switchMode(mode);
          };
        }
      });

      // Set default mode if not set
      if (!STATE.activeMode) {
        STATE.activeMode = 'play';
      }
      this.switchMode(STATE.activeMode);
    }

    onTransferComplete() {
      try {
        if (STATE.status === 'full') {
          STATE.transferComplete = true;
          this.renderFullPanel();
        } else {
          this.reset();
        }
      } catch (err) {
        console.error('Flux Zen error during transfer complete (shielded):', err);
      }
    }

    switchMode(mode) {
      try {
        this.stopActiveMode();
        STATE.activeMode = mode;

        // Update active class on tabs
        const modes = ['play', 'discover', 'zen'];
        modes.forEach(m => {
          const tabEl = document.getElementById('zenTab' + m.charAt(0).toUpperCase() + m.slice(1));
          if (tabEl) {
            tabEl.classList.toggle('active', m === mode);
          }
        });

        const contentArea = document.getElementById('zenModeContent');
        if (!contentArea) return;

        if (mode === 'play') {
          this.renderPlayMode(contentArea);
        } else if (mode === 'discover') {
          this.renderDiscoverMode(contentArea);
        } else if (mode === 'zen') {
          this.renderZenMode(contentArea);
        }
      } catch (err) {
        console.error('Error switching Flux Zen modes (shielded):', err);
      }
    }

    stopActiveMode() {
      try {
        // Stop Snake
        if (STATE.snakeInstance) {
          STATE.snakeInstance.stop();
          STATE.snakeInstance = null;
        }
        // Stop Memory Match
        if (STATE.memoryInstance) {
          STATE.memoryInstance.stop();
          STATE.memoryInstance = null;
        }
        // Stop general active game instance
        if (STATE.gameInstance) {
          STATE.gameInstance.stop();
          STATE.gameInstance = null;
        }
        // Stop Breathing visual
        if (STATE.breathingInstance) {
          STATE.breathingInstance.stop();
          STATE.breathingInstance = null;
        }
      } catch (e) {
        console.error('Error stopping active mode (shielded):', e);
      }
    }

    // ──── PLAY MODE ────
    renderPlayMode(container) {
      this.bindP2PListeners();

      if (STATE.selectedGame) {
        const multiplayerGames = ['tictactoe', 'connect4', 'pong', 'rps'];
        if (multiplayerGames.includes(STATE.selectedGame)) {
          if (STATE.gameStateMode === 'playing') {
            // Handled inside individual game render methods
          } else if (STATE.gameStateMode === 'invite_pending') {
            container.innerHTML = `
              <div class="zen-game-container" style="text-align:center; padding:30px 10px;">
                <h4 style="color:var(--amber); margin-bottom:10px;">Inviting peer...</h4>
                <p style="font-size:12px; color:var(--text-muted); margin-bottom:20px;">Waiting for opponent to accept.</p>
                <button class="flux-zen-compact-btn" id="cancelInviteBtn">Cancel</button>
              </div>
            `;
            document.getElementById('cancelInviteBtn').onclick = () => {
              this.sendGameMessage({ action: 'decline', game: STATE.selectedGame });
              STATE.gameStateMode = 'mode_select';
              this.renderModeSelect(container, STATE.selectedGame);
            };
          } else {
            STATE.gameStateMode = 'mode_select';
            this.renderModeSelect(container, STATE.selectedGame);
          }
        } else {
          STATE.gameStateMode = 'playing';
          if (STATE.selectedGame === 'snake') {
            this.startSnakeGame(container);
          } else if (STATE.selectedGame === 'memory') {
            this.startMemoryGame(container);
          } else if (STATE.selectedGame === 'minesweeper') {
            this.startMinesweeperGame(container);
          }
        }
      } else {
        STATE.gameStateMode = 'menu';
        container.innerHTML = `
          <div class="zen-game-selector" style="max-height: 250px; overflow-y: auto; padding-right: 4px;">
            <button class="zen-game-btn" id="btnPlaySnake">
              <div>
                <div class="zen-game-btn-title">🐍 Snake</div>
                <div class="zen-game-btn-desc">Classic grid crawler. Arrow keys or touch.</div>
              </div>
              <span>▶</span>
            </button>
            <button class="zen-game-btn" id="btnPlayMemory">
              <div>
                <div class="zen-game-btn-title">🎴 Memory Match</div>
                <div class="zen-game-btn-desc">Match emoji pairs under count.</div>
              </div>
              <span>▶</span>
            </button>
            <button class="zen-game-btn" id="btnPlayMines">
              <div>
                <div class="zen-game-btn-title">💣 Minesweeper</div>
                <div class="zen-game-btn-desc">Uncover cells without hitting mines.</div>
              </div>
              <span>▶</span>
            </button>
            <button class="zen-game-btn" id="btnPlayTTT">
              <div>
                <div class="zen-game-btn-title">❌ Tic Tac Toe</div>
                <div class="zen-game-btn-desc">3-in-a-row. vs AI, Local or vs Peer.</div>
              </div>
              <span>▶</span>
            </button>
            <button class="zen-game-btn" id="btnPlayConnect4">
              <div>
                <div class="zen-game-btn-title">🔴 Connect Four</div>
                <div class="zen-game-btn-desc">Drop discs. 4-in-a-row vs AI/Local/Peer.</div>
              </div>
              <span>▶</span>
            </button>
            <button class="zen-game-btn" id="btnPlayPong">
              <div>
                <div class="zen-game-btn-title">🏓 Ping Pong</div>
                <div class="zen-game-btn-desc">Bounce the ball. vs AI, Local or vs Peer.</div>
              </div>
              <span>▶</span>
            </button>
            <button class="zen-game-btn" id="btnPlayRPS">
              <div>
                <div class="zen-game-btn-title">✊ Rock Paper Scissors</div>
                <div class="zen-game-btn-desc">Standard hand showdown vs AI or Peer.</div>
              </div>
              <span>▶</span>
            </button>
          </div>
        `;

        document.getElementById('btnPlaySnake').onclick = () => {
          STATE.selectedGame = 'snake';
          this.switchMode('play');
        };
        document.getElementById('btnPlayMemory').onclick = () => {
          STATE.selectedGame = 'memory';
          this.switchMode('play');
        };
        document.getElementById('btnPlayMines').onclick = () => {
          STATE.selectedGame = 'minesweeper';
          this.switchMode('play');
        };
        document.getElementById('btnPlayTTT').onclick = () => {
          STATE.selectedGame = 'tictactoe';
          this.switchMode('play');
        };
        document.getElementById('btnPlayConnect4').onclick = () => {
          STATE.selectedGame = 'connect4';
          this.switchMode('play');
        };
        document.getElementById('btnPlayPong').onclick = () => {
          STATE.selectedGame = 'pong';
          this.switchMode('play');
        };
        document.getElementById('btnPlayRPS').onclick = () => {
          STATE.selectedGame = 'rps';
          this.switchMode('play');
        };
      }
    }

    // ──── NEW ORCHESTRATION METHODS ────
    bindP2PListeners() {
      if (this.p2pListenersBound) return;
      const conns = window.peerConnections || [];
      if (!conns.length) return;

      const primaryConn = conns[0];
      const dc = primaryConn._dc || primaryConn.dataChannel;
      if (!dc) return;

      this.p2pListenersBound = true;

      const onMessage = (event) => {
        if (typeof event.data !== 'string') return;
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'zen_game') {
            this.handleGameMessage(msg);
          }
        } catch (e) {}
      };

      dc.addEventListener('message', onMessage);

      primaryConn.on('close', () => {
        this.p2pListenersBound = false;
        this.exitToGameMenu();
      });
    }

    sendGameMessage(data) {
      const conns = window.peerConnections || [];
      if (!conns.length) return;
      const primaryConn = conns[0];
      try {
        primaryConn.send(JSON.stringify({
          type: 'zen_game',
          ...data
        }));
      } catch (err) {
        console.error('Error sending P2P game message:', err);
      }
    }

    handleGameMessage(msg) {
      if (msg.action === 'invite') {
        this.showInvitePopup(msg.game);
      } else if (msg.action === 'accept') {
        if (STATE.selectedGame === msg.game && STATE.gameStateMode === 'invite_pending') {
          const role = (msg.game === 'tictactoe') ? 'X' : 'R';
          this.startNewGame(msg.game, 'peer', role);
        }
      } else if (msg.action === 'decline') {
        if (STATE.selectedGame === msg.game && STATE.gameStateMode === 'invite_pending') {
          STATE.gameStateMode = 'mode_select';
          const container = document.getElementById('zenModeContent');
          if (container) this.renderModeSelect(container, msg.game);
          alert('Invitation declined by peer.');
        }
      } else if (msg.action === 'move') {
        if (STATE.gameInstance && STATE.selectedGame === msg.game && STATE.gameStateMode === 'playing') {
          STATE.gameInstance.receiveMove(msg.data);
        }
      } else if (msg.action === 'reset') {
        if (STATE.gameInstance && STATE.selectedGame === msg.game) {
          const role = (msg.game === 'tictactoe') ? (this.isSender() ? 'X' : 'O') : (this.isSender() ? 'R' : 'Y');
          STATE.gameInstance.init('peer', role);
        }
      } else if (msg.action === 'exit') {
        if (STATE.selectedGame === msg.game && STATE.gameStateMode === 'playing') {
          this.stopActiveMode();
          STATE.selectedGame = null;
          STATE.gameStateMode = 'menu';
          this.switchMode('play');
          alert('Peer left the game.');
        }
      }
    }

    showInvitePopup(gameId) {
      if (document.getElementById('flux-zen-invite-popup')) return;

      const gameNames = {
        tictactoe: 'Tic Tac Toe',
        connect4: 'Connect Four',
        pong: 'Ping Pong',
        rps: 'Rock Paper Scissors'
      };

      const popup = document.createElement('div');
      popup.id = 'flux-zen-invite-popup';
      popup.className = 'flux-zen-notice-popup';
      popup.style.borderColor = 'var(--amber)';
      popup.innerHTML = `
        <div class="zen-notice-header">
          <div class="zen-notice-title" style="color:var(--amber);">🎮 Game Invitation!</div>
          <button class="zen-notice-close" id="zenInviteCloseBtn" title="Decline">✖</button>
        </div>
        <div class="zen-notice-desc">
          Your peer invites you to play a match of <strong>${gameNames[gameId]}</strong>.
        </div>
        <div class="zen-notice-actions">
          <button class="zen-notice-btn primary" id="zenInviteAcceptBtn" style="background:var(--amber); color:var(--bg);">Accept & Play</button>
          <button class="zen-notice-btn secondary" id="zenInviteDeclineBtn">Decline</button>
        </div>
      `;
      document.body.appendChild(popup);

      const closePopup = () => {
        const p = document.getElementById('flux-zen-invite-popup');
        if (p) {
          p.classList.add('closing');
          setTimeout(() => { if (p.parentNode) p.parentNode.removeChild(p); }, 300);
        }
      };

      document.getElementById('zenInviteCloseBtn').onclick = () => {
        this.sendGameMessage({ action: 'decline', game: gameId });
        closePopup();
      };
      document.getElementById('zenInviteDeclineBtn').onclick = () => {
        this.sendGameMessage({ action: 'decline', game: gameId });
        closePopup();
      };

      document.getElementById('zenInviteAcceptBtn').onclick = () => {
        this.sendGameMessage({ action: 'accept', game: gameId });
        closePopup();
        
        STATE.userAction = 'opened';
        STATE.status = 'full';
        STATE.activeMode = 'play';
        STATE.selectedGame = gameId;
        STATE.gameStateMode = 'playing';
        this.render();

        const role = (gameId === 'tictactoe') ? 'O' : 'Y';
        this.startNewGame(gameId, 'peer', role);
      };
      
      setTimeout(() => {
        const p = document.getElementById('flux-zen-invite-popup');
        if (p && !p.classList.contains('closing')) {
          this.sendGameMessage({ action: 'decline', game: gameId });
          closePopup();
        }
      }, 30000);
    }

    renderModeSelect(container, gameId) {
      const gameNames = {
        tictactoe: 'Tic Tac Toe',
        connect4: 'Connect Four',
        pong: 'Ping Pong',
        rps: 'Rock Paper Scissors'
      };

      const conns = window.peerConnections || [];
      const hasPeer = conns.length > 0;

      container.innerHTML = `
        <div class="zen-game-container">
          <div class="zen-game-header" style="display:flex; justify-content:space-between; width:100%; margin-bottom:12px; font-size:12px; color:var(--text-muted); font-family:var(--font-mono);">
            <button class="zen-game-back" id="modeBackBtn">◀ Games</button>
            <span>${gameNames[gameId]}</span>
          </div>
          <div class="zen-mode-selector" style="display:flex; flex-direction:column; gap:12px; width:100%; padding:10px;">
            <button class="zen-game-btn" id="btnPlayAI">🤖 Play vs AI (Offline)</button>
            <button class="zen-game-btn" id="btnPlayLocal">👥 Play Local (Pass & Play)</button>
            <button class="zen-game-btn" id="btnPlayPeer" ${hasPeer ? '' : 'disabled'}>
              <div>
                <div class="zen-game-btn-title">🌐 Play vs Peer</div>
                <div class="zen-game-btn-desc" id="peerDesc">
                  ${hasPeer ? 'Play against the other connected peer' : '⚠️ Connect to a peer to play.'}
                </div>
              </div>
            </button>
          </div>
        </div>
      `;

      document.getElementById('modeBackBtn').onclick = () => {
        STATE.selectedGame = null;
        STATE.gameStateMode = 'menu';
        this.switchMode('play');
      };

      document.getElementById('btnPlayAI').onclick = () => {
        const role = (gameId === 'tictactoe') ? 'X' : 'R';
        this.startNewGame(gameId, 'ai', role);
      };

      document.getElementById('btnPlayLocal').onclick = () => {
        const role = (gameId === 'tictactoe') ? 'X' : 'R';
        this.startNewGame(gameId, 'local', role);
      };

      if (hasPeer) {
        document.getElementById('btnPlayPeer').onclick = () => {
          STATE.gameStateMode = 'invite_pending';
          container.innerHTML = `
            <div class="zen-game-container" style="text-align:center; padding:30px 10px;">
              <h4 style="color:var(--amber); margin-bottom:10px;">Inviting peer...</h4>
              <p style="font-size:12px; color:var(--text-muted); margin-bottom:20px;">Waiting for your peer to accept the invitation.</p>
              <button class="flux-zen-compact-btn" id="cancelInviteBtn">Cancel</button>
            </div>
          `;
          this.sendGameMessage({ action: 'invite', game: gameId });
          
          document.getElementById('cancelInviteBtn').onclick = () => {
            this.sendGameMessage({ action: 'decline', game: gameId });
            STATE.gameStateMode = 'mode_select';
            this.renderModeSelect(container, gameId);
          };
        };
      }
    }

    exitToGameMenu() {
      if (STATE.gameMode === 'peer') {
        this.sendGameMessage({ action: 'exit', game: STATE.selectedGame });
      }
      this.stopActiveMode();
      STATE.selectedGame = null;
      STATE.gameStateMode = 'menu';
      STATE.gameMode = null;
      this.switchMode('play');
    }

    isSender() {
      return window.fluxMode === 'send';
    }

    startNewGame(gameId, mode = 'ai', role = null) {
      const container = document.getElementById('zenModeContent');
      if (!container) return;

      this.stopActiveMode();
      STATE.gameStateMode = 'playing';
      STATE.gameMode = mode;

      if (gameId === 'snake') {
        this.startSnakeGame(container);
      } else if (gameId === 'memory') {
        this.startMemoryGame(container);
      } else if (gameId === 'minesweeper') {
        this.startMinesweeperGame(container);
      } else if (gameId === 'tictactoe') {
        this.startTicTacToeGame(container, mode, role);
      } else if (gameId === 'connect4') {
        this.startConnectFourGame(container, mode, role);
      } else if (gameId === 'pong') {
        this.startPongGame(container, mode, role);
      } else if (gameId === 'rps') {
        this.startRPSGame(container, mode, role);
      }
    }

    startMinesweeperGame(container) {
      container.innerHTML = `
        <div class="zen-game-container">
          <div class="zen-game-header" style="display:flex; justify-content:space-between; width:100%; margin-bottom:12px; font-size:12px; color:var(--text-muted); font-family:var(--font-mono);">
            <button class="zen-game-back" id="msBackBtn">◀ Games</button>
            <span>Minesweeper</span>
          </div>
          <div class="zen-canvas-wrapper" style="background:transparent; border:none; padding:0;" id="msGameArea"></div>
        </div>
      `;

      const area = document.getElementById('msGameArea');
      const game = new window.FluxZenGames.MinesweeperGame(area, {});
      STATE.gameInstance = game;
      game.init();

      document.getElementById('msBackBtn').onclick = () => {
        this.exitToGameMenu();
      };
    }

    startTicTacToeGame(container, mode, role) {
      container.innerHTML = `
        <div class="zen-game-container">
          <div class="zen-game-header" style="display:flex; justify-content:space-between; width:100%; margin-bottom:12px; font-size:12px; color:var(--text-muted); font-family:var(--font-mono);">
            <button class="zen-game-back" id="tttBackBtn">◀ Back</button>
            <span>Tic Tac Toe</span>
          </div>
          <div class="zen-canvas-wrapper" style="background:transparent; border:none;" id="tttGameArea"></div>
        </div>
      `;

      const area = document.getElementById('tttGameArea');
      const game = new window.FluxZenGames.TicTacToeGame(area, {
        sendMsg: (data) => this.sendGameMessage(data)
      });
      STATE.gameInstance = game;
      game.init(mode, role);

      document.getElementById('tttBackBtn').onclick = () => {
        this.exitToGameMenu();
      };
    }

    startConnectFourGame(container, mode, role) {
      container.innerHTML = `
        <div class="zen-game-container">
          <div class="zen-game-header" style="display:flex; justify-content:space-between; width:100%; margin-bottom:12px; font-size:12px; color:var(--text-muted); font-family:var(--font-mono);">
            <button class="zen-game-back" id="c4BackBtn">◀ Back</button>
            <span>Connect Four</span>
          </div>
          <div class="zen-canvas-wrapper" style="background:transparent; border:none;" id="c4GameArea"></div>
        </div>
      `;

      const area = document.getElementById('c4GameArea');
      const game = new window.FluxZenGames.ConnectFourGame(area, {
        sendMsg: (data) => this.sendGameMessage(data)
      });
      STATE.gameInstance = game;
      game.init(mode, role);

      document.getElementById('c4BackBtn').onclick = () => {
        this.exitToGameMenu();
      };
    }

    startPongGame(container, mode, role) {
      container.innerHTML = `
        <div class="zen-game-container">
          <div class="zen-game-header" style="display:flex; justify-content:space-between; width:100%; margin-bottom:12px; font-size:12px; color:var(--text-muted); font-family:var(--font-mono);">
            <button class="zen-game-back" id="pongBackBtn">◀ Back</button>
            <span>Ping Pong</span>
          </div>
          <div class="zen-canvas-wrapper" style="background:transparent; border:none;" id="pongGameArea"></div>
        </div>
      `;

      const area = document.getElementById('pongGameArea');
      const game = new window.FluxZenGames.PongGame(area, {
        sendMsg: (data) => this.sendGameMessage(data)
      });
      STATE.gameInstance = game;
      game.init(mode, role);

      document.getElementById('pongBackBtn').onclick = () => {
        this.exitToGameMenu();
      };
    }

    startRPSGame(container, mode, role) {
      container.innerHTML = `
        <div class="zen-game-container">
          <div class="zen-game-header" style="display:flex; justify-content:space-between; width:100%; margin-bottom:12px; font-size:12px; color:var(--text-muted); font-family:var(--font-mono);">
            <button class="zen-game-back" id="rpsBackBtn">◀ Back</button>
            <span>Rock Paper Scissors</span>
          </div>
          <div class="zen-canvas-wrapper" style="background:transparent; border:none;" id="rpsGameArea"></div>
        </div>
      `;

      const area = document.getElementById('rpsGameArea');
      const game = new window.FluxZenGames.RPSGame(area, {
        sendMsg: (data) => this.sendGameMessage(data)
      });
      STATE.gameInstance = game;
      game.init(mode, role);

      document.getElementById('rpsBackBtn').onclick = () => {
        this.exitToGameMenu();
      };
    }

    startSnakeGame(container) {
      container.innerHTML = `
        <div class="zen-game-container">
          <div class="zen-game-header">
            <button class="zen-game-back" id="snakeBackBtn">◀ Games</button>
            <span>Score: <span id="snakeScore">0</span></span>
          </div>
          <div class="zen-canvas-wrapper">
            <canvas class="zen-snake-canvas" id="snakeCanvas" width="240" height="240"></canvas>
            <div class="zen-game-overlay" id="snakeOverlay">
              <h4>Snake Game</h4>
              <p style="font-size:11px;color:var(--text-muted);">Use WASD, Arrows or D-pad below</p>
              <button id="snakeStartBtn">Start Game</button>
            </div>
          </div>
          
          <!-- On-screen arrow pad for mobile/touch screens -->
          <div class="zen-snake-controls">
            <button class="zen-control-btn ctrl-up" id="ctrlUp">▲</button>
            <button class="zen-control-btn ctrl-left" id="ctrlLeft">◀</button>
            <button class="zen-control-btn ctrl-right" id="ctrlRight">▶</button>
            <button class="zen-control-btn ctrl-down" id="ctrlDown">▼</button>
          </div>
        </div>
      `;

      const canvas = document.getElementById('snakeCanvas');
      const scoreEl = document.getElementById('snakeScore');
      const overlay = document.getElementById('snakeOverlay');
      const startBtn = document.getElementById('snakeStartBtn');

      const snake = new window.FluxZenGames.SnakeGame(canvas, {
        onScore: (score) => {
          scoreEl.textContent = score;
        },
        onGameOver: (finalScore) => {
          overlay.innerHTML = `
            <h4>Game Over</h4>
            <p>Score: ${finalScore}</p>
            <button id="snakeStartBtn">Play Again</button>
          `;
          overlay.classList.remove('hidden');
          // Re-bind the click handler
          document.getElementById('snakeStartBtn').onclick = () => {
            overlay.classList.add('hidden');
            snake.init();
          };
        }
      });
      STATE.snakeInstance = snake;

      // Start button
      startBtn.onclick = () => {
        overlay.classList.add('hidden');
        snake.init();
      };

      // Back button
      document.getElementById('snakeBackBtn').onclick = () => {
        STATE.selectedGame = null;
        this.switchMode('play');
      };

      // Wire touch D-pad
      const wireTouch = (id, direction) => {
        const btn = document.getElementById(id);
        if (btn) {
          btn.addEventListener('touchstart', (e) => {
            e.preventDefault();
            snake.setDirection(direction);
          });
          btn.addEventListener('mousedown', (e) => {
            e.preventDefault();
            snake.setDirection(direction);
          });
        }
      };
      wireTouch('ctrlUp', 'up');
      wireTouch('ctrlDown', 'down');
      wireTouch('ctrlLeft', 'left');
      wireTouch('ctrlRight', 'right');
    }

    startMemoryGame(container) {
      container.innerHTML = `
        <div class="zen-game-container">
          <div class="zen-game-header">
            <button class="zen-game-back" id="memoryBackBtn">◀ Games</button>
            <span>Moves: <span id="memoryMoves">0</span></span>
          </div>
          <div class="zen-canvas-wrapper" style="background:transparent;border:none;">
            <div id="memoryGrid" style="width:100%;height:100%;"></div>
            <div class="zen-game-overlay hidden" id="memoryOverlay">
              <h4>You Won!</h4>
              <p id="memoryWinText">Completed in -- moves</p>
              <button id="memoryStartBtn">Play Again</button>
            </div>
          </div>
        </div>
      `;

      const gridContainer = document.getElementById('memoryGrid');
      const movesEl = document.getElementById('memoryMoves');
      const overlay = document.getElementById('memoryOverlay');
      const startBtn = document.getElementById('memoryStartBtn');

      const memory = new window.FluxZenGames.MemoryMatchGame(gridContainer, {
        onMoves: (moves) => {
          movesEl.textContent = moves;
        },
        onWin: (finalMoves) => {
          document.getElementById('memoryWinText').textContent = `Completed in ${finalMoves} moves!`;
          overlay.classList.remove('hidden');
        }
      });
      STATE.memoryInstance = memory;

      // Start game
      memory.init();

      // Restart btn
      startBtn.onclick = () => {
        overlay.classList.add('hidden');
        memory.init();
      };

      // Back button
      document.getElementById('memoryBackBtn').onclick = () => {
        STATE.selectedGame = null;
        this.switchMode('play');
      };
    }

    // ──── DISCOVER MODE ────
    renderDiscoverMode(container) {
      if (!STATE.currentFact) {
        STATE.currentFact = window.FluxZenFacts.getRandom();
      }

      const fact = STATE.currentFact;
      if (!fact) {
        container.innerHTML = '<div>Trivia database is loading...</div>';
        return;
      }

      const isFav = window.FluxZenFacts.isFavorite(fact.id);

      container.innerHTML = `
        <div class="zen-discover-wrap">
          <div class="zen-fact-card" id="zenFactCard">
            <div class="zen-fact-cat-row">
              <span class="zen-fact-category">${fact.category}</span>
              <button class="zen-fact-fav-btn ${isFav ? 'active' : ''}" id="factFavBtn" title="Favorite">
                ${isFav ? '♥' : '♡'}
              </button>
            </div>
            <div class="zen-fact-text">"${fact.text}"</div>
          </div>
          <div class="zen-fact-footer">
            <span class="zen-fact-count">Favorites: ${window.FluxZenFacts.getFavoritesCount()}</span>
            <button class="zen-fact-next-btn" id="factNextBtn">Next Fact ➔</button>
          </div>
        </div>
      `;

      // Favorite toggle handler
      document.getElementById('factFavBtn').onclick = () => {
        const btn = document.getElementById('factFavBtn');
        const countSpan = document.querySelector('.zen-fact-count');
        const nextState = window.FluxZenFacts.toggleFavorite(fact.id);
        
        btn.classList.toggle('active', nextState);
        btn.textContent = nextState ? '♥' : '♡';
        if (countSpan) {
          countSpan.textContent = `Favorites: ${window.FluxZenFacts.getFavoritesCount()}`;
        }
      };

      // Next fact handler
      document.getElementById('factNextBtn').onclick = () => {
        const card = document.getElementById('zenFactCard');
        if (card) {
          card.style.opacity = '0';
          setTimeout(() => {
            STATE.currentFact = window.FluxZenFacts.getNext(fact.id);
            this.switchMode('discover');
          }, 150);
        }
      };
    }

    // ──── ZEN MODE ────
    renderZenMode(container) {
      container.innerHTML = `
        <div class="zen-waves-bg"></div>
        <div class="zen-breathing-wrap">
          <div class="zen-breathing-circle-container">
            <div class="zen-breathing-ring r1"></div>
            <div class="zen-breathing-ring r2"></div>
            <div class="zen-breathing-center"></div>
          </div>
          <div class="zen-breathing-instruction" id="zenBreathingPrompt">Focus on your breath</div>
        </div>
      `;

      const instructionEl = document.getElementById('zenBreathingPrompt');
      const wrap = container.querySelector('.zen-breathing-wrap');

      const breathing = new window.FluxZenVisuals.BreathingGuide(wrap, instructionEl);
      STATE.breathingInstance = breathing;
      breathing.start();
    }
  }

  window.FluxZen = new FluxZenOrchestrator();
})(window);
