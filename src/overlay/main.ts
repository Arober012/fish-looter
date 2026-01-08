// This file contains the main TypeScript logic for the overlay. 
// It handles user interactions, updates the game state, and communicates with the server.

import { GameState, Command } from '../../shared/types';

const canvas = document.getElementById('gameCanvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d');

let gameState: GameState = {
    fishCaught: 0,
    isFishing: false,
};

function drawGame() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Draw game elements based on gameState
    ctx.fillStyle = 'blue';
    ctx.fillText(`Fish Caught: ${gameState.fishCaught}`, 10, 20);
    if (gameState.isFishing) {
        ctx.fillText('Fishing...', canvas.width / 2, canvas.height / 2);
    }
}

function startFishing() {
    gameState.isFishing = true;
    drawGame();
    // Simulate fishing process
    setTimeout(() => {
        const caughtFish = Math.floor(Math.random() * 10);
        gameState.fishCaught += caughtFish;
        gameState.isFishing = false;
        drawGame();
        // Notify server about the caught fish
        sendCommandToServer({ type: 'FISH_CAUGHT', amount: caughtFish });
    }, 3000);
}

function sendCommandToServer(command: Command) {
    // Implement the logic to send command to the server
    fetch('/api/commands', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(command),
    });
}

// Event listener for Twitch commands
function onTwitchCommand(command: string) {
    if (command === '!fish') {
        startFishing();
    }
}

// Initialize the game
drawGame();