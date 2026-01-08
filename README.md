# OBS Overlay Fishing Game

## Overview
This project is an interactive fishing game designed to be used as an overlay in OBS (Open Broadcaster Software). The game is controlled via commands sent through Twitch chat, allowing viewers to interact with the stream in real-time.

## Project Structure
```
obs-overlay-fishing-game
├── src
│   ├── overlay
│   │   ├── index.html        # Main HTML structure for the OBS overlay
│   │   ├── main.ts           # TypeScript logic for the overlay
│   │   └── styles
│   │       └── main.css      # Styles for the overlay
│   ├── server
│   │   ├── index.ts          # Entry point for the server
│   │   ├── twitch-bridge.ts  # Manages Twitch chat connection
│   │   └── handlers
│   │       └── commands.ts    # Handles commands from Twitch chat
│   └── shared
│       └── types.ts          # Shared TypeScript types and interfaces
├── package.json               # npm configuration file
├── tsconfig.json              # TypeScript configuration file
└── README.md                  # Project documentation
```

## Setup Instructions
1. **Clone the Repository**
   ```bash
   git clone <repository-url>
   cd obs-overlay-fishing-game
   ```

2. **Install Dependencies**
   Make sure you have Node.js installed. Then run:
   ```bash
   npm install
   ```

3. **Configure Twitch Integration**
   - Create a Twitch developer application to get your client ID and secret.
   - Update the Twitch configuration in `src/server/twitch-bridge.ts` with your credentials.

4. **Run the Server**
   Start the server to listen for Twitch chat commands:
   ```bash
   npm run start
   ```

5. **Load the Overlay in OBS**
   - Open OBS and create a new browser source.
   - Set the URL to point to your local overlay (e.g., `http://localhost:3000/overlay/index.html`).

## Usage
- Viewers can interact with the game by sending commands in the Twitch chat.
- Commands are handled in `src/server/handlers/commands.ts`, where you can define the game mechanics and responses.

## Railway Deployment Notes (Token Persistence)
This app stores Twitch OAuth tokens (used for chat commands) and game saves under a `data/` directory.

If you deploy on Railway without a Volume, the filesystem can be ephemeral across deploys/restarts, which means:
- `data/channels.json` (OAuth tokens) may disappear → the server won’t reconnect to Twitch chat → chat commands stop working.

Recommended setup:
- Create a Railway **Volume** and mount it (commonly `/data`).
- Set environment variable `DATA_DIR=/data`.

After that, the server will store:
- Tokens at `/data/channels.json`
- Saves at `/data/saves/`

If the server logs "No saved channels found", visit `/api/auth/login` once to re-authorize and persist tokens.

If you cannot use Volumes (e.g., plan limitations), you can still run chat commands without storing OAuth tokens:
- Set `TWITCH_CHANNEL=<your_channel_login>`
- The server will connect to Twitch chat **anonymously (read-only)** and still receive `!commands`.
- Note: anonymous mode cannot send chat messages as the bot; it only listens.

## Contributing
Feel free to submit issues or pull requests if you have suggestions or improvements for the project.

## License
This project is licensed under the MIT License. See the LICENSE file for more details.